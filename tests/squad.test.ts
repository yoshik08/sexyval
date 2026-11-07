import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { RiotApi } from '../main/riot/api';
import { HistoryService, NameService } from '../main/services/history';
import { ProfileService } from '../main/services/profiles';
import { MmrEstimateService, pageUpdates } from '../main/services/mmrEstimate';
import { MAX_PREMADE_DETAIL_FETCH, SquadService } from '../main/services/squad';
import type { MmrTeamView } from '../shared/features';

process.env.SEXYVAL_QUIET = '1';

/** A valid, unique PUUID per label (hex of the label). */
const id = (s: string) => `00000000-0000-4000-a000-${Buffer.from(s).toString('hex').padStart(12, '0').slice(-12)}`;
const FRIEND_ONLY = new Set(Array.from({ length: 22 }, (_, i) => id(`fm${i}`)));
const ME = id('aaaa');
const FRIEND = id('f1');
const HIDDEN = id('h1');
const ONCE = id('o1');
const assets = { agent: (x?: string) => (x ? { id: x, name: 'agent', icon: 'icon' } : undefined), mapName: (m?: string) => m, rank: (t: unknown) => ({ tier: Number(t), name: `tier ${t}` }) } as any;
const catalog = { browse: { seasons: [] as any[] }, catalog: { cards: [], titles: [] } } as any;

/** Raw match-details JSON (what Riot sends), you on Blue with the given premades. */
function rawMatch(mid: string, players: { p: string; party: string; team: 'Blue' | 'Red'; tier: number; acs: number }[], blueWon: boolean) {
  return {
    matchInfo: { matchId: mid, mapId: '/Game/Maps/Ascent/Ascent', gameStartMillis: 1_700_000_000_000, queueID: 'competitive' },
    players: players.map((x) => ({ subject: x.p, teamId: x.team, partyId: x.party, competitiveTier: x.tier, characterId: 'agent', gameName: `n-${x.p.slice(0, 4)}`, tagLine: 'tag', stats: { score: x.acs * 22, roundsPlayed: 22, kills: 15, deaths: 15, assists: 3 } })),
    teams: [
      { teamId: 'Blue', won: blueWon, roundsWon: blueWon ? 13 : 9 },
      { teamId: 'Red', won: !blueWon, roundsWon: blueWon ? 9 : 13 },
    ],
    roundResults: [],
  };
}

interface World {
  updates: Record<string, any[]>;
  details: Record<string, any>;
}

/** 25 of your matches: the friend in 8, the hidden player in 6, a one-off in 1; the friend also has 30 games of their own. */
function world(myCount = 25): World {
  const w: World = { updates: {}, details: {} };
  const me: any[] = [];
  for (let i = 0; i < myCount; i++) {
    const mid = id(`m${i}`);
    const prem = [i < 8 ? FRIEND : null, i >= 8 && i < 14 ? HIDDEN : null, i === 20 ? ONCE : null].filter((x): x is string => !!x);
    const party = `party-${i}`;
    const win = i % 3 !== 0;
    const players = [
      { p: ME, party, team: 'Blue' as const, tier: 14, acs: 220 },
      ...prem.map((p) => ({ p, party, team: 'Blue' as const, tier: 13, acs: 180 })),
      ...Array.from({ length: 4 - prem.length }, (_, k) => ({ p: id(`r${i}x${k}`), party: `solo-${i}-${k}`, team: 'Blue' as const, tier: 14, acs: 200 })),
      ...Array.from({ length: 5 }, (_, k) => ({ p: id(`e${i}x${k}`), party: `e-${i}-${k}`, team: 'Red' as const, tier: 14, acs: 200 })),
    ];
    w.details[mid] = rawMatch(mid, players, win);
    me.push({ MatchID: mid, MatchStartTime: 2e12 - i * 1e6, SeasonID: '', TierBeforeUpdate: 14, TierAfterUpdate: 14, RankedRatingBeforeUpdate: 50, RankedRatingAfterUpdate: 50, RankedRatingEarned: win ? 20 : -18, AFKPenalty: 0 });
  }
  w.updates[ME] = me;
  // The friend's own career: the shared games plus 22 without you (details only on the "server").
  const fr: any[] = me.slice(0, 8).map((u) => ({ ...u, TierBeforeUpdate: 13, TierAfterUpdate: 13, RankedRatingEarned: u.RankedRatingEarned > 0 ? 14 : -22 }));
  for (let i = 0; i < 22; i++) {
    const mid = id(`fm${i}`);
    w.details[mid] = rawMatch(mid, [{ p: FRIEND, party: 'fp', team: 'Blue', tier: 13, acs: 190 }, ...Array.from({ length: 9 }, (_, k) => ({ p: id(`fx${i}${k}`), party: `fx${k}`, team: (k < 4 ? 'Blue' : 'Red') as 'Blue' | 'Red', tier: 12, acs: 200 }))], i % 2 === 0);
    fr.push({ MatchID: mid, MatchStartTime: 1e12 - i * 1e6, SeasonID: '', TierBeforeUpdate: 13, TierAfterUpdate: 13, RankedRatingBeforeUpdate: 40, RankedRatingAfterUpdate: 40, RankedRatingEarned: i % 2 === 0 ? 14 : -22, AFKPenalty: 0 });
  }
  w.updates[FRIEND] = fr.sort((a, b) => b.MatchStartTime - a.MatchStartTime);
  return w;
}

/** A RiotApi stand-in that records every call and can hold a player's mmr call until released. */
function spyApi(w: World) {
  const calls: { m: string; args: any[] }[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const mmrJson = (p: string) => ({ QueueSkills: { competitive: { SeasonalInfoBySeasonID: {} } }, LatestCompetitiveUpdate: w.updates[p]?.[0] ?? null, Subject: p });
  const api = {
    session: { puuid: ME },
    pdCalls: 0,
    async mmr(p: string) {
      calls.push({ m: 'mmr', args: [p] });
      if (p === FRIEND) await gate;
      return { status: 200, json: mmrJson(p) };
    },
    async competitiveUpdates(p: string, end = 20, _q = 'competitive', start = 0) {
      calls.push({ m: 'competitiveUpdates', args: [p, start, end] });
      return { status: 200, json: { Matches: (w.updates[p] ?? []).slice(start, Math.min(end, start + 20)) } };
    },
    async history(p: string) {
      calls.push({ m: 'history', args: [p] });
      return { status: 200, json: { History: [] } };
    },
    async matchDetails(mid: string) {
      calls.push({ m: 'matchDetails', args: [mid] });
      return w.details[mid] ? { status: 200, json: w.details[mid] } : { status: 404, json: null };
    },
    async names(ids: string[]) {
      calls.push({ m: 'names', args: [ids] });
      return { status: 200, json: ids.map((s) => ({ Subject: s, GameName: `name-${s.slice(-4)}`, TagLine: '0001' })) };
    },
    async local() {
      throw new Error('no client');
    },
  };
  return { api: api as unknown as RiotApi, calls, release };
}

describe('SquadService (spy RiotApi)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sexyval-squad-'));
  });
  // Persisted updates are written in the background: give them a moment, and retry the delete.
  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 100));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const setup = (w: World, hidden = new Set<string>()) => {
    const spy = spyApi(w);
    const sub = path.join(dir, String(Math.random()).slice(2));
    const history = new HistoryService(spy.api, assets, path.join(sub, 'matches'), () => undefined);
    const names = new NameService(spy.api, () => undefined);
    const profiles = new ProfileService(spy.api, assets, catalog, history, names);
    const isHidden = (p: string) => hidden.has(p);
    const mmr = new MmrEstimateService(spy.api, assets, catalog, history, names, profiles, path.join(sub, 'mmr'), isHidden);
    const updates: MmrTeamView[] = [];
    const squad = new SquadService({ api: spy.api, assets, catalog, history, names, profiles, mmr, isHidden, livePenalty: () => undefined, onUpdate: (v) => updates.push(v) });
    return { ...spy, squad, updates };
  };

  it('pages 25 updates as 0–20 then 20–25, and stops on a short first page', async () => {
    const full = setup(world(25));
    expect(await pageUpdates(full.api, ME)).toHaveLength(25);
    expect(full.calls.filter((c) => c.m === 'competitiveUpdates').map((c) => c.args.slice(1))).toEqual([
      [0, 20],
      [20, 25],
    ]);
    const short = setup(world(12));
    expect(await pageUpdates(short.api, ME)).toHaveLength(12);
    expect(short.calls.filter((c) => c.m === 'competitiveUpdates')).toHaveLength(1);
  });

  it('answers before premade lookups finish, then fills them in', async () => {
    const t = setup(world(), new Set([HIDDEN]));
    const first = await t.squad.get(ME);
    const friend = first.squad.find((r) => r.puuid === FRIEND)!;
    expect(friend.status).toBe('loading');
    expect(friend.theirEstMmr).toBeUndefined();
    expect(first.lookups).toEqual({ done: 0, total: 1 });
    expect(first.team.estimate.team!.window).toBe(25);
    t.release();
    for (let i = 0; i < 100 && !t.updates.some((v) => v.lookups.done === 1); i++) await new Promise((r) => setTimeout(r, 10));
    const last = t.updates.at(-1)!;
    const f2 = last.squad.find((r) => r.puuid === FRIEND)!;
    expect(f2.status).toBe('ready');
    expect(f2.theirEstMmr).toBeDefined();
    expect(f2.theirRR).toMatchObject({ games: 8 });
    expect(f2.name).toBe(`name-${FRIEND.slice(-4)}`);
    // Their games without you: at most MAX_PREMADE_DETAIL_FETCH new details.
    const friendOnly = t.calls.filter((c) => c.m === 'matchDetails' && FRIEND_ONLY.has(String(c.args[0])));
    expect(friendOnly.length).toBeLessThanOrEqual(MAX_PREMADE_DETAIL_FETCH);
    // The one-off premade (1 game) is listed but never looked up.
    expect(last.squad.find((r) => r.puuid === ONCE)).toMatchObject({ status: 'skipped', eligible: false });
    expect(t.calls.some((c) => c.args.flat().includes(ONCE) && c.m !== 'names')).toBe(false);
  });

  it('a hidden premade is shown as hidden and never reaches mmr, competitiveUpdates, history or names', async () => {
    const t = setup(world(), new Set([HIDDEN]));
    t.release();
    const v = await t.squad.get(ME);
    for (let i = 0; i < 100 && !t.updates.length; i++) await new Promise((r) => setTimeout(r, 10));
    const h = (t.updates.at(-1) ?? v).squad.find((r) => r.puuid === HIDDEN)!;
    expect(h).toMatchObject({ hidden: true, status: 'hidden', games: 6 });
    expect(h.theirEstMmr).toBeUndefined();
    expect(h.name).toBeUndefined();
    expect(h.cardIcon).toBeUndefined();
    const touched = t.calls.filter((c) => ['mmr', 'competitiveUpdates', 'history', 'names'].includes(c.m) && c.args.flat().includes(HIDDEN));
    expect(touched).toEqual([]);
    expect(v.team.matches.find((m) => m.premades?.includes(HIDDEN))!.premadeNames).toEqual(['Hidden teammate']);
    // And the hidden player can't be opened directly either.
    await expect(t.squad.get(HIDDEN)).rejects.toThrow(/Hidden player/);
  });

  it('re-fetches a cached copy that predates partyId, once', async () => {
    const t = setup(world());
    t.release();
    // Warm the disk cache, then strip the party data like a pre-1.3 cache would have it.
    const v = await t.squad.get(ME);
    expect(v.team.estimate.team!.noPartyData).toBe(0);
    const sub = path.dirname(((t.squad as any).d.history as any).dir);
    const mdir = path.join(sub, 'matches');
    for (const f of await fs.readdir(mdir)) {
      const j = JSON.parse(await fs.readFile(path.join(mdir, f), 'utf8'));
      delete j.partyData;
      for (const p of j.players) delete p.partyId;
      await fs.writeFile(path.join(mdir, f), JSON.stringify(j));
    }
    const fresh = setup(world());
    (fresh as any).squad.d.history = new HistoryService(fresh.api, assets, mdir, () => undefined);
    const hist = (fresh as any).squad.d.history as HistoryService;
    fresh.release();
    const mmr = new MmrEstimateService(fresh.api, assets, catalog, hist, new NameService(fresh.api, () => undefined), new ProfileService(fresh.api, assets, catalog, hist, new NameService(fresh.api, () => undefined)), path.join(sub, 'mmr2'));
    const squad = new SquadService({ api: fresh.api, assets, catalog, history: hist, names: new NameService(fresh.api, () => undefined), profiles: new ProfileService(fresh.api, assets, catalog, hist, new NameService(fresh.api, () => undefined)), mmr, isHidden: () => false, livePenalty: () => 0.25, onUpdate: () => undefined });
    const r = await squad.get(ME);
    expect(r.team.estimate.team!.noPartyData).toBe(0);
    expect(fresh.calls.filter((c) => c.m === 'matchDetails' && !FRIEND_ONLY.has(String(c.args[0])))).toHaveLength(25);
    expect(r.livePenalty).toBe(0.25);
    expect(r.team.estimate.forecast.rrFactor).toBe(0.75);
  });
});
