import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { MIN_SAMPLE, REF, svScore, WEIGHTS, type ScoreMatch } from '../shared/score';
import { actLabel, currentAndPeak } from '../shared/stats';
import { parseDisplayMode } from '../shared/fullscreen';
import { detectDisplayMode } from '../main/services/displayMode';
import { redact, redactString } from '../shared/redact';
import { trackerUrl } from '../shared/tracker';
import { summarizeMatch, trimDetails } from '../shared/last5';

const m = (over: Partial<ScoreMatch>): ScoreMatch => ({ result: 'W', kills: 15, deaths: 15, acs: 200, rounds: 20, adr: 135, hsPct: 20, firstBloods: 2, ...over });

describe('SV Score', () => {
  it('weights sum to 1 and every range is ordered', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    for (const r of Object.values(REF)) expect(r.hi).toBeGreaterThan(r.lo);
  });

  const strong = [m({ acs: 300, kills: 26, deaths: 14, adr: 182, hsPct: 34, firstBloods: 5 }), m({ acs: 285, kills: 24, deaths: 15, adr: 170, hsPct: 30, firstBloods: 4 }), m({ acs: 310, kills: 27, deaths: 13, adr: 190, hsPct: 36, firstBloods: 5, result: 'L' }), m({ acs: 290, kills: 25, deaths: 16, adr: 175, hsPct: 31, firstBloods: 4 }), m({ acs: 295, kills: 24, deaths: 14, adr: 178, hsPct: 33, firstBloods: 4 })];
  const average = [m({}), m({ result: 'L' }), m({ acs: 210, kills: 16, deaths: 15 }), m({ acs: 190, kills: 14, deaths: 16, result: 'L' }), m({ acs: 205 })];
  const weak = [m({ acs: 120, kills: 8, deaths: 18, adr: 85, hsPct: 9, firstBloods: 0, result: 'L' }), m({ acs: 135, kills: 9, deaths: 17, adr: 92, hsPct: 11, firstBloods: 1, result: 'L' }), m({ acs: 110, kills: 7, deaths: 19, adr: 80, hsPct: 8, firstBloods: 0, result: 'L' }), m({ acs: 140, kills: 10, deaths: 16, adr: 95, hsPct: 12, firstBloods: 1 }), m({ acs: 125, kills: 8, deaths: 17, adr: 88, hsPct: 10, firstBloods: 0, result: 'L' })];

  it('ranks strong > average > weak, all inside 0-1000', () => {
    const [s, a, w] = [strong, average, weak].map((x) => svScore(x)!);
    expect(s.score).toBeGreaterThan(850);
    expect(a.score).toBeGreaterThan(350);
    expect(a.score).toBeLessThan(650);
    expect(w.score).toBeLessThan(150);
    for (const x of [s, a, w]) {
      expect(x.score).toBeGreaterThanOrEqual(0);
      expect(x.score).toBeLessThanOrEqual(1000);
      expect(x.sample).toBe(5);
    }
  });

  it('reports the parts behind the number', () => {
    const a = svScore(average)!;
    expect(a.parts).toMatchObject({ wins: 3, losses: 2, adr: 135, hsPct: 20, fbPerRound: 0.1 });
    expect(a.parts.acs).toBe(Math.round((200 + 200 + 210 + 190 + 205) / 5));
    expect(a.parts.kd).toBeCloseTo((15 + 15 + 16 + 14 + 15) / (15 + 15 + 15 + 16 + 15), 2);
  });

  it('is null under 3 matches with round data, and ignores matches without it', () => {
    const noRounds = average.map((x) => ({ ...x, adr: null, firstBloods: null }));
    expect(svScore(noRounds)).toBeNull();
    expect(svScore([...average.slice(0, MIN_SAMPLE - 1), ...noRounds])).toBeNull();
    expect(svScore([])).toBeNull();
    const mixed = svScore([...average.slice(0, 3), m({ adr: null, firstBloods: null, acs: 999 })])!;
    expect(mixed.sample).toBe(3);
    expect(mixed.parts.acs).toBeLessThan(300); // the round-less 999 ACS game did not count
  });

  it('gets round stats from real match details through summarizeMatch', () => {
    const raw = {
      matchInfo: { matchId: 'M', queueID: 'competitive' },
      players: [{ subject: 'me', teamId: 'Blue', stats: { score: 4000, roundsPlayed: 20, kills: 18, deaths: 12, assists: 3 } }, { subject: 'x', teamId: 'Red', stats: { score: 1, roundsPlayed: 20, kills: 1, deaths: 1, assists: 0 } }],
      teams: [{ teamId: 'Blue', won: true, roundsWon: 13 }, { teamId: 'Red', won: false, roundsWon: 7 }],
      roundResults: [{ roundNum: 0, playerStats: [{ subject: 'me', kills: [{ killer: 'me', roundTime: 5 }], damage: [{ damage: 150, headshots: 1, bodyshots: 2, legshots: 1 }] }] }],
    };
    expect(summarizeMatch(trimDetails(raw), 'me')).toMatchObject({ rounds: 20, firstBloods: 1, hsPct: 25 });
  });
});

describe('current + peak rank', () => {
  const mmr = {
    QueueSkills: {
      competitive: {
        SeasonalInfoBySeasonID: {
          old: { SeasonID: 'old', CompetitiveTier: 18, RankedRating: 10, WinsByTier: { 21: 2, 17: 5 } },
          now: { SeasonID: 'now', CompetitiveTier: 16, RankedRating: 64, WinsByTier: { 16: 3, 22: 0 } },
        },
      },
    },
  };
  it('takes the current act and the highest tier won at, with its act', () => {
    expect(currentAndPeak(mmr, 'now')).toEqual({ currentTier: 16, rr: 64, peakTier: 21, peakSeasonId: 'old' });
  });
  it('is Unrated when the current act was not played, and empty data is all zero', () => {
    expect(currentAndPeak(mmr, 'next')).toMatchObject({ currentTier: 0, rr: 0, peakTier: 21 });
    expect(currentAndPeak(null, 'now')).toEqual({ currentTier: 0, rr: 0, peakTier: 0, peakSeasonId: undefined });
  });
  it('names the act with its episode', () => {
    const seasons = [
      { id: 'ep9', name: 'EPISODE 9' },
      { id: 'a3', name: 'ACT III', parentId: 'ep9' },
      { id: 's25', name: 'SEASON 2025' },
      { id: 'a1', name: 'ACT I', parentId: 's25' },
    ];
    expect(actLabel(seasons, 'a3')).toBe('Episode 9 Act III');
    expect(actLabel(seasons, 'A1')).toBe('Season 2025 Act I');
    expect(actLabel(seasons, 'missing')).toBeUndefined();
  });
});

describe('Valorant display mode', () => {
  it('parses FullscreenMode (then LastConfirmedFullscreenMode)', () => {
    expect(parseDisplayMode('[x]\r\nFullscreenMode=0\r\n')).toBe('fullscreen');
    expect(parseDisplayMode('LastConfirmedFullscreenMode=1\nPreferredFullscreenMode=1\nFullscreenMode=1')).toBe('borderless');
    expect(parseDisplayMode('LastConfirmedFullscreenMode=2')).toBe('windowed');
    expect(parseDisplayMode('FullscreenMode=7')).toBeNull();
    expect(parseDisplayMode('')).toBeNull();
  });
  it('finds the account file (WindowsClient or Windows) and says nothing when there is none', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cfg-'));
    expect(await detectDisplayMode(path.join(dir, 'nope'), 'x')).toBeNull();
    const puuid = 'bb6e6667-a433-5f80-8d76-bb074fd8a482';
    await fs.mkdir(path.join(dir, `${puuid}-ap`, 'WindowsClient'), { recursive: true });
    await fs.writeFile(path.join(dir, `${puuid}-ap`, 'WindowsClient', 'GameUserSettings.ini'), 'FullscreenMode=0\n');
    expect(await detectDisplayMode(dir, puuid)).toMatchObject({ mode: 'fullscreen' });
    expect(await detectDisplayMode(dir, null)).toMatchObject({ mode: 'fullscreen' });
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('secrets and links', () => {
  it('redacts the HenrikDev key by field name and by shape', () => {
    expect(redact({ henrikKey: 'HDEV-1234abcd-5678' })).toEqual({ henrikKey: '[REDACTED]' });
    expect(redactString('auth HDEV-1234abcd-5678-efgh failed')).toBe('auth [REDACTED_KEY] failed');
  });
  it('builds the tracker.gg URL from Name#Tag only', () => {
    expect(trackerUrl('Vibe', '0001')).toBe('https://tracker.gg/valorant/profile/riot/Vibe%230001/overview');
    expect(trackerUrl('Wiśniewska Kow', 'PL1')).toBe(`https://tracker.gg/valorant/profile/riot/${encodeURIComponent('Wiśniewska Kow#PL1')}/overview`);
    expect(trackerUrl(undefined, 'x')).toBeNull();
    expect(trackerUrl('a#b', 'x')).toBeNull();
  });
});
