// Lifetime aggregates for one player from Riot's own match data. Pure: no Riot calls.
import type { CompUpdate } from './mmr';
import type { MatchResult } from './types';

/** One player's line from one match (summarizeMatch output plus what the UI shows). */
export interface LifetimeMatch {
  matchId: string;
  startTime: number;
  queueId?: string;
  mapId?: string;
  characterId?: string;
  result: MatchResult;
  score: string;
  kills: number;
  deaths: number;
  assists: number;
  acs: number;
  rounds?: number;
  adr?: number | null;
  hsPct?: number | null;
  firstBloods?: number | null;
}

export interface FormStats {
  n: number;
  wins: number;
  losses: number;
  winRate?: number;
  kd: number;
  acs: number;
}

export interface LifetimeTotals extends FormStats {
  adr?: number;
  hsPct?: number;
  firstBloods: number;
}

export interface GroupRow {
  key: string;
  games: number;
  wins: number;
  winRate?: number;
  kd: number;
  acs: number;
}

export interface TimelinePoint {
  t: number;
  tier: number;
  rr: number;
  delta: number;
  actId: string;
  matchId: string;
}

export interface ActSummary {
  actId: string;
  matches: number;
  wins: number;
  losses: number;
  finalTier: number;
  finalRR: number;
  peakTier: number;
}

export interface LifetimeAggregate {
  /** Matches with details (K/D, ACS… come from these). */
  totals: LifetimeTotals;
  /** Competitive record from competitive updates (every act), independent of how many details are loaded. */
  competitive: { matches: number; wins: number; losses: number; winRate?: number };
  currentAct: { last10: FormStats; last20: FormStats };
  byAgent: GroupRow[];
  byMap: GroupRow[];
  timeline: TimelinePoint[];
  /** Index into `timeline` where a new act starts (for boundary markers). */
  actStarts: { index: number; actId: string }[];
  perAct: ActSummary[];
  bestAgent?: GroupRow;
  worstAgent?: GroupRow;
  bestMap?: GroupRow;
  worstMap?: GroupRow;
}

/** Riot pages these endpoints 20 at a time; a short or empty page is the last one. */
export const PAGE_SIZE = 20;

export function isLastPage(page: unknown[], size = PAGE_SIZE): boolean {
  return page.length < size;
}

/** Concatenates pages in order, dropping duplicates (pages shift when a new match lands mid-paging). */
export function stitchPages<T>(pages: T[][], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of pages) {
    for (const item of page) {
      const k = key(item);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const kdOf = (k: number, d: number) => (d > 0 ? r2(k / d) : k);

export function formOf(rows: LifetimeMatch[]): FormStats {
  const wins = rows.filter((r) => r.result === 'W').length;
  const losses = rows.filter((r) => r.result === 'L').length;
  const k = rows.reduce((a, r) => a + r.kills, 0);
  const d = rows.reduce((a, r) => a + r.deaths, 0);
  // ACS per round across matches (a 26-round game counts more than a 13-round one).
  const rounds = rows.reduce((a, r) => a + (r.rounds ?? 0), 0);
  const acs = rounds ? rows.reduce((a, r) => a + r.acs * (r.rounds ?? 0), 0) / rounds : rows.length ? rows.reduce((a, r) => a + r.acs, 0) / rows.length : 0;
  return { n: rows.length, wins, losses, winRate: wins + losses ? Math.round((wins / (wins + losses)) * 100) : undefined, kd: kdOf(k, d), acs: Math.round(acs) };
}

function totalsOf(rows: LifetimeMatch[]): LifetimeTotals {
  const f = formOf(rows);
  const withAdr = rows.filter((r) => r.adr != null && (r.rounds ?? 0) > 0);
  const adrRounds = withAdr.reduce((a, r) => a + (r.rounds ?? 0), 0);
  const withHs = rows.filter((r) => r.hsPct != null);
  return {
    ...f,
    adr: adrRounds ? Math.round(withAdr.reduce((a, r) => a + (r.adr ?? 0) * (r.rounds ?? 0), 0) / adrRounds) : undefined,
    hsPct: withHs.length ? Math.round(withHs.reduce((a, r) => a + (r.hsPct ?? 0), 0) / withHs.length) : undefined,
    firstBloods: rows.reduce((a, r) => a + (r.firstBloods ?? 0), 0),
  };
}

function groupBy(rows: LifetimeMatch[], key: (r: LifetimeMatch) => string | undefined): GroupRow[] {
  const m = new Map<string, LifetimeMatch[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const list = m.get(k) ?? [];
    list.push(r);
    m.set(k, list);
  }
  return [...m.entries()]
    .map(([k, list]) => {
      const f = formOf(list);
      return { key: k, games: f.n, wins: f.wins, winRate: f.winRate, kd: f.kd, acs: f.acs };
    })
    .sort((a, b) => b.games - a.games || (b.winRate ?? 0) - (a.winRate ?? 0));
}

/** Best / worst by win rate among groups with at least `min` games (ties: more games first). */
function extremes(rows: GroupRow[], min = 3): { best?: GroupRow; worst?: GroupRow } {
  const eligible = rows.filter((r) => r.games >= min && r.winRate != null);
  if (eligible.length < 2) return { best: eligible[0] };
  const sorted = [...eligible].sort((a, b) => b.winRate! - a.winRate! || b.games - a.games);
  return { best: sorted[0], worst: sorted[sorted.length - 1] };
}

export interface AggregateInput {
  matches: LifetimeMatch[];
  updates: CompUpdate[];
  /** Current act (for current-act form); `start` in ms. */
  currentAct?: { id: string; start: number };
}

export function aggregateLifetime(input: AggregateInput): LifetimeAggregate {
  const matches = stitchPages([input.matches], (m) => m.matchId).sort((a, b) => b.startTime - a.startTime);
  const updates = stitchPages([input.updates], (u) => u.matchId).sort((a, b) => a.startTime - b.startTime);

  const timeline: TimelinePoint[] = updates
    .filter((u) => u.tierAfter > 0 || u.rrAfter > 0)
    .map((u) => ({ t: u.startTime, tier: u.tierAfter, rr: u.rrAfter, delta: u.rrEarned, actId: u.seasonId, matchId: u.matchId }));
  const actStarts: LifetimeAggregate['actStarts'] = [];
  timeline.forEach((p, i) => {
    if (i === 0 || p.actId !== timeline[i - 1].actId) actStarts.push({ index: i, actId: p.actId });
  });

  const perActMap = new Map<string, ActSummary>();
  for (const u of updates) {
    const a = perActMap.get(u.seasonId) ?? { actId: u.seasonId, matches: 0, wins: 0, losses: 0, finalTier: 0, finalRR: 0, peakTier: 0 };
    a.matches++;
    if (u.rrEarned > 0) a.wins++;
    else if (u.rrEarned < 0) a.losses++;
    a.finalTier = u.tierAfter;
    a.finalRR = u.rrAfter;
    a.peakTier = Math.max(a.peakTier, u.tierAfter);
    perActMap.set(u.seasonId, a);
  }
  const compWins = updates.filter((u) => u.rrEarned > 0).length;
  const compLosses = updates.filter((u) => u.rrEarned < 0).length;

  const act = input.currentAct;
  const inAct = act ? matches.filter((m) => m.queueId === 'competitive' && m.startTime >= act.start) : [];
  const byAgent = groupBy(matches, (m) => m.characterId);
  const byMap = groupBy(matches, (m) => m.mapId);
  const a = extremes(byAgent);
  const mp = extremes(byMap);
  return {
    totals: totalsOf(matches),
    competitive: { matches: updates.length, wins: compWins, losses: compLosses, winRate: compWins + compLosses ? Math.round((compWins / (compWins + compLosses)) * 100) : undefined },
    currentAct: { last10: formOf(inAct.slice(0, 10)), last20: formOf(inAct.slice(0, 20)) },
    byAgent,
    byMap,
    timeline,
    actStarts,
    perAct: [...perActMap.values()],
    bestAgent: a.best,
    worstAgent: a.worst,
    bestMap: mp.best,
    worstMap: mp.worst,
  };
}
