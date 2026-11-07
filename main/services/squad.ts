import type { MmrTeamView, SquadRowView } from '../../shared/features';
import { estimateMmr, factsFromDetails, gapLabel, type MatchFacts, type MmrInput } from '../../shared/mmr';
import { teamFactsFromDetails, type PremadeInfo, type TeamFacts } from '../../shared/team';
import { seasonRank } from '../../shared/stats';
import type { RiotApi } from '../riot/api';
import type { AssetService } from './assets';
import { assetUrl } from './assets';
import type { CatalogService } from './catalog';
import type { HistoryService, NameService } from './history';
import type { MmrEstimateService } from './mmrEstimate';
import type { ProfileService } from './profiles';
import { log } from '../log';

const TTL = 5 * 60 * 1000;
/** Premades looked up (rank + their own competitive updates): only those with this many shared games… */
export const MIN_LOOKUP_GAMES = 2;
/** …and at most this many, most shared games first. */
export const MAX_SQUAD_LOOKUPS = 6;
/** New match details fetched per premade for their own estimate (their games without you). */
export const MAX_PREMADE_DETAIL_FETCH = 10;

const HIDDEN_ERR = 'Hidden player: SexyVal doesn’t look up players who hide their name.';

export interface SquadDeps {
  api: RiotApi;
  assets: AssetService;
  catalog: CatalogService;
  history: HistoryService;
  names: NameService;
  profiles: ProfileService;
  mmr: MmrEstimateService;
  /** Players the live match marks hidden: never looked up, shown as "Hidden teammate". */
  isHidden: (puuid: string) => boolean;
  /** Your current party's RR penalty (0–1), when Valorant reports one. */
  livePenalty: () => number | undefined;
  /** Pushes a fuller view as premade lookups land. */
  onUpdate: (v: MmrTeamView) => void;
}

interface Base {
  puuid: string;
  input: MmrInput;
  /** Premade -> shared games in this act's window. */
  seen: Map<string, number>;
  /** Premades queued for a lookup. */
  queue: string[];
  hidden: Set<string>;
}

/**
 * Team-based MMR and the Squad report (shared/team.ts) for your own account: the last 25 competitive
 * matches of this act, who you queued with in each, and (lazily, bounded) the rank and own competitive
 * updates of your regular premades. Only Riot's pd endpoints with your session, through the pd limiter.
 * The first answer never waits for premade lookups; each one that lands pushes a fuller view.
 */
export class SquadService {
  private cache = new Map<string, MmrTeamView>();
  private bases = new Map<string, Base>();
  private inflight = new Map<string, Promise<MmrTeamView>>();
  private premades = new Map<string, { at: number; info: PremadeInfo }>();
  private premadeInflight = new Map<string, Promise<PremadeInfo>>();
  private generation = new Map<string, number>();

  constructor(private readonly d: SquadDeps) {}

  cached(puuid: string): MmrTeamView | undefined {
    return this.cache.get(puuid);
  }

  async get(query: string, force = false): Promise<MmrTeamView> {
    const puuid = await this.d.profiles.resolve(query);
    if (this.d.isHidden(puuid)) throw new Error(HIDDEN_ERR);
    if (puuid !== this.d.api.session.puuid) throw new Error('The team view covers your own matches only.');
    const hit = this.cache.get(puuid);
    if (hit && !force && Date.now() - hit.fetchedAt < TTL) {
      // Same matches; only the live party may have changed (forecast).
      const base = this.bases.get(puuid);
      return base && hit.livePenalty !== this.d.livePenalty() ? this.rebuild(base) : hit;
    }
    const running = this.inflight.get(puuid);
    if (running) return running;
    const p = this.load(puuid, force).finally(() => this.inflight.delete(puuid));
    this.inflight.set(puuid, p);
    return p;
  }

  private async load(puuid: string, force: boolean): Promise<MmrTeamView> {
    const pd0 = this.d.api.pdCalls;
    const gen = (this.generation.get(puuid) ?? 0) + 1;
    this.generation.set(puuid, gen);
    const src = await this.d.mmr.source(puuid, force);
    const act = this.d.mmr.currentAct();
    const sr = seasonRank(src.mmr, act?.id);
    const facts: Record<string, MatchFacts | undefined> = {};
    const team: Record<string, TeamFacts | undefined> = {};
    await Promise.all(
      src.updates.map(async (u) => {
        // Copies cached before partyId was kept are fetched once more for their party data.
        const det = await this.d.history.getDetails(u.matchId, { needParty: true }).catch(() => null);
        facts[u.matchId] = det ? factsFromDetails(det, puuid) : undefined;
        team[u.matchId] = det ? teamFactsFromDetails(det, puuid) : undefined;
      }),
    );
    const actId = act?.id.toLowerCase();
    const seen = new Map<string, number>();
    for (const u of src.updates) {
      if (actId && u.seasonId && u.seasonId !== actId) continue;
      for (const p of team[u.matchId]?.premades ?? []) seen.set(p.puuid, (seen.get(p.puuid) ?? 0) + 1);
    }
    const hidden = new Set([...seen.keys()].filter((p) => this.d.isHidden(p)));
    const queue = [...seen.entries()]
      .filter(([p, n]) => n >= MIN_LOOKUP_GAMES && !hidden.has(p))
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SQUAD_LOOKUPS)
      .map(([p]) => p);
    // Names for visible premades only (bounded wait; the match details' names are the fallback).
    await this.d.names.waitFor([puuid, ...[...seen.keys()].filter((p) => !hidden.has(p))], 1500);
    const base: Base = { puuid, input: { updates: src.updates, facts, team, myTier: sr.tier, myRR: sr.rr, actId: act?.id, actStart: act?.start, puuid }, seen, queue, hidden };
    this.bases.set(puuid, base);
    const view = this.rebuild(base);
    void this.lookups(base, gen, force, pd0);
    return view;
  }

  /** Lookups run alongside each other (the pd limiter caps concurrency); each one pushes a view. */
  private async lookups(base: Base, gen: number, force: boolean, pd0: number): Promise<void> {
    await Promise.all(
      base.queue.map(async (p) => {
        await this.premade(p, force, new Set(base.input.updates.map((u) => u.matchId)));
        if (this.generation.get(base.puuid) !== gen) return; // a newer load took over
        this.d.onUpdate(this.rebuild(base));
      }),
    );
    log.debug(`squad: ${this.d.api.pdCalls - pd0} pd calls (${base.input.updates.length} matches, ${base.queue.length} premade lookups, ${base.hidden.size} hidden)`);
  }

  private infoFor(p: string, base: Base): PremadeInfo {
    if (base.hidden.has(p)) return { status: 'hidden' };
    const e = this.premades.get(p);
    if (e) return e.info;
    return base.queue.includes(p) ? { status: 'loading' } : { status: 'skipped' };
  }

  /** A premade's rank and estimated MMR from their own competitive updates (5 min, last good kept). */
  private premade(p: string, force: boolean, yours: Set<string>): Promise<PremadeInfo> {
    const hit = this.premades.get(p);
    if (hit && !force && Date.now() - hit.at < TTL) return Promise.resolve(hit.info);
    const running = this.premadeInflight.get(p);
    if (running) return running;
    const run = (async (): Promise<PremadeInfo> => {
      if (this.d.isHidden(p)) return { status: 'hidden' };
      try {
        const src = await this.d.mmr.source(p, force);
        const act = this.d.mmr.currentAct();
        const sr = seasonRank(src.mmr, act?.id);
        const facts: Record<string, MatchFacts | undefined> = {};
        const missing: string[] = [];
        // Their games without you: only the newest MAX_PREMADE_DETAIL_FETCH may be fetched, so a second
        // open finds them on disk and fetches nothing new.
        const fetchable = new Set(src.updates.filter((u) => !yours.has(u.matchId)).slice(0, MAX_PREMADE_DETAIL_FETCH).map((u) => u.matchId));
        for (const u of src.updates) {
          const det = await this.d.history.getDetails(u.matchId, { cachedOnly: true }).catch(() => null);
          if (det) facts[u.matchId] = factsFromDetails(det, p);
          else if (fetchable.has(u.matchId)) missing.push(u.matchId);
        }
        await Promise.all(
          missing.map(async (id) => {
            const det = await this.d.history.getDetails(id).catch(() => null);
            if (det) facts[id] = factsFromDetails(det, p);
          }),
        );
        const e = estimateMmr({ updates: src.updates, facts, myTier: sr.tier, myRR: sr.rr, actId: act?.id, actStart: act?.start });
        const info: PremadeInfo = {
          status: 'ready',
          tier: sr.tier >= 3 ? sr.tier : undefined,
          estMmr: e.usable ? e.estTierDecimal : undefined,
          // Estimate vs their rank, so the label always agrees with the two numbers shown next to it.
          gapLabel: e.usable && sr.tier >= 3 ? gapLabel(e.estTierDecimal - sr.tier) : undefined,
          rrByMatch: Object.fromEntries(src.updates.map((u) => [u.matchId, u.rrEarned])),
        };
        this.premades.set(p, { at: Date.now(), info });
        return info;
      } catch (err) {
        log.warn(`squad lookup ${p.slice(0, 8)} failed`, err);
        const last = this.premades.get(p);
        if (last?.info.status === 'ready') return last.info;
        const info: PremadeInfo = { status: 'unavailable' };
        this.premades.set(p, { at: Date.now(), info });
        return info;
      }
    })().finally(() => this.premadeInflight.delete(p));
    this.premadeInflight.set(p, run);
    return run;
  }

  private nameOf(p: string, base: Base, fallback?: { gameName?: string; tagLine?: string }): string {
    if (base.hidden.has(p)) return 'Hidden teammate';
    const n = this.d.names.get(p);
    if (n) return `${n.name}#${n.tag}`;
    return fallback?.gameName ? `${fallback.gameName}${fallback.tagLine ? `#${fallback.tagLine}` : ''}` : 'Teammate';
  }

  private rebuild(base: Base): MmrTeamView {
    const infos: Record<string, PremadeInfo> = {};
    for (const p of base.seen.keys()) infos[p] = this.infoFor(p, base);
    const premadeMmr: Record<string, number> = {};
    for (const [p, i] of Object.entries(infos)) if (i.status === 'ready' && i.estMmr != null) premadeMmr[p] = i.estMmr;
    const live = this.d.livePenalty();
    const { team: _team, puuid: _p, ...plain } = base.input;
    const soloE = estimateMmr(plain);
    const teamE = estimateMmr({ ...base.input, premadeMmr, premades: infos, livePartyPenalty: live });
    const rank = (t?: number) => (t != null && t >= 3 ? this.d.assets.rank(Math.round(t)) : undefined);
    const cards = this.d.catalog.catalog.cards;
    const squad: SquadRowView[] = (teamE.team?.squad ?? []).map((r) => {
      const n = r.hidden ? undefined : this.d.names.get(r.puuid);
      const card = r.hidden || !r.cardId ? undefined : cards.find((c) => c.id === String(r.cardId).toLowerCase());
      return {
        ...r,
        name: r.hidden ? undefined : (n?.name ?? r.gameName),
        tag: r.hidden ? undefined : (n?.tag ?? r.tagLine),
        cardIcon: card ? assetUrl(card.icon) : undefined,
        rank: rank(r.theirTier),
        estRank: rank(r.theirEstMmr),
        shared: r.shared.map((g) => ({ ...g, mapName: this.d.assets.mapName(g.mapId), agentIcon: this.d.assets.agent(g.theirAgent)?.icon })),
      };
    });
    const solo = this.d.mmr.view(base.puuid, soloE);
    const teamView = this.d.mmr.view(base.puuid, teamE);
    if (teamView.estimate.team) teamView.estimate = { ...teamView.estimate, team: { ...teamView.estimate.team, squad: [] } };
    const fallbackLine = (p: string) => {
      for (const tf of Object.values(base.input.team ?? {})) {
        const m = tf?.premades.find((x) => x.puuid === p);
        if (m?.gameName) return m;
      }
      return undefined;
    };
    teamView.matches = teamView.matches.map((m) => ({ ...m, premadeNames: m.premades?.map((p) => this.nameOf(p, base, fallbackLine(p))) }));
    const view: MmrTeamView = {
      puuid: base.puuid,
      solo,
      team: teamView,
      squad,
      livePenalty: live,
      lookups: { done: base.queue.filter((p) => this.premades.has(p) && !this.premadeInflight.has(p)).length, total: base.queue.length },
      soloLobby: rank(teamE.team?.lobbyAvgSolo),
      stackedLobby: rank(teamE.team?.lobbyAvgStacked),
      fetchedAt: Date.now(),
    };
    this.cache.set(base.puuid, view);
    return view;
  }
}
