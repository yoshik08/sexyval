// Estimated MMR from RR changes and lobby ranks. Pure: no Riot calls, no clocks except what callers pass.
//
// Riot doesn't publish MMR or the RR formula. Publicly confirmed: RR = base win/loss + round margin + a
// small performance effect + a convergence term that pulls your rank towards your MMR (MMR above rank:
// wins give more than losses take; at rank: about even, ~50% win rate; below: losses take more; far
// above: division skips). This module reads that asymmetry back out of your matches and blends it with
// the average rank of the players you were matched with. Everything here is an estimate.

/** RR asymmetry per division of MMR gap. Heuristic from public MMR calculators (+25/-13 ≈ +2, +19/-18 ≈ 0, +13/-24 ≈ -2). */
export const RR_PER_DIVISION = 5;
/** Blend weights: lobby average vs (your rank + RR-split gap). Tuned with scripts/mmr-backtest.mjs. */
export const W_LOBBY = 0.6;
export const W_SPLIT = 0.4;
/** Below this many wins (or losses) the regression is skipped and raw averages are used. */
export const MIN_REGRESSION = 6;
/** Per-match gap spread (divisions, std dev) at or under which >10 matches count as High confidence. */
export const SPREAD_HIGH = 1.5;
/** An act this young (ms) gives Low confidence: RR right after placements is noisy. */
export const START_OF_ACT_MS = 3 * 24 * 3600 * 1000;

export const MIN_TIER = 3; // Iron 1
export const MAX_TIER = 27; // Radiant

export type ExcludeReason = 'placement' | 'afk' | 'remake' | 'draw' | '5-stack' | 'other act';
export type GapLabel = 'well above rank' | 'above rank' | 'at rank' | 'below rank' | 'well below rank';
export type Confidence = 'Low' | 'Medium' | 'High';

/** One entry of mmr/v1/players/{puuid}/competitiveupdates (Matches[]). */
export interface CompUpdate {
  matchId: string;
  startTime: number;
  seasonId: string;
  tierBefore: number;
  tierAfter: number;
  rrBefore: number;
  rrAfter: number;
  rrEarned: number;
  /** RankedRatingPerformanceBonus, when Riot sends it. */
  perfBonus?: number;
  afkPenalty: number;
}

/** What the model needs from a match's details (trimmed details, cached on disk). */
export interface MatchFacts {
  result: 'W' | 'L' | 'D' | '-';
  /** Your rounds minus theirs. */
  roundDiff: number;
  totalRounds: number;
  acs: number;
  /** Competitive tier of every other player in the match (0 = unranked). Same count for every player. */
  otherTiers: number[];
  /** Players in your party, when the details say so. */
  partySize?: number;
  score?: string;
  mapId?: string;
  characterId?: string;
}

export interface MmrInput {
  updates: CompUpdate[];
  /** By match id; a missing entry means details aren't available (yet). */
  facts: Record<string, MatchFacts | undefined>;
  /** Current competitive tier and RR (mmr/v1/players). 0 = unrated. */
  myTier: number;
  myRR: number;
  /** Active act; updates from other acts are ignored. */
  actId?: string;
  actStart?: number;
  now?: number;
}

export interface MmrParams {
  rrPerDivision: number;
  wLobby: number;
  wSplit: number;
}

export const DEFAULT_PARAMS: MmrParams = { rrPerDivision: RR_PER_DIVISION, wLobby: W_LOBBY, wSplit: W_SPLIT };

export interface MmrMatchRow {
  matchId: string;
  startTime: number;
  result: 'W' | 'L' | 'D' | '-';
  score?: string;
  mapId?: string;
  characterId?: string;
  rrEarned: number;
  tierAfter: number;
  rrAfter: number;
  lobbyAvg?: number;
  excluded?: ExcludeReason;
  /** Short explanation of the RR, e.g. "+4 from round margin" or "excluded: 5-stack". */
  tag: string;
  /** Running estimate after this match (graph); undefined until there is one. */
  estAfter?: number;
}

export interface Forecast {
  /** Wins to the next division at your current win RR; undefined when unknown. */
  winsToNext?: number;
  nextTier?: number;
  /** RR a loss costs (positive number). */
  lossCost?: number;
  skipPossible: boolean;
}

export interface MmrEstimate {
  estTier: number;
  estTierDecimal: number;
  myTier: number;
  myRR: number;
  gapDivisions: number;
  label: GapLabel;
  confidence: Confidence;
  /** Std dev of per-match gap estimates, in divisions. */
  spread: number;
  Gw: number;
  Gl: number;
  GwRaw: number;
  GlRaw: number;
  lobbyAvg?: number;
  winRate10?: number;
  winRate20?: number;
  forecast: Forecast;
  /** Matches that fed the estimate (not excluded). */
  usable: number;
  /** 'regression' when both sides had MIN_REGRESSION matches with details; else 'average'. */
  method: 'regression' | 'average';
  matches: MmrMatchRow[];
}

const clampTier = (t: number) => Math.min(MAX_TIER, Math.max(MIN_TIER, t));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

const TIER_GROUPS = ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Ascendant', 'Immortal'];

/** Competitive tier -> "Gold 3" (nearest division). `short` abbreviates long names for chart axes ("Plat 2", "Asc 1"). */
export function tierName(t: number, short = false): string {
  const n = Math.round(t);
  if (n < MIN_TIER) return 'Unrated';
  if (n >= MAX_TIER) return 'Radiant';
  const g = TIER_GROUPS[Math.floor((n - MIN_TIER) / 3)];
  const div = ((n - MIN_TIER) % 3) + 1;
  return short ? `${g.slice(0, g === 'Platinum' ? 4 : g === 'Ascendant' ? 3 : g === 'Immortal' ? 3 : g.length)} ${div}` : `${g} ${div}`;
}

export function gapLabel(gap: number): GapLabel {
  if (gap >= 1.5) return 'well above rank';
  if (gap >= 0.5) return 'above rank';
  if (gap > -0.5) return 'at rank';
  if (gap > -1.5) return 'below rank';
  return 'well below rank';
}

/** Raw Riot JSON (Matches[] entry) -> CompUpdate. Missing numbers become 0. */
export function parseUpdate(u: any): CompUpdate | null {
  if (!u || typeof u.MatchID !== 'string') return null;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    matchId: u.MatchID,
    startTime: n(u.MatchStartTime),
    seasonId: String(u.SeasonID ?? '').toLowerCase(),
    tierBefore: n(u.TierBeforeUpdate),
    tierAfter: n(u.TierAfterUpdate),
    rrBefore: n(u.RankedRatingBeforeUpdate),
    rrAfter: n(u.RankedRatingAfterUpdate),
    rrEarned: n(u.RankedRatingEarned),
    perfBonus: u.RankedRatingPerformanceBonus != null && Number.isFinite(Number(u.RankedRatingPerformanceBonus)) ? Number(u.RankedRatingPerformanceBonus) : undefined,
    afkPenalty: n(u.AFKPenalty),
  };
}

/** Mean competitive tier of the other players, ignoring unranked (< Iron 1). Undefined when none are ranked. */
export function lobbyAverage(otherTiers: number[]): number | undefined {
  const ranked = otherTiers.filter((t) => t >= MIN_TIER);
  return ranked.length ? mean(ranked) : undefined;
}

export function excludeReason(u: CompUpdate, f: MatchFacts | undefined, actId?: string): ExcludeReason | undefined {
  if (actId && u.seasonId && u.seasonId !== actId.toLowerCase()) return 'other act';
  if (u.tierBefore < MIN_TIER) return 'placement';
  if (u.afkPenalty !== 0) return 'afk';
  if (f) {
    if (f.result === 'D') return 'draw';
    if (f.totalRounds > 0 && f.totalRounds < 5 && u.rrEarned === 0) return 'remake';
    if ((f.partySize ?? 0) >= 5) return '5-stack';
  } else if (u.rrEarned === 0) {
    return 'draw'; // no details: 0 RR is a draw or a remake
  }
  return undefined;
}

/** Least squares y = b0 + b1·x1 + b2·x2. Null when the system is singular (e.g. every ACS identical). */
export function fit3(rows: { y: number; x1: number; x2: number }[]): [number, number, number] | null {
  if (rows.length < 3) return null;
  // Normal equations: (XᵀX)β = Xᵀy
  const s = { n: 0, x1: 0, x2: 0, x11: 0, x22: 0, x12: 0, y: 0, x1y: 0, x2y: 0 };
  for (const r of rows) {
    s.n++;
    s.x1 += r.x1;
    s.x2 += r.x2;
    s.x11 += r.x1 * r.x1;
    s.x22 += r.x2 * r.x2;
    s.x12 += r.x1 * r.x2;
    s.y += r.y;
    s.x1y += r.x1 * r.y;
    s.x2y += r.x2 * r.y;
  }
  const A = [
    [s.n, s.x1, s.x2],
    [s.x1, s.x11, s.x12],
    [s.x2, s.x12, s.x22],
  ];
  const b = [s.y, s.x1y, s.x2y];
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (!Number.isFinite(D) || Math.abs(D) < 1e-9 * Math.max(1, s.n ** 3)) return null;
  const col = (i: number) => A.map((row, r) => row.map((v, c) => (c === i ? b[r] : v)));
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

interface SideModel {
  /** Adjusted mean RR at roundDiff 0, ACS 200 (absolute value for losses). */
  G: number;
  /** Raw mean RR (absolute for losses). */
  raw: number;
  coef?: [number, number, number];
  n: number;
}

function side(rows: { u: CompUpdate; f?: MatchFacts }[]): SideModel {
  const raw = mean(rows.map((r) => Math.abs(r.u.rrEarned)));
  const withFacts = rows.filter((r) => r.f);
  if (withFacts.length >= MIN_REGRESSION) {
    const coef = fit3(withFacts.map((r) => ({ y: r.u.rrEarned, x1: r.f!.roundDiff, x2: (r.f!.acs - 200) / 100 })));
    if (coef) return { G: Math.abs(coef[0]), raw, coef, n: rows.length };
  }
  // Fallback: raw averages, minus the performance bonus when Riot sends it.
  const adj = mean(rows.map((r) => Math.abs(r.u.rrEarned - (r.u.perfBonus ?? 0))));
  return { G: rows.length ? adj : 0, raw, n: rows.length };
}

function tagFor(u: CompUpdate, f: MatchFacts | undefined, ex: ExcludeReason | undefined, w: SideModel, l: SideModel): string {
  if (ex) return `excluded: ${ex}`;
  if (u.perfBonus) return `performance bonus ${u.perfBonus > 0 ? '+' : ''}${u.perfBonus}`;
  const m = u.rrEarned > 0 ? w : l;
  if (m.coef && f) {
    const margin = Math.round(m.coef[1] * f.roundDiff);
    const perf = Math.round((m.coef[2] * (f.acs - 200)) / 100);
    if (Math.abs(margin) >= 1 && Math.abs(margin) >= Math.abs(perf)) return `${margin > 0 ? '+' : ''}${margin} from round margin`;
    if (Math.abs(perf) >= 1) return `${perf > 0 ? '+' : ''}${perf} from performance`;
  }
  const avg = u.rrEarned > 0 ? w.raw : -l.raw;
  const d = Math.round(u.rrEarned - avg);
  if (Math.abs(d) >= 2) return `${d > 0 ? '+' : ''}${d} vs your average ${u.rrEarned > 0 ? 'win' : 'loss'}`;
  return u.rrEarned > 0 ? 'a normal win' : u.rrEarned < 0 ? 'a normal loss' : 'no RR change';
}

function winRate(rows: { result: string }[]): number | undefined {
  const decided = rows.filter((r) => r.result === 'W' || r.result === 'L');
  return decided.length ? Math.round((decided.filter((r) => r.result === 'W').length / decided.length) * 100) : undefined;
}

/** Result of a match from its RR when details are missing. */
function resultOf(u: CompUpdate, f?: MatchFacts): MmrMatchRow['result'] {
  if (f && f.result !== '-') return f.result;
  return u.rrEarned > 0 ? 'W' : u.rrEarned < 0 ? 'L' : 'D';
}

function core(input: MmrInput, p: MmrParams, withRunning: boolean): MmrEstimate {
  const updates = [...input.updates].sort((a, b) => a.startTime - b.startTime);
  const inAct = updates.filter((u) => !input.actId || !u.seasonId || u.seasonId === input.actId.toLowerCase());
  const rows: { u: CompUpdate; f?: MatchFacts; ex?: ExcludeReason }[] = updates.map((u) => {
    const f = input.facts[u.matchId];
    return { u, f, ex: excludeReason(u, f, input.actId) };
  });
  const usable = rows.filter((r) => !r.ex && r.u.rrEarned !== 0);
  const wins = usable.filter((r) => r.u.rrEarned > 0);
  const losses = usable.filter((r) => r.u.rrEarned < 0);
  const w = side(wins);
  const l = side(losses);
  const method: MmrEstimate['method'] = w.coef && l.coef ? 'regression' : 'average';
  const splitKnown = wins.length > 0 && losses.length > 0;
  const gap = splitKnown ? (w.G - l.G) / p.rrPerDivision : 0;

  const lobbies = usable.map((r) => (r.f ? lobbyAverage(r.f.otherTiers) : undefined)).filter((x): x is number => x != null);
  const lobbyAvg = lobbies.length ? mean(lobbies) : undefined;
  const myTier = input.myTier >= MIN_TIER ? input.myTier : (inAct.at(-1)?.tierAfter ?? 0);

  // Without a rank there is no split term; without lobby data there is no lobby term.
  const splitPart = myTier >= MIN_TIER ? myTier + gap : undefined;
  let est = 0;
  if (lobbyAvg != null && splitPart != null) est = p.wLobby * lobbyAvg + p.wSplit * splitPart;
  else est = lobbyAvg ?? splitPart ?? 0;
  if (!usable.length) est = 0;
  const estTierDecimal = est ? clampTier(est) : 0;

  // Per-match gap estimates: one side of the split against the other side's mean.
  const per = splitKnown ? usable.map((r) => (r.u.rrEarned > 0 ? (Math.abs(r.u.rrEarned) - l.G) / p.rrPerDivision : (w.G - Math.abs(r.u.rrEarned)) / p.rrPerDivision)) : [];
  const m = mean(per);
  const spread = per.length > 1 ? Math.sqrt(per.reduce((a, x) => a + (x - m) ** 2, 0) / (per.length - 1)) : 0;

  const excludedShare = inAct.length ? rows.filter((r) => r.ex && r.ex !== 'other act').length / inAct.length : 0;
  const now = input.now ?? Date.now();
  const startOfAct = input.actStart != null && now - input.actStart < START_OF_ACT_MS;
  let confidence: Confidence;
  if (usable.length < 5 || startOfAct || excludedShare > 0.4) confidence = 'Low';
  else if (usable.length > 10 && spread <= SPREAD_HIGH) confidence = 'High';
  else confidence = 'Medium';

  const decidedInAct = rows.filter((r) => r.ex !== 'other act').map((r) => ({ result: resultOf(r.u, r.f) })).reverse();
  const forecast: Forecast = {
    winsToNext: w.raw > 0 && myTier >= MIN_TIER && myTier < MAX_TIER ? Math.max(1, Math.ceil((100 - Math.min(99, input.myRR)) / w.raw)) : undefined,
    nextTier: myTier >= MIN_TIER && myTier < MAX_TIER ? myTier + 1 : undefined,
    lossCost: l.raw > 0 ? Math.round(l.raw) : undefined,
    skipPossible: gap >= 2,
  };

  const matches: MmrMatchRow[] = rows.map((r, i) => ({
    matchId: r.u.matchId,
    startTime: r.u.startTime,
    result: resultOf(r.u, r.f),
    score: r.f?.score,
    mapId: r.f?.mapId,
    characterId: r.f?.characterId,
    rrEarned: r.u.rrEarned,
    tierAfter: r.u.tierAfter,
    rrAfter: r.u.rrAfter,
    lobbyAvg: r.f ? lobbyAverage(r.f.otherTiers) : undefined,
    excluded: r.ex,
    tag: tagFor(r.u, r.f, r.ex, w, l),
    estAfter: withRunning ? runningAt(input, p, updates, i) : undefined,
  }));

  return {
    estTier: estTierDecimal ? Math.round(estTierDecimal) : 0,
    estTierDecimal: round1(estTierDecimal),
    myTier,
    myRR: input.myRR,
    gapDivisions: round1(gap),
    label: gapLabel(gap),
    confidence,
    spread: round1(spread),
    Gw: round1(w.G),
    Gl: round1(l.G),
    GwRaw: round1(w.raw),
    GlRaw: round1(l.raw),
    lobbyAvg: lobbyAvg != null ? round1(lobbyAvg) : undefined,
    winRate10: winRate(decidedInAct.slice(0, 10)),
    winRate20: winRate(decidedInAct.slice(0, 20)),
    forecast,
    usable: usable.length,
    method,
    matches,
  };
}

/** Estimate using only the matches up to and including index i (chronological), with the rank after it. */
function runningAt(input: MmrInput, p: MmrParams, sorted: CompUpdate[], i: number): number | undefined {
  const prefix = sorted.slice(0, i + 1);
  const last = prefix[prefix.length - 1];
  const e = core({ ...input, updates: prefix, myTier: last.tierAfter, myRR: last.rrAfter }, p, false);
  return e.usable ? e.estTierDecimal : undefined;
}

/** The estimate, every per-match row, and the running estimate after each match. */
export function estimateMmr(input: MmrInput, params: MmrParams = DEFAULT_PARAMS): MmrEstimate {
  return core(input, params, true);
}

/** A plain sentence about what the gap means for climbing. */
export function climbSentence(e: Pick<MmrEstimate, 'label' | 'usable'>): string {
  if (!e.usable) return 'Play a few competitive matches this act to get an estimate.';
  switch (e.label) {
    case 'well above rank':
      return 'You gain a lot more than you lose, so you should climb fast, and may skip a division, until your rank catches up.';
    case 'above rank':
      return 'You gain more than you lose, so you’ll keep climbing faster than usual until your rank catches up.';
    case 'at rank':
      return 'Wins and losses are about even: your rank is where your MMR is, so climbing needs a win rate above 50%.';
    case 'below rank':
      return 'Losses cost more than wins give, so your rank drifts down towards your MMR unless you win more than you lose.';
    default:
      return 'Losses cost a lot more than wins give: your rank is ahead of your MMR and will keep sliding until they meet.';
  }
}

/** Match details -> the facts the model needs, for one player. Party size comes from partyId when present. */
export function factsFromDetails(
  d: { players: { subject: string; teamId: string; score: number; roundsPlayed: number; tier?: number; partyId?: string; characterId?: string }[]; teams: { teamId: string; won: boolean; roundsWon: number }[]; mapId?: string },
  puuid: string,
): MatchFacts | undefined {
  const me = d.players.find((p) => p.subject === puuid);
  if (!me) return undefined;
  const mine = d.teams.find((t) => t.teamId === me.teamId);
  const other = d.teams.find((t) => t.teamId !== me.teamId);
  const rd = mine && other ? mine.roundsWon - other.roundsWon : 0;
  const total = mine && other ? mine.roundsWon + other.roundsWon : 0;
  let result: MatchFacts['result'] = '-';
  if (mine && other) result = mine.won ? 'W' : other.won ? 'L' : rd === 0 ? 'D' : 'L';
  const party = me.partyId ? d.players.filter((p) => p.partyId === me.partyId).length : undefined;
  return {
    result,
    roundDiff: rd,
    totalRounds: total,
    acs: me.roundsPlayed > 0 ? me.score / me.roundsPlayed : 0,
    otherTiers: d.players.filter((p) => p.subject !== puuid).map((p) => p.tier ?? 0),
    partySize: party,
    score: mine && other ? `${mine.roundsWon}-${other.roundsWon}` : undefined,
    mapId: d.mapId,
    characterId: me.characterId,
  };
}
