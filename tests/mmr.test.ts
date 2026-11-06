import { describe, expect, it } from 'vitest';
import { climbSentence, estimateMmr, excludeReason, factsFromDetails, fit3, gapLabel, lobbyAverage, MAX_TIER, MIN_TIER, parseUpdate, RR_PER_DIVISION, type CompUpdate, type MatchFacts, type MmrInput } from '../shared/mmr';

const ACT = 'act-now';
const DAY = 86400_000;
const NOW = Date.UTC(2026, 10, 6);

interface Spec {
  win: number; // base win RR at rd 0
  loss: number; // base loss RR (negative) at rd 0
  lobby: number; // lobby tier
  n?: number;
  winEvery?: number; // every k-th match is a loss
  margin?: number; // RR per round of margin
  perf?: number; // RR per 100 ACS over 200
  myTier?: number;
}

/** Builds a deterministic act of matches whose RR follows base + margin·rd + perf·(acs-200)/100. */
function persona(s: Spec): MmrInput {
  const n = s.n ?? 20;
  const updates: CompUpdate[] = [];
  const facts: Record<string, MatchFacts> = {};
  const tier = s.myTier ?? 14;
  let rr = 50;
  for (let i = 0; i < n; i++) {
    const win = i % (s.winEvery ?? 2) !== 0;
    const rd = win ? 2 + (i % 7) : -(2 + ((i * 3) % 7));
    const acs = 160 + ((i * 37) % 120);
    const base = win ? s.win : s.loss;
    const earned = Math.round(base + (s.margin ?? 0) * rd + ((s.perf ?? 0) * (acs - 200)) / 100);
    const id = `m${i}`;
    updates.push({ matchId: id, startTime: NOW - (n - i) * DAY / 4, seasonId: ACT, tierBefore: tier, tierAfter: tier, rrBefore: rr, rrAfter: rr + earned, rrEarned: earned, afkPenalty: 0 });
    rr = Math.max(0, Math.min(99, rr + earned));
    facts[id] = { result: win ? 'W' : 'L', roundDiff: rd, totalRounds: 13 + Math.abs(rd) % 11, acs, otherTiers: Array.from({ length: 9 }, (_, k) => s.lobby + ((k % 3) - 1)), partySize: 1, score: win ? `13-${13 - rd}` : `${13 + rd}-13` };
  }
  return { updates, facts, myTier: s.myTier ?? 14, myRR: 64, actId: ACT, actStart: NOW - 40 * DAY, now: NOW };
}

describe('shared/mmr: personas', () => {
  it('well above rank: +25/−12 with high lobbies', () => {
    const e = estimateMmr(persona({ win: 25, loss: -12, lobby: 16 }));
    expect(e.label).toBe('well above rank');
    expect(e.gapDivisions).toBeGreaterThanOrEqual(2);
    expect(e.estTier).toBeGreaterThan(e.myTier);
    expect(e.forecast.skipPossible).toBe(true);
    expect(climbSentence(e)).toMatch(/climb fast/);
  });

  it('at rank: +19/−18', () => {
    const e = estimateMmr(persona({ win: 19, loss: -18, lobby: 14 }));
    expect(e.label).toBe('at rank');
    expect(e.estTier).toBe(14);
    expect(e.forecast.skipPossible).toBe(false);
  });

  it('below rank: +13/−24 with low lobbies', () => {
    const e = estimateMmr(persona({ win: 13, loss: -24, lobby: 11 }));
    expect(e.label).toBe('well below rank');
    expect(e.estTier).toBeLessThan(e.myTier);
  });

  it('mostly excluded: Low confidence and the reasons are kept on the rows', () => {
    const input = persona({ win: 20, loss: -20, lobby: 14, n: 10 });
    input.updates.forEach((u, i) => {
      if (i < 4) u.afkPenalty = -3;
      else if (i < 7) input.facts[u.matchId]!.partySize = 5;
    });
    const e = estimateMmr(input);
    expect(e.confidence).toBe('Low');
    expect(e.usable).toBe(3);
    expect(e.matches.filter((m) => m.excluded === 'afk')).toHaveLength(4);
    expect(e.matches.filter((m) => m.excluded === '5-stack')).toHaveLength(3);
    expect(e.matches.find((m) => m.excluded)!.tag).toBe('excluded: afk');
  });
});

describe('shared/mmr: cleaning the RR', () => {
  it('regression recovers the base RR when round margin drives it', () => {
    const e = estimateMmr(persona({ win: 18, loss: -18, lobby: 14, margin: 1, perf: 2 }));
    expect(e.method).toBe('regression');
    // Raw averages are inflated by the margin (wins always have rd > 0); the regression strips it.
    expect(e.GwRaw).toBeGreaterThan(e.Gw + 2);
    expect(e.Gw).toBeCloseTo(18, 0);
    expect(e.Gl).toBeCloseTo(18, 0);
    expect(e.label).toBe('at rank');
    expect(e.matches.some((m) => /from round margin/.test(m.tag))).toBe(true);
  });

  it('falls back to raw averages (minus the performance bonus) under 6 wins or 6 losses', () => {
    const input = persona({ win: 20, loss: -15, lobby: 14, n: 9 });
    input.updates.forEach((u) => {
      if (u.rrEarned > 0) {
        u.perfBonus = 3;
      }
    });
    const e = estimateMmr(input);
    expect(e.method).toBe('average');
    expect(e.GwRaw).toBe(20);
    expect(e.Gw).toBe(17); // 20 - 3 bonus
    expect(e.Gl).toBe(15);
    expect(e.gapDivisions).toBeCloseTo((17 - 15) / RR_PER_DIVISION, 1);
    expect(e.matches.find((m) => m.rrEarned > 0)!.tag).toBe('performance bonus +3');
  });

  it('fit3 solves an exact plane and refuses a singular one', () => {
    const rows = [0, 1, 2, 3, 4, 5].map((i) => ({ x1: i, x2: (i * i) % 5, y: 10 + 2 * i - 3 * ((i * i) % 5) }));
    const c = fit3(rows)!;
    expect(c[0]).toBeCloseTo(10);
    expect(c[1]).toBeCloseTo(2);
    expect(c[2]).toBeCloseTo(-3);
    expect(fit3(rows.map((r) => ({ ...r, x2: 1 })))).toBeNull();
  });
});

describe('shared/mmr: exclusions', () => {
  const u = (o: Partial<CompUpdate> = {}): CompUpdate => ({ matchId: 'x', startTime: 0, seasonId: ACT, tierBefore: 14, tierAfter: 14, rrBefore: 10, rrAfter: 30, rrEarned: 20, afkPenalty: 0, ...o });
  const f = (o: Partial<MatchFacts> = {}): MatchFacts => ({ result: 'W', roundDiff: 3, totalRounds: 23, acs: 220, otherTiers: [], ...o });
  it('placement, afk, remake, draw, 5-stack and other acts', () => {
    expect(excludeReason(u({ tierBefore: 0 }), f(), ACT)).toBe('placement');
    expect(excludeReason(u({ afkPenalty: -5 }), f(), ACT)).toBe('afk');
    expect(excludeReason(u({ rrEarned: 0 }), f({ totalRounds: 2, result: 'L' }), ACT)).toBe('remake');
    expect(excludeReason(u({ rrEarned: 0 }), f({ result: 'D', roundDiff: 0 }), ACT)).toBe('draw');
    expect(excludeReason(u(), f({ partySize: 5 }), ACT)).toBe('5-stack');
    expect(excludeReason(u({ seasonId: 'old-act' }), f(), ACT)).toBe('other act');
    expect(excludeReason(u(), f({ partySize: 3 }), ACT)).toBeUndefined();
  });

  it('earlier acts are ignored by the estimate but still listed', () => {
    const input = persona({ win: 19, loss: -18, lobby: 14 });
    input.updates.slice(0, 5).forEach((x) => (x.seasonId = 'old-act'));
    const e = estimateMmr(input);
    expect(e.usable).toBe(15);
    expect(e.matches.filter((m) => m.excluded === 'other act')).toHaveLength(5);
  });

  it('parses Riot JSON, keeping a missing performance bonus undefined', () => {
    const p = parseUpdate({ MatchID: 'a', MatchStartTime: 5, SeasonID: 'ACT', TierBeforeUpdate: 12, TierAfterUpdate: 13, RankedRatingBeforeUpdate: 90, RankedRatingAfterUpdate: 10, RankedRatingEarned: 20, AFKPenalty: 0 })!;
    expect(p).toMatchObject({ seasonId: 'act', tierBefore: 12, tierAfter: 13, rrEarned: 20 });
    expect(p.perfBonus).toBeUndefined();
    expect(parseUpdate({})).toBeNull();
  });
});

describe('shared/mmr: limits, confidence, forecast', () => {
  it('clamps to Iron 1 … Radiant', () => {
    const top = estimateMmr(persona({ win: 40, loss: -5, lobby: 27, myTier: 27 }));
    expect(top.estTierDecimal).toBe(MAX_TIER);
    const bottom = estimateMmr(persona({ win: 5, loss: -40, lobby: 3, myTier: 3 }));
    expect(bottom.estTierDecimal).toBe(MIN_TIER);
  });

  it('confidence: Low under 5 or at the start of the act, Medium 5-10, High over 10 with low spread', () => {
    expect(estimateMmr(persona({ win: 19, loss: -18, lobby: 14, n: 4 })).confidence).toBe('Low');
    expect(estimateMmr(persona({ win: 19, loss: -18, lobby: 14, n: 8 })).confidence).toBe('Medium');
    const high = estimateMmr(persona({ win: 19, loss: -18, lobby: 14, n: 20 }));
    expect(high.confidence).toBe('High');
    expect(high.spread).toBeLessThanOrEqual(1.5);
    const young = persona({ win: 19, loss: -18, lobby: 14, n: 20 });
    young.actStart = NOW - DAY;
    expect(estimateMmr(young).confidence).toBe('Low');
    // Noisy RR: lots of spread keeps it at Medium even with 20 matches.
    const noisy = persona({ win: 19, loss: -18, lobby: 14, n: 20, perf: 25 });
    expect(estimateMmr(noisy).spread).toBeGreaterThan(1.5);
    expect(estimateMmr(noisy).confidence).toBe('Medium');
  });

  it('forecast: wins to next division at the raw win RR, cost of a loss, division skip flag', () => {
    const e = estimateMmr(persona({ win: 25, loss: -12, lobby: 16 }));
    expect(e.forecast.winsToNext).toBe(Math.ceil((100 - 64) / e.GwRaw));
    expect(e.forecast.nextTier).toBe(15);
    expect(e.forecast.lossCost).toBe(Math.round(e.GlRaw));
    expect(e.forecast.skipPossible).toBe(true);
  });

  it('gap labels at their edges', () => {
    expect(gapLabel(1.5)).toBe('well above rank');
    expect(gapLabel(0.5)).toBe('above rank');
    expect(gapLabel(0.49)).toBe('at rank');
    expect(gapLabel(-0.5)).toBe('below rank');
    expect(gapLabel(-1.5)).toBe('well below rank');
  });

  it('running estimate on every usable match, and an empty act says so', () => {
    const e = estimateMmr(persona({ win: 25, loss: -12, lobby: 16 }));
    expect(e.matches.at(-1)!.estAfter).toBeCloseTo(e.estTierDecimal, 0);
    const empty = estimateMmr({ updates: [], facts: {}, myTier: 0, myRR: 0, actId: ACT });
    expect(empty.usable).toBe(0);
    expect(empty.estTier).toBe(0);
    expect(climbSentence(empty)).toMatch(/Play a few competitive matches/);
  });
});

describe('shared/mmr: lobby average', () => {
  it('uses tiers only and ignores unranked', () => {
    expect(lobbyAverage([15, 16, 0, 17, 1])).toBe(16);
    expect(lobbyAverage([0, 0])).toBeUndefined();
  });

  it('counts every other player in the match the same way, hidden-name ones included', () => {
    const players = Array.from({ length: 10 }, (_, i) => ({ subject: `p${i}`, teamId: i < 5 ? 'Blue' : 'Red', score: 3000, roundsPlayed: 20, tier: 10 + i, partyId: i < 2 ? 'party-a' : `solo-${i}`, characterId: 'agent' }));
    const f = factsFromDetails({ players, teams: [{ teamId: 'Blue', won: true, roundsWon: 13 }, { teamId: 'Red', won: false, roundsWon: 7 }], mapId: 'map' }, 'p0')!;
    expect(f.otherTiers).toHaveLength(9);
    expect(lobbyAverage(f.otherTiers)).toBe((11 + 12 + 13 + 14 + 15 + 16 + 17 + 18 + 19) / 9);
    expect(f).toMatchObject({ result: 'W', roundDiff: 6, totalRounds: 20, acs: 150, partySize: 2, score: '13-7' });
  });
});
