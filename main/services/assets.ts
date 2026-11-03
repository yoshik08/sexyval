import { httpRequest } from '../riot/http';
import { readJson, writeJson } from '../paths';
import { log } from '../log';
import type { AgentInfo, MapInfo, RankInfo } from '../../shared/types';
import path from 'node:path';

const BASE = 'https://valorant-api.com/v1';
const MAX_AGE = 24 * 60 * 60 * 1000;

interface SkinEntry {
  skinId?: string;
  name: string;
  icon?: string;
  tierId?: string;
}
interface TierEntry {
  name: string;
  icon?: string;
  color?: string;
}

interface Cached<T> {
  fetchedAt: number;
  data: T;
}

/** Encodes a remote image URL into our svasset:// protocol (cached to disk by main). */
export function assetUrl(url: string | null | undefined): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  return `svasset://img/${Buffer.from(url).toString('base64url')}`;
}

function hex(c: unknown): string | undefined {
  if (typeof c !== 'string' || !/^[0-9a-f]{6,8}$/i.test(c)) return undefined;
  return `#${c.slice(0, 6)}`;
}

/** Fetches valorant-api.com indexes at runtime, caches compact copies on disk. */
export class AssetService {
  private agents = new Map<string, AgentInfo>();
  private maps = new Map<string, MapInfo>();
  private skins = new Map<string, SkinEntry>();
  private tiers = new Map<string, TierEntry>();
  private ranks = new Map<number, RankInfo>();
  ready = false;

  constructor(private readonly dir: string) {}

  private async cached<T>(name: string, url: string, transform: (data: any) => T): Promise<T | null> {
    const file = path.join(this.dir, `${name}.json`);
    const disk = await readJson<Cached<T> | null>(file, null);
    if (disk && Date.now() - disk.fetchedAt < MAX_AGE) return disk.data;
    try {
      const r = await httpRequest(url, { timeoutMs: 20000 });
      if (r.status !== 200 || !r.json?.data) throw new Error(`status ${r.status}`);
      const data = transform(r.json.data);
      await writeJson(file, { fetchedAt: Date.now(), data });
      return data;
    } catch (e) {
      log.warn(`assets ${name} fetch failed${disk ? ', using stale cache' : ''}`, e);
      return disk?.data ?? null;
    }
  }

  async load(): Promise<void> {
    const [agents, maps, skins, tiers, ranks] = await Promise.all([
      this.cached('agents', `${BASE}/agents?isPlayableCharacter=true`, (d: any[]) =>
        d.map((a) => ({
          id: String(a.uuid).toLowerCase(),
          name: a.displayName,
          icon: a.displayIcon ?? undefined,
          portrait: a.fullPortrait ?? a.bustPortrait ?? undefined,
          role: a.role?.displayName ?? undefined,
        })),
      ),
      this.cached('maps', `${BASE}/maps`, (d: any[]) =>
        d.map((m) => ({ id: m.mapUrl, name: m.displayName, splash: m.splash ?? undefined, listIcon: m.listViewIcon ?? undefined })),
      ),
      this.cached('skins2', `${BASE}/weapons/skins`, (d: any[]) => {
        // Map every level UUID (store offers use level ids) to its parent skin.
        const out: [string, SkinEntry][] = [];
        for (const s of d) {
          const icon = s.levels?.[0]?.displayIcon ?? s.displayIcon ?? s.chromas?.[0]?.fullRender ?? undefined;
          const entry: SkinEntry = { skinId: String(s.uuid).toLowerCase(), name: s.displayName, icon, tierId: s.contentTierUuid?.toLowerCase() };
          out.push([String(s.uuid).toLowerCase(), entry]);
          for (const l of s.levels ?? []) out.push([String(l.uuid).toLowerCase(), entry]);
        }
        return out;
      }),
      this.cached('contenttiers', `${BASE}/contenttiers`, (d: any[]) =>
        d.map((t) => [String(t.uuid).toLowerCase(), { name: t.devName ?? t.displayName, icon: t.displayIcon, color: hex(t.highlightColor) }] as [string, TierEntry]),
      ),
      this.cached('competitivetiers', `${BASE}/competitivetiers`, (d: any[]) => {
        const last = d[d.length - 1];
        return (last?.tiers ?? []).map((t: any) => ({ tier: Number(t.tier), name: t.tierName, icon: t.smallIcon ?? undefined, color: hex(t.color) }));
      }),
    ]);
    for (const a of agents ?? []) this.agents.set(a.id, a);
    for (const m of maps ?? []) this.maps.set(m.id, m);
    for (const [k, v] of skins ?? []) this.skins.set(k, v);
    for (const [k, v] of tiers ?? []) this.tiers.set(k, v);
    for (const r of ranks ?? []) this.ranks.set(r.tier, r);
    this.ready = this.agents.size > 0;
    log.info(`assets: ${this.agents.size} agents, ${this.maps.size} maps, ${this.skins.size} skin ids, ${this.ranks.size} ranks`);
  }

  agent(id: string | null | undefined): AgentInfo | undefined {
    if (!id) return undefined;
    const a = this.agents.get(String(id).toLowerCase());
    if (!a) return { id, name: 'Unknown' };
    return { ...a, icon: assetUrl(a.icon), portrait: assetUrl(a.portrait) };
  }

  map(mapUrl: string | null | undefined): MapInfo | undefined {
    if (!mapUrl) return undefined;
    const m = this.maps.get(mapUrl);
    if (!m) {
      const name = mapUrl.split('/').filter(Boolean).pop() ?? mapUrl;
      return { id: mapUrl, name };
    }
    return { ...m, splash: assetUrl(m.splash), listIcon: assetUrl(m.listIcon) };
  }

  mapName(mapUrl: string | null | undefined): string | undefined {
    return this.map(mapUrl)?.name;
  }

  rank(tier: unknown): RankInfo | undefined {
    const t = Number(tier);
    if (!Number.isFinite(t)) return undefined;
    const r = this.ranks.get(t);
    if (!r) return t > 0 ? { tier: t, name: `Tier ${t}` } : undefined;
    return { ...r, icon: assetUrl(r.icon) };
  }

  skin(levelId: string | null | undefined): { skinId?: string; name: string; icon?: string; tier?: TierEntry } | undefined {
    if (!levelId) return undefined;
    const s = this.skins.get(String(levelId).toLowerCase());
    if (!s) return undefined;
    const tier = s.tierId ? this.tiers.get(s.tierId) : undefined;
    return { skinId: s.skinId, name: s.name, icon: assetUrl(s.icon), tier: tier ? { ...tier, icon: assetUrl(tier.icon) } : undefined };
  }
}
