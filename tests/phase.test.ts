import { describe, expect, it, vi } from 'vitest';
import { FAST_MS, nextDelay, phaseEventUri, phaseFrom, phaseLabel, WAIT_MS } from '../shared/phase';
import { parsePartyCore, parseQueueEntryTime } from '../shared/party';
import { GameLoop } from '../main/loop';
import { HttpError } from '../main/riot/http';

const party = (State: string, extra: Record<string, unknown> = {}) => ({ ID: 'P1', State, MatchmakingData: { QueueID: 'competitive' }, QueueEntryTime: '2026-11-05T10:00:00Z', ...extra });

describe('phase from responses', () => {
  it('walks idle -> queue -> pregame -> ingame -> idle', () => {
    const steps = [
      { pregameMatch: null, coreMatch: null, party: party('DEFAULT') },
      { pregameMatch: null, coreMatch: null, party: party('MATCHMAKING') },
      { pregameMatch: { ID: 'M1' }, coreMatch: null, party: null },
      { pregameMatch: null, coreMatch: { MatchID: 'M1' }, party: null },
      { pregameMatch: null, coreMatch: null, party: party('DEFAULT') },
    ];
    expect(steps.map(phaseFrom)).toEqual(['idle', 'queue', 'pregame', 'ingame', 'idle']);
  });
  it('match beats party state, and no party at all is idle', () => {
    expect(phaseFrom({ pregameMatch: { ID: 'x' }, coreMatch: null, party: party('MATCHMAKING') })).toBe('pregame');
    expect(phaseFrom({ pregameMatch: null, coreMatch: { MatchID: 'x' }, party: party('MATCHMAKING') })).toBe('ingame');
    expect(phaseFrom({ pregameMatch: null, coreMatch: null, party: null })).toBe('idle');
    expect(phaseFrom({ pregameMatch: null, coreMatch: null, party: { State: 'MATCHMADE_GAME_STARTING' } })).toBe('idle');
  });
  it('labels each phase for the header chip and tray', () => {
    expect(phaseLabel('queue', true)).toBe('In queue');
    expect(phaseLabel('pregame', true)).toBe('Agent select');
    expect(phaseLabel('ingame', false)).toBe('Valorant closed');
  });
});

describe('party parsing (shared by the Party screen and the loop)', () => {
  it('reads state, queue and entry time; treats 0001-01-01 as unset', () => {
    const p = parsePartyCore(party('MATCHMAKING', { EligibleQueues: ['competitive'], Accessibility: 'OPEN', InviteCode: '' }));
    expect(p).toMatchObject({ state: 'MATCHMAKING', matchmaking: true, queueId: 'competitive', accessibility: 'OPEN', inviteCode: undefined, queueEntryAt: Date.parse('2026-11-05T10:00:00Z') });
    expect(parseQueueEntryTime('0001-01-01T00:00:00Z')).toBeUndefined();
    expect(parseQueueEntryTime(undefined)).toBeUndefined();
    expect(parsePartyCore(null)).toMatchObject({ matchmaking: false, eligibleQueues: [], preferredPods: [] });
  });
});

describe('cadence', () => {
  it('queue and agent select tick every second regardless of the poll setting', () => {
    expect(nextDelay({ phase: 'queue', pollMs: 12_000, valorantRunning: true, backoffMs: 0 })).toBe(FAST_MS);
    expect(nextDelay({ phase: 'pregame', pollMs: 30_000, valorantRunning: true, backoffMs: 0 })).toBe(1000);
  });
  it('menus and matches use the poll setting; no Valorant waits at least WAIT_MS', () => {
    expect(nextDelay({ phase: 'ingame', pollMs: 5000, valorantRunning: true, backoffMs: 0 })).toBe(5000);
    expect(nextDelay({ phase: 'idle', pollMs: 8000, valorantRunning: true, backoffMs: 0 })).toBe(8000);
    expect(nextDelay({ phase: 'idle', pollMs: 2000, valorantRunning: false, backoffMs: 0 })).toBe(WAIT_MS);
  });
  it('429/5xx backoff wins over the fast cadence', () => {
    expect(nextDelay({ phase: 'queue', pollMs: 5000, valorantRunning: true, backoffMs: 20_000 })).toBe(20_000);
    expect(nextDelay({ phase: 'pregame', pollMs: 5000, valorantRunning: true, backoffMs: 10_000 })).toBe(10_000);
  });
});

describe('Riot Client WebSocket events', () => {
  it('keeps party / pregame / core-game events and drops the rest', () => {
    const ev = (uri: string) => JSON.stringify([8, 'OnJsonApiEvent', { data: {}, eventType: 'Update', uri }]);
    expect(phaseEventUri(ev('/riot-messaging-service/v1/message/ares-parties/parties/v1/parties/P1'))).toContain('ares-parties');
    expect(phaseEventUri(ev('/riot-messaging-service/v1/message/ares-pregame/pregame/v1/matches/M1'))).toContain('ares-pregame');
    expect(phaseEventUri(ev('/riot-messaging-service/v1/message/ares-core-game/core-game/v1/matches/M1'))).toContain('ares-core-game');
    expect(phaseEventUri(ev('/chat/v4/presences'))).toBeNull();
    expect(phaseEventUri('')).toBeNull();
    expect(phaseEventUri('not json')).toBeNull();
    expect(phaseEventUri(JSON.stringify([5, 'OnJsonApiEvent']))).toBeNull();
  });
});

// ---------------- the loop itself, with fake Riot responses ----------------

const ME = 'me-0000';
const ALLY = 'ally-0001';
const HIDDEN = 'hidden-0002';
const ENEMY_HIDDEN = 'enemy-hidden-0003';
const ok = (json: unknown) => ({ status: 200, json, text: '', headers: { get: () => null }, url: '' });
const nf = () => ({ status: 404, json: null, text: '', headers: { get: () => null }, url: '' });
const ident = (incognito: boolean) => ({ Incognito: incognito, AccountLevel: 77 });

function harness() {
  const r = { pregame: null as any, core: null as any, party: party('DEFAULT') as any, partyStatus: 200, failWith: 0 };
  const api = {
    pregamePlayer: vi.fn(async () => {
      if (r.failWith) throw new HttpError(r.failWith, '/pregame', '');
      return r.pregame ? ok({ MatchID: 'M1' }) : nf();
    }),
    pregameMatch: vi.fn(async () => (r.pregame ? ok(r.pregame) : nf())),
    coreGamePlayer: vi.fn(async () => (r.core ? ok({ MatchID: 'M1' }) : nf())),
    coreGameMatch: vi.fn(async () => (r.core ? ok(r.core) : nf())),
    partyPlayer: vi.fn(async () => ok({ CurrentPartyID: 'P1' })),
    party: vi.fn(async () => (r.partyStatus === 200 ? ok(r.party) : nf())),
  };
  const names = { request: vi.fn(), get: vi.fn((p: string) => ({ name: `n-${p}`, tag: 't' })) };
  const history = { ensure: vi.fn(), get: vi.fn(() => ({ status: 'done', matches: [] })), score: vi.fn(() => null), invalidate: vi.fn() };
  const mmr = { ensure: vi.fn(), get: vi.fn(() => ({ status: 'done' as const })) };
  const session = { ensure: vi.fn(async () => undefined), puuid: ME, valorantRunning: true, tokenSource: 'riot-client', riotClient: 'up' };
  const loop = new GameLoop({
    session: session as any,
    api: api as any,
    assets: { ready: true, agent: () => undefined, rank: () => undefined, map: () => undefined } as any,
    history: history as any,
    names: names as any,
    shop: { start: vi.fn(), stop: vi.fn() } as any,
    mmr,
    emit: vi.fn(),
    toast: vi.fn(),
    mock: true,
    pollMs: () => 5000,
  });
  return { r, api, names, history, mmr, loop };
}

/** Every puuid any lookup function was called with. */
function looked(h: ReturnType<typeof harness>): Set<string> {
  const out = new Set<string>();
  for (const c of h.names.request.mock.calls) for (const p of c[0] as string[]) out.add(p);
  for (const fn of [h.names.get, h.history.ensure, h.history.get, h.history.score, h.mmr.ensure, h.mmr.get]) for (const c of fn.mock.calls as unknown[][]) out.add(String(c[0]));
  return out;
}

describe('GameLoop', () => {
  it('goes idle -> queue -> pregame -> ingame -> idle and builds the queue view', async () => {
    const h = harness();
    const phases: string[] = [];
    const step = async () => {
      await h.loop.tick();
      phases.push(h.loop.snapshot().phase);
    };
    await step();
    h.r.party = party('MATCHMAKING');
    await step();
    expect(h.loop.snapshot().queue).toMatchObject({ queueId: 'competitive', queueName: 'Competitive', enteredAt: Date.parse('2026-11-05T10:00:00Z') });
    expect(h.loop.state.conn.message).toBe('In queue');
    h.r.pregame = { ID: 'M1', MapID: '/Game/Maps/Ascent/Ascent', AllyTeam: { TeamID: 'Red', Players: [{ Subject: ME, PlayerIdentity: ident(false) }] }, QueueID: 'competitive' };
    await step();
    h.r.pregame = null;
    h.r.core = { MatchID: 'M1', Players: [{ Subject: ME, TeamID: 'Red', PlayerIdentity: ident(false) }] };
    await step();
    h.r.core = null;
    h.r.party = party('DEFAULT');
    await step();
    expect(phases).toEqual(['idle', 'queue', 'pregame', 'ingame', 'idle']);
  });

  it('caches CurrentPartyID and asks again only after the party call 404s', async () => {
    const h = harness();
    await h.loop.tick();
    await h.loop.tick();
    await h.loop.tick();
    expect(h.api.partyPlayer).toHaveBeenCalledTimes(1);
    expect(h.api.party).toHaveBeenCalledTimes(3);
    h.r.partyStatus = 404;
    await h.loop.tick();
    expect(h.api.partyPlayer).toHaveBeenCalledTimes(2);
  });

  it('pushes the map the moment it appears in agent select (no debounce)', async () => {
    const h = harness();
    const emit = (h.loop as any).d.emit as ReturnType<typeof vi.fn>;
    h.r.pregame = { ID: 'M1', MapID: '', AllyTeam: { TeamID: 'Blue', Players: [] }, QueueID: 'competitive' };
    await h.loop.tick(); // phase change -> immediate emit
    const before = emit.mock.calls.length;
    await h.loop.tick(); // nothing new -> debounced only
    expect(emit.mock.calls.length).toBe(before);
    h.r.pregame = { ...h.r.pregame, MapID: '/Game/Maps/Ascent/Ascent' };
    await h.loop.tick();
    expect(emit.mock.calls.length).toBe(before + 1);
  });

  it('never looks up a hidden (incognito) player: no names, history, score or MMR', async () => {
    const h = harness();
    h.r.pregame = {
      ID: 'M1',
      MapID: '/Game/Maps/Ascent/Ascent',
      QueueID: 'competitive',
      AllyTeam: {
        TeamID: 'Red',
        Players: [
          { Subject: ME, PlayerIdentity: ident(false) },
          { Subject: ALLY, PlayerIdentity: ident(false) },
          { Subject: HIDDEN, CompetitiveTier: 20, PlayerIdentity: ident(true) },
        ],
      },
    };
    await h.loop.tick();
    const pre = structuredClone(h.loop.snapshot());
    h.r.pregame = null;
    h.r.core = {
      MatchID: 'M1',
      Players: [
        { Subject: ME, TeamID: 'Red', PlayerIdentity: ident(false) },
        { Subject: ALLY, TeamID: 'Red', PlayerIdentity: ident(false) },
        { Subject: HIDDEN, TeamID: 'Red', PlayerIdentity: ident(true) },
        { Subject: ENEMY_HIDDEN, TeamID: 'Blue', PlayerIdentity: ident(true) },
      ],
    };
    await h.loop.tick();
    const core = h.loop.snapshot();
    const seen = looked(h);
    expect(seen.has(ALLY)).toBe(true);
    expect(seen.has(HIDDEN)).toBe(false);
    expect(seen.has(ENEMY_HIDDEN)).toBe(false);
    const hiddenRow = pre.pregame!.allies.find((p) => p.puuid === HIDDEN)!;
    expect(hiddenRow).toMatchObject({ name: undefined, last5: { status: 'skipped' }, svScore: undefined, mmr: undefined, accountLevel: 77 });
    expect(core.coregame!.enemyTeam[0]).toMatchObject({ name: undefined, svScore: undefined, mmr: undefined });
    // The visible ally does get a score and MMR.
    expect(pre.pregame!.allies.find((p) => p.puuid === ALLY)!.mmr).toEqual({ status: 'done' });
    // Profiles / MMR / lifetime ask the loop before looking anyone up: hidden players are refused there too.
    expect(h.loop.isHidden(HIDDEN)).toBe(true);
    expect(h.loop.isHidden(ENEMY_HIDDEN)).toBe(true);
    expect(h.loop.isHidden(ALLY)).toBe(false);
    expect(h.loop.isHidden(ME)).toBe(false);
  });

  it('does not fetch enemies in agent select', async () => {
    const h = harness();
    h.r.pregame = { ID: 'M1', MapID: 'x', QueueID: 'competitive', AllyTeam: { TeamID: 'Red', Players: [{ Subject: ME, PlayerIdentity: ident(false) }] }, EnemyTeam: { Players: [{ Subject: 'enemy-1', PlayerIdentity: ident(false) }] } };
    await h.loop.tick();
    expect(looked(h).has('enemy-1')).toBe(false);
  });

  it('a 429 backoff wins over the 1 s cadence and drops WebSocket nudges', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.r.party = party('MATCHMAKING');
      await h.loop.tick();
      expect(h.loop.state.phase).toBe('queue');
      h.r.failWith = 429;
      await h.loop.tick();
      expect(h.loop.state.conn.backoffMs).toBeGreaterThanOrEqual(10_000);
      const calls = h.api.pregamePlayer.mock.calls.length;
      h.loop.start();
      h.loop.nudge();
      await vi.advanceTimersByTimeAsync(5000); // well past the fast cadence and the nudge delay
      expect(h.api.pregamePlayer.mock.calls.length).toBe(calls + 1); // only start()'s immediate tick
      h.loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
