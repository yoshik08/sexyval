import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pickHistoryIds, summarizeMatch, summarizePlayer, trimDetails, type RawMatchSummary, type TrimmedDetails } from '../../shared/last5';
import type { Last5State, MatchSummary, SvScore } from '../../shared/types';
import { svScore } from '../../shared/score';
import type { RiotApi } from '../riot/api';
import type { AssetService } from './assets';
import { readJson, writeJson } from '../paths';
import { log } from '../log';

const HISTORY_TTL = 10 * 60 * 1000;

interface Entry {
  status: Last5State['status'];
  fetchedAt: number;
  rows: RawMatchSummary[];
  error?: string;
}

/** Last-5 per player. History cached 10 min; match details cached forever on disk. */
export class HistoryService {
  private entries = new Map<string, Entry>();
  private details = new Map<string, TrimmedDetails>();
  private detailInflight = new Map<string, Promise<TrimmedDetails | null>>();
  private loadInflight = new Map<string, Promise<void>>();

  constructor(
    private readonly api: RiotApi,
    private readonly assets: AssetService,
    private readonly dir: string,
    private readonly onChange: () => void,
  ) {}

  get(puuid: string): Last5State {
    const e = this.entries.get(puuid);
    if (!e) return { status: 'idle', matches: [] };
    const matches = e.rows.map((r) => this.resolve(r));
    return {
      status: e.status,
      matches,
      summary: matches.length ? summarizePlayer(matches) : undefined,
      error: e.error,
    };
  }

  /** SV Score from the cached last 5 (null under 3 matches with round data). Hidden players never get here. */
  score(puuid: string): SvScore | null {
    const e = this.entries.get(puuid);
    return e ? svScore(e.rows) : null;
  }

  private resolve(r: RawMatchSummary): MatchSummary {
    return {
      matchId: r.matchId,
      startTime: r.startTime,
      result: r.result,
      agent: this.assets.agent(r.characterId),
      kills: r.kills,
      deaths: r.deaths,
      assists: r.assists,
      acs: r.acs,
      map: this.assets.mapName(r.mapId),
      queueTag: r.queueTag,
      score: r.score,
    };
  }

  /** Starts a load if not cached or stale. Safe to call every tick. */
  ensure(puuid: string, force = false): void {
    const e = this.entries.get(puuid);
    const fresh = e && e.status === 'done' && Date.now() - e.fetchedAt < HISTORY_TTL;
    if ((fresh && !force) || this.loadInflight.has(puuid)) return;
    if (e?.status === 'error' && Date.now() - e.fetchedAt < 30_000 && !force) return;
    const p = this.load(puuid).finally(() => this.loadInflight.delete(puuid));
    this.loadInflight.set(puuid, p);
  }

  invalidate(puuid: string): void {
    const e = this.entries.get(puuid);
    if (e) e.fetchedAt = 0;
  }

  private async load(puuid: string): Promise<void> {
    const prev = this.entries.get(puuid);
    const entry: Entry = { status: 'loading', fetchedAt: Date.now(), rows: prev?.rows ?? [] };
    this.entries.set(puuid, entry);
    this.onChange();
    try {
      const res = await this.api.history(puuid, 5);
      const ids = pickHistoryIds(res.json, 5);
      const rows: (RawMatchSummary | null)[] = ids.map(() => null);
      let failures = 0;
      await Promise.all(
        ids.map(async (id, i) => {
          try {
            const d = await this.getDetails(id);
            rows[i] = d ? summarizeMatch(d, puuid) : null;
          } catch (err) {
            failures++;
            log.warn(`details ${id.slice(0, 8)} failed`, err);
          }
          // Progressive render: publish what we have so far.
          entry.rows = rows.filter((r): r is RawMatchSummary => !!r);
          this.onChange();
        }),
      );
      entry.rows = rows.filter((r): r is RawMatchSummary => !!r);
      entry.status = failures && !entry.rows.length ? 'error' : 'done';
      if (failures) entry.error = `${failures} match(es) failed to load`;
      entry.fetchedAt = Date.now();
    } catch (err) {
      entry.status = 'error';
      entry.error = (err as Error).message;
      entry.fetchedAt = Date.now();
      log.warn(`history ${puuid.slice(0, 8)} failed`, err);
    }
    this.onChange();
  }

  private file(id: string): string {
    return path.join(this.dir, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.v2.json`);
  }

  /** Memory -> disk -> network. Returns null on 404 (e.g. match not finished). */
  async getDetails(id: string): Promise<TrimmedDetails | null> {
    const mem = this.details.get(id);
    if (mem) return mem;
    const inflight = this.detailInflight.get(id);
    if (inflight) return inflight;
    const p = (async () => {
      const disk = await readJson<TrimmedDetails | null>(this.file(id), null);
      if (disk && disk.matchId) {
        this.details.set(id, disk);
        return disk;
      }
      const res = await this.api.matchDetails(id);
      if (res.status === 404 || !res.json) return null;
      const t = trimDetails(res.json, id);
      this.details.set(id, t);
      await writeJson(this.file(id), t).catch((e) => log.warn('persist details failed', e));
      return t;
    })().finally(() => this.detailInflight.delete(id));
    this.detailInflight.set(id, p);
    return p;
  }

  async cacheSize(): Promise<number> {
    try {
      return (await fs.readdir(this.dir)).length;
    } catch {
      return 0;
    }
  }
}

/** Batches name lookups (PUT name-service) and caches forever in memory. */
export class NameService {
  private names = new Map<string, { name: string; tag: string }>();
  private queue = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private failed = new Map<string, number>();

  constructor(
    private readonly api: RiotApi,
    private readonly onChange: () => void,
  ) {}

  get(puuid: string): { name: string; tag: string } | undefined {
    return this.names.get(puuid);
  }

  /** Requests names and waits (bounded) until they arrive. */
  async waitFor(puuids: string[], timeoutMs = 2500): Promise<void> {
    this.request(puuids);
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && puuids.some((p) => !this.names.has(p) && Date.now() - (this.failed.get(p) ?? 0) > 30_000)) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  entries(): [string, { name: string; tag: string }][] {
    return [...this.names.entries()];
  }

  request(puuids: string[]): void {
    for (const p of puuids) {
      if (this.names.has(p)) continue;
      if (Date.now() - (this.failed.get(p) ?? 0) < 30_000) continue;
      this.queue.add(p);
    }
    if (this.queue.size && !this.timer) this.timer = setTimeout(() => void this.flush(), 120);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const batch = [...this.queue];
    this.queue.clear();
    if (!batch.length) return;
    try {
      const res = await this.api.names(batch);
      const list: any[] = Array.isArray(res.json) ? res.json : [];
      for (const n of list) {
        if (n && typeof n.Subject === 'string' && typeof n.GameName === 'string' && n.GameName) {
          this.names.set(n.Subject, { name: n.GameName, tag: String(n.TagLine ?? '') });
        }
      }
      this.onChange();
    } catch (e) {
      for (const p of batch) this.failed.set(p, Date.now());
      log.warn('name-service failed', e);
    }
  }
}
