import { describe, expect, it } from 'vitest';
import { aggregateLifetime, formOf, isLastPage, PAGE_SIZE, stitchPages, type LifetimeMatch } from '../shared/lifetime';
import type { CompUpdate } from '../shared/mmr';

const m = (i: number, o: Partial<LifetimeMatch> = {}): LifetimeMatch => ({
  matchId: `m${i}`,
  startTime: 1000 + i,
  queueId: 'competitive',
  mapId: 'ascent',
  characterId: 'jett',
  result: 'W',
  score: '13-5',
  kills: 20,
  deaths: 10,
  assists: 4,
  acs: 250,
  rounds: 18,
  adr: 150,
  hsPct: 25,
  firstBloods: 3,
  ...o,
});

const u = (i: number, o: Partial<CompUpdate> = {}): CompUpdate => ({ matchId: `m${i}`, startTime: 1000 + i, seasonId: 'act2', tierBefore: 14, tierAfter: 14, rrBefore: 40, rrAfter: 60, rrEarned: 20, afkPenalty: 0, ...o });

describe('shared/lifetime', () => {
  it('lifetime totals on a hand-built fixture', () => {
    const rows = [
      m(1, { kills: 20, deaths: 10, acs: 250, rounds: 20, adr: 160, hsPct: 30, firstBloods: 4 }),
      m(2, { result: 'L', kills: 10, deaths: 15, acs: 150, rounds: 20, adr: 100, hsPct: 20, firstBloods: 1 }),
      m(3, { result: 'W', kills: 15, deaths: 15, acs: 200, rounds: 10, adr: null, hsPct: null, firstBloods: 0 }),
      m(4, { result: 'D', kills: 5, deaths: 0, acs: 100, rounds: 0, adr: null, hsPct: null, firstBloods: null }),
    ];
    const a = aggregateLifetime({ matches: rows, updates: [] });
    expect(a.totals).toMatchObject({ n: 4, wins: 2, losses: 1, winRate: 67, kd: 1.25, firstBloods: 5 });
    // ACS weighted by rounds: (250·20 + 150·20 + 200·10) / 50 = 200
    expect(a.totals.acs).toBe(200);
    // ADR only from matches with round data: (160·20 + 100·20) / 40 = 130
    expect(a.totals.adr).toBe(130);
    expect(a.totals.hsPct).toBe(25);
  });

  it('per-agent and per-map tables, best and worst', () => {
    const rows = [
      ...[1, 2, 3, 4].map((i) => m(i, { characterId: 'jett', mapId: 'ascent', result: i === 4 ? 'L' : 'W' })),
      ...[5, 6, 7].map((i) => m(i, { characterId: 'sova', mapId: 'bind', result: i === 5 ? 'W' : 'L' })),
      m(8, { characterId: 'omen', mapId: 'bind' }),
    ];
    const a = aggregateLifetime({ matches: rows, updates: [] });
    expect(a.byAgent.map((g) => [g.key, g.games, g.winRate])).toEqual([
      ['jett', 4, 75],
      ['sova', 3, 33],
      ['omen', 1, 100],
    ]);
    expect(a.byMap.map((g) => [g.key, g.games])).toEqual([
      ['ascent', 4],
      ['bind', 4],
    ]);
    expect(a.bestAgent?.key).toBe('jett');
    expect(a.worstAgent?.key).toBe('sova'); // omen has 1 game: below the 3-game minimum
    expect(a.bestMap?.key).toBe('ascent');
    expect(a.worstMap?.key).toBe('bind');
  });

  it('per-act timeline with act boundaries and act summaries', () => {
    const updates = [u(1, { seasonId: 'act1', tierAfter: 12, rrAfter: 50 }), u(2, { seasonId: 'act1', tierAfter: 13, rrAfter: 5, rrEarned: 22 }), u(3, { seasonId: 'act2', tierAfter: 12, rrAfter: 80, rrEarned: -15 }), u(4, { seasonId: 'act2', tierAfter: 12, rrAfter: 98 })];
    const a = aggregateLifetime({ matches: [], updates: [...updates].reverse() });
    expect(a.timeline.map((p) => p.matchId)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(a.actStarts).toEqual([
      { index: 0, actId: 'act1' },
      { index: 2, actId: 'act2' },
    ]);
    expect(a.perAct).toEqual([
      { actId: 'act1', matches: 2, wins: 2, losses: 0, finalTier: 13, finalRR: 5, peakTier: 13 },
      { actId: 'act2', matches: 2, wins: 1, losses: 1, finalTier: 12, finalRR: 98, peakTier: 12 },
    ]);
    expect(a.competitive).toEqual({ matches: 4, wins: 3, losses: 1, winRate: 75 });
  });

  it('current-act form: last 10 / last 20 competitive matches since the act started', () => {
    const rows = Array.from({ length: 30 }, (_, i) => m(i, { result: i % 3 === 0 ? 'L' : 'W', queueId: i % 10 === 9 ? 'unrated' : 'competitive' }));
    const a = aggregateLifetime({ matches: rows, updates: [], currentAct: { id: 'act2', start: 1005 } });
    expect(a.currentAct.last10.n).toBe(10);
    expect(a.currentAct.last20.n).toBe(20);
    // newest first: m29 (unrated, skipped), m28, m27 (L) …
    expect(a.currentAct.last10.wins + a.currentAct.last10.losses).toBe(10);
  });

  it('pagination stitching: 45 matches in pages of 20, no duplicates, nothing dropped', () => {
    const all = Array.from({ length: 45 }, (_, i) => ({ MatchID: `id${i}` }));
    const pages: { MatchID: string }[][] = [];
    for (let start = 0; ; start += PAGE_SIZE) {
      // A new match landed after the first page: the second page repeats the first page's last entry.
      const shift = start > 0 ? 1 : 0;
      const page = all.slice(start - shift, start + PAGE_SIZE);
      pages.push(page);
      if (isLastPage(page.slice(shift))) break;
    }
    expect(pages).toHaveLength(3);
    const ids = stitchPages(pages, (x) => x.MatchID).map((x) => x.MatchID);
    expect(ids).toHaveLength(45);
    expect(new Set(ids).size).toBe(45);
    expect(ids[44]).toBe('id44');
  });

  it('empty history', () => {
    const a = aggregateLifetime({ matches: [], updates: [] });
    expect(a.totals).toMatchObject({ n: 0, wins: 0, losses: 0, kd: 0, acs: 0, firstBloods: 0 });
    expect(a.totals.winRate).toBeUndefined();
    expect(a.byAgent).toEqual([]);
    expect(a.timeline).toEqual([]);
    expect(a.competitive.winRate).toBeUndefined();
    expect(formOf([]).n).toBe(0);
  });
});
