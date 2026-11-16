// Lifetime warehouse: one compact row per match per account, built from the on-disk match-details cache
// (matches/<id>.v2.json) and the stored competitive updates (mmr-updates/<puuid>.json). Pure: the service
// (main/services/warehouse.ts) does the files. Rows are keyed by Riot's matchId, so re-ingesting is a no-op.
import type { TrimmedDetails } from './last5';
import type { CompUpdate } from './mmr';

export const WAREHOUSE_VERSION = 1;

export interface WRow {
  matchId: string;
  /** Match start, ms. */
  t: number;
  queue: string;
  map?: string;
  agent?: string;
  result: 'W' | 'L' | 'D' | '-';
  /** Rounds won / lost by your team (0/0 outside team modes). */
  rw: number;
  rl: number;
  rounds: number;
  k: number;
  d: number;
  a: number;
  /** 0 outside round-based modes. */
  acs: number;
  adr: number | null;
  hs: number | null;
  /** First kills / first deaths (opening duels). fd is null for matches cached before 1.7. */
  fk: number | null;
  fd: number | null;
  /** [rounds won, rounds played] on each side; absent when sides aren't known (non-standard modes). */
  atk?: [number, number];
  def?: [number, number];
  lengthMs?: number;
  /** Your rank in that match (match details), when Riot sent it. */
  tier?: number;
  /** From competitive updates: RR earned, rank after, act. */
  rr?: number;
  tierAfter?: number;
  rrAfter?: number;
  act?: string;
}

export interface WarehouseFile {
  version: number;
  puuid: string;
  rows: WRow[];
  /** Match ids looked at that this account isn't in (never re-read). */
  checked: string[];
  updatedAt: number;
}

/** Halves of 12 rounds, Red attacks first (shared/side.ts), overtime swaps every round. */
const SIDE_QUEUES = new Set(['competitive', 'unrated', 'premier']);

export function sideOfRound(teamId: string, roundNum: number): 'atk' | 'def' | null {
  const red = teamId === 'Red';
  if (teamId !== 'Red' && teamId !== 'Blue') return null;
  let redAttacks: boolean;
  if (roundNum < 12) redAttacks = true;
  else if (roundNum < 24) redAttacks = false;
  else redAttacks = (roundNum - 24) % 2 === 0;
  return red === redAttacks ? 'atk' : 'def';
}

export function rowFromDetails(d: TrimmedDetails, puuid: string): WRow | null {
  const p = d.players?.find((x) => x.subject === puuid);
  if (!p || !d.matchId) return null;
  const teamMode = p.teamId === 'Blue' || p.teamId === 'Red';
  const mine = teamMode ? d.teams.find((t) => t.teamId === p.teamId) : undefined;
  const other = teamMode ? d.teams.find((t) => t.teamId !== p.teamId) : undefined;
  let result: WRow['result'] = '-';
  if (mine && other) result = mine.won ? 'W' : other.won ? 'L' : mine.roundsWon === other.roundsWon ? 'D' : 'L';
  const roundBased = p.roundsPlayed >= 3;
  const queue = String(d.queueId ?? '').toLowerCase();
  const row: WRow = {
    matchId: d.matchId,
    t: d.startTime,
    queue,
    map: d.mapId,
    agent: p.characterId,
    result,
    rw: mine?.roundsWon ?? 0,
    rl: other?.roundsWon ?? 0,
    rounds: roundBased ? p.roundsPlayed : 0,
    k: p.kills,
    d: p.deaths,
    a: p.assists,
    acs: roundBased ? Math.round(p.score / p.roundsPlayed) : 0,
    adr: p.adr ?? null,
    hs: p.hsPct ?? null,
    fk: p.firstBloods ?? null,
    fd: p.firstDeaths ?? null,
    lengthMs: d.lengthMs,
    tier: p.tier,
  };
  if (teamMode && SIDE_QUEUES.has(queue) && d.roundResults?.length) {
    const atk: [number, number] = [0, 0];
    const def: [number, number] = [0, 0];
    for (const r of d.roundResults) {
      const side = sideOfRound(p.teamId, r.roundNum);
      if (!side || !r.winningTeam) continue;
      const won = r.winningTeam === p.teamId ? 1 : 0;
      const tally = side === 'atk' ? atk : def;
      tally[0] += won;
      tally[1]++;
    }
    if (atk[1] + def[1] > 0) {
      row.atk = atk;
      row.def = def;
    }
  }
  return row;
}

/** Adds RR/rank/act from competitive updates (by matchId). */
export function joinUpdates(rows: WRow[], updates: CompUpdate[]): void {
  const by = new Map(updates.map((u) => [u.matchId, u]));
  for (const r of rows) {
    const u = by.get(r.matchId);
    if (!u) continue;
    r.rr = u.rrEarned;
    r.tierAfter = u.tierAfter;
    r.rrAfter = u.rrAfter;
    r.act = u.seasonId || r.act;
  }
}

/** Dedup by matchId (the newer row wins), newest first. */
export function mergeRows(existing: WRow[], incoming: WRow[]): WRow[] {
  const by = new Map(existing.map((r) => [r.matchId, r]));
  for (const r of incoming) by.set(r.matchId, { ...by.get(r.matchId), ...r });
  return [...by.values()].sort((a, b) => b.t - a.t);
}

export interface Act {
  id: string;
  label: string;
  start: number;
  end: number;
}

export function actOf(t: number, acts: Act[]): Act | undefined {
  return acts.find((a) => a.start <= t && t < a.end);
}

export interface RankPoint {
  t: number;
  tier: number;
  rr: number;
  delta: number;
  matchId: string;
}

/** From competitive updates (all stored, not only matches with details), oldest first. */
export function rankProgression(updates: CompUpdate[]): RankPoint[] {
  return [...updates]
    .filter((u) => u.tierAfter > 0)
    .sort((a, b) => a.startTime - b.startTime)
    .map((u) => ({ t: u.startTime, tier: u.tierAfter, rr: u.rrAfter, delta: u.rrEarned, matchId: u.matchId }));
}

export interface GroupStat {
  key: string;
  label?: string;
  games: number;
  wins: number;
  losses: number;
  kd: number;
  acs: number;
  rr: number;
  atk?: [number, number];
  def?: [number, number];
}

export function groupBy(rows: WRow[], key: (r: WRow) => string | undefined): GroupStat[] {
  const m = new Map<string, WRow[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  return [...m.entries()]
    .map(([k, rs]) => {
      const kills = rs.reduce((s, r) => s + r.k, 0);
      const deaths = rs.reduce((s, r) => s + r.d, 0);
      const acsRows = rs.filter((r) => r.acs > 0);
      const atk = rs.reduce<[number, number]>((s, r) => (r.atk ? [s[0] + r.atk[0], s[1] + r.atk[1]] : s), [0, 0]);
      const def = rs.reduce<[number, number]>((s, r) => (r.def ? [s[0] + r.def[0], s[1] + r.def[1]] : s), [0, 0]);
      return {
        key: k,
        games: rs.length,
        wins: rs.filter((r) => r.result === 'W').length,
        losses: rs.filter((r) => r.result === 'L').length,
        kd: deaths ? Math.round((kills / deaths) * 100) / 100 : kills,
        acs: acsRows.length ? Math.round(acsRows.reduce((s, r) => s + r.acs, 0) / acsRows.length) : 0,
        rr: rs.reduce((s, r) => s + (r.rr ?? 0), 0),
        ...(atk[1] ? { atk } : {}),
        ...(def[1] ? { def } : {}),
      };
    })
    .sort((a, b) => b.games - a.games);
}

/**
 * Known gaps: competitive matches Riot reported RR for but whose details were never stored (SexyVal
 * wasn't running, or the details had expired). Reported, never filled in.
 */
export function gapsOf(rows: WRow[], updates: CompUpdate[]): { missing: number; oldest?: number; newest?: number } {
  const have = new Set(rows.map((r) => r.matchId));
  const miss = updates.filter((u) => !have.has(u.matchId));
  if (!miss.length) return { missing: 0 };
  const ts = miss.map((u) => u.startTime);
  return { missing: miss.length, oldest: Math.min(...ts), newest: Math.max(...ts) };
}

const CSV_COLS: (keyof WRow)[] = ['matchId', 't', 'queue', 'map', 'agent', 'result', 'rw', 'rl', 'rounds', 'k', 'd', 'a', 'acs', 'adr', 'hs', 'fk', 'fd', 'atk', 'def', 'lengthMs', 'tier', 'rr', 'tierAfter', 'rrAfter', 'act'];

export function toCsv(rows: WRow[], names: { map: (id?: string) => string | undefined; agent: (id?: string) => string | undefined }): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : Array.isArray(v) ? v.join('/') : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [...CSV_COLS.map((c) => (c === 't' ? 'startedAt' : c)), 'mapName', 'agentName'];
  const lines = rows.map((r) => [...CSV_COLS.map((c) => (c === 't' ? new Date(r.t).toISOString() : (r as any)[c])), names.map(r.map), names.agent(r.agent)].map(esc).join(','));
  return [head.join(','), ...lines].join('\n');
}
