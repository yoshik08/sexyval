import path from 'node:path';
import type { MmrChip, MmrView } from '../../shared/features';
import { estimateMmr, factsFromDetails, parseUpdate, type CompUpdate, type MatchFacts, type MmrEstimate } from '../../shared/mmr';
import { isLastPage, PAGE_SIZE, stitchPages } from '../../shared/lifetime';
import { seasonRank } from '../../shared/stats';
import type { RiotApi } from '../riot/api';
import type { AssetService } from './assets';
import type { CatalogService } from './catalog';
import type { HistoryService, NameService } from './history';
import type { ProfileService } from './profiles';
import { readJson, writeJson } from '../paths';
import { log } from '../log';

const TTL = 5 * 60 * 1000;
/** Matches per estimate: the last 25 competitive updates (two pages of at most 20). */
export const WINDOW = 25;

/** mmr/v1/players JSON and the newest WINDOW competitive updates, as fetched together. */
export interface MmrSource {
  mmr: any;
  updates: CompUpdate[];
  at: number;
}

/**
 * Competitive updates paged like lifetime.ts: 0–20, then 20–25 only if the first page was full. Never
 * assumes one call returns more than 20.
 */
export async function pageUpdates(api: RiotApi, puuid: string, limit = WINDOW): Promise<CompUpdate[]> {
  const pages: CompUpdate[][] = [];
  for (let start = 0; start < limit; start += PAGE_SIZE) {
    const end = Math.min(limit, start + PAGE_SIZE);
    const res = await api.competitiveUpdates(puuid, end, 'competitive', start);
    const raw: any[] = Array.isArray(res.json?.Matches) ? res.json.Matches : [];
    pages.push(raw.map(parseUpdate).filter((u): u is CompUpdate => !!u));
    if (isLastPage(raw, end - start)) break;
  }
  return stitchPages(pages, (u) => u.matchId).slice(0, limit);
}

interface Stored {
  v: 1;
  updates: CompUpdate[];
}

/**
 * Estimated MMR (shared/mmr.ts) for any player SexyVal can resolve. Reuses the pd calls Profiles
 * already makes (mmr, competitiveupdates, match details from the disk cache). Competitive updates are
 * also kept on disk per player so scripts/mmr-backtest.mjs can replay them.
 */
export class MmrEstimateService {
  private cache = new Map<string, MmrView>();
  private inflight = new Map<string, Promise<MmrView>>();
  private sources = new Map<string, MmrSource>();
  private sourceInflight = new Map<string, Promise<MmrSource>>();

  constructor(
    private readonly api: RiotApi,
    private readonly assets: AssetService,
    private readonly catalog: CatalogService,
    private readonly history: HistoryService,
    private readonly names: NameService,
    private readonly profiles: ProfileService,
    private readonly dir: string,
    /** Players the current live match marks hidden are never looked up. */
    private readonly isHidden: (puuid: string) => boolean = () => false,
  ) {}

  currentAct(): { id: string; start: number } | undefined {
    const now = Date.now();
    const a = this.catalog.browse.seasons.find((s: any) => s.type === 'Act' && Date.parse(s.start) <= now && now < Date.parse(s.end));
    return a ? { id: String(a.id), start: Date.parse(a.start) } : undefined;
  }

  private file(puuid: string): string {
    return path.join(this.dir, `${puuid.replace(/[^a-zA-Z0-9-]/g, '')}.json`);
  }

  /** Merge new updates into the per-player store (never drops one). */
  private async persist(puuid: string, updates: CompUpdate[]): Promise<void> {
    const prev = await readJson<Partial<Stored>>(this.file(puuid), {});
    const byId = new Map<string, CompUpdate>((Array.isArray(prev.updates) ? prev.updates : []).map((u) => [u.matchId, u]));
    for (const u of updates) byId.set(u.matchId, u);
    await writeJson(this.file(puuid), { v: 1, updates: [...byId.values()].sort((a, b) => b.startTime - a.startTime) } satisfies Stored).catch((e) => log.warn('persist competitive updates failed', e));
  }

  /** Last good result, if any (the screen keeps it when a refresh fails). */
  cached(puuid: string): MmrView | undefined {
    return this.cache.get(puuid);
  }

  async get(query: string, force = false): Promise<MmrView> {
    const puuid = await this.profiles.resolve(query);
    if (this.isHidden(puuid)) throw new Error('Hidden player: SexyVal doesn’t look up players who hide their name.');
    const hit = this.cache.get(puuid);
    if (hit && !force && Date.now() - hit.fetchedAt < TTL) return hit;
    const running = this.inflight.get(puuid);
    if (running) return running;
    const p = this.load(puuid, force).finally(() => this.inflight.delete(puuid));
    this.inflight.set(puuid, p);
    return p;
  }

  async chip(puuid: string): Promise<MmrChip> {
    const v = await this.get(puuid);
    return { puuid, est: v.est, label: v.estimate.label, gapDivisions: v.estimate.gapDivisions, confidence: v.estimate.confidence, usable: v.estimate.usable };
  }

  /**
   * Rank + the newest WINDOW competitive updates for a player, shared by the MMR tab's solo and team views
   * (5 min, one fetch in flight per player). Persisted for scripts/mmr-backtest.mjs.
   */
  async source(puuid: string, force = false): Promise<MmrSource> {
    if (this.isHidden(puuid)) throw new Error('Hidden player: SexyVal doesn’t look up players who hide their name.');
    const hit = this.sources.get(puuid);
    if (hit && !force && Date.now() - hit.at < TTL) return hit;
    const running = this.sourceInflight.get(puuid);
    if (running) return running;
    const p = (async () => {
      // Errors carry the HTTP status (HttpError message) to the screen, like every other screen.
      const [mmr, updates] = await Promise.all([this.api.mmr(puuid), pageUpdates(this.api, puuid)]);
      void this.persist(puuid, updates);
      const s: MmrSource = { mmr: mmr.json, updates, at: Date.now() };
      this.sources.set(puuid, s);
      return s;
    })().finally(() => this.sourceInflight.delete(puuid));
    this.sourceInflight.set(puuid, p);
    return p;
  }

  private async load(puuid: string, force: boolean): Promise<MmrView> {
    const namesReady = this.names.waitFor([puuid]);
    const src = await this.source(puuid, force);
    const act = this.currentAct();
    const sr = seasonRank(src.mmr, act?.id);
    const updates = src.updates;
    const facts: Record<string, MatchFacts | undefined> = {};
    await Promise.all(
      updates.map(async (u: CompUpdate) => {
        const d = await this.history.getDetails(u.matchId).catch(() => null);
        facts[u.matchId] = d ? factsFromDetails(d, puuid) : undefined;
      }),
    );
    const e = estimateMmr({ updates, facts, myTier: sr.tier, myRR: sr.rr, actId: act?.id, actStart: act?.start });
    await namesReady;
    const view = this.view(puuid, e);
    this.cache.set(puuid, view);
    return view;
  }

  /** Estimate -> what the MMR screen shows (rank icons, map and agent names resolved). */
  view(puuid: string, e: MmrEstimate): MmrView {
    const n = this.names.get(puuid);
    const rank = (t?: number) => (t && t >= 3 ? this.assets.rank(Math.round(t)) : undefined);
    const { matches, ...estimate } = e;
    const view: MmrView = {
      puuid,
      name: n?.name,
      tag: n?.tag,
      isMe: puuid === this.api.session.puuid,
      estimate,
      est: rank(e.estTier),
      mine: rank(e.myTier),
      lobby: rank(e.lobbyAvg),
      next: rank(e.forecast.nextTier),
      matches: matches
        .map((m) => {
          const agent = this.assets.agent(m.characterId);
          return { ...m, mapName: this.assets.mapName(m.mapId), agentName: agent?.name, agentIcon: agent?.icon, rankAfter: rank(m.tierAfter), lobbyRank: rank(m.lobbyAvg) };
        })
        .reverse(),
      fetchedAt: Date.now(),
    };
    return view;
  }
}
