import type { MatchResult, PlayerSummary } from './types';
import { queueTag } from './queues';

/** Trimmed match-details we persist forever (no round-by-round economy etc). */
export interface TrimmedDetails {
  matchId: string;
  mapId?: string;
  queueId?: string;
  gameMode?: string;
  startTime: number;
  lengthMs?: number;
  players: {
    subject: string;
    teamId: string;
    characterId?: string;
    score: number;
    roundsPlayed: number;
    kills: number;
    deaths: number;
    assists: number;
    gameName?: string;
    tagLine?: string;
    tier?: number;
    cardId?: string;
    titleId?: string;
    level?: number;
    /** Party the player queued with (match-details players[].partyId); absent in details cached before 1.3. */
    partyId?: string;
    /** Derived from roundResults[].playerStats; null when the match has no round data. */
    adr?: number | null;
    hsPct?: number | null;
    firstBloods?: number | null;
    avgLoadout?: number | null;
    avgSpent?: number | null;
  }[];
  teams: { teamId: string; won: boolean; roundsWon: number }[];
  roundResults: { roundNum: number; winningTeam?: string; bombPlanter?: string }[];
  /** 1.4+: whether Riot's details carried partyId. Undefined = cached by an older version that didn't keep it. */
  partyData?: boolean;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

interface Adv {
  dmg: number;
  head: number;
  shots: number;
  fb: number;
  loadout: number;
  spent: number;
  econRounds: number;
}

/** Per-player damage, headshots, first bloods and economy from round data. */
function advancedStats(rounds: any[]): Map<string, Adv> {
  const m = new Map<string, Adv>();
  const get = (p: string) => {
    let a = m.get(p);
    if (!a) m.set(p, (a = { dmg: 0, head: 0, shots: 0, fb: 0, loadout: 0, spent: 0, econRounds: 0 }));
    return a;
  };
  for (const r of rounds) {
    const stats: any[] = Array.isArray(r?.playerStats) ? r.playerStats : [];
    let first: { killer: string; t: number } | null = null;
    for (const ps of stats) {
      if (typeof ps?.subject !== 'string') continue;
      const a = get(ps.subject);
      for (const d of Array.isArray(ps.damage) ? ps.damage : []) {
        a.dmg += num(d?.damage);
        a.head += num(d?.headshots);
        a.shots += num(d?.headshots) + num(d?.bodyshots) + num(d?.legshots);
      }
      if (ps.economy && typeof ps.economy === 'object') {
        a.loadout += num(ps.economy.loadoutValue);
        a.spent += num(ps.economy.spent);
        a.econRounds++;
      }
      for (const k of Array.isArray(ps.kills) ? ps.kills : []) {
        const t = num(k?.roundTime);
        if (typeof k?.killer === 'string' && (!first || t < first.t)) first = { killer: k.killer, t };
      }
    }
    if (first) get(first.killer).fb++;
  }
  return m;
}

export function trimDetails(raw: any, fallbackId?: string): TrimmedDetails {
  const info = raw?.matchInfo ?? {};
  const players: any[] = Array.isArray(raw?.players) ? raw.players : [];
  const teams: any[] = Array.isArray(raw?.teams) ? raw.teams : [];
  const rounds: any[] = Array.isArray(raw?.roundResults) ? raw.roundResults : [];
  const adv = advancedStats(rounds);
  const hasRounds = rounds.some((r) => Array.isArray(r?.playerStats) && r.playerStats.length);
  return {
    matchId: String(info.matchId ?? fallbackId ?? ''),
    mapId: info.mapId ?? undefined,
    queueId: info.queueID ?? info.queueId ?? undefined,
    gameMode: info.gameMode ?? undefined,
    startTime: num(info.gameStartMillis),
    lengthMs: info.gameLengthMillis != null ? num(info.gameLengthMillis) : undefined,
    players: players
      .filter((p) => p && typeof p.subject === 'string')
      .map((p) => ({
        subject: p.subject,
        teamId: String(p.teamId ?? ''),
        characterId: p.characterId ?? undefined,
        score: num(p.stats?.score),
        roundsPlayed: num(p.stats?.roundsPlayed),
        kills: num(p.stats?.kills),
        deaths: num(p.stats?.deaths),
        assists: num(p.stats?.assists),
        gameName: typeof p.gameName === 'string' ? p.gameName : undefined,
        tagLine: typeof p.tagLine === 'string' ? p.tagLine : undefined,
        tier: p.competitiveTier != null ? num(p.competitiveTier) : undefined,
        cardId: typeof p.playerCard === 'string' ? p.playerCard : undefined,
        titleId: typeof p.playerTitle === 'string' ? p.playerTitle : undefined,
        level: p.accountLevel != null ? num(p.accountLevel) : undefined,
        partyId: typeof p.partyId === 'string' && p.partyId ? p.partyId : undefined,
        ...(() => {
          const a = adv.get(p.subject);
          const rp = num(p.stats?.roundsPlayed);
          if (!hasRounds) return { adr: null, hsPct: null, firstBloods: null, avgLoadout: null, avgSpent: null };
          if (!a) return { adr: null, hsPct: null, firstBloods: 0, avgLoadout: null, avgSpent: null };
          return {
            adr: rp > 0 ? Math.round(a.dmg / rp) : null,
            hsPct: a.shots > 0 ? Math.round((a.head / a.shots) * 100) : null,
            firstBloods: a.fb,
            avgLoadout: a.econRounds ? Math.round(a.loadout / a.econRounds) : null,
            avgSpent: a.econRounds ? Math.round(a.spent / a.econRounds) : null,
          };
        })(),
      })),
    teams: teams
      .filter((t) => t && t.teamId != null)
      .map((t) => ({ teamId: String(t.teamId), won: t.won === true, roundsWon: num(t.roundsWon) })),
    roundResults: rounds.map((r) => ({
      roundNum: num(r?.roundNum),
      winningTeam: r?.winningTeam ?? undefined,
      bombPlanter: r?.bombPlanter ?? undefined,
    })),
    partyData: players.some((p) => typeof p?.partyId === 'string' && p.partyId),
  };
}

/** Cached by a version that trimmed partyId away (before 1.3): a team match with no party data and no flag. */
export function lacksPartyData(d: TrimmedDetails): boolean {
  return d.partyData === undefined && d.teams.length === 2 && d.players.length > 2 && !d.players.some((p) => p.partyId);
}

/** Match row before asset resolution. */
export interface RawMatchSummary {
  matchId: string;
  startTime: number;
  result: MatchResult;
  characterId?: string;
  kills: number;
  deaths: number;
  assists: number;
  acs: number;
  mapId?: string;
  queueId?: string;
  queueTag: string;
  score: string;
  /** For SV Score (shared/score.ts). adr/firstBloods are null when the match has no round data. */
  rounds?: number;
  adr?: number | null;
  hsPct?: number | null;
  firstBloods?: number | null;
}

/** Extracts one player's line from a match. Returns null if they aren't in it. */
export function summarizeMatch(d: TrimmedDetails, puuid: string): RawMatchSummary | null {
  const p = d.players.find((x) => x.subject === puuid);
  if (!p) return null;
  const isTeamMode = p.teamId === 'Blue' || p.teamId === 'Red';
  const mine = isTeamMode ? d.teams.find((t) => t.teamId === p.teamId) : undefined;
  const other = isTeamMode ? d.teams.find((t) => t.teamId !== p.teamId) : undefined;
  let result: MatchResult = '-';
  if (mine) {
    if (mine.won) result = 'W';
    else if (other?.won) result = 'L';
    else if (other && mine.roundsWon === other.roundsWon) result = 'D';
    else result = 'L';
  }
  const score = mine && other ? `${mine.roundsWon}-${other.roundsWon}` : '-';
  return {
    matchId: d.matchId,
    startTime: d.startTime,
    result,
    characterId: p.characterId,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    acs: p.roundsPlayed > 0 ? Math.round(p.score / p.roundsPlayed) : 0,
    mapId: d.mapId,
    queueId: d.queueId,
    queueTag: queueTag(d.queueId),
    score,
    rounds: p.roundsPlayed,
    adr: p.adr ?? null,
    hsPct: p.hsPct ?? null,
    firstBloods: p.firstBloods ?? null,
  };
}

export function summarizePlayer(rows: { result: MatchResult; kills: number; deaths: number; acs: number }[]): PlayerSummary {
  const wins = rows.filter((r) => r.result === 'W').length;
  const losses = rows.filter((r) => r.result === 'L').length;
  const kills = rows.reduce((a, r) => a + r.kills, 0);
  const deaths = rows.reduce((a, r) => a + r.deaths, 0);
  const acs = rows.length ? Math.round(rows.reduce((a, r) => a + r.acs, 0) / rows.length) : 0;
  const kd = deaths > 0 ? Math.round((kills / deaths) * 100) / 100 : kills;
  return { count: rows.length, wins, losses, kd, acs };
}

/** History list -> sorted unique match ids (newest first), max n. */
export function pickHistoryIds(history: any, n = 5): string[] {
  const list: any[] = Array.isArray(history?.History) ? history.History : [];
  const seen = new Set<string>();
  return list
    .filter((h) => h && typeof h.MatchID === 'string')
    .sort((a, b) => Number(b.GameStartTime ?? 0) - Number(a.GameStartTime ?? 0))
    .map((h) => h.MatchID as string)
    .filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
    .slice(0, n);
}
