import type { MatchDetailView, MatchRow, ProfileView, ScoreboardRow } from '../../shared/features';
import { summarizeMatch, pickHistoryIds, type TrimmedDetails } from '../../shared/last5';
import { queueTag } from '../../shared/queues';
import { peakTier, seasonRank } from '../../shared/stats';
import type { RiotApi } from '../riot/api';
import type { AssetService } from './assets';
import type { CatalogService } from './catalog';
import type { HistoryService, NameService } from './history';
import { assetUrl } from './assets';
import { log } from '../log';

/** Profiles, match history with RR impact, full scoreboards. */
export class ProfileService {
  private nameIndex = new Map<string, string>(); // "name#tag" lowercased -> puuid

  constructor(
    private readonly api: RiotApi,
    private readonly assets: AssetService,
    private readonly catalog: CatalogService,
    private readonly history: HistoryService,
    private readonly names: NameService,
  ) {}

  private remember(puuid: string, name?: string, tag?: string): void {
    if (puuid && name) this.nameIndex.set(`${name}#${tag ?? ''}`.toLowerCase(), puuid);
  }

  private currentActId(): string | undefined {
    const now = Date.now();
    return this.catalog.browse.seasons.find((s: any) => s.type === 'Act' && Date.parse(s.start) <= now && now < Date.parse(s.end))?.id;
  }

  /**
   * Name#Tag -> PUUID. Riot documents no direct lookup, so this checks players SexyVal has seen
   * (name-service results, match scoreboards) and the ranked leaderboard search.
   */
  async resolve(query: string): Promise<string> {
    const q = query.trim();
    if (/^[0-9a-f-]{36}$/i.test(q)) return q.toLowerCase();
    const m = /^(.+)#([^#]+)$/.exec(q);
    if (!m) throw new Error('Use Name#Tag');
    for (const [puuid, n] of this.names.entries()) this.remember(puuid, n.name, n.tag);
    const hit = this.nameIndex.get(q.toLowerCase());
    if (hit) return hit;
    // Friends list from the Riot Client's local chat API (only reachable while the client runs).
    try {
      const f = await this.api.local('GET', '/chat/v4/friends', undefined, 'friends');
      for (const x of Array.isArray(f.json?.friends) ? f.json.friends : []) if (x?.puuid) this.remember(x.puuid, x.game_name, x.game_tag);
      const friend = this.nameIndex.get(q.toLowerCase());
      if (friend) return friend;
    } catch {
      // Riot Client not running: fall through to the leaderboard search.
    }
    const act = this.currentActId();
    if (act) {
      try {
        const lb = await this.api.leaderboard(act, 0, 10, m[1]);
        const p = (lb.json?.Players ?? []).find((x: any) => `${x.gameName}#${x.tagLine}`.toLowerCase() === q.toLowerCase());
        if (p?.puuid) return p.puuid;
      } catch (e) {
        log.warn('leaderboard search failed', e);
      }
    }
    throw new Error(`Can't find ${q}. Riot has no documented Name#Tag lookup; SexyVal finds players you've played with or who are on the leaderboard.`);
  }

  private row(d: TrimmedDetails, puuid: string, rr?: { delta: number; tier: number }): MatchRow | null {
    const s = summarizeMatch(d, puuid);
    if (!s) return null;
    const p = d.players.find((x) => x.subject === puuid);
    const agent = this.assets.agent(s.characterId);
    return {
      matchId: s.matchId,
      startTime: s.startTime,
      queueId: s.queueId ?? '',
      queueTag: s.queueTag,
      mapId: s.mapId,
      mapName: this.assets.mapName(s.mapId),
      agentId: s.characterId,
      agentName: agent?.name,
      agentIcon: agent?.icon,
      result: s.result,
      score: s.score,
      kills: s.kills,
      deaths: s.deaths,
      assists: s.assists,
      acs: s.acs,
      adr: p?.adr ?? null,
      hsPct: p?.hsPct ?? null,
      rrChange: rr?.delta,
      tierAfter: rr?.tier,
    };
  }

  async profile(query: string, opts: { count?: number; queue?: string } = {}): Promise<ProfileView> {
    const puuid = await this.resolve(query);
    const me = this.api.session.puuid;
    const view: ProfileView = { status: 'ready', puuid, isMe: puuid === me, rrHistory: [], matches: [], matchesLoading: false };
    const namesReady = this.names.waitFor([puuid]);
    const [mmr, comp, hist, loadout] = await Promise.all([
      this.api.mmr(puuid).catch((e) => (log.warn('mmr failed', e), null)),
      this.api.competitiveUpdates(puuid, 20).catch((e) => (log.warn('competitive updates failed', e), null)),
      this.api.history(puuid, opts.count ?? 15, 0, opts.queue || undefined).catch((e) => (log.warn('history failed', e), null)),
      puuid === me ? this.api.loadout().catch(() => null) : Promise.resolve(null),
    ]);
    const act = this.currentActId();
    const sr = seasonRank(mmr?.json, act);
    view.rank = this.assets.rank(sr.tier);
    view.rr = sr.rr;
    view.peak = this.assets.rank(peakTier(mmr?.json));
    view.leaderboardRank = sr.leaderboardRank || undefined;
    const updates: any[] = Array.isArray(comp?.json?.Matches) ? comp.json.Matches : [];
    const rrBy = new Map(updates.map((u) => [u.MatchID, { delta: Number(u.RankedRatingEarned) || 0, tier: Number(u.TierAfterUpdate) || 0 }]));
    view.rrHistory = updates
      .map((u) => ({ t: Number(u.MatchStartTime) || 0, tier: Number(u.TierAfterUpdate) || 0, rr: Number(u.RankedRatingAfterUpdate) || 0, delta: Number(u.RankedRatingEarned) || 0, matchId: u.MatchID }))
      .sort((a, b) => a.t - b.t);

    const ids = pickHistoryIds(hist?.json, opts.count ?? 15);
    const details = await Promise.all(ids.map((id) => this.history.getDetails(id).catch(() => null)));
    for (const d of details) {
      if (!d) continue;
      for (const p of d.players) this.remember(p.subject, p.gameName, p.tagLine);
      const r = this.row(d, puuid, rrBy.get(d.matchId));
      if (r) view.matches.push(r);
    }
    view.matches.sort((a, b) => b.startTime - a.startTime);

    // Identity: own loadout, or the most recent scoreboard entry for others.
    const latest = details.filter(Boolean).sort((a, b) => b!.startTime - a!.startTime)[0];
    const pl = latest?.players.find((p) => p.subject === puuid);
    const cardId = loadout?.json?.Identity?.PlayerCardID ?? pl?.cardId;
    const titleId = loadout?.json?.Identity?.PlayerTitleID ?? pl?.titleId;
    view.level = Number(loadout?.json?.Identity?.AccountLevel) || pl?.level;
    const card = this.catalog.catalog.cards.find((c) => c.id === String(cardId ?? '').toLowerCase());
    view.cardId = cardId;
    view.cardWide = assetUrl(card?.wide);
    view.title = this.catalog.catalog.titles.find((t) => t.id === String(titleId ?? '').toLowerCase())?.text;
    await namesReady;
    const n = this.names.get(puuid);
    view.name = n?.name ?? pl?.gameName;
    view.tag = n?.tag ?? pl?.tagLine;
    this.remember(puuid, view.name, view.tag);
    return view;
  }

  async matchDetail(matchId: string): Promise<MatchDetailView> {
    const d = await this.history.getDetails(matchId);
    if (!d) throw new Error('Match details not available yet');
    const rows: ScoreboardRow[] = d.players.map((p) => {
      const agent = this.assets.agent(p.characterId);
      this.remember(p.subject, p.gameName, p.tagLine);
      return {
        puuid: p.subject,
        name: p.gameName,
        tag: p.tagLine,
        teamId: p.teamId,
        agentId: p.characterId,
        agentName: agent?.name,
        agentIcon: agent?.icon,
        tier: p.tier ?? 0,
        rank: this.assets.rank(p.tier),
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        acs: p.roundsPlayed ? Math.round(p.score / p.roundsPlayed) : 0,
        adr: p.adr ?? null,
        hsPct: p.hsPct ?? null,
        firstBloods: p.firstBloods ?? null,
        avgLoadout: p.avgLoadout ?? null,
        avgSpent: p.avgSpent ?? null,
      };
    });
    rows.sort((a, b) => a.teamId.localeCompare(b.teamId) || b.acs - a.acs);
    return {
      matchId,
      mapName: this.assets.mapName(d.mapId),
      queueTag: queueTag(d.queueId),
      startTime: d.startTime,
      lengthMs: d.lengthMs,
      teams: d.teams,
      rows,
      rounds: d.roundResults.map((r) => ({ n: r.roundNum, winner: r.winningTeam })),
    };
  }
}
