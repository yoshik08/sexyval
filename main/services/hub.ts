import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { FriendRequestView, FriendView, LeaderboardView, Lineup } from '../../shared/features';
import type { RiotApi } from '../riot/api';
import type { AssetService } from './assets';
import type { CatalogService } from './catalog';
import { assetUrl } from './assets';
import { readJson, writeJson } from '../paths';

/** Pure: decode the base64 "private" field of a Valorant presence (Presence.ts schema). */
export function decodePresence(priv: unknown): any | null {
  if (typeof priv !== 'string' || !priv) return null;
  try {
    return JSON.parse(Buffer.from(priv, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Pure: short human status from a decoded Valorant presence. */
export function presenceStatus(p: any): string | undefined {
  if (!p) return undefined;
  const loop = String(p.sessionLoopState ?? '');
  if (loop === 'INGAME') return `In game ${p.partyOwnerMatchScoreAllyTeam ?? 0}-${p.partyOwnerMatchScoreEnemyTeam ?? 0}`;
  if (loop === 'PREGAME') return 'Agent select';
  if (p.partyState === 'MATCHMAKING') return 'In queue';
  if (loop === 'MENUS') return p.isIdle ? 'Away' : 'In menus';
  return loop || undefined;
}

/**
 * Pure: one friend's status from all their chat presences. A friend can have several at once
 * (Valorant, Riot Client, League); the Valorant one wins. Anything that isn't Valorant only means
 * "online": the chat service reports Riot Client users under riot_client or even league_of_legends
 * when they aren't playing anything, so SexyVal never says "Playing …" for those.
 */
export function friendPresence(list: any[]): { online: boolean; state?: string; product?: string; status?: string; valorant: any | null } {
  const live = list.filter((x) => x && x.state !== 'offline');
  if (!live.length) return { online: false, valorant: null };
  const val = live.find((x) => x.product === 'valorant');
  const pick = val ?? live[0];
  const dec = val ? decodePresence(val.private) : null;
  const status = dec ? presenceStatus(dec) : val ? 'Online' : pick.state === 'mobile' ? 'On Riot Mobile' : pick.state === 'away' ? 'Away' : 'Online';
  return { online: true, state: pick.state, product: pick.product, status: status ?? 'Online', valorant: dec };
}

export class HubService {
  constructor(
    private readonly api: RiotApi,
    private readonly assets: AssetService,
    private readonly catalog: CatalogService,
    private readonly lineupFile: string,
    private readonly lineupDir: string,
  ) {}

  // ---- friends (local Riot Client chat API; needs the Riot Client) ----
  async friends(): Promise<{ friends: FriendView[]; requests: FriendRequestView[] }> {
    const [f, p, r] = await Promise.all([
      this.api.local('GET', '/chat/v4/friends', undefined, 'friends'),
      this.api.local('GET', '/chat/v4/presences', undefined, 'presences'),
      this.api.local('GET', '/chat/v4/friendrequests', undefined, 'friendRequests'),
    ]);
    const presences = new Map<string, any[]>();
    for (const x of Array.isArray(p.json?.presences) ? p.json.presences : []) if (x?.puuid) presences.set(x.puuid, [...(presences.get(x.puuid) ?? []), x]);
    const friends: FriendView[] = (Array.isArray(f.json?.friends) ? f.json.friends : []).map((x: any) => {
      const pr = friendPresence(presences.get(x.puuid) ?? []);
      const dec = pr.valorant;
      return {
        puuid: x.puuid,
        name: x.game_name ?? '',
        tag: x.game_tag ?? '',
        online: pr.online,
        state: pr.state,
        product: pr.product,
        status: pr.status,
        partySize: dec?.partySize,
        level: dec?.accountLevel,
        rank: dec?.competitiveTier ? this.assets.rank(dec.competitiveTier) : undefined,
        note: x.note || undefined,
        lastOnline: Number(x.last_online_ts) || undefined,
      };
    });
    friends.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    const requests: FriendRequestView[] = (Array.isArray(r.json?.requests) ? r.json.requests : []).map((x: any) => ({
      puuid: x.puuid,
      name: x.game_name ?? '',
      tag: x.game_tag ?? '',
      direction: x.subscription === 'pending_in' ? 'in' : 'out',
    }));
    return { friends, requests };
  }

  async sendFriendRequest(nameTag: string) {
    const m = /^(.+)#([^#]+)$/.exec(nameTag.trim());
    if (!m) throw new Error('Use Name#Tag');
    await this.api.local('POST', '/chat/v4/friendrequests', { game_name: m[1], game_tag: m[2] }, 'sendFriendRequest');
    return this.friends();
  }

  /** Documented: removes an outgoing friend request. */
  async cancelFriendRequest(puuid: string) {
    await this.api.local('DELETE', '/chat/v4/friendrequests', { puuid }, 'removeFriendRequest');
    return this.friends();
  }

  // ---- leaderboard ----
  async leaderboard(seasonId?: string, startIndex = 0): Promise<LeaderboardView> {
    const now = Date.now();
    const acts = this.catalog.browse.seasons.filter((s: any) => s.type === 'Act');
    const season = seasonId ? acts.find((s: any) => s.id === seasonId) : acts.find((s: any) => Date.parse(s.start) <= now && now < Date.parse(s.end));
    if (!season) return { status: 'error', error: 'No act found in the catalog', players: [] };
    try {
      const r = await this.api.leaderboard(season.id, startIndex, 50);
      const cards = this.catalog.catalog.cards;
      return {
        status: 'ready',
        seasonId: season.id,
        seasonName: season.title ?? season.name,
        region: this.api.session.region ?? undefined,
        total: Number(r.json?.totalPlayers) || undefined,
        players: (Array.isArray(r.json?.Players) ? r.json.Players : []).map((p: any) => ({
          rank: Number(p.leaderboardRank) || 0,
          name: p.IsAnonymized ? 'Secret Agent' : (p.gameName ?? ''),
          tag: p.IsAnonymized ? '' : (p.tagLine ?? ''),
          rr: Number(p.rankedRating) || 0,
          wins: Number(p.numberOfWins) || 0,
          tier: Number(p.competitiveTier) || 0,
          rankInfo: this.assets.rank(p.competitiveTier),
          anonymized: p.IsAnonymized === true,
          cardIcon: assetUrl(cards.find((c) => c.id === String(p.PlayerCardID ?? '').toLowerCase())?.icon),
        })),
      };
    } catch (e) {
      return { status: 'error', error: (e as Error).message, seasonId: season.id, seasonName: season.title ?? season.name, players: [] };
    }
  }

  acts() {
    return this.catalog.browse.seasons
      .filter((s: any) => s.type === 'Act' && Date.parse(s.start) <= Date.now())
      .sort((a: any, b: any) => Date.parse(b.start) - Date.parse(a.start))
      .map((s: any) => ({ id: s.id, name: s.title ?? s.name }));
  }

  // ---- lineups (local library; Riot provides none) ----
  lineups(): Promise<Lineup[]> {
    return readJson<Lineup[]>(this.lineupFile, []);
  }

  async saveLineup(l: Partial<Lineup> & { title: string }): Promise<Lineup[]> {
    const list = await this.lineups();
    const entry: Lineup = {
      id: l.id ?? crypto.randomUUID(),
      agentId: l.agentId,
      mapId: l.mapId,
      site: l.site,
      title: String(l.title).slice(0, 120),
      notes: l.notes?.slice(0, 4000),
      links: (l.links ?? []).filter((x) => /^https?:\/\//i.test(x)).slice(0, 20),
      images: (l.images ?? []).filter((x) => x.startsWith('svlocal://')).slice(0, 20),
      createdAt: l.createdAt ?? Date.now(),
    };
    const idx = list.findIndex((x) => x.id === entry.id);
    if (idx >= 0) list[idx] = entry;
    else list.unshift(entry);
    await writeJson(this.lineupFile, list);
    return list;
  }

  async deleteLineup(id: string): Promise<Lineup[]> {
    const list = await this.lineups();
    const gone = list.find((x) => x.id === id);
    for (const img of gone?.images ?? []) await fs.rm(path.join(this.lineupDir, path.basename(img)), { force: true }).catch(() => undefined);
    const next = list.filter((x) => x.id !== id);
    await writeJson(this.lineupFile, next);
    return next;
  }

  /** Copies a user-picked image into the lineup folder; returns its svlocal:// URL. */
  async importImage(src: string): Promise<string> {
    const ext = path.extname(src).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) throw new Error('Unsupported image type');
    const stat = await fs.stat(src);
    if (stat.size > 15 * 1024 * 1024) throw new Error('Image too large (15 MB max)');
    await fs.mkdir(this.lineupDir, { recursive: true });
    const name = `${crypto.randomUUID()}${ext}`;
    await fs.copyFile(src, path.join(this.lineupDir, name));
    return `svlocal://img/${name}`;
  }
}
