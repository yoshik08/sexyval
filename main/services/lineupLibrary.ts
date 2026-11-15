import path from 'node:path';
import { httpRequest } from '../riot/http';
import { readJson, writeJson } from '../paths';
import { log } from '../log';
import type { LibraryLineup, LineupLibraryView, LineupMapArt } from '../../shared/features';

/**
 * Community lineups from Blitz.gg. Blitz publishes each agent/map lineup list as static JSON (the same
 * files its own lineup pages load); SexyVal fetches one list when you open that agent + map, keeps it on
 * disk for a day, and always links back to Blitz. Nothing is crawled in bulk.
 */
const BASE = 'https://utils.iesdev.com/static/json/nexus/valorant';
const TTL = 24 * 60 * 60 * 1000;
export const BLITZ_PAGE = (agent: string, map: string) => `https://blitz.gg/valorant/lineups/${agent}/${map}`;

/** "KAY/O" -> "kayo", "Sunset" -> "sunset": Blitz's keys. */
export const blitzKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const blitzHost = (u?: string) => {
  if (!u) return undefined;
  try {
    const h = new URL(u).hostname;
    return h === 'blitz-cdn.blitz.gg' || h === 'blitz-cdn-videos.blitz.gg' ? u : undefined;
  } catch {
    return undefined;
  }
};

/** Pure: Blitz tips JSON -> lineups for one agent on one map (their `related` lists are other maps, ignored). */
export function parseTips(json: unknown, agent: string, map: string): LibraryLineup[] {
  const list: any[] = Array.isArray(json) ? json : json && typeof json === 'object' ? Object.values(json as object) : [];
  const out: LibraryLineup[] = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    if (str(t.agentKey) !== agent || str(t.mapKey) !== map) continue;
    const title = str(t.title)?.trim();
    if (!title) continue;
    out.push({
      id: String(t.id ?? title),
      title,
      description: str(t.description)?.trim(),
      ability: str(t.abilityKey),
      difficulty: str(t.difficulty),
      side: t.side === 'attacking' ? 'attack' : t.side === 'defending' ? 'defense' : undefined,
      video: blitzHost(str(t.video)),
      thumbnail: blitzHost(str(t.thumbnail)),
      x: num(t.locationX),
      y: num(t.locationY),
    });
  }
  return out;
}

export class LineupLibrary {
  private mem = new Map<string, { at: number; list: LibraryLineup[] }>();
  private maps: { at: number; art: Record<string, LineupMapArt> } | null = null;

  constructor(private readonly dir: string) {}

  private file(key: string) {
    return path.join(this.dir, `${key.replace(/[^a-z0-9-]/g, '')}.json`);
  }

  private async mapArt(): Promise<Record<string, LineupMapArt>> {
    if (this.maps && Date.now() - this.maps.at < TTL) return this.maps.art;
    const disk = await readJson<{ at: number; art: Record<string, LineupMapArt> } | null>(this.file('_maps'), null);
    if (disk && Date.now() - disk.at < TTL) return (this.maps = disk).art;
    try {
      const r = await httpRequest(`${BASE}/maps`, { timeoutMs: 15000 });
      const list: any[] = Array.isArray(r.json) ? r.json : Object.values(r.json ?? {});
      const art: Record<string, LineupMapArt> = {};
      for (const m of list) {
        const key = str(m?.key);
        if (!key) continue;
        art[key] = { layout: blitzHost(str(m.layoutImage)), attackRotation: num(m.attackingSideOrientation) ?? 0, defenseRotation: num(m.defendingSideOrientation) ?? 180 };
      }
      this.maps = { at: Date.now(), art };
      await writeJson(this.file('_maps'), this.maps).catch(() => undefined);
      return art;
    } catch (e) {
      log.warn('lineup maps failed', e);
      return disk?.art ?? {};
    }
  }

  /** Lineups for agent + map (display names). Cached a day; a failed refresh keeps the last copy. */
  async get(agentName: string, mapName: string, force = false): Promise<LineupLibraryView> {
    const agent = blitzKey(agentName);
    const map = blitzKey(mapName);
    const key = `${agent}-${map}`;
    const source = BLITZ_PAGE(agent, map);
    const art = (await this.mapArt())[map];
    const hit = this.mem.get(key) ?? (await readJson<{ at: number; list: LibraryLineup[] } | null>(this.file(key), null)) ?? undefined;
    if (hit && !force && Date.now() - hit.at < TTL) {
      this.mem.set(key, hit);
      return { status: 'ready', agent, map, lineups: hit.list, source, fetchedAt: hit.at, mapArt: art };
    }
    try {
      const r = await httpRequest(`${BASE}/tips/${key}`, { timeoutMs: 15000 });
      if (r.status === 404) {
        const e = { at: Date.now(), list: [] };
        this.mem.set(key, e);
        return { status: 'ready', agent, map, lineups: [], source, fetchedAt: e.at, mapArt: art };
      }
      if (r.status !== 200) throw new Error(`Blitz answered ${r.status}`);
      const e = { at: Date.now(), list: parseTips(r.json, agent, map) };
      this.mem.set(key, e);
      await writeJson(this.file(key), e).catch(() => undefined);
      return { status: 'ready', agent, map, lineups: e.list, source, fetchedAt: e.at, mapArt: art };
    } catch (err) {
      log.warn(`lineups ${key} failed`, err);
      if (hit) return { status: 'ready', agent, map, lineups: hit.list, source, fetchedAt: hit.at, stale: true, mapArt: art };
      return { status: 'error', agent, map, lineups: [], source, error: `Couldn’t reach Blitz.gg: ${(err as Error).message}`, mapArt: art };
    }
  }
}
