import { describe, expect, it } from 'vitest';
import { fit3, lobbyAverage } from '../shared/mmr';
import {
  blendInverseVariance,
  buildSquad,
  fitRidge,
  fiveStackPenaltyRisk,
  huberMean,
  impliedMe,
  measureFiveStack,
  normalisePenalty,
  rankWindow,
  SPLIT_FLOOR,
  stackBreakdown,
  TEAM_FLOOR,
  teamFactsFromDetails,
  teamLobbyValue,
  teamProxy,
  type PremadeInfo,
  type WindowMatch,
} from '../shared/team';
import { matchDetails, mates } from './teamFixtures';

const ME = 'me';

describe('shared/team: teamFactsFromDetails', () => {
  it('stack size 1/2/3/5 from partyId; your premades and randoms', () => {
    for (const n of [1, 2, 3, 5]) {
      const prem = Array.from({ length: n - 1 }, (_, i) => ({ id: `f${i}`, tier: 14 }));
      const tf = teamFactsFromDetails(matchDetails({ id: `s${n}`, me: ME, myTier: 14, mates: mates(14, prem, `s${n}`), enemies: [14, 14, 14, 14, 14], win: true }), ME)!;
      expect(tf.stack).toBe(n);
      expect(tf.premades.map((p) => p.puuid)).toEqual(prem.map((p) => p.id));
      expect(tf.randoms).toHaveLength(5 - n);
      expect(tf.enemies).toHaveLength(5);
    }
  });

  it('missing partyId is "unknown", never guessed; a 4-stack is reported as the data says', () => {
    const none = teamFactsFromDetails(matchDetails({ id: 'x', me: ME, myTier: 14, mates: mates(14, [{ id: 'f', tier: 14 }]), enemies: [14, 14, 14, 14, 14], win: true, partyData: false }), ME)!;
    expect(none.stack).toBe('unknown');
    expect(none.premades).toHaveLength(0);
    const four = teamFactsFromDetails(matchDetails({ id: 'q', me: ME, myTier: 14, mates: mates(14, [1, 2, 3].map((i) => ({ id: `f${i}`, tier: 14 }))), enemies: [14, 14, 14, 14, 14], win: false }), ME)!;
    expect(four.stack).toBe(4);
  });

  it('z-scores sum to ~0 across the match; ACS place on your team', () => {
    const d = matchDetails({ id: 'z', me: ME, myTier: 14, myAcs: 260, mates: [{ id: 'a', tier: 14, acs: 300 }, { id: 'b', tier: 14, acs: 150 }, { id: 'c', tier: 14, acs: 200 }, { id: 'd', tier: 14, acs: 180 }], enemies: [{ id: 'e1', tier: 14, acs: 240 }, { id: 'e2', tier: 14, acs: 210 }, { id: 'e3', tier: 14, acs: 190 }, { id: 'e4', tier: 14, acs: 170 }, { id: 'e5', tier: 14, acs: 230 }], win: true });
    const tf = teamFactsFromDetails(d, ME)!;
    const zs = Object.values(tf.z);
    expect(zs).toHaveLength(10);
    expect(Math.abs(zs.reduce((a, b) => a + b, 0))).toBeLessThan(1e-9);
    expect(tf.myAcsPlace).toBe(2);
    expect(tf.teamPlace.a).toBe(1);
    expect(tf.teamPlace.b).toBe(5);
    expect(tf.z.a).toBeGreaterThan(0);
    expect(tf.z.b).toBeLessThan(0);
  });

  it('team averages use ranked tiers only, you included', () => {
    const tf = teamFactsFromDetails(matchDetails({ id: 't', me: ME, myTier: 15, mates: [{ id: 'a', tier: 0 }, { id: 'b', tier: 13 }, { id: 'c', tier: 14 }, { id: 'd', tier: 14 }], enemies: [14, 0, 16, 14, 14], win: false }), ME)!;
    expect(tf.myTeamAvgTier).toBe((15 + 13 + 14 + 14) / 4);
    expect(tf.enemyAvgTier).toBe(14.5);
    expect(tf.result).toBe('L');
    expect(tf.roundDiff).toBe(-4);
  });
});

describe('shared/team: team-adjusted lobby signal', () => {
  it('a solo match in a balanced lobby collapses to the raw lobby average', () => {
    const d = matchDetails({ id: 'solo', me: ME, myTier: 14, mates: [13, 14, 15, 14].map((t, i) => ({ id: `r${i}`, tier: t })), enemies: [14, 13, 15, 14, 14], win: true });
    const tf = teamFactsFromDetails(d, ME)!;
    const raw = lobbyAverage(d.players.filter((p) => p.subject !== ME).map((p) => p.tier ?? 0))!;
    expect(impliedMe(tf)).toBeCloseTo(14, 5);
    expect(Math.abs(impliedMe(tf)! - raw)).toBeLessThan(0.2);
    // The signal itself uses the raw lobby in solo games (same expectation, a quarter of the noise).
    expect(teamLobbyValue(tf, raw, teamProxy())).toBe(raw);
  });

  it('a duo with a friend 3 divisions below lifts impliedMe above the raw lobby', () => {
    // You 16, friend 13: the matchmaker fills around the party's 14.5.
    const d = matchDetails({ id: 'duo', me: ME, myTier: 15, mates: mates(14.5, [{ id: 'friend', tier: 13 }], 'duo'), enemies: [14.5, 14.5, 14.5, 14.5, 14.5], win: true });
    const tf = teamFactsFromDetails(d, ME)!;
    const raw = lobbyAverage(d.players.filter((p) => p.subject !== ME).map((p) => p.tier ?? 0))!;
    expect(raw).toBeCloseTo(14.33, 1);
    expect(impliedMe(tf)).toBeCloseTo(16, 5);
    // With the friend's own estimated MMR (12) as the proxy it rises further.
    expect(impliedMe(tf, teamProxy({ friend: 12 }))).toBeCloseTo(17, 5);
    expect(teamLobbyValue(tf, raw, teamProxy())).toBeCloseTo(16, 5);
  });

  it('rescales to the players actually ranked and skips thin lobbies', () => {
    const one = teamFactsFromDetails(matchDetails({ id: 'u', me: ME, myTier: 14, mates: [{ id: 'a', tier: 0 }, { id: 'b', tier: 14 }, { id: 'c', tier: 14 }, { id: 'd', tier: 14 }], enemies: [14, 14, 14, 14, 0], win: true }), ME)!;
    expect(impliedMe(one)).toBeCloseTo(14, 5); // (1 + 3) · 14 − 3 · 14
    const thin = teamFactsFromDetails(matchDetails({ id: 'v', me: ME, myTier: 14, mates: [{ id: 'a', tier: 0 }, { id: 'b', tier: 0 }, { id: 'c', tier: 14 }, { id: 'd', tier: 14 }], enemies: [14, 14, 14, 14, 14], win: true }), ME)!;
    expect(impliedMe(thin)).toBeUndefined();
    const fewEnemies = teamFactsFromDetails(matchDetails({ id: 'w', me: ME, myTier: 14, mates: mates(14), enemies: [14, 14, 14, 0, 0], win: true }), ME)!;
    expect(impliedMe(fewEnemies)).toBeUndefined();
  });

  it('PARTY_TOP_WEIGHT: no effect solo, and the balance still solves for you', () => {
    const solo = teamFactsFromDetails(matchDetails({ id: 's', me: ME, myTier: 14, mates: mates(14), enemies: [14, 14, 14, 14, 15], win: true }), ME)!;
    expect(impliedMe(solo, teamProxy(), 0.5)).toBeCloseTo(impliedMe(solo, teamProxy(), 0)!, 9);
    const duo = teamFactsFromDetails(matchDetails({ id: 'd', me: ME, myTier: 15, mates: mates(14.5, [{ id: 'friend', tier: 13 }], 'd'), enemies: [14.5, 14.5, 14.5, 14.5, 14.5], win: true }), ME)!;
    const me = impliedMe(duo, teamProxy(), 0.5)!;
    // Party value = 0.5 · mean(me, 13) + 0.5 · max(me, 13) must equal the party's share of the balance (14.5).
    expect(0.5 * ((me + 13) / 2) + 0.5 * Math.max(me, 13)).toBeCloseTo(14.5, 9);
    expect(me).toBeLessThan(impliedMe(duo, teamProxy(), 0)!); // top-weighted: you count more, so less is implied
  });

  it('Huber mean resists one outlier lobby', () => {
    const xs = [14.1, 13.9, 14.2, 13.8, 14, 14.1, 13.9, 24];
    const h = huberMean(xs)!;
    const plain = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(plain).toBeGreaterThan(15);
    expect(h.mean).toBeLessThan(14.4);
    expect(h.se).toBeGreaterThan(0);
    expect(huberMean([])).toBeUndefined();
  });

  it('inverse-variance blend moves toward the lower-variance signal, floors respected', () => {
    const tightSplit = blendInverseVariance({ value: 14, spread: 0.5, n: 20 }, { value: 16, se: 2 });
    const tightTeam = blendInverseVariance({ value: 14, spread: 3, n: 5 }, { value: 16, se: 0.1 });
    expect(tightSplit.wSplit).toBeGreaterThan(0.75);
    expect(tightTeam.wTeam).toBeGreaterThan(0.5);
    expect(tightSplit.est).toBeLessThan(tightTeam.est);
    // Zero sample variance on both sides: only the floors are left.
    const floors = blendInverseVariance({ value: 14, spread: 0, n: 20 }, { value: 16, se: 0 });
    const expectTeam = 1 / TEAM_FLOOR ** 2 / (1 / SPLIT_FLOOR ** 2 + 1 / TEAM_FLOOR ** 2);
    expect(floors.wTeam).toBeCloseTo(expectTeam, 9);
    expect(floors.wSplit + floors.wTeam).toBeCloseTo(1, 9);
    expect(floors.wTeam).toBeLessThan(0.5);
  });
});

describe('shared/team: 5-stacks, party penalty, rank windows', () => {
  it('measures a 25% cut per side, needs 3 samples per side and group', () => {
    const rows = [
      ...[20, 22, 18, 21].map((rr) => ({ rr, stack: 1 as const })),
      ...[-18, -20, -19].map((rr) => ({ rr, stack: 2 as const })),
      ...[15, 16, 14].map((rr) => ({ rr, stack: 5 as const })),
      ...[-14, -15, -14].map((rr) => ({ rr, stack: 5 as const })),
    ];
    const f = measureFiveStack(rows);
    expect(f.win).toBeCloseTo(15 / 20.5, 3);
    expect(f.loss).toBeCloseTo(14 / 19, 3);
    expect(Math.abs(f.five! - 0.75)).toBeLessThan(0.05);
    expect(measureFiveStack(rows.slice(0, 12)).loss).toBeUndefined(); // two 5-stack losses only
  });

  it('SkillDisparityRRPenalty: fraction or percentage, normalised to 0–1', () => {
    expect(normalisePenalty(0)).toBe(0);
    expect(normalisePenalty(0.25)).toBe(0.25);
    expect(normalisePenalty(25)).toBe(0.25);
    expect(normalisePenalty('75')).toBe(0.75);
    expect(normalisePenalty(undefined)).toBeUndefined();
    expect(normalisePenalty('n/a')).toBeUndefined();
    expect(normalisePenalty(-3)).toBe(0);
  });

  it('community rank windows: wide at low ranks, tight from Platinum, Immortal always a risk', () => {
    expect(rankWindow(12)).toBe(6);
    expect(rankWindow(16)).toBe(3);
    expect(fiveStackPenaltyRisk([12, 14])).toBe(false);
    expect(fiveStackPenaltyRisk([12, 16])).toBe(true);
    expect(fiveStackPenaltyRisk([20, 23])).toBe(false);
    expect(fiveStackPenaltyRisk([22, 24])).toBe(true);
  });
});

describe('shared/team: ridge regression', () => {
  it('λ = 0 is ordinary least squares (same as fit3)', () => {
    const rows = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ x1: i, x2: (i * i) % 5, y: 10 + 2 * i - 3 * ((i * i) % 5) + (i % 2 ? 0.3 : -0.3) }));
    const ols = fit3(rows)!;
    const r = fitRidge(rows.map((x) => ({ y: x.y, x: [1, x.x1, x.x2] })), 0, [false, false, false])!;
    r.forEach((b, i) => expect(b).toBeCloseTo(ols[i], 9));
  });

  it('singular without the penalty, solvable with it (two premades who always queue together)', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ y: i < 5 ? -10 : 15, x: [1, i < 5 ? 1 : 0, i < 5 ? 1 : 0] }));
    expect(fitRidge(rows, 0, [false, true, true])).toBeNull();
    const b = fitRidge(rows, 3, [false, true, true])!;
    expect(b[1]).toBeCloseTo(b[2], 9);
    expect(b[1]).toBeLessThan(0);
  });

  it('A is always with B and only A hurts: the effect lands on A', () => {
    const rows: { y: number; x: number[] }[] = [];
    for (let i = 0; i < 6; i++) rows.push({ y: i % 2 ? -14 : -16, x: [1, 1, 1] }); // A + B
    for (let i = 0; i < 6; i++) rows.push({ y: i % 2 ? 6 : 4, x: [1, 0, 1] }); // B alone
    for (let i = 0; i < 8; i++) rows.push({ y: i % 2 ? 6 : 4, x: [1, 0, 0] }); // solo
    const [, a, b] = fitRidge(rows, 3, [false, true, true])!;
    // True effect of A: −20 RR per game. Ridge shrinks it a little but keeps it on A, not B.
    expect(a).toBeLessThan(-9);
    expect(Math.abs(b)).toBeLessThan(4);
    expect(Math.abs(a) / (Math.abs(a) + Math.abs(b))).toBeGreaterThan(0.75);
    // Without the penalty (λ = 0) all of it is A's.
    const [, a0, b0] = fitRidge(rows, 0, [false, true, true])!;
    expect(a0).toBeCloseTo(-20, 6);
    expect(b0).toBeCloseTo(0, 6);
  });
});

/** A 24-match window: solo, drain (D), carry (C), neutral (N), rare (R, 2 games). */
function squadWindow(): WindowMatch[] {
  const plan: { prem: string[]; res: ('W' | 'L')[] }[] = [
    { prem: [], res: ['W', 'L', 'W', 'L', 'W', 'W', 'L', 'L'] },
    { prem: ['D'], res: ['L', 'L', 'W', 'L'] },
    { prem: ['C'], res: ['W', 'W', 'L', 'W'] },
    { prem: ['N'], res: ['W', 'L', 'W', 'L'] },
    { prem: ['D', 'C'], res: ['L', 'W'] },
    { prem: ['R', 'N'], res: ['W', 'L'] },
  ];
  const acs: Record<string, number> = { D: 150, C: 300, N: 205, R: 210 };
  const out: WindowMatch[] = [];
  let k = 0;
  for (const p of plan) {
    for (const r of p.res) {
      const id = `w${k}`;
      const team = mates(14, p.prem.map((x) => ({ id: x, tier: x === 'D' ? 12 : x === 'C' ? 15 : 14, acs: acs[x] })), id);
      // Balanced like real matchmaking, on MMR: D's MMR (11) is below his rank, C's (16) above, the rest at rank.
      const mmr: Record<string, number> = { D: 11, C: 16 };
      const avg = (14 + team.reduce((a, m) => a + (mmr[m.id] ?? m.tier), 0)) / 5;
      const d = matchDetails({ id, me: ME, myTier: 14, myAcs: 210, mates: team, enemies: [avg, avg, avg, avg, avg], win: r === 'W', startTime: 1000 + k });
      const tf = teamFactsFromDetails(d, ME)!;
      out.push({ matchId: id, startTime: 1000 + k, rr: r === 'W' ? 20 : -18, result: r, stack: tf.stack, tf, mapId: 'map', score: r === 'W' ? '13-9' : '9-13' });
      k++;
    }
  }
  return out;
}

describe('shared/team: stack breakdown and squad report', () => {
  const info: Record<string, PremadeInfo> = {
    D: { status: 'ready', tier: 12, estMmr: 11 },
    C: { status: 'ready', tier: 15, estMmr: 16 },
    N: { status: 'ready', tier: 14, estMmr: 14 },
  };

  it('stack breakdown: totals equal the window, empty groups say games 0', () => {
    const w = squadWindow();
    const s = stackBreakdown(w);
    expect(s.map((x) => x.stack)).toEqual([1, 2, 3, 5, 'unknown']);
    expect(s.reduce((a, x) => a + x.games, 0)).toBe(w.length);
    expect(s.reduce((a, x) => a + x.wins, 0)).toBe(w.filter((m) => m.result === 'W').length);
    expect(s.reduce((a, x) => a + x.netRR, 0)).toBe(w.reduce((a, m) => a + m.rr, 0));
    expect(s.find((x) => x.stack === 5)!.games).toBe(0);
    expect(s.find((x) => x.stack === 2)!).toMatchObject({ games: 12, wins: 6, losses: 6, avgWinRR: 20, avgLossRR: -18 });
  });

  it('ranks drain first, carry last, never ranks the rare one; numbers are deterministic', () => {
    const w = squadWindow();
    const a = buildSquad({ matches: w, you: { puuid: ME, tier: 14, est: 14 }, premades: info });
    const b = buildSquad({ matches: w, you: { puuid: ME, tier: 14, est: 14 }, premades: info });
    expect(a).toEqual(b);
    const order = a.squad.map((r) => r.puuid);
    expect(order).toEqual(['D', 'N', 'C', 'R']);
    const [d, n, c, r] = a.squad;
    expect(d.drain!).toBeGreaterThan(25);
    expect(d.verdict).toBe('biggest drain');
    expect(c.verdict).toBe('best partner');
    expect(c.drain!).toBeLessThan(-25);
    expect(n.verdict).toBe('neutral');
    expect(r).toMatchObject({ eligible: false, verdict: 'not enough games', games: 2 });
    // Raw with/without, shrinkage, interval.
    expect(d.games).toBe(6);
    expect(d.deltaRRPerGame!).toBeLessThan(0);
    expect(d.shrunkDelta!).toBeCloseTo((d.deltaRRPerGame! * 6) / 11, 0);
    expect(d.interval![0]).toBeLessThanOrEqual(d.shrunkDelta!);
    expect(d.interval![1]).toBeGreaterThanOrEqual(d.shrunkDelta!);
    expect(d.intervalMethod).toBe('bootstrap');
    expect(d.beta!).toBeLessThan(0);
    expect(c.beta!).toBeGreaterThan(0);
    expect(d.rrCostEstimate!).toBeLessThan(0);
    expect(c.rrCostEstimate!).toBeGreaterThan(0);
    // Performance in shared games, and the same numbers for you.
    expect(d.them.acs).toBe(150);
    expect(d.them.bottomFragLosses).toBe(1);
    expect(d.them.meanZLosses!).toBeLessThan(-0.5);
    expect(d.you.games).toBe(d.games);
    expect(d.mmrGapVsYou).toBe(3);
    expect(c.mmrGapVsYou).toBe(-2);
    expect(d.shared).toHaveLength(6);
    expect(a.ridge!.n).toBe(24);
    expect(a.randoms.soloGames).toBe(8);
    expect(a.randoms.soloRRPerGame).toBe(1);
  });

  it('hidden premades: listed as hidden with no name, card or MMR of their own', () => {
    const w = squadWindow();
    for (const m of w) for (const p of m.tf!.premades) if (p.puuid === 'D') Object.assign(p, { gameName: 'Rahul', tagLine: 'drain', cardId: 'card' });
    const s = buildSquad({ matches: w, you: { puuid: ME, tier: 14, est: 14 }, premades: { ...info, D: { status: 'hidden', estMmr: 11, tier: 12 } } });
    const d = s.squad.find((r) => r.puuid === 'D')!;
    expect(d).toMatchObject({ hidden: true, status: 'hidden' });
    expect(d.theirEstMmr).toBeUndefined();
    expect(d.theirTier).toBeUndefined();
    expect(d.mmrGapVsYou).toBeUndefined();
    expect(d.gameName).toBeUndefined();
    expect(d.cardId).toBeUndefined();
    // Their lines in your matches still count (your data).
    expect(d.games).toBe(6);
    expect(d.them.acs).toBe(150);
  });

  it('a premade in nearly every match is listed but not ranked: no games without them to compare', () => {
    const w = squadWindow().map((m, i) => {
      if (m.tf!.premades.some((p) => p.puuid === 'N') || i >= 22) return m;
      const tf = { ...m.tf!, premades: [...m.tf!.premades, { ...m.tf!.randoms[0], puuid: 'N', premade: true }], randoms: m.tf!.randoms.slice(1) };
      return { ...m, tf, stack: (m.tf!.premades.length + 2) as 2 | 3 };
    });
    const n = buildSquad({ matches: w, you: { puuid: ME, tier: 14 } }).squad.find((r) => r.puuid === 'N')!;
    expect(n.without.games).toBeLessThan(3);
    expect(n).toMatchObject({ eligible: false, verdict: 'not enough games' });
  });

  it('matches without party data are left out of every squad number', () => {
    const w = squadWindow().map((m, i) => (i < 4 ? { ...m, stack: 'unknown' as const } : m));
    const s = buildSquad({ matches: w, you: { puuid: ME, tier: 14 } });
    expect(s.ridge!.n).toBe(20);
    expect(s.randoms.soloGames).toBe(4);
  });
});
