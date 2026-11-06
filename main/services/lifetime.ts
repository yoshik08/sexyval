import type { LifetimeGroupView, LifetimeView, MatchRow } from '../../shared/features';
import { aggregateLifetime, isLastPage, PAGE_SIZE, stitchPages, type GroupRow, type LifetimeMatch } from '../../shared/lifetime';
import { summarizeMatch, type TrimmedDetails } from '../../shared/last5';
import { parseUpdate, type CompUpdate } from '../../shared/mmr';
import { actLabel } from '../../shared/stats';
import type { RiotApi } from '../riot/api';
import type { AssetService } from './assets';
import type { CatalogService } from './catalog';
import type { HistoryService } from './history';
import type { ProfileService } from './profiles';
import { log } from '../log';

/** Lists (history ids, competitive updates) are re-paged after this; match details never are (disk cache). */
const LIST_TTL = 10 * 60 * 1000;
/** Safety cap: 50 pages of 20 = 1000 matches per list. */
const MAX_PAGES = 50;

interface Entry {
  at: number;
  ids: string[];
  updates: CompUpdate[];
  /** Details loaded so far, in history order. */
  details: TrimmedDetails[];
  loadedCount: number;
  view?: LifetimeView;
}

/**
 * Full lifetime profile for one player, from Riot's own pd endpoints with your session: competitive
 * updates and match history paged 20 at a time until a short page, then match details (shared disk cache,
 * so a match seen for anyone is never fetched twice). Everything goes through the pd rate limiter.
 * Fetched only when a player is opened, never for a whole roster.
 */
export class LifetimeService {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<LifetimeView>>();

  constructor(
    private readonly api: RiotApi,
    private readonly assets: AssetService,
    private readonly catalog: CatalogService,
    private readonly history: HistoryService,
    private readonly profiles: ProfileService,
    /** Players the current live match marks hidden are never looked up. */
    private readonly isHidden: (puuid: string) => boolean = () => false,
  ) {}

  private currentAct(): { id: string; start: number } | undefined {
    const now = Date.now();
    const a = this.catalog.browse.seasons.find((s: any) => s.type === 'Act' && Date.parse(s.start) <= now && now < Date.parse(s.end));
    return a ? { id: String(a.id), start: Date.parse(a.start) } : undefined;
  }

  /** Every page of competitive updates (all acts), newest first. */
  private async allUpdates(puuid: string): Promise<CompUpdate[]> {
    const pages: CompUpdate[][] = [];
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await this.api.competitiveUpdates(puuid, (i + 1) * PAGE_SIZE, 'competitive', i * PAGE_SIZE);
      const raw: any[] = Array.isArray(res.json?.Matches) ? res.json.Matches : [];
      pages.push(raw.map(parseUpdate).filter((u): u is CompUpdate => !!u));
      if (isLastPage(raw)) break;
    }
    return stitchPages(pages, (u) => u.matchId);
  }

  /** Every page of match history ids (all queues), newest first. */
  private async allIds(puuid: string): Promise<string[]> {
    const pages: string[][] = [];
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await this.api.history(puuid, (i + 1) * PAGE_SIZE, i * PAGE_SIZE);
      const raw: any[] = Array.isArray(res.json?.History) ? res.json.History : [];
      pages.push(raw.filter((h) => typeof h?.MatchID === 'string').sort((a, b) => Number(b.GameStartTime ?? 0) - Number(a.GameStartTime ?? 0)).map((h) => h.MatchID as string));
      if (isLastPage(raw)) break;
    }
    return stitchPages(pages, (id) => id);
  }

  /** Sequential through the limiter; a failed match is skipped, not fatal. */
  private async loadDetails(e: Entry, upTo: number): Promise<void> {
    const want = e.ids.slice(e.loadedCount, upTo);
    const got = await Promise.all(want.map((id) => this.history.getDetails(id).catch((err) => (log.warn(`lifetime details ${id.slice(0, 8)} failed`, err), null))));
    for (const d of got) if (d) e.details.push(d);
    e.loadedCount = Math.min(upTo, e.ids.length);
  }

  /** Lifetime view with at least `count` matches' details (20 more per "load more"). */
  async get(puuid: string, count = PAGE_SIZE): Promise<LifetimeView> {
    const id = await this.profiles.resolve(puuid);
    if (this.isHidden(id)) throw new Error('Hidden player: SexyVal doesn’t look up players who hide their name.');
    const key = `${id}:${count}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.load(id, Math.max(PAGE_SIZE, Math.min(1000, Math.round(count)))).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async load(puuid: string, count: number): Promise<LifetimeView> {
    let e = this.entries.get(puuid);
    if (!e || Date.now() - e.at > LIST_TTL) {
      // Sequential, cheapest first: updates then history ids. Details only for what is shown.
      const updates = await this.allUpdates(puuid);
      const ids = await this.allIds(puuid);
      const keep = e && e.ids.join() === ids.slice(0, e.ids.length).join() ? e : undefined;
      e = { at: Date.now(), ids, updates, details: keep?.details ?? [], loadedCount: keep?.loadedCount ?? 0 };
      this.entries.set(puuid, e);
    }
    if (e.loadedCount < count && e.loadedCount < e.ids.length) await this.loadDetails(e, count);
    e.view = this.build(puuid, e);
    return e.view;
  }

  private group(g: GroupRow, kind: 'agent' | 'map'): LifetimeGroupView {
    const agent = kind === 'agent' ? this.assets.agent(g.key) : undefined;
    return { key: g.key, name: (kind === 'agent' ? agent?.name : this.assets.mapName(g.key)) ?? 'Unknown', icon: agent?.icon, games: g.games, winRate: g.winRate, kd: g.kd, acs: g.acs };
  }

  private build(puuid: string, e: Entry): LifetimeView {
    const rrBy = new Map(e.updates.map((u) => [u.matchId, { delta: u.rrEarned, tier: u.tierAfter }]));
    const lines: LifetimeMatch[] = [];
    const rows: MatchRow[] = [];
    for (const d of e.details) {
      const s = summarizeMatch(d, puuid);
      if (s) lines.push(s);
      const r = this.profiles.matchRow(d, puuid, rrBy.get(d.matchId));
      if (r) rows.push(r);
    }
    const a = aggregateLifetime({ matches: lines, updates: e.updates, currentAct: this.currentAct() });
    const seasons = this.catalog.browse.seasons;
    const g = (x: GroupRow | undefined, k: 'agent' | 'map') => (x ? this.group(x, k) : undefined);
    return {
      puuid,
      status: 'ready',
      totals: a.totals,
      competitive: a.competitive,
      currentAct: a.currentAct,
      byAgent: a.byAgent.map((x) => this.group(x, 'agent')),
      byMap: a.byMap.map((x) => this.group(x, 'map')),
      best: { agent: g(a.bestAgent, 'agent'), worstAgent: g(a.worstAgent, 'agent'), map: g(a.bestMap, 'map'), worstMap: g(a.worstMap, 'map') },
      timeline: a.timeline,
      actStarts: a.actStarts.map((s) => ({ ...s, name: actLabel(seasons, s.actId) })),
      matches: rows.sort((x, y) => y.startTime - x.startTime),
      totalMatches: e.ids.length,
      loaded: e.loadedCount,
      hasMore: e.loadedCount < e.ids.length,
      fetchedAt: Date.now(),
    };
  }
}
