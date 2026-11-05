import type { MatchResult, SvScore } from './types';

/**
 * SV Score: SexyVal's own 0-1000 rating from a player's recent matches. It is not Tracker Score
 * (that formula is proprietary) and is not comparable to it. It is a weighted blend of six stats,
 * each mapped linearly from its reference range onto 0..1 and clamped:
 *
 *   value <= lo  -> 0      value >= hi  -> 1
 *
 * The ranges are fixed (no percentiles from a population we don't have), chosen so an ordinary
 * ranked player lands near the middle and a player carrying their lobby lands near the top.
 */
export const REF = {
  /** Average combat score per round. ~200 is an ordinary ranked average; 300+ is top-fragging most games. */
  acs: { lo: 130, hi: 300 },
  /** Kills per death over the sample. 1.0 is even; 1.6 means winning most duels. */
  kd: { lo: 0.6, hi: 1.6 },
  /** Average damage per round. ~135 is ordinary; 180 is consistently high impact. */
  adr: { lo: 90, hi: 180 },
  /** Headshot share of hits, percent. Around 20% is common in ranked; 35% is exceptional aim. */
  hsPct: { lo: 10, hi: 35 },
  /** First kills per round. Ten players share about one per round, so 0.10 is average; 0.20 is an entry specialist. */
  fbPerRound: { lo: 0.04, hi: 0.2 },
  /** Wins / decided matches (draws and remakes ignored). Five games is a small sample, so the range is wide. */
  winRate: { lo: 0.3, hi: 0.7 },
} as const;

/** Weights sum to 1. Round impact (ACS, ADR) counts most, win rate least per point of sample noise. */
export const WEIGHTS = { acs: 0.3, kd: 0.2, adr: 0.15, hsPct: 0.1, fbPerRound: 0.1, winRate: 0.15 } as const;

/** Fewer matches with round data than this and there is no score ("—"). */
export const MIN_SAMPLE = 3;

/** One player's line in one match. `adr`/`firstBloods` are null when the match has no round data. */
export interface ScoreMatch {
  result: MatchResult;
  kills: number;
  deaths: number;
  acs: number;
  rounds?: number;
  adr?: number | null;
  hsPct?: number | null;
  firstBloods?: number | null;
}

const norm = (v: number, r: { lo: number; hi: number }) => Math.min(1, Math.max(0, (v - r.lo) / (r.hi - r.lo)));

export function svScore(matches: ScoreMatch[]): SvScore | null {
  const used = matches.filter((m) => (m.rounds ?? 0) > 0 && m.adr != null && m.firstBloods != null);
  if (used.length < MIN_SAMPLE) return null;
  const rounds = used.reduce((a, m) => a + (m.rounds ?? 0), 0);
  const perRound = (f: (m: ScoreMatch) => number) => used.reduce((a, m) => a + f(m) * (m.rounds ?? 0), 0) / rounds;
  const kills = used.reduce((a, m) => a + m.kills, 0);
  const deaths = used.reduce((a, m) => a + m.deaths, 0);
  const wins = used.filter((m) => m.result === 'W').length;
  const losses = used.filter((m) => m.result === 'L').length;
  const withHs = used.filter((m) => m.hsPct != null);
  const hsRounds = withHs.reduce((a, m) => a + (m.rounds ?? 0), 0);

  const acs = perRound((m) => m.acs);
  const kd = deaths > 0 ? kills / deaths : kills;
  const adr = perRound((m) => m.adr ?? 0);
  const hsPct = hsRounds ? withHs.reduce((a, m) => a + (m.hsPct ?? 0) * (m.rounds ?? 0), 0) / hsRounds : 0;
  const fbPerRound = used.reduce((a, m) => a + (m.firstBloods ?? 0), 0) / rounds;
  const winRate = wins + losses ? wins / (wins + losses) : 0.5;

  const blend =
    WEIGHTS.acs * norm(acs, REF.acs) +
    WEIGHTS.kd * norm(kd, REF.kd) +
    WEIGHTS.adr * norm(adr, REF.adr) +
    WEIGHTS.hsPct * norm(hsPct, REF.hsPct) +
    WEIGHTS.fbPerRound * norm(fbPerRound, REF.fbPerRound) +
    WEIGHTS.winRate * norm(winRate, REF.winRate);

  return {
    score: Math.round(blend * 1000),
    sample: used.length,
    parts: {
      acs: Math.round(acs),
      kd: Math.round(kd * 100) / 100,
      adr: Math.round(adr),
      hsPct: Math.round(hsPct),
      fbPerRound: Math.round(fbPerRound * 100) / 100,
      wins,
      losses,
    },
  };
}
