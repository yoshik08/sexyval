import path from 'node:path';
import { promises as fs } from 'node:fs';
import { writeJson } from '../paths';
import { log } from '../log';
import {
  agentAnalytics,
  buildMasteryView,
  emptyMasteryFile,
  gearCosmetics,
  MASTERY_LAUNCH,
  MASTERY_QUEUES,
  migrateMasteryFile,
  parseBloomlineBonsai,
  parseBloomlinePlayer,
  parseValidQueues,
  recordSnapshot,
  rewardRows,
  statAvailability,
  statSlotViews,
  type ActRef,
  type AgentMasteryDetail,
  type AgentMeta,
  type AnalyticsRow,
  type CosmeticRef,
  type MasteryFile,
  type MasteryView,
  type OwnedIds,
  type StatKey,
} from '../../shared/mastery';
import type { HttpResult } from '../riot/http';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A view older than this refreshes in the background when the screen asks for it. */
export const MASTERY_TTL_MS = 5 * 60_000;
const STATS_TTL_MS = 10 * 60_000;
const QUEUES_TTL_MS = 24 * 3600_000;

export interface MasteryApi {
  bloomlinePlayer(puuid: string): Promise<HttpResult>;
  bloomlineBonsai(puuid: string, agentId: string): Promise<HttpResult>;
  bloomlineValidQueues(): Promise<HttpResult>;
}

export interface MasteryDeps {
  api: MasteryApi;
  /** Folder for mastery/<puuid>.json. */
  dir: string;
  /** The account the app is showing right now. */
  activePuuid: () => string | null;
  /** Every playable agent (public catalog). */
  agents: () => AgentMeta[];
  /** The Act that's current now (public content catalog). */
  currentAct: () => ActRef | null;
  /** A fresh view for the active account. Never called with another account's data. */
  onUpdate?: (v: MasteryView) => void;
  /** Owned items for `puuid`, or null when they aren't loaded for that account. */
  owned?: (puuid: string) => { ids: OwnedIds; at?: number } | null;
  /** The agent's old Agent Gear contract levels (carried into the mastery track). */
  gearLevels?: (agentId: string) => { rewardType?: string; rewardId?: string }[];
  resolveItem?: (type: string, id: string) => { name: string; icon?: string; art?: string; text?: string };
  masteryCard?: (agentId: string) => CosmeticRef | undefined;
  /** This account's cached matches (warehouse rows). */
  rows?: (puuid: string) => Promise<AnalyticsRow[]>;
  now?: () => number;
}

type Status = { status: MasteryView['status']; error?: string; dropped?: number; at: number };

/**
 * Agent Mastery per account. Riot is asked with an explicit puuid, the answer must name the same Subject,
 * and it is stored under that puuid only, so a late answer for one account can never land in another's
 * view. Views go out through onUpdate only while their account is the active one.
 */
export class MasteryService {
  private files = new Map<string, MasteryFile>();
  private loading = new Map<string, Promise<MasteryFile>>();
  private inflight = new Map<string, Promise<MasteryView>>();
  private statsInflight = new Map<string, Promise<void>>();
  private status = new Map<string, Status>();
  /** Accounts Riot answered for in this session (vs. only a saved snapshot). */
  private live = new Set<string>();
  /** Accounts whose file couldn't be read this time: never written until a read succeeds. */
  private readOnly = new Set<string>();

  constructor(private readonly deps: MasteryDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private fileOf(puuid: string): string {
    return path.join(this.deps.dir, `${puuid}.json`);
  }

  private load(puuid: string): Promise<MasteryFile> {
    const hit = this.files.get(puuid);
    if (hit) return Promise.resolve(hit);
    const run = this.loading.get(puuid);
    if (run) return run;
    const p = this.doLoad(puuid).finally(() => this.loading.delete(puuid));
    this.loading.set(puuid, p);
    return p;
  }

  private async doLoad(puuid: string): Promise<MasteryFile> {
    const file = this.fileOf(puuid);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Locked or unreadable right now: work in memory, don't overwrite it, try again next time.
        log.warn(`mastery: ${path.basename(file)} unreadable for now`, e);
        this.readOnly.add(puuid);
        return emptyMasteryFile(puuid);
      }
      const f = emptyMasteryFile(puuid);
      this.files.set(puuid, f);
      return f;
    }
    this.readOnly.delete(puuid);
    let f: MasteryFile | null = null;
    try {
      f = migrateMasteryFile(JSON.parse(text), puuid);
    } catch {
      f = null;
    }
    if (!f) {
      // Damaged, or written by a newer SexyVal: keep it beside, start fresh.
      const aside = file.replace(/\.json$/, `.unread-${this.now()}.json`);
      await fs.rename(file, aside).catch(() => undefined);
      log.warn(`mastery: ${path.basename(file)} unusable, kept as ${path.basename(aside)}`);
      f = emptyMasteryFile(puuid);
    }
    this.files.set(puuid, f);
    return f;
  }

  private async save(puuid: string, f: MasteryFile): Promise<void> {
    this.files.set(puuid, f);
    if (this.readOnly.has(puuid)) return;
    await writeJson(this.fileOf(puuid), f).catch((e) => log.warn('mastery: save failed (kept in memory)', e));
  }

  private viewOf(puuid: string, f: MasteryFile): MasteryView {
    const s = this.status.get(puuid);
    return buildMasteryView({
      puuid,
      file: f,
      agents: this.deps.agents(),
      act: this.deps.currentAct(),
      live: this.live.has(puuid),
      status: s?.status ?? (f.current ? 'ready' : 'idle'),
      error: s?.error,
      dropped: s?.dropped,
    });
  }

  private emit(puuid: string): void {
    if (this.deps.activePuuid() !== puuid) return;
    const f = this.files.get(puuid);
    if (f) this.deps.onUpdate?.(this.viewOf(puuid, f));
  }

  /** The saved/last view straight away; starts a refresh when it's older than `maxAgeMs` (results arrive via onUpdate). */
  async get(puuid: string, maxAgeMs = MASTERY_TTL_MS): Promise<MasteryView> {
    if (!ID.test(puuid)) throw new Error('bad account id');
    const f = await this.load(puuid);
    const last = this.status.get(puuid);
    const fresh = this.live.has(puuid) && f.current && this.now() - f.current.at < maxAgeMs;
    const triedRecently = last && last.status === 'error' && this.now() - last.at < 30_000;
    if (!fresh && !triedRecently && !this.inflight.has(puuid)) void this.refresh(puuid).catch(() => undefined);
    return this.viewOf(puuid, f);
  }

  /** Asks Riot now (deduplicated per account). */
  refresh(puuid: string): Promise<MasteryView> {
    if (!ID.test(puuid)) return Promise.reject(new Error('bad account id'));
    const run = this.inflight.get(puuid);
    if (run) return run;
    const p = this.doRefresh(puuid).finally(() => this.inflight.delete(puuid));
    this.inflight.set(puuid, p);
    return p;
  }

  private async doRefresh(puuid: string): Promise<MasteryView> {
    await this.load(puuid);
    this.status.set(puuid, { ...(this.status.get(puuid) ?? {}), status: 'loading', at: this.now() });
    this.emit(puuid);
    let err: string | undefined;
    let dropped = 0;
    try {
      const res = await this.deps.api.bloomlinePlayer(puuid);
      if (res.status === 404) throw new Error('Riot has no mastery data for this account (404)');
      const parsed = parseBloomlinePlayer(res.json, puuid);
      if (!parsed.ok) throw new Error(parsed.error);
      dropped = parsed.dropped;
      if (dropped) log.warn(`mastery: dropped ${dropped} malformed agent record(s)`);
      const act = this.deps.currentAct();
      // Re-read the file: the account may have been saved by another call while this one waited.
      const f = recordSnapshot(await this.load(puuid), { at: this.now(), act: act ? { id: act.id, label: act.label } : undefined, agents: parsed.value });
      this.live.add(puuid);
      await this.save(puuid, f);
      void this.refreshQueues(puuid).catch(() => undefined);
    } catch (e) {
      err = (e as Error).message || 'Mastery request failed';
      log.warn(`mastery refresh failed: ${err}`);
    }
    this.status.set(puuid, { status: err ? 'error' : 'ready', error: err, dropped, at: this.now() });
    const f = this.files.get(puuid) ?? emptyMasteryFile(puuid);
    this.emit(puuid);
    return this.viewOf(puuid, f);
  }

  private async refreshQueues(puuid: string): Promise<void> {
    const f = await this.load(puuid);
    if (f.queues && this.now() - f.queues.at < QUEUES_TTL_MS) return;
    const res = await this.deps.api.bloomlineValidQueues();
    const q = res.status === 200 ? parseValidQueues(res.json) : null;
    if (!q) return;
    await this.save(puuid, { ...(await this.load(puuid)), queues: { at: this.now(), ...q } });
    this.emit(puuid);
  }

  private async refreshStats(puuid: string, agentId: string): Promise<void> {
    const key = `${puuid}:${agentId}`;
    const run = this.statsInflight.get(key);
    if (run) return run;
    const p = (async () => {
      const res = await this.deps.api.bloomlineBonsai(puuid, agentId);
      if (res.status === 404) throw new Error('No Agent ID data for this agent yet');
      const parsed = parseBloomlineBonsai(res.json, puuid, agentId);
      if (!parsed.ok) throw new Error(parsed.error);
      const f = await this.load(puuid);
      await this.save(puuid, { ...f, stats: { ...f.stats, [agentId]: { at: this.now(), slots: parsed.value.stats } } });
    })().finally(() => this.statsInflight.delete(key));
    this.statsInflight.set(key, p);
    return p;
  }

  /** Everything the agent page shows. Stat slots are fetched per agent (only that endpoint has them). */
  async detail(puuid: string, agentId: string, offline = false): Promise<AgentMasteryDetail> {
    if (!ID.test(puuid) || !ID.test(agentId)) throw new Error('bad id');
    let statsError: string | undefined;
    const before = (await this.load(puuid)).stats[agentId];
    if (!offline && (!before || this.now() - before.at > STATS_TTL_MS)) {
      try {
        await this.refreshStats(puuid, agentId);
      } catch (e) {
        statsError = (e as Error).message;
      }
    }
    const f = await this.load(puuid);
    const view = this.viewOf(puuid, f);
    const agent = view.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error('Unknown agent');
    const own = this.deps.owned?.(puuid) ?? null;
    const card = this.deps.masteryCard?.(agentId);
    const stats = f.stats[agentId];
    const slots = statSlotViews(stats?.slots ?? []);
    const statOwned = new Set<StatKey>(slots.map((s) => s.stat?.key).filter((k): k is StatKey => !!k));
    const resolve = this.deps.resolveItem ?? ((t: string) => ({ name: t }));
    const gear = gearCosmetics(this.deps.gearLevels?.(agentId) ?? [], resolve, own?.ids ?? null);
    const rewards = rewardRows(agent.lifetimeLevel, card, own?.ids ?? null, statOwned, gear);
    const placed = new Set(rewards.map((r) => r.item && `${r.item.type}:${r.item.id}`).filter(Boolean));
    // Only what the track couldn't place; normally empty.
    const cosmetics: AgentMasteryDetail['cosmetics'] = gear.filter((c) => !placed.has(`${c.type}:${c.id}`)).map((c) => ({ ...c, origin: 'gear' as const }));
    const rows = (await this.deps.rows?.(puuid).catch(() => [] as AnalyticsRow[])) ?? [];
    const act = view.act;
    const queues = f.queues?.processed.length ? f.queues.processed : [...MASTERY_QUEUES];
    const history = f.acts
      .filter((a) => a.id !== act?.id && a.levels[agentId])
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((a) => ({ id: a.id, label: a.label, level: a.levels[agentId], lastSeenAt: a.lastSeenAt }));
    return {
      puuid,
      agent,
      act,
      actChanged: view.actChanged,
      syncedAt: view.syncedAt,
      source: view.source,
      history,
      rewards,
      cosmetics,
      ownershipAt: own?.at,
      stats: { slots, at: stats?.at, error: statsError, availability: statAvailability(agent.lifetimeLevel) },
      analytics: {
        sinceLaunch: agentAnalytics(rows, agentId, MASTERY_LAUNCH, Infinity, queues),
        thisAct: act ? agentAnalytics(rows, agentId, Math.max(act.start, MASTERY_LAUNCH), act.end, queues) : null,
        matchesCached: rows.filter((r) => r.t >= MASTERY_LAUNCH && queues.includes(r.queue)).length,
        queues,
      },
    };
  }

  /**
   * The saved copy only, never a request: for when there's no session (Riot Client closed, offline).
   * Throws when nothing was ever saved for that account.
   */
  async snapshot(puuid: string): Promise<MasteryView> {
    if (!ID.test(puuid)) throw new Error('bad account id');
    const f = await this.load(puuid);
    if (!f.current) throw new Error('Not signed in');
    return this.viewOf(puuid, f);
  }

  /** Drops cached copies (after a Vault restore wrote new files). */
  forget(): void {
    this.files.clear();
    this.live.clear();
    this.status.clear();
  }
}
