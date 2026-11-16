import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readJson, writeJson } from '../paths';
import type { TrimmedDetails } from '../../shared/last5';
import type { CompUpdate } from '../../shared/mmr';
import { actOf, gapsOf, groupBy, joinUpdates, mergeRows, rankProgression, rowFromDetails, toCsv, WAREHOUSE_VERSION, type Act, type WarehouseFile, type WRow } from '../../shared/warehouse';
import { computeInsights } from '../../shared/insights';
import type { WarehouseView } from '../../shared/features';
import { log } from '../log';

const ID = /^[0-9a-f-]{36}$/i;
/** Files read per slice before yielding to the event loop (keeps the UI and live polling responsive). */
const SLICE = 40;

/**
 * Lifetime warehouse (Feature 9): warehouse/<puuid>.json per account, built incrementally from the match
 * cache and the stored competitive updates. A JSON file per account is enough at this size (a few thousand
 * rows, well under 2 MB, loaded once per account): SQLite would add a native dependency for no measured
 * gain. Both sources are kept by the Vault, so the warehouse can always be rebuilt from a restore.
 */
export class WarehouseService {
  private files = new Map<string, WarehouseFile>();
  private running = new Map<string, Promise<WarehouseFile>>();

  constructor(
    private readonly matchesDir: string,
    private readonly updatesDir: string,
    private readonly outDir: string,
    private readonly deps: {
      acts: () => Act[];
      mapName: (id?: string) => string | undefined;
      agentName: (id?: string) => string | undefined;
      /** Lightweight mode: background ingestion waits (explicit requests still run). */
      paused?: () => boolean;
    },
  ) {}

  private file(puuid: string): string {
    return path.join(this.outDir, `${puuid}.json`);
  }

  private async load(puuid: string): Promise<WarehouseFile> {
    const hit = this.files.get(puuid);
    if (hit) return hit;
    const raw = await readJson<Partial<WarehouseFile>>(this.file(puuid), {});
    const f: WarehouseFile = raw.version === WAREHOUSE_VERSION && raw.puuid === puuid && Array.isArray(raw.rows) ? { version: WAREHOUSE_VERSION, puuid, rows: raw.rows, checked: Array.isArray(raw.checked) ? raw.checked : [], updatedAt: raw.updatedAt ?? 0 } : { version: WAREHOUSE_VERSION, puuid, rows: [], checked: [], updatedAt: 0 };
    this.files.set(puuid, f);
    return f;
  }

  private async updates(puuid: string): Promise<CompUpdate[]> {
    const s = await readJson<{ updates?: CompUpdate[] }>(path.join(this.updatesDir, `${puuid}.json`), {});
    return Array.isArray(s.updates) ? s.updates : [];
  }

  /** Reads only match files not seen before for this account. Background calls respect lightweight mode. */
  ingest(puuid: string, background = false): Promise<WarehouseFile> {
    if (!ID.test(puuid)) return Promise.reject(new Error('bad account id'));
    const run = this.running.get(puuid);
    if (run) return run;
    if (background && this.deps.paused?.()) return this.load(puuid);
    const p = this.doIngest(puuid).finally(() => this.running.delete(puuid));
    this.running.set(puuid, p);
    return p;
  }

  private async doIngest(puuid: string): Promise<WarehouseFile> {
    const f = await this.load(puuid);
    let names: string[] = [];
    try {
      names = (await fs.readdir(this.matchesDir)).filter((n) => n.endsWith('.v2.json'));
    } catch {
      // no match cache yet
    }
    const known = new Set([...f.rows.map((r) => r.matchId), ...f.checked]);
    const todo = names.filter((n) => !known.has(n.slice(0, -'.v2.json'.length)));
    const rows: WRow[] = [];
    const checked: string[] = [];
    for (let i = 0; i < todo.length; i++) {
      if (i && i % SLICE === 0) await new Promise((r) => setImmediate(r));
      const id = todo[i].slice(0, -'.v2.json'.length);
      try {
        const d = JSON.parse(await fs.readFile(path.join(this.matchesDir, todo[i]), 'utf8')) as TrimmedDetails;
        const row = rowFromDetails(d, puuid);
        if (row) rows.push(row);
        else checked.push(id);
      } catch {
        // unreadable cache file: try again next time (not marked checked)
      }
    }
    const updates = await this.updates(puuid);
    const rrBefore = f.rows.filter((r) => r.rr != null).length;
    const merged = mergeRows(f.rows, rows);
    joinUpdates(merged, updates);
    const acts = this.deps.acts();
    for (const r of merged) if (!r.act) r.act = actOf(r.t, acts)?.id;
    const changed = rows.length > 0 || checked.length > 0 || merged.filter((r) => r.rr != null).length !== rrBefore;
    f.rows = merged;
    f.checked = [...f.checked, ...checked];
    if (changed) {
      f.updatedAt = Date.now();
      await writeJson(this.file(puuid), f).catch((e) => log.warn('warehouse save failed', e));
      log.info(`warehouse: +${rows.length} match(es) for this account, ${merged.length} total`);
    }
    return f;
  }

  async view(puuid: string, queue = 'competitive'): Promise<WarehouseView> {
    const f = await this.ingest(puuid);
    const updates = await this.updates(puuid);
    const acts = this.deps.acts();
    const rows = queue === 'all' ? f.rows : f.rows.filter((r) => r.queue === queue);
    const actLabel = new Map(acts.map((a) => [a.id, a.label]));
    const months = groupBy(rows, (r) => new Date(r.t).toISOString().slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key));
    return {
      puuid,
      queue,
      total: f.rows.length,
      matches: rows.length,
      first: rows.length ? rows[rows.length - 1].t : undefined,
      last: rows.length ? rows[0].t : undefined,
      updatedAt: f.updatedAt,
      gaps: gapsOf(f.rows, updates),
      rank: rankProgression(updates),
      maps: groupBy(rows, (r) => r.map).map((g) => ({ ...g, label: this.deps.mapName(g.key) ?? 'Unknown map' })),
      agents: groupBy(rows, (r) => r.agent).map((g) => ({ ...g, label: this.deps.agentName(g.key) ?? 'Unknown agent' })),
      acts: groupBy(rows, (r) => r.act)
        .map((g) => ({ ...g, label: actLabel.get(g.key) ?? 'Unknown act' }))
        .sort((a, b) => (acts.find((x) => x.id === b.key)?.start ?? 0) - (acts.find((x) => x.id === a.key)?.start ?? 0)),
      months,
      insights: computeInsights(rows, { mapName: this.deps.mapName, agentName: this.deps.agentName }),
    };
  }

  async export(puuid: string, format: 'csv' | 'json'): Promise<string> {
    const f = await this.ingest(puuid);
    if (format === 'json') return JSON.stringify({ app: 'SexyVal', kind: 'lifetime-history', exportedAt: new Date().toISOString(), puuid, rows: f.rows }, null, 1);
    return toCsv(f.rows, { map: this.deps.mapName, agent: this.deps.agentName });
  }

  /** Account removed or vault restored: drop the in-memory copy (the file stays, rebuilt on demand). */
  forget(puuid?: string): void {
    if (puuid) this.files.delete(puuid);
    else this.files.clear();
  }
}
