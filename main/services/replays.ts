import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { buildReplay, type MapTransform, type ReplayData } from '../../shared/replay';
import type { ReplayListItem, ReplayView } from '../../shared/features';
import { pickHistoryIds, summarizeMatch } from '../../shared/last5';
import { queueTag } from '../../shared/queues';
import type { RiotApi } from '../riot/api';
import type { AssetService } from './assets';
import { assetUrl } from './assets';
import type { CatalogService } from './catalog';
import type { HistoryService, NameService } from './history';
import { readJson, writeJson } from '../paths';
import { log } from '../log';

/** Where Valorant saves downloaded replays (one <matchId>.vrf per match). */
export function demosDir(): string {
  return process.env.SEXYVAL_DEMOS_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'VALORANT', 'Saved', 'Demos');
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bump when ReplayData changes shape; older cached copies are rebuilt from the API. */
const CACHE_V = 1;

/**
 * Replays tab. Lists Valorant's local .vrf files (they only play inside the game: the format is Riot's own and
 * undocumented) next to your recent matches, and builds a 2D minimap replay for any of them from match
 * details: the positions Riot records at every kill, plant and defuse.
 */
export class ReplayService {
  private inflight = new Map<string, Promise<ReplayView>>();

  constructor(
    private readonly api: RiotApi,
    private readonly assets: AssetService,
    private readonly catalog: CatalogService,
    private readonly history: HistoryService,
    private readonly names: NameService,
    private readonly dir: string,
  ) {}

  private async localFiles(): Promise<Map<string, { size: number; savedAt: number; file: string }>> {
    const out = new Map<string, { size: number; savedAt: number; file: string }>();
    const dir = demosDir();
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return out;
    }
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.vrf')) continue;
      const id = n.slice(0, -4).toLowerCase();
      if (!ID.test(id)) continue;
      try {
        const st = await fs.stat(path.join(dir, n));
        out.set(id, { size: st.size, savedAt: st.mtimeMs, file: path.join(dir, n) });
      } catch {
        // deleted while listing
      }
    }
    return out;
  }

  /** Local replay files first, then your recent matches (all queues). */
  async list(): Promise<{ items: ReplayListItem[]; folder: string; folderFound: boolean }> {
    const local = await this.localFiles();
    const me = this.api.session.puuid;
    let recent: string[] = [];
    if (me) {
      try {
        recent = pickHistoryIds((await this.api.history(me, 15)).json, 15);
      } catch (e) {
        log.warn('replays: history failed', e);
      }
    }
    const ids = [...new Set([...local.keys(), ...recent.map((x) => x.toLowerCase())])];
    const items = await Promise.all(
      ids.map(async (id): Promise<ReplayListItem> => {
        const d = await this.history.getDetails(id, { cachedOnly: !recent.includes(id) }).catch(() => null);
        const s = d && me ? summarizeMatch(d, me) : null;
        const f = local.get(id);
        const map = this.assets.map(d?.mapId);
        return {
          matchId: id,
          startTime: d?.startTime || f?.savedAt || 0,
          mapName: map?.name,
          mapImage: map?.listIcon,
          queueTag: d ? queueTag(d.queueId) : undefined,
          agentIcon: s ? this.assets.agent(s.characterId)?.icon : undefined,
          result: s?.result,
          score: s?.score,
          kda: s ? `${s.kills}/${s.deaths}/${s.assists}` : undefined,
          file: f ? { size: f.size, savedAt: f.savedAt } : undefined,
        };
      }),
    );
    items.sort((a, b) => Number(!!b.file) - Number(!!a.file) || b.startTime - a.startTime);
    const folderFound = await fs.stat(demosDir()).then(
      (s) => s.isDirectory(),
      () => false,
    );
    return { items, folder: demosDir(), folderFound };
  }

  async filePath(matchId: string): Promise<string | null> {
    return (await this.localFiles()).get(matchId.toLowerCase())?.file ?? null;
  }

  private transform(mapId?: string): { tf?: MapTransform; map?: any } {
    const map = this.catalog.browse.maps.find((m: any) => m.id === mapId);
    return { tf: map?.transform, map };
  }

  get(matchId: string, force = false): Promise<ReplayView> {
    const id = matchId.toLowerCase();
    if (!ID.test(id)) return Promise.reject(new Error('Not a match id'));
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.load(id, force).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async load(id: string, force: boolean): Promise<ReplayView> {
    const file = path.join(this.dir, `${id}.json`);
    let data: ReplayData | null = null;
    if (!force) {
      const c = await readJson<{ v: number; data: ReplayData } | null>(file, null);
      if (c?.v === CACHE_V && c.data?.matchId) data = c.data;
    }
    if (!data) {
      const res = await this.api.matchDetails(id);
      if (res.status === 404 || !res.json) throw new Error('Riot has no details for this match (yet).');
      const mapId = res.json?.matchInfo?.mapId;
      const { tf } = this.transform(mapId);
      if (!tf) log.warn(`replays: no coordinate transform for ${mapId}`);
      data = buildReplay(res.json, tf);
      // Only cache a replay we could place on the map.
      if (tf) await writeJson(file, { v: CACHE_V, data }).catch((e) => log.warn('replay cache failed', e));
    }
    // Riot sends empty names in match details now: the name service has them.
    await this.names.waitFor(data.players.filter((p) => !p.name).map((p) => p.puuid), 3000);
    const { map } = this.transform(data.mapId);
    const weapons: ReplayView['weapons'] = {};
    for (const w of this.catalog.browse.weapons) weapons[w.id] = { name: w.name, icon: assetUrl(w.icon) };
    const abilities: ReplayView['abilities'] = {};
    for (const a of this.catalog.browse.agents) for (const ab of a.abilities ?? []) abilities[`${a.id}:${ab.slot}`] = { name: ab.name, icon: assetUrl(ab.icon) };
    const local = await this.filePath(id);
    return {
      ...data,
      players: data.players.map((p) => {
        const n = this.names.get(p.puuid);
        const ag = this.assets.agent(p.agentId);
        return { ...p, name: p.name ?? n?.name, tag: p.tag ?? n?.tag, agentName: ag?.name, agentIcon: ag?.icon };
      }),
      me: this.api.session.puuid ?? undefined,
      mapName: map?.name ?? this.assets.mapName(data.mapId),
      minimap: assetUrl(map?.icon),
      callouts: (map?.callouts ?? []) as ReplayView['callouts'],
      weapons,
      abilities,
      queueTag: queueTag(data.queueId),
      hasFile: !!local,
    };
  }
}
