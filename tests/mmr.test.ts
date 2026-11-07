import { describe, expect, it } from 'vitest';
import { climbSentence, estimateMmr, excludeReason, factsFromDetails, fit3, gapLabel, lobbyAverage, MAX_TIER, MIN_TIER, parseUpdate, RR_PER_DIVISION, type CompUpdate, type MatchFacts, type MmrInput } from '../shared/mmr';
import { teamFactsFromDetails, type TeamFacts } from '../shared/team';
import { matchDetails, mates } from './teamFixtures';

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

// ---------- 1.4: team mode (MmrInput.team). Everything above runs without team data, unchanged. ----------

interface TeamSpec extends Spec {
  /** Party size per match index (default solo). */
  stack?: (i: number) => 1 | 2 | 3 | 5;
  /** Premades' rank (default: the lobby tier). */
  friendTier?: number;
  /** RR multiplier in 5-stacks (a penalty). */
  fiveFactor?: number;
  /** Randoms' and enemies' tier per match (default: the persona's lobby). */
  lobbyAt?: (i: number) => number;
  /** Matches with no party data (details cached before partyId existed). */
  noParty?: (i: number) => boolean;
}

/** persona() plus team facts from synthetic details: a lobby balanced around `lobbyAt(i)`, your premades first. */
function teamPersona(s: TeamSpec): MmrInput {
  const input = persona(s);
  const team: Record<string, TeamFacts | undefined> = {};
  input.updates.forEach((u, i) => {
    const f = input.facts[u.matchId]!;
    const n = s.stack?.(i) ?? 1;
    const L = s.lobbyAt?.(i) ?? s.lobby;
    const prem = Array.from({ length: n - 1 }, (_, k) => ({ id: `friend-${k}`, tier: s.friendTier ?? L }));
    const d = matchDetails({ id: u.matchId, me: 'me', myTier: s.myTier ?? 14, myAcs: f.acs, mates: mates(L, prem, u.matchId), enemies: [L, L, L, L, L], win: f.result === 'W', margin: Math.abs(f.roundDiff), partyData: !s.noParty?.(i) });
    team[u.matchId] = teamFactsFromDetails(d, 'me');
    f.otherTiers = d.players.filter((p) => p.subject !== 'me').map((p) => p.tier ?? 0);
    f.partySize = s.noParty?.(i) ? undefined : n;
    if (n === 5 && s.fiveFactor) u.rrEarned = Math.round(u.rrEarned * s.fiveFactor);
  });
  return { ...input, team, puuid: 'me' };
}

describe('shared/mmr 1.4: team mode', () => {
  it('without team data nothing changes: no team summary, same numbers', () => {
    const input = persona({ win: 22, loss: -14, lobby: 15 });
    const a = estimateMmr(input);
    expect(a.team).toBeUndefined();
    expect(a.matches[0].stack).toBeUndefined();
    expect(estimateMmr({ ...input, team: undefined })).toEqual(a);
  });

  it('solo-only data reproduces the 1.3 estimate (within 0.3 divisions), noisy lobbies and an outlier included', () => {
    for (const spec of [
      { win: 25, loss: -12, lobby: 16 },
      { win: 19, loss: -18, lobby: 14 },
      { win: 13, loss: -24, lobby: 11 },
      { win: 22, loss: -15, lobby: 12, myTier: 15 }, // lobby and split disagree
    ]) {
      const lobbyAt = (i: number) => spec.lobby + (((i * 5) % 7) - 3) * 0.4 + (i === 7 ? 6 : 0);
      const input = teamPersona({ ...spec, lobbyAt });
      const t = estimateMmr(input);
      const old = estimateMmr({ ...input, team: undefined });
      expect(Math.abs(t.estTierDecimal - old.estTierDecimal)).toBeLessThanOrEqual(0.3);
      expect(t.team!.wTeamUsed).toBe(0.6);
      expect(t.team!.stackedShare).toBe(0);
    }
  });

  it('a duo with a lower-ranked friend: the raw lobby drags the 1.3 estimate down, the team estimate corrects it', () => {
    // Your MMR ~16 (wins +25 / losses −12 at Gold 3), always with a Gold 1 friend; the lobby fills around 14.5.
    const input = teamPersona({ win: 25, loss: -12, lobby: 14.5, stack: () => 2, friendTier: 13 });
    const solo = estimateMmr({ ...input, team: undefined });
    const team = estimateMmr(input);
    expect(solo.lobbyAvg!).toBeLessThan(14.5);
    expect(team.team!.teamSignal!).toBeCloseTo(16, 1);
    expect(team.estTierDecimal).toBeGreaterThan(solo.estTierDecimal + 0.5);
    expect(team.team!.lobbyAvgStacked).toBeCloseTo(14.3, 1);
    expect(team.team!.stackedShare).toBe(1);
    expect(team.team!.wSplitUsed + team.team!.wTeamUsed).toBeCloseTo(1, 2);
    expect(team.matches[0]).toMatchObject({ stack: 2, premades: ['friend-0'], impliedMe: 16 });
    // The friend's own estimated MMR (12, below their rank) replaces their rank as the proxy.
    const withMmr = estimateMmr({ ...input, premadeMmr: { 'friend-0': 12 } });
    expect(withMmr.team!.teamSignal!).toBeCloseTo(17, 1);
  });

  it('5-stacks with a 25% RR cut: measured, rescaled and kept', () => {
    const spec: TeamSpec = { win: 20, loss: -20, lobby: 14, n: 24, margin: 0.5, stack: (i) => (i % 4 < 2 ? 5 : 1), fiveFactor: 0.75 };
    const t = estimateMmr(teamPersona(spec));
    const old = estimateMmr({ ...teamPersona(spec), team: undefined });
    expect(old.matches.filter((m) => m.excluded === '5-stack')).toHaveLength(12);
    expect(Math.abs(t.team!.stackPenalty.five! - 0.75)).toBeLessThanOrEqual(0.05);
    expect(t.team!.stackPenalty.source).toBe('measured');
    const fives = t.matches.filter((m) => m.stack === 5);
    expect(fives.every((m) => !m.excluded && /^5-stack · RR ×0\.7\d \(penalty\)$/.test(m.tag))).toBe(true);
    expect(t.usable).toBe(24);
    // Undone: the cleaned split matches what solo games alone say.
    expect(Math.abs(t.Gw - old.Gw)).toBeLessThan(1.5);
    expect(Math.abs(t.Gl - old.Gl)).toBeLessThan(1.5);
    expect(Math.abs(t.GwRaw - old.GwRaw)).toBeLessThan(1.5);
  });

  it('5-stacks without a penalty are kept as they are; with too few samples they stay excluded', () => {
    const none = estimateMmr(teamPersona({ win: 20, loss: -20, lobby: 14, n: 24, margin: 0.5, stack: (i) => (i % 4 < 2 ? 5 : 1) }));
    expect(none.matches.filter((m) => m.stack === 5).every((m) => !m.excluded && m.tag === '5-stack · no penalty seen' && m.fiveScale === 1)).toBe(true);
    const few = estimateMmr(teamPersona({ win: 20, loss: -20, lobby: 14, n: 24, stack: (i) => (i < 4 ? 5 : 1), fiveFactor: 0.75 }));
    expect(few.matches.filter((m) => m.excluded === '5-stack')).toHaveLength(4);
    expect(few.team!.stackPenalty.source).toBe('none');
    expect(few.team!.stackPenalty.five).toBeUndefined();
  });

  it('the live party penalty changes only the next-match forecast', () => {
    const input = teamPersona({ win: 24, loss: -12, lobby: 16 });
    const plain = estimateMmr(input);
    const pen = estimateMmr({ ...input, livePartyPenalty: 0.25 });
    expect(pen.estTierDecimal).toBe(plain.estTierDecimal);
    expect(pen.forecast.rrFactor).toBe(0.75);
    expect(pen.forecast.winsToNext).toBe(Math.ceil((100 - 64) / (pen.GwRaw * 0.75)));
    expect(pen.forecast.lossCost).toBe(Math.round(pen.GlRaw * 0.75));
    expect(pen.team!.stackPenalty).toMatchObject({ party: 0.25, source: 'party-field' });
    expect(plain.forecast.rrFactor).toBeUndefined();
  });

  it('stack breakdown covers the window; matches without party data are "unknown" and kept out of the squad', () => {
    const e = estimateMmr(teamPersona({ win: 20, loss: -18, lobby: 14, stack: (i) => ([1, 2, 3, 5] as const)[i % 4], noParty: (i) => i % 5 === 0 }));
    const t = e.team!;
    expect(t.window).toBe(20);
    expect(t.stacks.reduce((a, s) => a + s.games, 0)).toBe(t.window);
    expect(t.stacks.find((s) => s.stack === 'unknown')!.games).toBe(4);
    expect(t.noPartyData).toBe(4);
    expect(t.ridge!.n).toBe(16);
    expect(e.matches.filter((m) => m.stack === 'unknown')).toHaveLength(4);
  });
});
