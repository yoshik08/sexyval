// Team-aware MMR: who you queued with, how that moves your lobbies and your RR, and a per-premade
// "squad report". Pure: no Riot calls, no clocks. Every number here is our own estimate.
//
// Matchmaking balances teams, not players: your party plus the randoms who fill it are matched against an
// enemy team of about the same average MMR. A lobby reflects your party's MMR, not yours. RR stays
// personal, but wins and losses are shared, so who you queue with moves your win rate and your RR.
//
// Only types come from ./mmr (no runtime import), so the two modules can't form an import cycle.
import type { TrimmedDetails } from './last5';
import type { GapLabel } from './mmr';

const IRON_1 = 3;
const IMMORTAL_1 = 24;
const RADIANT = 27;

/** Weight of the party's highest player vs its mean inside the team balance (0 = plain mean). Some players
 * believe premade MMR leans towards the top player; scripts/mmr-backtest.mjs --team grids this. */
export const PARTY_TOP_WEIGHT = 0;
/** Huber mean cut-off for the team signal, in divisions. */
export const HUBER_DELTA = 1.5;
/** Variance floors (divisions) so neither signal takes all the weight on a small sample. */
export const SPLIT_FLOOR = 0.6;
export const TEAM_FLOOR = 0.8;
/** The team signal needs this many matches with a usable value. */
export const MIN_TEAM_SIGNAL = 3;
/** A match feeds the team signal only with this many ranked enemies and ranked teammates. */
export const MIN_RANKED_ENEMIES = 4;
export const MIN_RANKED_MATES = 3;
/** 5-stack RR factor under this counts as a penalty (5-stacks are then rescaled). */
export const FIVE_PENALTY_BELOW = 0.85;
/** Matches needed per side (wins, losses) in both groups (5-stacks, solo/duo/trio) to measure the factor. */
export const MIN_FIVE_SAMPLES = 3;
/** Shrinkage of the with/without delta: delta · n / (n + K_SHRINK). */
export const K_SHRINK = 5;
/** Ridge penalty on the premade coefficients (intercept and controls are not penalised). */
export const RIDGE_LAMBDA = 3;
export const BOOTSTRAP_N = 1000;
/** Bootstrap the interval under this many games; normal approximation from here on. */
export const NORMAL_FROM = 8;
/** Premades with fewer shared games are listed, never ranked. */
export const MIN_RANKED_GAMES = 3;
/** …and so are premades in nearly every match: under this many games without them there is no baseline. */
export const MIN_BASELINE_GAMES = 3;
/** "Biggest drain" / "Best partner" need |drain| at least this and this many games. */
export const EXTREME_DRAIN = 25;
export const EXTREME_GAMES = 5;
/** |drain| under this is "neutral". */
export const NEUTRAL_DRAIN = 10;
/** Composite drain score: weights and the scale each input is divided by before clamping to ±1. */
export const DRAIN_WEIGHTS = { beta: 0.45, delta: 0.25, z: 0.2, gap: 0.1 } as const;
export const DRAIN_SCALES = { beta: 8, delta: 8, z: 1, gap: 2 } as const;
/** Floor for the per-match ACS standard deviation behind the z-scores. */
export const Z_SD_FLOOR = 25;

/**
 * Party rank windows as reported by the community (players' testing and patch-note readings). Riot doesn't
 * publish this table; it is not official and may be out of date. `maxDiff` = most tiers between the highest
 * and lowest member, by the highest member's tier. Immortal and up: duos only, no trios.
 */
export const RANK_WINDOWS: readonly { upTo: number; maxDiff: number }[] = [
  { upTo: 14, maxDiff: 6 }, // Iron 1 … Gold 3: about 2 ranks
  { upTo: 23, maxDiff: 3 }, // Platinum 1 … Ascendant 3: tighter, about 1 rank
  { upTo: RADIANT, maxDiff: 3 }, // Immortal+
];
/**
 * Community-reported 5-stack RR rules (unofficial): inside the window with everyone Ascendant 3 or below,
 * no reduction; outside the window ~25% less; any Immortal ~25% less; any Radiant ~75–90% less.
 * Shown as context only: the estimate measures the factor from your own matches instead.
 */
export const FIVE_STACK_RULES = { inside: 1, outside: 0.75, immortal: 0.75, radiant: [0.1, 0.25] } as const;

export type StackSize = 1 | 2 | 3 | 4 | 5 | 'unknown';

export interface TeamMate {
  puuid: string;
  /** Competitive tier in that match (0 = unranked). */
  tier: number;
  /** Same partyId as the viewer. */
  premade: boolean;
  partyId?: string;
  acs: number;
  kills: number;
  deaths: number;
  assists: number;
  adr: number | null;
  hsPct: number | null;
  firstBloods: number | null;
  characterId?: string;
  gameName?: string;
  tagLine?: string;
  cardId?: string;
}

export interface TeamFacts {
  /** Party size from partyId. 4 can't queue competitive: kept only if the data says so. */
  stack: StackSize;
  me: TeamMate;
  /** Your party, without you. Empty when there is no party data. */
  premades: TeamMate[];
  /** Your team, other parties. */
  randoms: TeamMate[];
  enemies: TeamMate[];
  /** Ranked tiers of your team, you included. */
  myTeamAvgTier?: number;
  enemyAvgTier?: number;
  /** Your place on your team by ACS (1 = top frag). */
  myAcsPlace: number;
  /** Every player on your team -> place by ACS (1 = top). */
  teamPlace: Record<string, number>;
  /** Per-player ACS z-score inside this match (all players): (acs − mean) / sd, sd floored at Z_SD_FLOOR. */
  z: Record<string, number>;
  roundDiff: number;
  result: 'W' | 'L' | 'D' | '-';
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const r1 = (n: number) => Math.round(n * 10) / 10;
const sdOf = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const defined = <T>(x: T | undefined | null): x is T => x != null;

type DetailsLike = Pick<TrimmedDetails, 'players' | 'teams'>;

/** One match's team context for the viewer. Undefined when they aren't in it or it has no two teams. */
export function teamFactsFromDetails(d: DetailsLike, puuid: string): TeamFacts | undefined {
  const me = d.players.find((p) => p.subject === puuid);
  if (!me) return undefined;
  const mine = d.teams.find((t) => t.teamId === me.teamId);
  const other = d.teams.find((t) => t.teamId !== me.teamId);
  if (!mine || !other) return undefined;
  const acsOf = (p: DetailsLike['players'][number]) => (p.roundsPlayed > 0 ? p.score / p.roundsPlayed : 0);
  const myTeam = d.players.filter((p) => p.teamId === me.teamId);
  const party = me.partyId ? myTeam.filter((p) => p.partyId === me.partyId).length : 0;
  const stack: StackSize = !me.partyId || party < 1 || party > 5 ? 'unknown' : (party as 1 | 2 | 3 | 4 | 5);
  const mate = (p: DetailsLike['players'][number]): TeamMate => ({
    puuid: p.subject,
    tier: p.tier ?? 0,
    premade: stack !== 'unknown' && p.subject !== puuid && p.partyId === me.partyId,
    partyId: p.partyId,
    acs: acsOf(p),
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    adr: p.adr ?? null,
    hsPct: p.hsPct ?? null,
    firstBloods: p.firstBloods ?? null,
    characterId: p.characterId,
    gameName: p.gameName,
    tagLine: p.tagLine,
    cardId: p.cardId,
  });
  const others = myTeam.filter((p) => p.subject !== puuid).map(mate);
  const all = d.players.filter((p) => p.roundsPlayed > 0);
  const acsAll = all.map(acsOf);
  const m = mean(acsAll);
  const sd = Math.max(Z_SD_FLOOR, Math.sqrt(acsAll.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, acsAll.length)));
  const z: Record<string, number> = {};
  for (const p of all) z[p.subject] = (acsOf(p) - m) / sd;
  const order = [...myTeam].sort((a, b) => acsOf(b) - acsOf(a));
  const teamPlace: Record<string, number> = {};
  order.forEach((p, i) => (teamPlace[p.subject] = i + 1));
  const rankedMine = myTeam.map((p) => p.tier ?? 0).filter((t) => t >= IRON_1);
  const enemies = d.players.filter((p) => p.teamId !== me.teamId).map(mate);
  const rankedEnemy = enemies.map((p) => p.tier).filter((t) => t >= IRON_1);
  const rd = mine.roundsWon - other.roundsWon;
  return {
    stack,
    me: mate(me),
    premades: others.filter((p) => p.premade),
    randoms: others.filter((p) => !p.premade),
    enemies,
    myTeamAvgTier: rankedMine.length ? mean(rankedMine) : undefined,
    enemyAvgTier: rankedEnemy.length ? mean(rankedEnemy) : undefined,
    myAcsPlace: teamPlace[puuid] ?? 1,
    teamPlace,
    z,
    roundDiff: rd,
    result: mine.won ? 'W' : other.won ? 'L' : rd === 0 ? 'D' : 'L',
  };
}

/** Teammate -> the number that stands in for their MMR: a premade's estimated MMR if known, else their rank. */
export function teamProxy(premadeMmr?: Record<string, number>): (m: TeamMate) => number | undefined {
  return (m) => (m.premade && premadeMmr?.[m.puuid] != null ? premadeMmr[m.puuid] : m.tier >= IRON_1 ? m.tier : undefined);
}

/**
 * Your MMR implied by the team balance: mean(your 5) ≈ mean(their 5), so
 * impliedMe = 5 · enemyAvg − Σ proxy(teammate) = enemyAvg + 4 · (enemyAvg − teamOthersAvg).
 * Unranked players are dropped and the 5 is rescaled to the players actually ranked (you + ranked
 * teammates), which keeps the same balance assumption. Skipped (undefined) with fewer than
 * MIN_RANKED_ENEMIES ranked enemies or MIN_RANKED_MATES ranked teammates. It multiplies lobby noise by ~4:
 * aggregate it robustly (huberMean).
 *
 * topWeight > 0: the party enters the balance as (1 − w) · mean(party) + w · max(party), you included;
 * solved exactly for you (the party value rises monotonically with yours, so one branch fits).
 */
export function impliedMe(tf: TeamFacts, proxy: (m: TeamMate) => number | undefined = teamProxy(), topWeight = PARTY_TOP_WEIGHT): number | undefined {
  const enemy = tf.enemies.map((m) => m.tier).filter((t) => t >= IRON_1);
  if (enemy.length < MIN_RANKED_ENEMIES) return undefined;
  const prem = tf.premades.map(proxy).filter(defined);
  const rand = tf.randoms.map(proxy).filter(defined);
  if (prem.length + rand.length < MIN_RANKED_MATES) return undefined;
  const k = 1 + prem.length; // party members with a value, you included
  const teamTotal = (k + rand.length) * mean(enemy);
  const partyEff = (teamTotal - sum(rand)) / k; // the party's matchmaking value, per member
  const S = sum(prem);
  const w = clamp(topWeight, 0, 0.9);
  if (w === 0 || !prem.length) return k * partyEff - S;
  const M = Math.max(...prem);
  const above = (partyEff - ((1 - w) * S) / k) / ((1 - w) / k + w); // you are the top player
  if (above >= M) return above;
  return (k * (partyEff - w * M)) / (1 - w) - S;
}

/**
 * Value a match gives the team-adjusted lobby signal. Stacked games: impliedMe (corrects for premades
 * whose MMR differs from yours). Solo games and games without party data: the plain lobby average, which
 * is what impliedMe collapses to in expectation when nobody is a premade, with about a quarter of the noise.
 */
export function teamLobbyValue(tf: TeamFacts | undefined, rawLobby: number | undefined, proxy: (m: TeamMate) => number | undefined, topWeight = PARTY_TOP_WEIGHT): number | undefined {
  if (!tf || tf.stack === 'unknown' || tf.stack === 1) return rawLobby;
  return impliedMe(tf, proxy, topWeight);
}

/** Huber M-estimate of the mean (cut-off δ in divisions) and its standard error sd/√n. */
export function huberMean(xs: number[], delta = HUBER_DELTA): { mean: number; se: number; n: number } | undefined {
  if (!xs.length) return undefined;
  let mu = median(xs);
  for (let it = 0; it < 100; it++) {
    let sw = 0;
    let swx = 0;
    for (const x of xs) {
      const d = Math.abs(x - mu);
      const w = d <= delta ? 1 : delta / d;
      sw += w;
      swx += w * x;
    }
    const next = swx / sw;
    if (Math.abs(next - mu) < 1e-9) {
      mu = next;
      break;
    }
    mu = next;
  }
  return { mean: mu, se: xs.length > 1 ? sdOf(xs) / Math.sqrt(xs.length) : Infinity, n: xs.length };
}

export interface InverseVarianceBlend {
  est: number;
  wSplit: number;
  wTeam: number;
}

/** Inverse-variance blend of the RR-split signal and the team signal, both with variance floors. */
export function blendInverseVariance(split: { value: number; spread: number; n: number }, team: { value: number; se: number }): InverseVarianceBlend {
  const vs = (split.n > 0 ? split.spread ** 2 / split.n : Infinity) + SPLIT_FLOOR ** 2;
  const vt = (Number.isFinite(team.se) ? team.se ** 2 : Infinity) + TEAM_FLOOR ** 2;
  const a = 1 / vs;
  const b = Number.isFinite(vt) ? 1 / vt : 0;
  const wTeam = a + b > 0 ? b / (a + b) : 0;
  return { est: (1 - wTeam) * split.value + wTeam * team.value, wSplit: 1 - wTeam, wTeam };
}

/**
 * 5-stack RR factor per side: median |RR| in 5-stacks / median |RR| in solo, duo and trio games.
 * Each side needs MIN_FIVE_SAMPLES matches in both groups, else that side is undefined.
 */
export function measureFiveStack(rows: { rr: number; stack: StackSize }[]): { win?: number; loss?: number; five?: number } {
  const small = (s: StackSize) => s === 1 || s === 2 || s === 3;
  const side = (sign: 1 | -1) => {
    const f = rows.filter((r) => r.stack === 5 && Math.sign(r.rr) === sign).map((r) => Math.abs(r.rr));
    const o = rows.filter((r) => small(r.stack) && Math.sign(r.rr) === sign).map((r) => Math.abs(r.rr));
    if (f.length < MIN_FIVE_SAMPLES || o.length < MIN_FIVE_SAMPLES) return undefined;
    const base = median(o);
    return base > 0 ? median(f) / base : undefined;
  };
  const win = side(1);
  const loss = side(-1);
  return { win, loss, five: win != null && loss != null ? (win + loss) / 2 : undefined };
}

/** SkillDisparityRRPenalty as a 0–1 fraction of RR lost. Riot's scale is unverified: > 1 is read as a percentage. */
export function normalisePenalty(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v)) return undefined;
  return clamp(v > 1 ? v / 100 : v, 0, 1);
}

/** Highest − lowest tier allowed for a party whose top member is at `top` (community-reported). */
export function rankWindow(top: number): number {
  return (RANK_WINDOWS.find((w) => top <= w.upTo) ?? RANK_WINDOWS[RANK_WINDOWS.length - 1]).maxDiff;
}

/** A 5-stack of these tiers would sit outside the normal rank window, or has an Immortal+ in it. */
export function fiveStackPenaltyRisk(tiers: number[]): boolean {
  const ranked = tiers.filter((t) => t >= IRON_1);
  if (ranked.length < 2) return ranked.some((t) => t >= IMMORTAL_1);
  const top = Math.max(...ranked);
  return top >= IMMORTAL_1 || top - Math.min(...ranked) > rankWindow(top);
}

/**
 * Ridge regression: β = argmin ‖y − Xβ‖² + λ Σ_{penalised j} β_j², by the normal equations
 * (XᵀX + λD)β = Xᵀy with Gaussian elimination. Null when the system is singular (or no rows).
 * λ = 0 is ordinary least squares.
 */
export function fitRidge(rows: { y: number; x: number[] }[], lambda: number, penalised: boolean[]): number[] | null {
  const k = penalised.length;
  if (!rows.length || !k) return null;
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (const r of rows) {
    for (let i = 0; i < k; i++) {
      b[i] += r.x[i] * r.y;
      for (let j = 0; j < k; j++) A[i][j] += r.x[i] * r.x[j];
    }
  }
  for (let i = 0; i < k; i++) if (penalised[i]) A[i][i] += lambda;
  const scale = Math.max(1, ...A.map((row, i) => Math.abs(row[i])));
  // Gaussian elimination with partial pivoting on [A | b].
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-9 * scale) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < k; r++) {
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let j = c; j < k; j++) A[r][j] -= f * A[c][j];
      b[r] -= f * b[c];
    }
  }
  const beta = new Array<number>(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < k; j++) s -= A[i][j] * beta[j];
    beta[i] = s / A[i][i];
  }
  return beta.every(Number.isFinite) ? beta : null;
}

/** One match of the window (current act, last 25, no placements / AFK / remakes; draws kept). */
export interface WindowMatch {
  matchId: string;
  startTime: number;
  /** Your RR from that match, as Riot gave it. */
  rr: number;
  result: 'W' | 'L' | 'D' | '-';
  stack: StackSize;
  tf?: TeamFacts;
  mapId?: string;
  score?: string;
  /** This 5-stack was rescaled in the RR split (a penalty was measured). */
  fiveScaled?: boolean;
}

export interface StackRow {
  stack: StackSize;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** Percent of decided games. */
  winRate?: number;
  avgWinRR?: number;
  avgLossRR?: number;
  netRR: number;
  rrPerGame?: number;
  avgRoundDiff?: number;
  avgMyAcsPlace?: number;
  avgTeamTier?: number;
  avgEnemyTier?: number;
}

/** Per stack size (1, 2, 3, 5, unknown; 4 only if the data has one): record and RR. Empty groups have games 0. */
export function stackBreakdown(rows: WindowMatch[]): StackRow[] {
  const keys: StackSize[] = [1, 2, 3, 5, 'unknown'];
  if (rows.some((r) => r.stack === 4)) keys.splice(3, 0, 4);
  return keys.map((stack) => {
    const g = rows.filter((r) => r.stack === stack);
    const wins = g.filter((r) => r.result === 'W');
    const losses = g.filter((r) => r.result === 'L');
    const decided = wins.length + losses.length;
    const avg = (xs: (number | undefined)[]) => {
      const v = xs.filter(defined);
      return v.length ? r1(mean(v)) : undefined;
    };
    const net = sum(g.map((r) => r.rr));
    return {
      stack,
      games: g.length,
      wins: wins.length,
      losses: losses.length,
      draws: g.length - decided,
      winRate: decided ? r1((wins.length / decided) * 100) : undefined,
      avgWinRR: avg(wins.map((r) => r.rr)),
      avgLossRR: avg(losses.map((r) => r.rr)),
      netRR: net,
      rrPerGame: g.length ? r1(net / g.length) : undefined,
      avgRoundDiff: avg(g.map((r) => r.tf?.roundDiff)),
      avgMyAcsPlace: avg(g.map((r) => r.tf?.myAcsPlace)),
      avgTeamTier: avg(g.map((r) => r.tf?.myTeamAvgTier)),
      avgEnemyTier: avg(g.map((r) => r.tf?.enemyAvgTier)),
    };
  });
}

// ---------- Squad report ----------

export type SquadStatus = 'loading' | 'ready' | 'unavailable' | 'hidden' | 'skipped';
export type Verdict = 'biggest drain' | 'costs you RR' | 'neutral' | 'helps you' | 'best partner' | 'not enough games';

/** What the service learned about a premade from their own data (none of it for hidden players). */
export interface PremadeInfo {
  status: SquadStatus;
  /** Current competitive tier (mmr/v1/players). */
  tier?: number;
  /** Their estimated MMR (decimal tier), from their own competitive updates. */
  estMmr?: number;
  gapLabel?: GapLabel;
  /** Their own RR by match id (their competitive updates). */
  rrByMatch?: Record<string, number>;
}

export interface PerfLine {
  games: number;
  acs?: number;
  adr?: number;
  kd?: number;
  hsPct?: number;
  fbPerGame?: number;
  meanZ?: number;
  meanZLosses?: number;
  /** Share of lost shared games where this player had the lowest ACS on your team. */
  bottomFragLosses?: number;
  /** Share of won shared games where this player had the highest ACS on your team. */
  topFragWins?: number;
}

export interface SharedGame {
  matchId: string;
  startTime: number;
  mapId?: string;
  result: 'W' | 'L' | 'D' | '-';
  score?: string;
  stack: StackSize;
  yourRR: number;
  theirRR?: number;
  yourAcs: number;
  theirAcs: number;
  yourPlace: number;
  theirPlace: number;
  topFrag?: string;
  bottomFrag?: string;
  theirAgent?: string;
}

export interface SquadRow {
  puuid: string;
  hidden: boolean;
  status: SquadStatus;
  /** From your match details (fallback when name-service has nothing). Never set for hidden players. */
  gameName?: string;
  tagLine?: string;
  cardId?: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate?: number;
  yourNetRR: number;
  yourRRPerGame: number;
  without: { games: number; winRate?: number; rrPerGame?: number };
  deltaRRPerGame?: number;
  deltaWinRate?: number;
  shrunkDelta?: number;
  /** 80% interval of the shrunk delta. */
  interval?: [number, number];
  intervalMethod?: 'bootstrap' | 'normal';
  /** Ridge: your RR per game attributable to this premade, other premades and lobby difficulty held fixed. */
  beta?: number;
  /** Same model with y = win ? +1 : −1. */
  betaWin?: number;
  you: PerfLine;
  them: PerfLine;
  theirTier?: number;
  theirEstMmr?: number;
  theirGapLabel?: GapLabel;
  /** Your estimate − theirs, in divisions. Positive: queuing with them lowers your lobby. */
  mmrGapVsYou?: number;
  theirRR?: { games: number; net: number; perGame: number };
  penaltyRisk: boolean;
  /** −100…+100: positive costs you, negative carries you. */
  drain?: number;
  /** Each input after scaling and clamping to ±1 (sign already flipped so + = costs you). */
  drainParts?: { beta: number; delta: number; z: number; gap: number };
  /**
   * Σ over shared games of (your RR − what the ridge expects from stack size and lobby difficulty alone,
   * with no premade effects). The 5-stack control keeps a 5-stack RR penalty from being blamed on
   * whoever happened to be in the stack.
   */
  rrCostEstimate?: number;
  verdict: Verdict;
  /** Enough games with them (MIN_RANKED_GAMES) and without them (MIN_BASELINE_GAMES) to be ranked. */
  eligible: boolean;
  shared: SharedGame[];
}

export interface RandomsRow {
  games: number;
  appearances: number;
  meanTier?: number;
  yourTier: number;
  meanZ?: number;
  bottomFragLosses?: number;
  soloGames: number;
  soloRRPerGame?: number;
}

export interface RidgeSummary {
  lambda: number;
  intercept: number;
  r2: number;
  n: number;
}

/** Team view of the estimate (MmrEstimate.team), present only when the input carried team data. */
export interface TeamSummary {
  /** Matches analysed: current act, no placements / AFK / remakes (≤ 25). */
  window: number;
  teamSignal?: number;
  teamSignalSe?: number;
  wSplitUsed: number;
  wTeamUsed: number;
  /** Share of signal matches that were stacked (duo or more). */
  stackedShare: number;
  lobbyAvgSolo?: number;
  lobbyAvgStacked?: number;
  stackPenalty: { five?: number; fiveWin?: number; fiveLoss?: number; party?: number; source: 'measured' | 'party-field' | 'none' };
  stacks: StackRow[];
  squad: SquadRow[];
  randoms: RandomsRow;
  ridge?: RidgeSummary;
  /** Window matches without party data (listed, left out of every party stat). */
  noPartyData: number;
}

export interface SquadInput {
  matches: WindowMatch[];
  you: { puuid: string; tier: number; est?: number };
  premades?: Record<string, PremadeInfo>;
  lambda?: number;
}

/** Deterministic RNG (mulberry32) seeded from a string, so bootstrap intervals are reproducible. */
export function seededRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 80% interval of mean(with) − baseline, bootstrapped over the `with` games. */
function bootstrap(values: number[], baseline: number, seed: string, n = BOOTSTRAP_N): [number, number] {
  const rnd = seededRng(seed);
  const out: number[] = [];
  for (let b = 0; b < n; b++) {
    let s = 0;
    for (let i = 0; i < values.length; i++) s += values[Math.floor(rnd() * values.length)];
    out.push(s / values.length - baseline);
  }
  out.sort((a, c) => a - c);
  return [out[Math.floor(0.1 * (n - 1))], out[Math.ceil(0.9 * (n - 1))]];
}

function perf(games: { tf: TeamFacts; result: WindowMatch['result'] }[], pick: (tf: TeamFacts) => TeamMate | undefined): PerfLine {
  const lines = games.map((g) => ({ g, m: pick(g.tf) })).filter((x): x is { g: (typeof games)[number]; m: TeamMate } => !!x.m);
  if (!lines.length) return { games: 0 };
  const avg = (xs: (number | null | undefined)[]) => {
    const v = xs.filter(defined);
    return v.length ? mean(v) : undefined;
  };
  const kills = sum(lines.map((l) => l.m.kills));
  const deaths = sum(lines.map((l) => l.m.deaths));
  const teamSize = (tf: TeamFacts) => Object.keys(tf.teamPlace).length;
  const losses = lines.filter((l) => l.g.result === 'L');
  const wins = lines.filter((l) => l.g.result === 'W');
  return {
    games: lines.length,
    acs: avg(lines.map((l) => l.m.acs)),
    adr: avg(lines.map((l) => l.m.adr)),
    kd: deaths > 0 ? kills / deaths : kills,
    hsPct: avg(lines.map((l) => l.m.hsPct)),
    fbPerGame: avg(lines.map((l) => l.m.firstBloods)),
    meanZ: avg(lines.map((l) => l.g.tf.z[l.m.puuid])),
    meanZLosses: avg(losses.map((l) => l.g.tf.z[l.m.puuid])),
    bottomFragLosses: losses.length ? losses.filter((l) => l.g.tf.teamPlace[l.m.puuid] === teamSize(l.g.tf)).length / losses.length : undefined,
    topFragWins: wins.length ? wins.filter((l) => l.g.tf.teamPlace[l.m.puuid] === 1).length / wins.length : undefined,
  };
}

const norm = (x: number | undefined, scale: number) => (x == null || !Number.isFinite(x) ? 0 : clamp(x / scale, -1, 1));

/**
 * Squad report for everyone you queued with in the window: raw and shrunk with/without deltas, a ridge
 * "adjusted plus-minus" that separates people who always queue together, their performance in your games,
 * the MMR gap, a transparent composite drain score and a plain verdict. Matches without party data are
 * left out of every number here.
 */
export function buildSquad(input: SquadInput): { squad: SquadRow[]; randoms: RandomsRow; ridge?: RidgeSummary } {
  const lambda = input.lambda ?? RIDGE_LAMBDA;
  const known = input.matches.filter((m): m is WindowMatch & { tf: TeamFacts } => !!m.tf && m.stack !== 'unknown');
  const byPremade = new Map<string, (WindowMatch & { tf: TeamFacts })[]>();
  for (const m of known) for (const p of m.tf.premades) byPremade.set(p.puuid, [...(byPremade.get(p.puuid) ?? []), m]);
  const ids = [...byPremade.keys()];

  // ---- Ridge (adjusted plus-minus) ----
  // Lobby difficulty = enemy average − your team's average, with premades counted at their estimated MMR
  // when known. By rank alone the control would move with any premade whose MMR differs from their rank
  // (the matchmaker balances MMR) and soak up exactly the effect we want to attribute to them.
  const known5 = Object.fromEntries(Object.entries(input.premades ?? {}).filter(([, i]) => i.status === 'ready' && i.estMmr != null).map(([p, i]) => [p, i.estMmr!]));
  const proxy = teamProxy(known5);
  const teamAvg = (tf: TeamFacts) => {
    const v = [tf.me.tier >= IRON_1 ? tf.me.tier : undefined, ...tf.premades.map(proxy), ...tf.randoms.map(proxy)].filter(defined);
    return v.length ? mean(v) : undefined;
  };
  const lobbyDiff = known.map((m) => {
    const t = teamAvg(m.tf);
    return m.tf.enemyAvgTier != null && t != null ? m.tf.enemyAvgTier - t : undefined;
  });
  const ldKnown = lobbyDiff.filter(defined);
  const ldMean = mean(ldKnown);
  // Centred, so the intercept is your RR per game alone, at no 5-stack, in an average lobby.
  const ld = lobbyDiff.map((x) => (x == null ? 0 : x - ldMean));
  const fives = known.filter((m) => m.stack === 5).length;
  const useFive = fives > 0 && fives < known.length;
  const useLd = ld.some((x) => Math.abs(x) > 1e-9);
  const design = known.map((m, i) => {
    const set = new Set(m.tf.premades.map((p) => p.puuid));
    return [1, ...ids.map((id) => (set.has(id) ? 1 : 0)), ...(useFive ? [m.stack === 5 ? 1 : 0] : []), ...(useLd ? [ld[i]] : [])];
  });
  const pen = [false, ...ids.map(() => true), ...(useFive ? [false] : []), ...(useLd ? [false] : [])];
  const rrModel = known.length >= 3 ? fitRidge(known.map((m, i) => ({ y: m.rr, x: design[i] })), lambda, pen) : null;
  const winY = (r: WindowMatch['result']) => (r === 'W' ? 1 : r === 'L' ? -1 : 0);
  const winModel = known.length >= 3 ? fitRidge(known.map((m, i) => ({ y: winY(m.result), x: design[i] })), lambda, pen) : null;
  let ridge: RidgeSummary | undefined;
  if (rrModel) {
    const ys = known.map((m) => m.rr);
    const my = mean(ys);
    const ssTot = sum(ys.map((y) => (y - my) ** 2));
    const ssRes = sum(known.map((m, i) => (m.rr - sum(design[i].map((x, j) => x * rrModel[j]))) ** 2));
    ridge = { lambda, intercept: r1(rrModel[0]), r2: ssTot > 0 ? Math.round((1 - ssRes / ssTot) * 100) / 100 : 0, n: known.length };
  }

  // What the ridge expects for match i with every premade effect switched off (intercept + controls).
  const rowOf = new Map(known.map((m, i) => [m.matchId, i]));
  const fiveCol = 1 + ids.length;
  const ldCol = fiveCol + (useFive ? 1 : 0);
  const controlsOnly = (i: number) => (rrModel ? rrModel[0] + (useFive ? rrModel[fiveCol] * design[i][fiveCol] : 0) + (useLd ? rrModel[ldCol] * design[i][ldCol] : 0) : 0);

  // ---- Per premade ----
  const rows: SquadRow[] = ids.map((id, j) => {
    const info = input.premades?.[id];
    const hidden = info?.status === 'hidden';
    const w = byPremade.get(id)!;
    const wo = known.filter((m) => !m.tf.premades.some((p) => p.puuid === id));
    const rec = (g: WindowMatch[]) => {
      const wins = g.filter((m) => m.result === 'W').length;
      const losses = g.filter((m) => m.result === 'L').length;
      const net = sum(g.map((m) => m.rr));
      return { wins, losses, draws: g.length - wins - losses, winRate: wins + losses ? (wins / (wins + losses)) * 100 : undefined, net, perGame: g.length ? net / g.length : undefined };
    };
    const a = rec(w);
    const b = rec(wo);
    const n = w.length;
    const delta = b.perGame != null && a.perGame != null ? a.perGame - b.perGame : undefined;
    const shrink = n / (n + K_SHRINK);
    let interval: [number, number] | undefined;
    let intervalMethod: SquadRow['intervalMethod'];
    if (delta != null && b.perGame != null) {
      const vals = w.map((m) => m.rr);
      if (n >= NORMAL_FROM) {
        const h = (1.2816 * sdOf(vals)) / Math.sqrt(n);
        interval = [(delta - h) * shrink, (delta + h) * shrink];
        intervalMethod = 'normal';
      } else {
        const [lo, hi] = bootstrap(vals, b.perGame, `squad:${id}:${w.map((m) => m.matchId).join(',')}`);
        interval = [lo * shrink, hi * shrink];
        intervalMethod = 'bootstrap';
      }
    }
    const them = perf(w, (tf) => tf.premades.find((p) => p.puuid === id));
    const you = perf(w, (tf) => tf.me);
    const latest = [...w].sort((x, y) => y.startTime - x.startTime)[0];
    const latestLine = latest.tf.premades.find((p) => p.puuid === id);
    const theirTierNow = info?.tier ?? latestLine?.tier;
    const gap = input.you.est != null && info?.estMmr != null ? input.you.est - info.estMmr : undefined;
    const theirRRList = info?.rrByMatch ? w.map((m) => info.rrByMatch![m.matchId]).filter(defined) : [];
    const beta = rrModel ? rrModel[1 + j] : undefined;
    const shrunk = delta != null ? delta * shrink : undefined;
    const parts = { beta: norm(beta != null ? -beta : undefined, DRAIN_SCALES.beta), delta: norm(shrunk != null ? -shrunk : undefined, DRAIN_SCALES.delta), z: norm(them.meanZLosses != null ? -them.meanZLosses : undefined, DRAIN_SCALES.z), gap: norm(gap, DRAIN_SCALES.gap) };
    const drain = 100 * (DRAIN_WEIGHTS.beta * parts.beta + DRAIN_WEIGHTS.delta * parts.delta + DRAIN_WEIGHTS.z * parts.z + DRAIN_WEIGHTS.gap * parts.gap);
    const eligible = n >= MIN_RANKED_GAMES && wo.length >= MIN_BASELINE_GAMES;
    const shared: SharedGame[] = [...w]
      .sort((x, y) => y.startTime - x.startTime)
      .map((m) => {
        const line = m.tf.premades.find((p) => p.puuid === id)!;
        const size = Object.keys(m.tf.teamPlace).length;
        const top = Object.entries(m.tf.teamPlace).find(([, pl]) => pl === 1)?.[0];
        const bottom = Object.entries(m.tf.teamPlace).find(([, pl]) => pl === size)?.[0];
        return {
          matchId: m.matchId,
          startTime: m.startTime,
          mapId: m.mapId,
          result: m.result,
          score: m.score,
          stack: m.stack,
          yourRR: m.rr,
          theirRR: info?.rrByMatch?.[m.matchId],
          yourAcs: Math.round(m.tf.me.acs),
          theirAcs: Math.round(line.acs),
          yourPlace: m.tf.myAcsPlace,
          theirPlace: m.tf.teamPlace[id] ?? 0,
          topFrag: top,
          bottomFrag: bottom,
          theirAgent: line.characterId,
        };
      });
    return {
      puuid: id,
      hidden,
      status: info?.status ?? 'skipped',
      gameName: hidden ? undefined : latestLine?.gameName,
      tagLine: hidden ? undefined : latestLine?.tagLine,
      cardId: hidden ? undefined : latestLine?.cardId,
      games: n,
      wins: a.wins,
      losses: a.losses,
      draws: a.draws,
      winRate: a.winRate != null ? r1(a.winRate) : undefined,
      yourNetRR: a.net,
      yourRRPerGame: r1(a.perGame ?? 0),
      without: { games: wo.length, winRate: b.winRate != null ? r1(b.winRate) : undefined, rrPerGame: b.perGame != null ? r1(b.perGame) : undefined },
      deltaRRPerGame: delta != null ? r1(delta) : undefined,
      deltaWinRate: a.winRate != null && b.winRate != null ? r1(a.winRate - b.winRate) : undefined,
      shrunkDelta: shrunk != null ? r1(shrunk) : undefined,
      interval: interval ? [r1(interval[0]), r1(interval[1])] : undefined,
      intervalMethod,
      beta: beta != null ? r1(beta) : undefined,
      betaWin: winModel ? Math.round(winModel[1 + j] * 100) / 100 : undefined,
      you,
      them,
      theirTier: hidden ? undefined : info?.tier,
      theirEstMmr: hidden ? undefined : info?.estMmr != null ? r1(info.estMmr) : undefined,
      theirGapLabel: hidden ? undefined : info?.gapLabel,
      mmrGapVsYou: hidden || gap == null ? undefined : r1(gap),
      theirRR: !hidden && theirRRList.length ? { games: theirRRList.length, net: sum(theirRRList), perGame: r1(mean(theirRRList)) } : undefined,
      penaltyRisk: fiveStackPenaltyRisk([input.you.tier, theirTierNow ?? 0]),
      drain: Math.round(drain),
      drainParts: { beta: r1(parts.beta), delta: r1(parts.delta), z: r1(parts.z), gap: r1(parts.gap) },
      rrCostEstimate: rrModel ? Math.round(sum(w.map((m) => m.rr - controlsOnly(rowOf.get(m.matchId)!)))) : undefined,
      verdict: eligible ? 'neutral' : 'not enough games',
      eligible,
      shared,
    };
  });

  // ---- Verdicts and order ----
  const ranked = rows.filter((r) => r.eligible);
  for (const r of ranked) r.verdict = (r.drain ?? 0) >= NEUTRAL_DRAIN ? 'costs you RR' : (r.drain ?? 0) <= -NEUTRAL_DRAIN ? 'helps you' : 'neutral';
  const byDrain = [...ranked].sort((x, y) => (y.drain ?? 0) - (x.drain ?? 0) || y.games - x.games);
  const top = byDrain[0];
  const bottom = byDrain[byDrain.length - 1];
  if (top && (top.drain ?? 0) >= EXTREME_DRAIN && top.games >= EXTREME_GAMES) top.verdict = 'biggest drain';
  if (bottom && bottom !== top && (bottom.drain ?? 0) <= -EXTREME_DRAIN && bottom.games >= EXTREME_GAMES) bottom.verdict = 'best partner';
  const squad = [...byDrain, ...rows.filter((r) => !r.eligible).sort((x, y) => y.games - x.games)];

  // ---- Random teammates (aggregate only, never named) ----
  const appear = known.flatMap((m) => m.tf.randoms.map((p) => ({ m, p })));
  const inLosses = appear.filter((x) => x.m.result === 'L');
  const rankedTiers = appear.map((x) => x.p.tier).filter((t) => t >= IRON_1);
  const zs = appear.map((x) => x.m.tf.z[x.p.puuid]).filter(defined);
  const solo = known.filter((m) => m.stack === 1);
  const randoms: RandomsRow = {
    games: known.filter((m) => m.tf.randoms.length > 0).length,
    appearances: appear.length,
    meanTier: rankedTiers.length ? r1(mean(rankedTiers)) : undefined,
    yourTier: input.you.tier,
    meanZ: zs.length ? Math.round(mean(zs) * 100) / 100 : undefined,
    bottomFragLosses: inLosses.length ? Math.round((inLosses.filter((x) => x.m.tf.teamPlace[x.p.puuid] === Object.keys(x.m.tf.teamPlace).length).length / inLosses.length) * 100) / 100 : undefined,
    soloGames: solo.length,
    soloRRPerGame: solo.length ? r1(mean(solo.map((m) => m.rr))) : undefined,
  };
  return { squad, randoms, ridge };
}
