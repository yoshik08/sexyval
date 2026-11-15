import { describe, expect, it } from 'vitest';
import { buildReplay, clutchOf, frameAt, replayEvents, snapshots, toMinimap, TRADE_WINDOW } from '../shared/replay';

const TF = { xm: 0.00007, ym: -0.00007, xa: 0.813895, ya: 0.573242 }; // Ascent
const A = ['a1', 'a2', 'a3', 'a4', 'a5'];
const B = ['b1', 'b2', 'b3', 'b4', 'b5'];
const loc = (x: number, y: number) => ({ x, y });
const kill = (round: number, t: number, killer: string, victim: string, extra: any = {}) => ({
  round,
  roundTime: t,
  killer,
  victim,
  assistants: extra.assistants ?? [],
  victimLocation: extra.victimLocation ?? loc(1000, 1000),
  playerLocations: extra.playerLocations ?? [{ subject: killer, viewRadians: 1, location: loc(0, 0) }],
  finishingDamage: { damageType: 'Weapon', damageItem: '9C82E19D-4575-0200-1A81-3EACF00CF872' },
});
function raw(kills: any[], extra: any = {}) {
  return {
    matchInfo: { matchId: 'm1', mapId: '/Game/Maps/Ascent/Ascent', gameStartMillis: 1, queueID: 'competitive' },
    players: [...A.map((s) => ({ subject: s, teamId: 'Blue', gameName: '', tagLine: '', characterId: 'AGENT', stats: { kills: 1, deaths: 1, assists: 0 } })), ...B.map((s) => ({ subject: s, teamId: 'Red', stats: {} }))],
    teams: [{ teamId: 'Blue', won: true, roundsWon: 13 }, { teamId: 'Red', won: false, roundsWon: 5 }],
    roundResults: [{ roundNum: 0, winningTeam: 'Blue', roundResult: 'Eliminated', playerStats: [], ...extra }],
    kills,
  };
}

describe('replay', () => {
  it('maps game units onto the minimap with swapped axes', () => {
    const p = toMinimap({ x: 1000, y: 2000 }, TF)!;
    expect(p.x).toBeCloseTo(2000 * 0.00007 + 0.813895);
    expect(p.y).toBeCloseTo(1000 * -0.00007 + 0.573242);
    expect(toMinimap({ x: 1, y: 1 }, undefined)).toBeUndefined();
  });

  it('builds rounds from the top-level kills, flags trades and streaks', () => {
    const d = buildReplay(raw([kill(0, 10_000, 'b1', 'a1'), kill(0, 10_000 + TRADE_WINDOW - 1, 'a2', 'b1'), kill(0, 30_000, 'a2', 'b2'), kill(0, 31_000, 'a2', 'b3')]), TF);
    expect(d.hasPositions).toBe(true);
    expect(d.players[0].name).toBeUndefined(); // empty names stay empty: the name service fills them
    const r = d.rounds[0];
    expect(r.kills.map((k) => k.trade)).toEqual([false, true, false, false]);
    expect(r.kills.map((k) => k.streak)).toEqual([1, 1, 2, 3]);
    expect(r.kills[0].weapon).toBe('9c82e19d-4575-0200-1a81-3eacf00cf872');
    expect(r.length).toBeGreaterThan(31_000);
  });

  it('falls back to playerStats kills when there is no top-level list (and never doubles them)', () => {
    const k = kill(0, 5000, 'a1', 'b1');
    const d = buildReplay(raw([], { playerStats: [{ subject: 'a1', kills: [k] }, { subject: 'b1', kills: [] }] }), TF);
    expect(d.rounds[0].kills).toHaveLength(1);
  });

  it('interpolates between snapshots and pins the dead where they fell', () => {
    const d = buildReplay(
      raw([
        kill(0, 10_000, 'a1', 'b1', { playerLocations: [{ subject: 'a1', location: loc(0, 0) }, { subject: 'a2', location: loc(0, 0) }], victimLocation: loc(500, 500) }),
        kill(0, 20_000, 'a1', 'b2', { playerLocations: [{ subject: 'a1', location: loc(0, 0) }, { subject: 'a2', location: loc(1000, 0) }] }),
      ]),
      TF,
    );
    const r = d.rounds[0];
    const f = frameAt(r, snapshots(r), ['a1', 'a2', 'b1'], 15_000);
    expect(f.a2.y).toBeCloseTo((toMinimap(loc(0, 0), TF)!.y + toMinimap(loc(1000, 0), TF)!.y) / 2);
    expect(f.a2.estimated).toBe(false);
    expect(f.b1.alive).toBe(false);
    expect(f.b1.x).toBeCloseTo(toMinimap(loc(500, 500), TF)!.x);
    // Before the first snapshot: held at the first known spot, marked estimated.
    expect(frameAt(r, snapshots(r), ['a2'], 0).a2.estimated).toBe(true);
  });

  it('events: aces, clutches and a focused player’s deaths and assists', () => {
    const ace = B.map((b, i) => kill(0, 10_000 + i * 1000, 'a1', b));
    const d = buildReplay(raw(ace), TF);
    const ev = replayEvents(d);
    expect(ev.some((e) => e.kind === 'ace' && e.player === 'a1')).toBe(true);
    const mine = replayEvents(buildReplay(raw([kill(0, 1000, 'b1', 'a3', { assistants: [] }), kill(0, 2000, 'a1', 'b1', { assistants: ['a3'] })]), TF), 'a3');
    expect(mine.map((e) => e.kind)).toEqual(['death', 'assist']);
    // 1v3 clutch: four Blue players die first, a5 kills everyone left.
    const cl = buildReplay(raw([...A.slice(0, 4).map((a, i) => kill(0, 1000 + i, 'b1', a)), ...B.map((b, i) => kill(0, 9000 + i * 100, 'a5', b))]), TF);
    const team = new Map(cl.players.map((p) => [p.puuid, p.teamId]));
    expect(clutchOf(cl.rounds[0], team)).toMatchObject({ player: 'a5', against: 5 });
  });

  it('plants carry their site and positions', () => {
    const d = buildReplay(raw([], { bombPlanter: 'a1', plantRoundTime: 40_000, plantSite: 'A', plantLocation: loc(10, 10), plantPlayerLocations: [{ subject: 'a1', location: loc(10, 10) }] }), TF);
    expect(d.rounds[0].plant).toMatchObject({ t: 40_000, player: 'a1', site: 'A' });
    expect(d.rounds[0].attackers).toBe('Blue');
    expect(snapshots(d.rounds[0])).toHaveLength(1);
  });
});
