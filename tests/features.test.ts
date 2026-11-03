import { describe, expect, it } from 'vitest';
import { mergeLoadout, normalizeView, parseLoadout, SPRAY_TYPE } from '../main/services/loadout';
import { decodePresence, presenceStatus } from '../main/services/hub';
import { contractProgress, weekliesActiveAt } from '../main/services/progression';
import { analyzeMatches, filterMatches, peakTier, seasonRank } from '../shared/stats';
import { trimDetails } from '../shared/last5';
import type { MatchRow } from '../shared/features';

describe('loadout (personalization v3)', () => {
  // Shape captured from the live API (ids shortened): Sprays became ActiveExpressions.
  const raw = {
    Subject: 'me',
    Version: 172,
    Guns: [
      { ID: 'W1', SkinID: 'S1', SkinLevelID: 'L1', ChromaID: 'C1', CharmInstanceID: 'I1', CharmID: 'B1', CharmLevelID: 'BL1', Attachments: [] },
      { ID: 'KNIFE', SkinID: 'S2', SkinLevelID: 'L2', ChromaID: 'C2', Attachments: [] },
      { ID: 'UNTOUCHED', SkinID: 'S3', SkinLevelID: 'L3', ChromaID: 'C3', Attachments: [], Future: 'keep me' },
    ],
    ActiveExpressions: [
      { TypeID: SPRAY_TYPE, AssetID: 'SP1' },
      { TypeID: 'some-future-expression-type', AssetID: 'FLEX' },
      { TypeID: SPRAY_TYPE, AssetID: 'SP2' },
    ],
    DynamicOptions: { x: 1 },
    Identity: { PlayerCardID: 'CARD', PlayerTitleID: 'TITLE', AccountLevel: 99, PreferredLevelBorderID: 'B', HideAccountLevel: false },
    Incognito: false,
  };

  it('parses guns, spray slots (spray-typed expressions only), identity', () => {
    const v = parseLoadout(raw);
    expect(v.api).toBe('v3');
    expect(v.version).toBe(172);
    expect(v.guns[0]).toMatchObject({ weaponId: 'w1', charmInstanceId: 'i1' });
    expect(v.sprays).toEqual([{ slot: 0, sprayId: 'sp1' }, { slot: 1, sprayId: 'sp2' }]);
    expect(v.cardId).toBe('card');
  });

  it('merges only the edits into Riot\'s own object and carries everything else through', () => {
    const v = parseLoadout(raw);
    v.guns[0] = { ...v.guns[0], skinId: 'new-skin', skinLevelId: 'new-level', chromaId: 'new-chroma' };
    v.guns[1] = { ...v.guns[1], charmId: 'b9', charmLevelId: 'bl9', charmInstanceId: 'i9' };
    v.sprays[1] = { slot: 1, sprayId: 'sp9' };
    v.incognito = true;
    const body = mergeLoadout(raw, v);
    expect(body.Subject).toBe('me'); // read-only fields are echoed, not dropped
    expect(body.Version).toBe(172);
    expect(body.DynamicOptions).toEqual({ x: 1 });
    expect(body.Guns[0]).toMatchObject({ ID: 'W1', SkinID: 'new-skin', SkinLevelID: 'new-level', ChromaID: 'new-chroma', CharmID: 'b1' });
    expect(body.Guns[1]).toMatchObject({ CharmID: 'b9', CharmLevelID: 'bl9', CharmInstanceID: 'i9' });
    expect(body.Guns[2]).toEqual(raw.Guns[2]); // untouched gun, including unknown fields
    expect(body.ActiveExpressions[0].AssetID).toBe('SP1');
    expect(body.ActiveExpressions[1]).toEqual({ TypeID: 'some-future-expression-type', AssetID: 'FLEX' });
    expect(body.ActiveExpressions[2].AssetID).toBe('sp9');
    expect(body.Incognito).toBe(true);
    expect(raw.Guns[0].SkinID).toBe('S1'); // input not mutated
  });

  it('an unedited loadout merges to exactly what Riot sent (a no-op apply is a true no-op)', () => {
    expect(mergeLoadout(raw, parseLoadout(raw))).toEqual(raw);
    // ...even when Riot's ids are upper case and our view is lower case
    const upper = { ...raw, Guns: raw.Guns.map((g) => ({ ...g })) };
    expect(mergeLoadout(upper, parseLoadout(upper))).toEqual(upper);
  });

  it('removes a buddy when all three charm fields are cleared', () => {
    const v = parseLoadout(raw);
    v.guns[0] = { ...v.guns[0], charmId: undefined, charmLevelId: undefined, charmInstanceId: undefined };
    const g = mergeLoadout(raw, v).Guns[0];
    expect(g.CharmID).toBeUndefined();
    expect(g.CharmInstanceID).toBeUndefined();
  });

  it('still understands the retired v2 Sprays shape', () => {
    const v2 = { Version: 3, Guns: [], Sprays: [{ EquipSlotID: 'slot', SprayID: 'SP', SprayLevelID: null }], Identity: {} };
    const v = parseLoadout(v2, 'v2');
    expect(v.sprays).toEqual([{ slot: 0, sprayId: 'sp' }]);
    v.sprays[0] = { slot: 0, sprayId: 'other' };
    expect(mergeLoadout(v2, v).Sprays[0]).toEqual({ EquipSlotID: 'slot', SprayID: 'other', SprayLevelID: null });
  });

  it('upgrades presets saved before v3 (slot ids -> indexes)', () => {
    const old: any = { status: 'ready', guns: [], sprays: [{ slot: 'uuid-a', sprayId: 'SP1' }, { slot: 'uuid-b', sprayId: 'SP2' }] };
    expect(normalizeView(old).sprays).toEqual([{ slot: 0, sprayId: 'sp1' }, { slot: 1, sprayId: 'sp2' }]);
  });

  it('survives null', () => {
    expect(parseLoadout(null)).toMatchObject({ status: 'ready', guns: [], sprays: [] });
    expect(mergeLoadout(null, parseLoadout(null))).toMatchObject({ Guns: [], Identity: {} });
  });
});

describe('presence', () => {
  it('decodes the base64 private payload', () => {
    const priv = Buffer.from(JSON.stringify({ sessionLoopState: 'INGAME', partyOwnerMatchScoreAllyTeam: 7, partyOwnerMatchScoreEnemyTeam: 5 })).toString('base64');
    expect(presenceStatus(decodePresence(priv))).toBe('In game 7-5');
    expect(presenceStatus({ sessionLoopState: 'MENUS', partyState: 'MATCHMAKING' })).toBe('In queue');
    expect(decodePresence('%%%')).toBeNull();
    expect(decodePresence(null)).toBeNull();
  });
});

describe('progression helpers', () => {
  it('contract progress and next reward', () => {
    const def = { levels: [{ xp: 0, rewardType: 'Spray', rewardId: 'a' }, { xp: 2000, rewardType: 'Card', rewardId: 'b' }, { xp: 3000, rewardType: 'Skin', rewardId: 'c' }] };
    expect(contractProgress({ ProgressionLevelReached: 1, ProgressionTowardsNextLevel: 500 }, def)).toEqual({ level: 1, maxLevel: 3, xpIntoLevel: 500, xpForNext: 2000, next: { type: 'Card', id: 'b' } });
    expect(contractProgress({ ProgressionLevelReached: 3 }, def).next).toBeUndefined();
  });
  it('weeklies active on a date', () => {
    const m = [
      { id: '1', type: 'Weekly', title: 'A', xp: 1, target: 1, activation: '2026-11-01T00:00:00Z', expiration: '2026-11-15T00:00:00Z' },
      { id: '2', type: 'Weekly', title: 'B', xp: 1, target: 1, activation: '2026-11-08T00:00:00Z', expiration: '2026-11-22T00:00:00Z' },
      { id: '3', type: 'Daily', title: 'C', xp: 1, target: 1 },
    ];
    expect(weekliesActiveAt(m, Date.parse('2026-11-03')).map((x) => x.id)).toEqual(['1']);
    expect(weekliesActiveAt(m, Date.parse('2026-11-10')).map((x) => x.id)).toEqual(['2']);
    expect(weekliesActiveAt(m, Date.parse('2026-11-16')).map((x) => x.id)).toEqual([]);
  });
});

describe('profile stats', () => {
  const row = (o: Partial<MatchRow>): MatchRow => ({ matchId: 'm', startTime: 0, queueId: 'competitive', queueTag: 'COMP', result: 'W', score: '13-5', kills: 10, deaths: 10, assists: 0, acs: 200, adr: null, hsPct: null, ...o });
  const rows = [
    row({ matchId: '1', startTime: 3, agentId: 'jett', agentName: 'Jett', mapId: 'ascent', result: 'W', kills: 20, deaths: 10, acs: 300 }),
    row({ matchId: '2', startTime: 1, agentId: 'jett', agentName: 'Jett', mapId: 'bind', result: 'L', kills: 10, deaths: 20, acs: 150 }),
    row({ matchId: '3', startTime: 2, agentId: 'sage', agentName: 'Sage', mapId: 'ascent', result: 'W', queueId: 'unrated' }),
  ];
  it('per-agent/per-map win rates and chronological trend', () => {
    const a = analyzeMatches(rows);
    expect(a.byAgent.find((g) => g.key === 'jett')).toMatchObject({ games: 2, wins: 1, winRate: 50, kd: 1 });
    expect(a.byMap.find((g) => g.key === 'ascent')?.winRate).toBe(100);
    expect(a.trend.map((t) => t.t)).toEqual([1, 2, 3]);
  });
  it('history filters', () => {
    expect(filterMatches(rows, { queue: 'unrated' }).map((r) => r.matchId)).toEqual(['3']);
    expect(filterMatches(rows, { agentId: 'jett', result: 'L' }).map((r) => r.matchId)).toEqual(['2']);
    expect(filterMatches(rows, { from: 2 }).map((r) => r.matchId)).toEqual(['1', '3']);
  });
  it('peak tier and season rank from MMR', () => {
    const mmr = { QueueSkills: { competitive: { SeasonalInfoBySeasonID: { s1: { CompetitiveTier: 15, RankedRating: 40, LeaderboardRank: 0, WinsByTier: { '18': 2 } }, s2: { CompetitiveTier: 12, RankedRating: 10, WinsByTier: null } } } } };
    expect(peakTier(mmr)).toBe(18);
    expect(seasonRank(mmr, 's2')).toEqual({ tier: 12, rr: 10, leaderboardRank: 0 });
    expect(seasonRank({ LatestCompetitiveUpdate: { TierAfterUpdate: 9, RankedRatingAfterUpdate: 77 } }, 'none')).toEqual({ tier: 9, rr: 77, leaderboardRank: 0 });
    expect(peakTier(null)).toBe(0);
  });
});

describe('advanced match stats', () => {
  it('ADR, HS%, first bloods and economy from round data', () => {
    const d = trimDetails({
      matchInfo: { matchId: 'M' },
      players: [
        { subject: 'a', teamId: 'Blue', stats: { score: 400, roundsPlayed: 2, kills: 2, deaths: 0, assists: 0 } },
        { subject: 'b', teamId: 'Red', stats: { score: 100, roundsPlayed: 2, kills: 0, deaths: 2, assists: 0 } },
      ],
      roundResults: [
        { roundNum: 0, playerStats: [{ subject: 'a', kills: [{ killer: 'a', roundTime: 9000 }], damage: [{ damage: 150, headshots: 1, bodyshots: 2, legshots: 1 }], economy: { loadoutValue: 3900, spent: 2900 } }, { subject: 'b', kills: [], damage: [], economy: { loadoutValue: 800, spent: 800 } }] },
        { roundNum: 1, playerStats: [{ subject: 'a', kills: [{ killer: 'a', roundTime: 4000 }], damage: [{ damage: 150, headshots: 3, bodyshots: 1, legshots: 0 }], economy: { loadoutValue: 4700, spent: 0 } }] },
      ],
    });
    const a = d.players.find((p) => p.subject === 'a')!;
    expect(a).toMatchObject({ adr: 150, hsPct: 50, firstBloods: 2, avgLoadout: 4300, avgSpent: 1450 });
    const noRounds = trimDetails({ players: [{ subject: 'x', teamId: 'Blue', stats: { roundsPlayed: 1 } }] });
    expect(noRounds.players[0]).toMatchObject({ adr: null, hsPct: null });
  });
});
