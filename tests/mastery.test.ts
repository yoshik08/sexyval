// Agent Mastery. Fixtures are SYNTHETIC unless marked otherwise: the one exception is COMMUNITY_SAMPLE,
// a response a community member posted (techchrism/valorant-api-docs issue #71, Oct 2026), copied as
// posted and not verified by SexyVal against the live game.
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0', getAppMetrics: () => [] } }));

import {
  ACT_LEVEL_TOTAL,
  actProgress,
  agentAnalytics,
  buildMasteryView,
  emptyMasteryFile,
  gearCosmetics,
  MASTERY_LAUNCH,
  MASTERY_SCHEMA,
  masteryCardsByDeveloperName,
  migrateMasteryFile,
  normId,
  parseBloomlineBonsai,
  parseBloomlinePlayer,
  parseValidQueues,
  portraitTier,
  recordSnapshot,
  REWARD_TRACK,
  rewardRows,
  sortAgents,
  statAvailability,
  statSlotViews,
  type ActRef,
  type AgentMeta,
  type AnalyticsRow,
  type MasteryFile,
  type MasteryView,
  type OwnedIds,
} from '../shared/mastery';
import { MasteryService, type MasteryApi } from '../main/services/mastery';
import { sanitizePayload } from '../shared/vault';
import { startMockServer, type MockHandle } from '../mock/server';
import { setMockMastery } from '../mock/mastery';
import { RiotSession, type ConnectionCache } from '../main/riot/session';
import { RiotApi } from '../main/riot/api';
import { ME as MOCK_ME } from '../mock/data';
import type { HttpResult } from '../main/riot/http';

process.env.SEXYVAL_QUIET = '1';

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const JETT = 'add6443a-41bd-e414-f6ad-e58d267f4e95';
const SAGE = '569fdd95-4d10-43ab-ca70-79becc718b46';
const OMEN = '8e253930-4c05-31dd-1b6c-968525494517';
const AGENTS: AgentMeta[] = [
  { id: JETT, name: 'Jett', role: 'Duelist' },
  { id: SAGE, name: 'Sage', role: 'Sentinel' },
  { id: OMEN, name: 'Omen', role: 'Controller' },
];
const ACT1: ActRef = { id: 'act-1', label: 'V26 · Act 5', start: Date.parse('2026-09-22'), end: Date.parse('2026-11-30') };
const ACT2: ActRef = { id: 'act-2', label: 'V26 · Act 6', start: Date.parse('2026-11-30'), end: Date.parse('2027-01-30') };

/** Community-posted (issue #71), unverified. Subject added: the post elided it. */
const COMMUNITY_SAMPLE = {
  Subject: A,
  Bonsais: [
    {
      BonsaiID: 'add6443a-41bd-e414-f6ad-e58d267f4e95',
      HypeID: '86c14974-4fd7-f5b9-abdb-0795c6385cdf',
      BackgroundID: 'fd824a65-4fcc-9da1-f270-68a5b0859de6',
      ClipID: '9b77a097-4ddc-c66c-0826-faa081057cd1',
      BorderID: 'e8454bb9-4455-b3da-b0a9-e88df20e312d',
      Flourish: { ShortLevel: 2, PreviousShortLevel: 10, LongLevel: 12, FlourishID: 'dbd05129-4402-c16e-aa72-d991f8da1de5', Points: 13225, PointsVersion: 5 },
      TrackProgressList: [{ TrackID: '9f32aa28-42cc-acf1-4292-c3bb9e7d3859', TrackLevel: 12 }],
    },
  ],
};

/** Synthetic. */
const bonsai = (agent: string, f: Record<string, number>) => ({ BonsaiID: agent, Flourish: f });
const res = (status: number, json: unknown): HttpResult => ({ status, json, text: JSON.stringify(json ?? ''), url: 'https://pd.test/bloomline', headers: {} }) as unknown as HttpResult;
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'sv-mastery-'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('parsing Riot’s Bloomline responses', () => {
  it('reads the community-posted sample', () => {
    const r = parseBloomlinePlayer(COMMUNITY_SAMPLE, A);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dropped).toBe(0);
    expect(r.value).toEqual([
      {
        agentId: JETT,
        actLevel: 2,
        previousActLevel: 10,
        lifetimeLevel: 12,
        points: 13225,
        pointsVersion: 5,
        slots: { hype: '86c14974-4fd7-f5b9-abdb-0795c6385cdf', background: 'fd824a65-4fcc-9da1-f270-68a5b0859de6', clip: '9b77a097-4ddc-c66c-0826-faa081057cd1', border: 'e8454bb9-4455-b3da-b0a9-e88df20e312d' },
        tracks: [{ trackId: '9f32aa28-42cc-acf1-4292-c3bb9e7d3859', level: 12 }],
      },
    ]);
    // Its points fall inside Act Level 2's band of the community table: the reading "Act total" holds here.
    expect(actProgress(2, 13225)).toEqual({ ok: true, progress: { into: 13225 - 10500, need: 9300, nextLevel: 3 } });
  });

  it('normalizes 32-hex ids and treats omitted numbers as zero', () => {
    expect(normId('0E38B51041A857805E8F568B2A4F2D6C')).toBe('0e38b510-41a8-5780-5e8f-568b2a4f2d6c');
    expect(normId('00000000-0000-0000-0000-000000000000')).toBeUndefined();
    const r = parseBloomlinePlayer({ Subject: A, Bonsais: [bonsai('ADD6443A41BDE414F6ADE58D267F4E95', { LongLevel: 4 })] }, A);
    expect(r.ok && r.value[0]).toMatchObject({ agentId: JETT, actLevel: 0, previousActLevel: 0, lifetimeLevel: 4, points: 0, slots: {}, tracks: [] });
  });

  it('accepts an account with no mastery (zero progression, not an error)', () => {
    expect(parseBloomlinePlayer({ Subject: A }, A)).toEqual({ ok: true, value: [], dropped: 0 });
    expect(parseBloomlinePlayer({ Subject: A, Bonsais: [] }, A)).toEqual({ ok: true, value: [], dropped: 0 });
  });

  it('rejects answers for another account and unrecognised shapes', () => {
    expect(parseBloomlinePlayer({ ...COMMUNITY_SAMPLE, Subject: B }, A).ok).toBe(false);
    for (const bad of [null, [], 'x', 42, { Bonsais: 'nope' }, { Subject: A, Bonsais: {} }, {}]) expect(parseBloomlinePlayer(bad, A).ok).toBe(false);
  });

  it('drops malformed agent records and keeps the rest; all malformed is an error', () => {
    const r = parseBloomlinePlayer(
      {
        Subject: A,
        Bonsais: [
          bonsai(JETT, { ShortLevel: 3, LongLevel: 3, Points: 20000 }),
          bonsai('not-an-id', { LongLevel: 1 }),
          bonsai(SAGE, { LongLevel: -1 }),
          bonsai(OMEN, { ShortLevel: 5, LongLevel: 2 }), // Act Level above Lifetime: impossible
          { BonsaiID: SAGE, Flourish: { LongLevel: 1.5 } },
          bonsai(JETT, { LongLevel: 9 }), // duplicate
        ],
      },
      A,
    );
    expect(r.ok && r.value.map((x) => x.agentId)).toEqual([JETT]);
    expect(r.ok && r.dropped).toBe(5);
    expect(parseBloomlinePlayer({ Subject: A, Bonsais: [bonsai('x', {})] }, A).ok).toBe(false);
  });

  it('reads per-agent stat slots and refuses another agent’s answer', () => {
    const one = { ...bonsai(JETT, { LongLevel: 5 }), NumberModules: [{ ModuleID: 'a'.repeat(32), NumberID: 'B'.repeat(32), Value: 311 }, { ModuleID: 'c'.repeat(32), NumberID: '0'.repeat(32), Value: 0 }, { Value: -3 }] };
    const r = parseBloomlineBonsai(one, A, JETT);
    expect(r.ok && r.value.stats).toEqual([
      { slotId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', statId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', value: 311 },
      { slotId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', value: 0 },
    ]);
    expect(r.ok && r.dropped).toBe(1);
    expect(parseBloomlineBonsai({ Subject: A, Bonsais: [bonsai(SAGE, { LongLevel: 1 })] }, A, JETT).ok).toBe(false);
    expect(parseBloomlineBonsai({ ...one, Subject: B }, A, JETT).ok).toBe(false);
  });

  it('reads the valid-queues config', () => {
    expect(parseValidQueues({ ProcessedQueues: ['competitive', 'hurm', 12, 'bad queue!'], PerformanceScoreQueues: ['competitive'] })).toEqual({ processed: ['competitive', 'hurm'], performance: ['competitive'] });
    expect(parseValidQueues({ nope: 1 })).toBeNull();
  });
});

/**
 * VERIFIED SHAPE: records from a live `bloomline/v0/players` answer captured on 2026-11-16 (Subject replaced,
 * four of the 30 records kept). Riot sends every agent; an unplayed one has an empty Flourish.
 */
const LIVE_2026_11_16 = {
  Subject: A,
  Bonsais: [
    { BonsaiID: 'add6443a-41bd-e414-f6ad-e58d267f4e95', Flourish: { Points: 658, PointsVersion: 1 }, TrackProgressList: [{ TrackID: '9f32aa28-42cc-acf1-4292-c3bb9e7d3859' }] },
    { BonsaiID: 'bb2a4828-46eb-8cd1-e765-15848195d751', Flourish: { ShortLevel: 11, PreviousShortLevel: 6, LongLevel: 17, FlourishID: 'e6db3852-468e-a169-1b72-04afdba506b8', Points: 215595, PointsVersion: 73 }, TrackProgressList: [{ TrackID: '1a4ea652-4d9d-7687-f561-e498540e94e3', TrackLevel: 17 }] },
    { BonsaiID: '569fdd95-4d10-43ab-ca70-79becc718b46', Flourish: { ShortLevel: 3, PreviousShortLevel: 1, LongLevel: 4, Points: 24668, PointsVersion: 8 }, TrackProgressList: [{ TrackID: 'a99dc9de-4bc1-4b4a-2b37-32859b65aa66', TrackLevel: 4 }] },
    { BonsaiID: '8e253930-4c05-31dd-1b6c-968525494517', Flourish: {}, TrackProgressList: [{ TrackID: '47c69be6-49a8-4564-ae5b-30b141102cc8' }] },
  ],
  LongGroupVersion: 27,
};

describe('live response shape (captured 2026-11-16)', () => {
  it('parses every record and every Points value sits in its Act Level’s wiki band', () => {
    const r = parseBloomlinePlayer(LIVE_2026_11_16, A);
    expect(r.ok && r.dropped).toBe(0);
    if (!r.ok) return;
    for (const a of r.value) expect(actProgress(a.actLevel, a.points).ok).toBe(true);
  });

  it('an empty Flourish is an unplayed agent, Points alone is progress toward Level 1', () => {
    const r = parseBloomlinePlayer(LIVE_2026_11_16, A);
    const f = recordSnapshot(emptyMasteryFile(A), { at: 1, act: { id: ACT1.id, label: ACT1.label }, agents: r.ok ? r.value : [] });
    const v = buildMasteryView({ puuid: A, file: f, agents: AGENTS, act: ACT1, live: true, status: 'ready' });
    const by = Object.fromEntries(v.agents.map((a) => [a.name, a]));
    expect(by.Omen.state).toBe('none');
    expect(by.Jett).toMatchObject({ state: 'progress', actLevel: 0, lifetimeLevel: 0, points: 658, progress: { into: 658, need: 2000, nextLevel: 1 } });
    expect(by.Sage).toMatchObject({ actLevel: 3, previousActLevel: 1, lifetimeLevel: 4 });
    expect(f.acts[0].levels).toEqual({ '569fdd95-4d10-43ab-ca70-79becc718b46': 3, 'bb2a4828-46eb-8cd1-e765-15848195d751': 11 });
  });

  it('the per-agent route answers wrapped in Bonsais', () => {
    const one = { Subject: A, Bonsais: [LIVE_2026_11_16.Bonsais[1]], LongGroupVersion: 27 };
    const r = parseBloomlineBonsai(one, A, 'bb2a4828-46eb-8cd1-e765-15848195d751');
    expect(r.ok && r.value.record?.lifetimeLevel).toBe(17);
    expect(r.ok && r.value.stats).toEqual([]);
  });
});

describe('Act Levels, portrait and the community level table', () => {
  it('matches the wiki’s cumulative totals', () => {
    expect(ACT_LEVEL_TOTAL[1]).toBe(2000);
    expect(ACT_LEVEL_TOTAL[10]).toBe(132400);
    expect(ACT_LEVEL_TOTAL[12]).toBe(245400);
    expect(ACT_LEVEL_TOTAL[30]).toBe(12308400);
  });

  it('shows progress only when Riot’s points agree with the table', () => {
    expect(actProgress(0, 0)).toEqual({ ok: true, progress: { into: 0, need: 2000, nextLevel: 1 } });
    expect(actProgress(4, 999)).toEqual({ ok: false, reason: 'mismatch' });
    expect(actProgress(1, 10500)).toEqual({ ok: false, reason: 'mismatch' }); // that is Level 2 already
    expect(actProgress(30, 13_000_000)).toEqual({ ok: false, reason: 'beyond-table' });
  });

  it('keeps last Act’s portrait accent for one more Act', () => {
    expect(portraitTier(0, 0)).toBe(0);
    expect(portraitTier(1, 0)).toBe(1);
    expect(portraitTier(4, 0)).toBe(2);
    expect(portraitTier(2, 7)).toBe(3);
    expect(portraitTier(0, 10)).toBe(4);
    expect(portraitTier(14, 0)).toBe(4);
  });
});

function fileWith(puuid: string, act: ActRef | undefined, bonsais: unknown[], at = Date.parse('2026-11-10')): MasteryFile {
  const r = parseBloomlinePlayer({ Subject: puuid, Bonsais: bonsais }, puuid);
  if (!r.ok) throw new Error(r.error);
  return recordSnapshot(emptyMasteryFile(puuid), { at, act: act && { id: act.id, label: act.label }, agents: r.value });
}

describe('mastery view', () => {
  const file = fileWith(A, ACT1, [bonsai(JETT, { ShortLevel: 7, PreviousShortLevel: 10, LongLevel: 23, Points: 80450 }), bonsai(SAGE, { ShortLevel: 4, LongLevel: 4, Points: 999 })]);

  it('tells no data, no mastery yet and progress apart', () => {
    const none = buildMasteryView({ puuid: A, file: null, agents: AGENTS, act: ACT1, live: false, status: 'idle' });
    expect(none.source).toBe('none');
    expect(none.agents.every((a) => a.state === 'unknown' && a.actLevel === null && a.lifetimeLevel === null)).toBe(true);
    const v = buildMasteryView({ puuid: A, file, agents: AGENTS, act: ACT1, live: true, status: 'ready' });
    const by = Object.fromEntries(v.agents.map((a) => [a.name, a]));
    expect(by.Omen).toMatchObject({ state: 'none', actLevel: 0, lifetimeLevel: 0, points: 0, progress: null });
    expect(by.Jett).toMatchObject({ state: 'progress', actLevel: 7, previousActLevel: 10, lifetimeLevel: 23, points: 80450, portraitTier: 4, milestones: 4 });
    expect(by.Jett.progress).toEqual({ into: 80450 - 71900, need: 17900, nextLevel: 8 });
    expect(by.Sage).toMatchObject({ progress: null, progressNote: 'mismatch' });
  });

  it('resets Act values (not Lifetime) when the Act changed since the snapshot', () => {
    const v = buildMasteryView({ puuid: A, file, agents: AGENTS, act: ACT2, live: false, status: 'ready' });
    expect(v.actChanged).toEqual({ from: ACT1.label });
    const jett = v.agents.find((a) => a.id === JETT)!;
    expect(jett).toMatchObject({ actLevel: null, points: null, previousActLevel: 7, lifetimeLevel: 23, progress: null, portraitTier: 3 });
    expect(v.agents.find((a) => a.id === OMEN)).toMatchObject({ state: 'none', actLevel: null, lifetimeLevel: 0 });
  });

  it('records per-Act history and keeps Lifetime across an Act reset', () => {
    let f = file;
    // Riot after the reset: Act Levels back to zero, previous = last Act, Lifetime kept.
    const r = parseBloomlinePlayer({ Subject: A, Bonsais: [bonsai(JETT, { ShortLevel: 1, PreviousShortLevel: 7, LongLevel: 24, Points: 3000 })] }, A);
    f = recordSnapshot(f, { at: Date.parse('2026-12-02'), act: { id: ACT2.id, label: ACT2.label }, agents: r.ok ? r.value : [] });
    expect(f.acts.map((a) => [a.id, a.levels[JETT]])).toEqual([
      ['act-1', 7],
      ['act-2', 1],
    ]);
    const v = buildMasteryView({ puuid: A, file: f, agents: AGENTS, act: ACT2, live: true, status: 'ready' });
    expect(v.agents.find((a) => a.id === JETT)).toMatchObject({ actLevel: 1, previousActLevel: 7, lifetimeLevel: 24 });
    expect(v.agents.find((a) => a.id === SAGE)).toMatchObject({ state: 'none', lifetimeLevel: 0 });
  });

  it('sorts by Act, Lifetime and name with no-data agents last', () => {
    const v = buildMasteryView({ puuid: A, file, agents: [...AGENTS, { id: 'cccccccc-0000-4000-8000-000000000000', name: 'Astra' }], act: ACT1, live: true, status: 'ready' });
    expect(sortAgents(v.agents, 'act').map((a) => a.name)).toEqual(['Jett', 'Sage', 'Astra', 'Omen']);
    expect(sortAgents(v.agents, 'lifetime').map((a) => a.name)).toEqual(['Jett', 'Sage', 'Astra', 'Omen']);
    expect(sortAgents(v.agents, 'name').map((a) => a.name)).toEqual(['Astra', 'Jett', 'Omen', 'Sage']);
  });

  it('builds 30 agents fast enough for every state push', () => {
    const agents = Array.from({ length: 30 }, (_, i) => ({ id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, name: `Agent ${i}` }));
    const f = fileWith(A, ACT1, agents.map((a, i) => bonsai(a.id, { ShortLevel: i % 11, LongLevel: 30 + i, Points: ACT_LEVEL_TOTAL[i % 11] + 5 })));
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) sortAgents(buildMasteryView({ puuid: A, file: f, agents, act: ACT1, live: true, status: 'ready' }).agents, 'act');
    expect(performance.now() - t0).toBeLessThan(500); // ~2.5 ms per build at worst
  });
});

describe('rewards, ownership and stats', () => {
  const owned = (cards: string[] = [], sprays: string[] = []): OwnedIds => ({ sprays: new Set(sprays), cards: new Set(cards), titles: new Set(), buddies: new Set(), skins: new Set() });
  const card = { type: 'card' as const, id: 'dddddddd-0000-4000-8000-000000000000', name: 'Jett Mastery Card' };

  it('locks by Lifetime Level and never claims ownership it can’t see', () => {
    const rows = rewardRows(12, card, owned(), new Set());
    expect(rows).toHaveLength(REWARD_TRACK.length);
    expect(rows.filter((r) => r.level <= 10).every((r) => r.state === 'unknown')).toBe(true);
    expect(rows.filter((r) => r.level > 12).every((r) => r.state === 'locked')).toBe(true);
    expect(rewardRows(null, card, owned(), new Set()).filter((r) => r.state !== 'unknown')).toHaveLength(0);
  });

  it('uses entitlements for the mastery card: owned even while locked, otherwise available once unlocked', () => {
    const m = (lt: number, o: OwnedIds | null) => rewardRows(lt, card, o, new Set()).find((r) => r.item)!.state;
    expect(m(30, owned())).toBe('available');
    expect(m(30, owned([card.id]))).toBe('owned');
    expect(m(3, owned([card.id]))).toBe('owned');
    expect(m(29, owned())).toBe('locked');
    expect(m(30, null)).toBe('unknown');
  });

  it('marks a stat equipped only when Riot’s slot names it', () => {
    expect(rewardRows(30, undefined, null, new Set(['kd'])).find((r) => r.stat === 'kd')!.state).toBe('equipped');
    expect(statSlotViews([{ statId: 'eeeeeeee-0000-4000-8000-000000000000', value: 9 }])[0].stat).toBeUndefined();
  });

  it('lists default and unlockable Agent ID stats like Riot’s guide', () => {
    const av = statAvailability(12);
    expect(av.filter((s) => s.state === 'default').map((s) => s.def.key)).toEqual(['assists', 'actLevel10s', 'hoursPlayed', 'gamesWon', 'damage', 'kills']);
    expect(Object.fromEntries(av.filter((s) => !s.def.default).map((s) => [s.def.key, s.state]))).toEqual({ kd: 'eligible', mvps: 'eligible', headshots: 'eligible', firstBloods: 'locked', winRate: 'locked', clutches: 'locked', aces: 'locked' });
    expect(statAvailability(null).filter((s) => s.state === 'unknown')).toHaveLength(7);
  });

  it('carries Agent Gear items over with real ownership', () => {
    const spray = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
    const list = gearCosmetics(
      [
        { rewardType: 'Spray', rewardId: spray },
        { rewardType: 'Currency', rewardId: 'eeeeeeee-2222-4222-8222-eeeeeeeeeeee' },
        { rewardType: 'PlayerCard', rewardId: card.id },
      ],
      (t) => ({ name: t }),
      owned([], [spray]),
    );
    expect(list.map((c) => [c.type, c.owned])).toEqual([
      ['spray', true],
      ['card', false],
    ]);
    expect(gearCosmetics([{ rewardType: 'Spray', rewardId: spray }], (t) => ({ name: t }), null)[0].owned).toBeNull();
  });

  it('slots Agent Gear items into the track in contract order, only when the counts agree', () => {
    const g = (type: 'spray' | 'card' | 'title' | 'buddy' | 'skin', n: number) => ({ type, id: `${type}-${n}`, name: `${type} ${n}` });
    const gear = [g('spray', 1), g('card', 1), g('title', 1), g('spray', 2), g('buddy', 1), g('spray', 3), g('title', 2), g('card', 2), g('skin', 1)];
    const rows = rewardRows(17, card, owned([], ['spray-2']), new Set(), gear);
    const at = (l: number, c: string) => rows.filter((r) => r.level === l && r.category === c).map((r) => [r.item?.id, r.state]);
    expect(at(5, 'spray')).toEqual([['spray-1', 'available']]);
    expect(at(15, 'spray')).toEqual([['spray-2', 'owned']]);
    expect(at(25, 'spray')).toEqual([['spray-3', 'locked']]);
    expect(at(10, 'card')).toEqual([['card-2', 'available']]);
    expect(at(30, 'card')).toEqual([[card.id, 'locked']]);
    expect(at(20, 'title')).toEqual([['title-2', 'locked']]);
    expect(at(30, 'title')).toEqual([[undefined, 'locked']]);
    expect(at(15, 'skin')).toEqual([['skin-1', 'available']]);
    // two sprays for three slots: leave every spray slot generic
    const short = rewardRows(17, card, owned(), new Set(), [g('spray', 1), g('spray', 2)]);
    expect(short.filter((r) => r.category === 'spray').every((r) => !r.item)).toBe(true);
    // launch agents have a third Agent Gear title, at Lifetime 30
    const three = rewardRows(17, card, owned(), new Set(), [...gear, g('title', 3)]);
    expect(three.filter((r) => r.category === 'title').map((r) => r.item?.id)).toEqual(['title-1', 'title-2', 'title-3']);
  });

  it('finds each agent’s mastery card in the public catalog by developer name', () => {
    expect(
      masteryCardsByDeveloperName([
        { uuid: card.id, assetPath: 'ShooterGame/Content/Personalization/PlayerCards/Bloomline/Bloomline_Wushu_01/Playercard_Bloomline_Wushu_01_PrimaryAsset' },
        { uuid: 'ffffffff-0000-4000-8000-000000000000', assetPath: 'ShooterGame/Content/Personalization/PlayerCards/Other/Card' },
      ]),
    ).toEqual({ wushu: card.id });
  });

  it('SexyVal analytics only count MP modes since the launch', () => {
    const row = (t: string, queue: string, result: AnalyticsRow['result'], k: number): AnalyticsRow => ({ t: Date.parse(t), queue, agent: JETT, result, k, d: 10, a: 2, hs: 25, fk: 1, lengthMs: 1_800_000, adr: 150, rounds: 20 });
    const rows = [row('2026-09-01', 'competitive', 'W', 99), row('2026-10-01', 'competitive', 'W', 20), row('2026-10-02', 'unrated', 'L', 10), row('2026-10-03', 'deathmatch', 'W', 40), { ...row('2026-10-04', 'competitive', 'W', 5), agent: SAGE }];
    const a = agentAnalytics(rows, JETT, MASTERY_LAUNCH);
    expect(a).toMatchObject({ matches: 2, wins: 1, kills: 30, deaths: 20, kd: 1.5, winRate: 0.5, hours: 1, firstBloods: 2, damage: 6000 });
    expect(agentAnalytics([], JETT, MASTERY_LAUNCH)).toMatchObject({ matches: 0, kd: null, winRate: null });
  });
});

describe('mastery file schema', () => {
  it('migrates the current schema and refuses what it can’t use', () => {
    const f = fileWith(A, ACT1, [bonsai(JETT, { LongLevel: 2, ShortLevel: 2, Points: 11000 })]);
    expect(migrateMasteryFile(JSON.parse(JSON.stringify(f)), A)).toEqual(f);
    expect(migrateMasteryFile({ ...f, schema: MASTERY_SCHEMA + 1 }, A)).toBeNull(); // newer SexyVal
    expect(migrateMasteryFile(f, B)).toBeNull(); // another account's file
    expect(migrateMasteryFile({ nope: true }, A)).toBeNull();
    const damaged = migrateMasteryFile({ schema: 1, puuid: A, current: { at: 5, agents: [{ agentId: 'bad' }, ...f.current!.agents] }, acts: 'x', stats: null }, A)!;
    expect(damaged.current!.agents).toHaveLength(1);
    expect(damaged.acts).toEqual([]);
    expect(damaged.stats).toEqual({});
  });

  it('vault payloads carry mastery files and still read without them', () => {
    const p = sanitizePayload({ files: {}, mmrUpdates: {}, mastery: { [`${A}.json`]: { schema: 1 }, 'evil/../x.json': {}, [`${B}.json`]: 'not-an-object' }, matchCount: 0 });
    expect(Object.keys(p.mastery!)).toEqual([`${A}.json`]);
    expect(sanitizePayload({ files: {}, mmrUpdates: {}, matchCount: 0 }).mastery).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------

class FakeApi implements MasteryApi {
  calls: string[] = [];
  /** puuid → [delay ms, response or error]. */
  answers = new Map<string, [number, HttpResult | Error]>();
  async bloomlinePlayer(puuid: string): Promise<HttpResult> {
    this.calls.push(`player:${puuid}`);
    const [ms, r] = this.answers.get(puuid) ?? [0, res(200, { Subject: puuid })];
    if (ms) await wait(ms);
    if (r instanceof Error) throw r;
    return r;
  }
  async bloomlineBonsai(puuid: string, agentId: string): Promise<HttpResult> {
    this.calls.push(`bonsai:${puuid}:${agentId}`);
    return res(200, { ...bonsai(agentId, { LongLevel: 3 }), NumberModules: [{ ModuleID: 'a'.repeat(32), NumberID: 'b'.repeat(32), Value: 42 }] });
  }
  async bloomlineValidQueues(): Promise<HttpResult> {
    this.calls.push('queues');
    return res(200, { ProcessedQueues: ['competitive'], PerformanceScoreQueues: [] });
  }
}

function service(dir: string, api: FakeApi, active: { p: string | null }, act: ActRef = ACT1) {
  const updates: MasteryView[] = [];
  const svc = new MasteryService({ api, dir, activePuuid: () => active.p, agents: () => AGENTS, currentAct: () => act, onUpdate: (v) => updates.push(v) });
  return { svc, updates };
}
const answer = (puuid: string, f: Record<string, number>, agent = JETT) => res(200, { Subject: puuid, Bonsais: [bonsai(agent, f)] });

describe('MasteryService', () => {
  it('saves per account and pushes views only for the active account', async () => {
    const dir = await tmp();
    const api = new FakeApi();
    api.answers.set(A, [0, answer(A, { ShortLevel: 3, LongLevel: 3, Points: 20000 })]);
    const active = { p: A };
    const { svc, updates } = service(dir, api, active);
    const v = await svc.refresh(A);
    expect(v).toMatchObject({ puuid: A, source: 'live', status: 'ready' });
    expect(updates.every((u) => u.puuid === A)).toBe(true);
    expect(updates.at(-1)!.agents.find((a) => a.id === JETT)!.actLevel).toBe(3);
    const disk = JSON.parse(await fs.readFile(path.join(dir, `${A}.json`), 'utf8'));
    expect(disk).toMatchObject({ schema: MASTERY_SCHEMA, puuid: A, current: { act: { id: ACT1.id } } });
    expect(JSON.stringify(disk)).not.toMatch(/token|entitlement|Bearer/i);
  });

  it('a slow answer for the previous account never reaches the new account’s view', async () => {
    const dir = await tmp();
    const api = new FakeApi();
    api.answers.set(A, [120, answer(A, { ShortLevel: 9, LongLevel: 40, Points: 115000 })]);
    api.answers.set(B, [0, answer(B, { ShortLevel: 1, LongLevel: 1, Points: 2500 })]);
    const active = { p: A as string | null };
    const { svc, updates } = service(dir, api, active);
    const slow = svc.refresh(A);
    await wait(10);
    active.p = B; // Riot Client account switch while A's request is in flight
    await svc.refresh(B);
    await slow;
    const afterSwitch = updates.slice(updates.findIndex((u) => u.puuid === B));
    expect(afterSwitch.every((u) => u.puuid === B)).toBe(true);
    expect(afterSwitch.at(-1)!.agents.find((a) => a.id === JETT)!.lifetimeLevel).toBe(1);
    // A's answer still went to A's own file.
    expect(JSON.parse(await fs.readFile(path.join(dir, `${A}.json`), 'utf8')).current.agents[0].lifetimeLevel).toBe(40);
    expect(JSON.parse(await fs.readFile(path.join(dir, `${B}.json`), 'utf8')).current.agents[0].lifetimeLevel).toBe(1);
  });

  it('rejects an answer naming another account and keeps the saved copy', async () => {
    const dir = await tmp();
    const api = new FakeApi();
    const active = { p: A };
    const { svc } = service(dir, api, active);
    api.answers.set(A, [0, answer(A, { ShortLevel: 2, LongLevel: 5, Points: 12000 })]);
    await svc.refresh(A);
    api.answers.set(A, [0, answer(B, { ShortLevel: 8, LongLevel: 8, Points: 95000 })]);
    const v = await svc.refresh(A);
    expect(v.status).toBe('error');
    expect(v.error).toMatch(/different account/);
    expect(v.agents.find((a) => a.id === JETT)!.lifetimeLevel).toBe(5);
  });

  it('offline and invalid answers keep the snapshot with its sync time', async () => {
    const dir = await tmp();
    const api = new FakeApi();
    let now = Date.parse('2026-11-10T10:00:00Z');
    const updates: MasteryView[] = [];
    const svc = new MasteryService({ api, dir, activePuuid: () => A, agents: () => AGENTS, currentAct: () => ACT1, onUpdate: (v) => updates.push(v), now: () => now });
    api.answers.set(A, [0, answer(A, { ShortLevel: 4, LongLevel: 6, Points: 31000 })]);
    await svc.refresh(A);
    const synced = now;
    now += 3600_000;
    api.answers.set(A, [0, new Error('connect ECONNREFUSED')]);
    let v = await svc.refresh(A);
    expect(v).toMatchObject({ status: 'error', source: 'live', syncedAt: synced });
    expect(v.agents.find((a) => a.id === JETT)!.actLevel).toBe(4);
    api.answers.set(A, [0, res(200, { Subject: A, Bonsais: 'garbage' })]);
    v = await svc.refresh(A);
    expect(v).toMatchObject({ status: 'error', syncedAt: synced });
    api.answers.set(A, [0, res(404, { errorCode: 'RESOURCE_NOT_FOUND' })]);
    expect((await svc.refresh(A)).error).toMatch(/404/);
    // A new session (app restart) offline: the saved copy, marked as such.
    const again = new MasteryService({ api: new FakeApi(), dir, activePuuid: () => null, agents: () => AGENTS, currentAct: () => ACT1 });
    const snap = await again.snapshot(A);
    expect(snap).toMatchObject({ source: 'snapshot', syncedAt: synced });
    await expect(again.snapshot(B)).rejects.toThrow();
  });

  it('get answers from the saved copy at once and refreshes in the background, deduplicated', async () => {
    const dir = await tmp();
    const api = new FakeApi();
    api.answers.set(A, [60, answer(A, { ShortLevel: 1, LongLevel: 1, Points: 2100 })]);
    const { svc, updates } = service(dir, api, { p: A });
    const v = await svc.get(A);
    expect(v.source).toBe('none');
    await svc.get(A);
    await svc.refresh(A);
    expect(api.calls.filter((c) => c.startsWith('player'))).toHaveLength(1);
    expect(updates.at(-1)!.source).toBe('live');
    await svc.get(A); // fresh: no new request
    expect(api.calls.filter((c) => c.startsWith('player'))).toHaveLength(1);
  });

  it('sets aside a damaged or newer-format file instead of overwriting it', async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, `${A}.json`), '{"schema": 99, "puuid": "x"');
    const { svc } = service(dir, new FakeApi(), { p: A });
    expect((await svc.get(A)).source).toBe('none');
    const names = await fs.readdir(dir);
    expect(names.some((n) => n.startsWith(`${A}.unread-`))).toBe(true);
  });

  it('agent detail fetches stat slots once and skips the request offline', async () => {
    const dir = await tmp();
    const api = new FakeApi();
    api.answers.set(A, [0, answer(A, { ShortLevel: 3, LongLevel: 12, Points: 20000 })]);
    const { svc } = service(dir, api, { p: A });
    await svc.refresh(A);
    const d = await svc.detail(A, JETT);
    expect(d.stats.slots).toEqual([{ slotId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', statId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', value: 42 }]);
    expect(d.rewards.find((r) => r.level === 10 && r.category === 'frame')!.state).toBe('unknown');
    expect(d.rewards.find((r) => r.level === 15)!.state).toBe('locked');
    await svc.detail(A, JETT);
    expect(api.calls.filter((c) => c.startsWith('bonsai'))).toHaveLength(1);
    const fresh = new FakeApi();
    const off = new MasteryService({ api: fresh, dir, activePuuid: () => null, agents: () => AGENTS, currentAct: () => ACT1 });
    expect((await off.detail(A, SAGE, true)).agent.state).toBe('none');
    expect(fresh.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('mock Riot server: Bloomline end to end (synthetic data)', () => {
  let mock: MockHandle;
  let api: RiotApi;
  let session: RiotSession;
  let cache: ConnectionCache = {};
  beforeAll(async () => {
    mock = await startMockServer({ quiet: true, lockDir: path.join(os.tmpdir(), `sexyval-mastery-${process.pid}`) });
    mock.setPhase('idle');
    session = new RiotSession({
      lockfilePath: mock.lockfilePath,
      shooterLogPath: path.join(os.tmpdir(), 'sexyval-no-log'),
      overrideGlz: `${mock.base}/glz`,
      overridePd: `${mock.base}/pd`,
      overrideShared: `${mock.base}/shared`,
      loadCache: async () => cache,
      saveCache: async (c) => {
        cache = c;
      },
    });
    api = new RiotApi(session, () => undefined);
    await session.ensure();
  });
  afterAll(async () => {
    setMockMastery('');
    await mock.close();
  });

  it('reads mastery through the real API client, dropping the malformed record', async () => {
    const r = parseBloomlinePlayer((await api.bloomlinePlayer(MOCK_ME)).json, MOCK_ME);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dropped).toBe(1);
    expect(r.value.length).toBeGreaterThanOrEqual(5);
    const omen = r.value.find((x) => x.agentId === OMEN)!;
    expect(omen).toMatchObject({ actLevel: 0, previousActLevel: 6, lifetimeLevel: 9, points: 0 });
    const one = parseBloomlineBonsai((await api.bloomlineBonsai(MOCK_ME, JETT)).json, MOCK_ME, JETT);
    expect(one.ok && one.value.stats.length).toBe(3);
    expect(parseValidQueues((await api.bloomlineValidQueues()).json)?.processed).toContain('competitive');
  });

  it('serves each account its own data and fails cleanly in the failure modes', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    const r = parseBloomlinePlayer((await api.bloomlinePlayer(other)).json, other);
    expect(r.ok && r.value.find((x) => x.agentId === JETT)?.lifetimeLevel).toBe(1);
    setMockMastery('invalid');
    expect(parseBloomlinePlayer((await api.bloomlinePlayer(MOCK_ME)).json, MOCK_ME).ok).toBe(false);
    setMockMastery('empty');
    expect(parseBloomlinePlayer((await api.bloomlinePlayer(MOCK_ME)).json, MOCK_ME)).toEqual({ ok: true, value: [], dropped: 0 });
    setMockMastery('notfound');
    expect((await api.bloomlinePlayer(MOCK_ME)).status).toBe(404);
    setMockMastery('');
  });

  it('a full service run against the mock keeps accounts apart under a delayed answer', async () => {
    const other = '44444444-4444-4444-8444-444444444444';
    setMockMastery('', { [MOCK_ME]: 300 });
    const dir = await tmp();
    const active = { p: MOCK_ME as string | null };
    const updates: MasteryView[] = [];
    const svc = new MasteryService({ api, dir, activePuuid: () => active.p, agents: () => AGENTS, currentAct: () => ACT1, onUpdate: (v) => updates.push(v) });
    const slow = svc.refresh(MOCK_ME);
    await wait(30);
    active.p = other;
    await svc.refresh(other);
    await slow;
    setMockMastery('');
    const after = updates.slice(updates.findIndex((u) => u.puuid === other));
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((u) => u.puuid === other)).toBe(true);
    expect((await svc.snapshot(MOCK_ME)).agents.find((a) => a.id === JETT)!.lifetimeLevel).toBe(23);
  });
});
