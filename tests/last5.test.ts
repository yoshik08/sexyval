import { describe, expect, it } from 'vitest';
import { pickHistoryIds, summarizeMatch, summarizePlayer, trimDetails } from '../shared/last5';

const raw = {
  matchInfo: { matchId: 'M1', mapId: '/Game/Maps/Ascent/Ascent', queueID: 'competitive', gameMode: 'Bomb', gameStartMillis: 1000 },
  players: [
    { subject: 'me', teamId: 'Blue', characterId: 'A', stats: { score: 5000, roundsPlayed: 20, kills: 18, deaths: 12, assists: 4 } },
    { subject: 'x', teamId: 'Red', characterId: 'B', stats: null },
    null,
  ],
  teams: [
    { teamId: 'Blue', won: true, roundsWon: 13 },
    { teamId: 'Red', won: false, roundsWon: 7 },
  ],
  roundResults: [{ roundNum: 0, winningTeam: 'Blue', bombPlanter: 'x' }],
};

describe('last-5 extraction', () => {
  it('summarises a team match', () => {
    const s = summarizeMatch(trimDetails(raw), 'me')!;
    expect(s).toMatchObject({ result: 'W', kills: 18, deaths: 12, assists: 4, acs: 250, score: '13-7', queueTag: 'COMP', characterId: 'A' });
    expect(summarizeMatch(trimDetails(raw), 'x')).toMatchObject({ result: 'L', acs: 0, score: '7-13' });
  });
  it('returns "-" when teamId is a puuid (deathmatch)', () => {
    const dm = trimDetails({
      matchInfo: { matchId: 'D', queueID: 'deathmatch' },
      players: [{ subject: 'me', teamId: 'me', stats: { score: 100, roundsPlayed: 1, kills: 20, deaths: 10, assists: 1 } }],
      teams: [{ teamId: 'me', won: true, roundsWon: 0 }],
    });
    expect(summarizeMatch(dm, 'me')).toMatchObject({ result: '-', score: '-', queueTag: 'DM' });
  });
  it('detects draws', () => {
    const d = trimDetails({
      ...raw,
      teams: [
        { teamId: 'Blue', won: false, roundsWon: 12 },
        { teamId: 'Red', won: false, roundsWon: 12 },
      ],
    });
    expect(summarizeMatch(d, 'me')?.result).toBe('D');
  });
  it('returns null when player not in match and survives garbage', () => {
    expect(summarizeMatch(trimDetails(raw), 'nobody')).toBeNull();
    expect(trimDetails(null, 'id')).toMatchObject({ matchId: 'id', players: [], teams: [], roundResults: [] });
  });
  it('summarises a player', () => {
    expect(
      summarizePlayer([
        { result: 'W', kills: 20, deaths: 10, acs: 300 },
        { result: 'L', kills: 10, deaths: 10, acs: 200 },
        { result: '-', kills: 0, deaths: 0, acs: 100 },
      ]),
    ).toEqual({ count: 3, wins: 1, losses: 1, kd: 1.5, acs: 200 });
    expect(summarizePlayer([])).toEqual({ count: 0, wins: 0, losses: 0, kd: 0, acs: 0 });
  });
  it('picks newest unique history ids', () => {
    const h = {
      History: [
        { MatchID: 'a', GameStartTime: 1 },
        { MatchID: 'b', GameStartTime: 3 },
        { MatchID: 'b', GameStartTime: 3 },
        { MatchID: 'c', GameStartTime: 2 },
        { bad: true },
      ],
    };
    expect(pickHistoryIds(h, 2)).toEqual(['b', 'c']);
    expect(pickHistoryIds(null)).toEqual([]);
  });
});
