import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { MOCK_HENRIK_KEY, startMockServer, type MockHandle } from '../mock/server';
import { RiotEvents } from '../main/riot/events';
import { httpRequest } from '../main/riot/http';
import { parsePartyCore } from '../shared/party';
import { parseOffers } from '../shared/offers';
import { RiotSession, WaitingError, type ConnectionCache } from '../main/riot/session';
import { ITEM_TYPES, RiotApi } from '../main/riot/api';
import { parseOwnedItems } from '../shared/collection';
import { LoadoutService } from '../main/services/loadout';
import { ME } from '../mock/data';
import { SQUAD } from '../mock/data';
import { squadWorld, type SquadMode } from '../mock/career';
import { mockFixtures, type Stress } from '../mock/extra';
import { HistoryService, NameService } from '../main/services/history';
import { ProfileService } from '../main/services/profiles';
import { MmrEstimateService } from '../main/services/mmrEstimate';
import { SquadService } from '../main/services/squad';
import { fiveStackPenaltyRisk } from '../shared/team';
import type { MmrTeamView } from '../shared/features';
import { promises as fs } from 'node:fs';

process.env.SEXYVAL_QUIET = '1';

describe('mock Riot server end to end', () => {
  let mock: MockHandle;
  let session: RiotSession;
  let api: RiotApi;
  let cache: ConnectionCache = {};
  const raw: Record<string, unknown> = {};

  beforeAll(async () => {
    mock = await startMockServer({ quiet: true, lockDir: path.join(os.tmpdir(), `sexyval-test-${process.pid}`) });
    mock.setPhase('idle');
    session = new RiotSession({
      lockfilePath: mock.lockfilePath,
      shooterLogPath: path.join(os.tmpdir(), 'sexyval-no-log'),
      overrideGlz: `${mock.base}/glz`,
      overridePd: `${mock.base}/pd`,
      overrideShared: `${mock.base}/shared`,
      onRaw: (k, d) => (raw[k] = d),
      loadCache: async () => cache,
      saveCache: async (c) => {
        cache = c;
      },
    });
    api = new RiotApi(session, (k, d) => (raw[k] = d));
  });
  afterAll(() => mock.close());

  it('authenticates via lockfile and resolves region/version from the Valorant session', async () => {
    await session.ensure();
    expect(session.puuid).toBe(ME);
    expect(session.tokenSource).toBe('riot-client');
    expect(session.valorantRunning).toBe(true);
    expect(session.region).toBe('eu');
    expect(session.regionSource).toBe('valorant-session');
    expect(session.versionSource).toBe('valorant-session');
    expect(cache.accounts?.[ME]).toEqual({ region: 'eu', shard: 'eu' });
    expect(JSON.stringify(raw)).not.toContain('mock-access-token');
  });

  it('walks idle -> pregame -> ingame -> idle', async () => {
    expect((await api.pregamePlayer(ME)).status).toBe(404);
    mock.setPhase('pregame', 20_000);
    const pp = await api.pregamePlayer(ME);
    expect(pp.status).toBe(200);
    const pm = await api.pregameMatch(pp.json.MatchID);
    expect(pm.json.AllyTeam.Players).toHaveLength(5);
    expect(pm.json.EnemyTeam).toBeNull();
    mock.setPhase('ingame');
    expect((await api.pregamePlayer(ME)).status).toBe(404);
    const cp = await api.coreGamePlayer(ME);
    const cm = await api.coreGameMatch(cp.json.MatchID);
    expect(cm.json.Players).toHaveLength(10);
    mock.setPhase('idle');
    expect((await api.coreGamePlayer(ME)).status).toBe(404);
  });

  it('history, details (with a 429 in the mix) and names', async () => {
    const h = await api.history(ME, 15);
    expect(h.json.History.length).toBeGreaterThanOrEqual(15);
    // [0] is the match that just ended in the previous test: details not processed yet (404).
    const ids: string[] = h.json.History.map((x: any) => x.MatchID);
    expect((await api.matchDetails(ids[0])).status).toBe(404);
    const details = await Promise.all(ids.slice(1, 18).map((id) => api.matchDetails(id)));
    expect(details.every((d) => d.status === 200)).toBe(true);
    const names = await api.names([ME]);
    expect(names.json[0]).toMatchObject({ GameName: 'Vibe', TagLine: '0001' });
  });

  it('with Valorant CLOSED: tokens, region (region-locale), store, owned items, contracts, loadout all work', async () => {
    mock.setPhase('noval');
    cache = {}; // force the region-locale path
    await session.ensure();
    expect(session.valorantRunning).toBe(false);
    expect(session.riotClient).toBe('up');
    expect(session.regionSource).toBe('region-locale');
    expect(session.region).toBe('eu');
    expect(session.versionSource).toBe('valorant-api'); // no session, no cache, no log
    const { res, source } = await api.storefront(ME);
    expect(source).toContain('v3 POST');
    expect(res.json.SkinsPanelLayout.SingleItemOffers).toHaveLength(4);
    expect(res.json.FeaturedBundle.Bundles[0].Items.length).toBeGreaterThan(0);
    const levels = parseOwnedItems((await api.ownedItems(ITEM_TYPES.skins)).json, ITEM_TYPES.skins);
    expect(levels.shape).toBe('EntitlementsByTypes');
    expect(levels.items.length).toBeGreaterThan(50);
    const buddies = parseOwnedItems((await api.ownedItems(ITEM_TYPES.buddies)).json, ITEM_TYPES.buddies);
    expect(buddies.items.every((b) => b.instanceId)).toBe(true);
    const contracts = await api.contracts();
    expect(contracts.json.Contracts.length).toBeGreaterThan(0);
    const lo = await api.loadout();
    expect(lo.apiVersion).toBe('v3'); // v2 answers 404 in production, and in the mock
    expect(lo.json.Guns.length).toBeGreaterThan(10);
    expect(lo.json.ActiveExpressions.length).toBeGreaterThan(1);
    const put = await api.setLoadout(lo.json);
    expect(put.json.Version).toBe(lo.json.Version + 1);
    // Endpoints Riot retired stay retired: the app must never depend on them again.
    expect((await api.call('pd', 'GET', '/store/v1/offers/', undefined, 0)).status).toBe(404);
    expect((await api.call('pd', 'GET', `/personalization/v2/players/${ME}/playerloadout`, undefined, 0)).status).toBe(404);
    // Live endpoints simply 404; party service only knows online players.
    expect((await api.pregamePlayer(ME)).status).toBe(404);
    expect((await api.partyPlayer()).status).toBe(404);
  });

  it('LoadoutService: refresh -> edit -> apply -> confirmed by the server', async () => {
    mock.setPhase('noval');
    await session.ensure();
    const svc = new LoadoutService(api, path.join(os.tmpdir(), `sexyval-presets-${process.pid}.json`), () => undefined);
    const v = await svc.refresh();
    expect(v.status).toBe('ready');
    expect(v.api).toBe('v3');
    expect(v.sprays.length).toBeGreaterThan(1);
    const before = v.version!;
    const [first, second] = v.sprays;
    const edited = { ...v, incognito: true, sprays: [{ ...first, sprayId: second.sprayId }, ...v.sprays.slice(1)] };
    const after = await svc.apply(edited);
    expect(after.version).toBe(before + 1);
    expect(after.incognito).toBe(true);
    expect(after.sprays[0].sprayId).toBe(second.sprayId);
    expect(after.guns.length).toBe(v.guns.length); // nothing else was lost
    // A fresh read agrees with what apply returned.
    expect((await svc.refresh()).sprays[0].sprayId).toBe(second.sprayId);
  });

  it('party actions while Valorant runs', async () => {
    mock.setPhase('idle');
    await session.ensure();
    const pp = await api.partyPlayer();
    const id = pp.json.CurrentPartyID;
    await api.partyAction('POST', `/parties/v1/parties/${id}/queue`, { queueId: 'unrated' });
    await api.partyAction('POST', `/parties/v1/parties/${id}/invitecode`);
    const p = await api.party(id);
    expect(p.json.MatchmakingData.QueueID).toBe('unrated');
    expect(p.json.InviteCode).toBe('MOCK42');
    await api.partyAction('POST', `/parties/v1/parties/${id}/matchmaking/join`);
    expect((await api.party(id)).json.State).toBe('MATCHMAKING');
  });

  it('reports waiting when the client goes away and no account is signed in', async () => {
    mock.setPhase('offline');
    await expect(session.ensure()).rejects.toBeInstanceOf(WaitingError);
    expect(session.tokenSource).toBe('none');
    mock.setPhase('idle');
    await session.ensure();
    expect(session.ready).toBe(true);
  });

  it('falls back to a signed-in session when the Riot Client is closed', async () => {
    const signed = new RiotSession({
      lockfilePath: path.join(os.tmpdir(), 'no-such-lockfile'),
      overridePd: `${mock.base}/pd`,
      overrideGlz: `${mock.base}/glz`,
      loadCache: async () => ({}),
      signin: {
        hasAccount: () => true,
        reauth: async () => true,
        getTokens: async () => ({ accessToken: 'mock-signin-access', entitlement: 'eyJhbGciOiJSUzI1NiJ9.eyJtb2NrIjp0cnVlfQ.bW9ja3NpZw', subject: ME, region: 'eu', label: 'Vibe#0001' }),
      },
    });
    await signed.ensure();
    expect(signed.tokenSource).toBe('signin');
    expect(signed.riotClient).toBe('down');
    expect(signed.regionSource).toBe('riot-geo');
    const w = await new RiotApi(signed, () => undefined).wallet(ME);
    expect(w.status).toBe(200);
  });
});

describe('mock: queue phase, Riot Client events, HenrikDev offers', () => {
  let mock: MockHandle;
  let session: RiotSession;
  let api: RiotApi;
  beforeAll(async () => {
    mock = await startMockServer({ quiet: true, lockDir: path.join(os.tmpdir(), `sexyval-test-q-${process.pid}`), henrik: 'offers' });
    mock.setPhase('idle');
    session = new RiotSession({ lockfilePath: mock.lockfilePath, shooterLogPath: path.join(os.tmpdir(), 'sexyval-no-log'), overrideGlz: `${mock.base}/glz`, overridePd: `${mock.base}/pd`, overrideShared: `${mock.base}/shared`, loadCache: async () => ({}) });
    api = new RiotApi(session, () => undefined);
    await session.ensure();
  });
  afterAll(() => mock.close());

  it('queue = party MATCHMAKING with a real QueueEntryTime; idle is DEFAULT', async () => {
    const id = (await api.partyPlayer()).json.CurrentPartyID;
    expect(parsePartyCore((await api.party(id)).json)).toMatchObject({ matchmaking: false, queueEntryAt: undefined });
    mock.setPhase('queue', 30_000);
    const q = parsePartyCore((await api.party(id)).json);
    expect(q.matchmaking).toBe(true);
    expect(Date.now() - q.queueEntryAt!).toBeGreaterThanOrEqual(29_000);
    expect((await api.pregamePlayer(ME)).status).toBe(404);
    mock.setPhase('pregame', 0);
    const pm = await api.pregameMatch((await api.pregamePlayer(ME)).json.MatchID);
    expect(pm.json.MapID).toBe(''); // the map arrives a moment into agent select
    mock.setPhase('idle');
  });

  it('pushes party / pregame / core-game events over the local WebSocket to RiotEvents', async () => {
    const uris: string[] = [];
    const ev = new RiotEvents(() => session.lockInfo, (u) => uris.push(u));
    ev.start();
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 30));
    };
    await until(() => ev.state === 'connected' && mock.events.subscribers() > 0);
    expect(ev.state).toBe('connected');
    mock.setPhase('queue');
    mock.setPhase('pregame');
    mock.setPhase('ingame');
    await until(() => uris.length >= 3);
    ev.stop();
    expect(uris.some((u) => u.includes('ares-parties'))).toBe(true);
    expect(uris.some((u) => u.includes('ares-pregame'))).toBe(true);
    expect(uris.some((u) => u.includes('ares-core-game'))).toBe(true);
    mock.setPhase('idle');
  });

  it('rejects a WebSocket without the right Basic password', async () => {
    const bad = new RiotEvents(() => ({ ...session.lockInfo!, password: 'wrong' }), () => undefined);
    bad.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(bad.state).not.toBe('connected');
    bad.stop();
  });

  it('HenrikDev: 401 for a bad key, offers for a good one (v1 and v2 shapes)', async () => {
    const url = (v: string) => `${mock.base}/henrik/valorant/${v}/store-offers`;
    const bad = await httpRequest(url('v1'), { headers: { Authorization: 'HDEV-wrong' } });
    expect(bad.status).toBe(401);
    expect(bad.json.errors[0].message).toBe('Unauthorized');
    expect((await httpRequest(url('v1'))).status).toBe(401);
    for (const v of ['v1', 'v2']) {
      const r = await httpRequest(url(v), { headers: { Authorization: MOCK_HENRIK_KEY } });
      expect(r.status).toBe(200);
      expect(Object.keys(parseOffers(r.json)!.levels).length).toBeGreaterThan(1000);
    }
  });

  it('HenrikDev: production today answers 404 RiotImplementationRemoved', async () => {
    const removed = await startMockServer({ quiet: true, lockDir: path.join(os.tmpdir(), `sexyval-test-r-${process.pid}`) });
    const r = await httpRequest(`${removed.base}/henrik/valorant/v1/store-offers`, { headers: { Authorization: MOCK_HENRIK_KEY } });
    expect(r.status).toBe(404);
    expect(r.text).toContain('RiotImplementationRemoved');
    await removed.close();
  });
});

// ---------- 1.4: the mock squad (MOCK_SQUAD) through the real services ----------

const sqAssets = { agent: (x?: string) => (x ? { id: x, name: 'agent' } : undefined), mapName: (m?: string) => m?.split('/').pop(), rank: (t: unknown) => ({ tier: Number(t), name: `tier ${t}` }) } as any;
const sqCatalog = { browse: { seasons: [] as any[] }, catalog: { cards: [], titles: [] } } as any;

async function squadRig(opts: { squad?: SquadMode; stress?: Stress } = {}) {
  const mock = await startMockServer({ quiet: true, lockDir: path.join(os.tmpdir(), `sexyval-test-sq-${process.pid}-${Math.random().toString(36).slice(2)}`), ...opts });
  mock.setPhase('noval');
  const session = new RiotSession({ lockfilePath: mock.lockfilePath, shooterLogPath: path.join(os.tmpdir(), 'sexyval-no-log'), overrideGlz: `${mock.base}/glz`, overridePd: `${mock.base}/pd`, overrideShared: `${mock.base}/shared`, loadCache: async () => ({}) });
  const api = new RiotApi(session, () => undefined);
  await session.ensure();
  const named: string[] = [];
  const names0 = api.names.bind(api);
  api.names = (ids: string[]) => (named.push(...ids), names0(ids));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sexyval-sq-'));
  const hidden = new Set<string>();
  const build = () => {
    const history = new HistoryService(api, sqAssets, path.join(dir, 'matches'), () => undefined);
    const names = new NameService(api, () => undefined);
    const profiles = new ProfileService(api, sqAssets, sqCatalog, history, names);
    const isHidden = (p: string) => hidden.has(p);
    const mmr = new MmrEstimateService(api, sqAssets, sqCatalog, history, names, profiles, path.join(dir, 'mmr'), isHidden);
    const pushed: MmrTeamView[] = [];
    const squad = new SquadService({ api, assets: sqAssets, catalog: sqCatalog, history, names, profiles, mmr, isHidden, livePenalty: () => undefined, onUpdate: (v) => pushed.push(v) });
    /** First answer, then the view once every premade lookup has landed. */
    const open = async () => {
      const first = await squad.get(ME);
      for (let i = 0; i < 400 && first.lookups.total && pushed.at(-1)?.lookups.done !== first.lookups.total; i++) await new Promise((r) => setTimeout(r, 20));
      return { first, last: pushed.at(-1) ?? first };
    };
    return { squad, open };
  };
  const close = async () => {
    await mock.close();
    await new Promise((r) => setTimeout(r, 100));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  return { mock, api, named, hidden, build, close };
}

describe('mock squad (MOCK_SQUAD) end to end', () => {
  it('the squad appears and ranks as designed; shared matches agree; only pd endpoints; bounded pd calls', async () => {
    const rig = await squadRig();
    try {
      const r0 = rig.mock.requests.length;
      const { first, last } = await rig.build().open();
      const cold = rig.mock.requests.slice(r0);
      // First paint did not wait for premade lookups.
      expect(first.squad.find((r) => r.puuid === SQUAD.drain)!.status).toBe('loading');
      const byName = (n: string) => last.squad.find((r) => r.name === n)!;
      const eligible = last.squad.filter((r) => r.eligible);
      expect(eligible[0].name).toBe('Rahul');
      expect(eligible[0].verdict).toBe('biggest drain');
      expect(eligible.at(-1)!.name).toBe('Arjun');
      expect(eligible.at(-1)!.verdict).toBe('best partner');
      expect(byName('Dev')).toMatchObject({ games: 2, eligible: false, verdict: 'not enough games' });
      expect(byName('Kabir').verdict).toBe('neutral');
      expect(byName('Rahul').theirEstMmr!).toBeLessThan(byName('Rahul').theirTier!);
      expect(byName('Rahul').rrCostEstimate!).toBeLessThan(0);
      expect(byName('Arjun').rrCostEstimate!).toBeGreaterThan(0);
      const t = last.team.estimate.team!;
      expect(t.window).toBe(25);
      expect(t.noPartyData).toBe(0);
      expect(t.stacks.filter((s) => typeof s.stack === 'number').map((s) => s.games)).toEqual([8, 7, 4, 6]);
      expect(Math.abs(t.stackPenalty.five! - 0.75)).toBeLessThan(0.08);
      expect(t.lobbyAvgStacked!).toBeLessThan(t.lobbyAvgSolo! - 0.5);
      // Shared match ids agree between your competitive updates and theirs (same result too).
      const mine = new Map(((await rig.api.competitiveUpdates(ME, 20)).json.Matches.concat((await rig.api.competitiveUpdates(ME, 25, 'competitive', 20)).json.Matches) as any[]).map((u) => [u.MatchID, u]));
      for (const p of [SQUAD.drain, SQUAD.carry, SQUAD.neutral]) {
        const theirs: any[] = (await rig.api.competitiveUpdates(p, 20)).json.Matches.concat((await rig.api.competitiveUpdates(p, 25, 'competitive', 20)).json.Matches);
        const row = last.squad.find((r) => r.puuid === p)!;
        for (const g of row.shared) {
          const u = theirs.find((x) => x.MatchID === g.matchId);
          expect(u, `${p.slice(0, 8)} has ${g.matchId.slice(0, 8)}`).toBeDefined();
          expect(Math.sign(u.RankedRatingEarned)).toBe(Math.sign(mine.get(g.matchId).RankedRatingEarned));
          expect(g.theirRR).toBe(u.RankedRatingEarned);
        }
      }
      // Only Riot's own pd endpoints; the cold open stays inside the budget (≤ 2 + 25 + 6 × (2 + 10), plus retried 429s).
      expect(cold.every((r) => / \/pd\/(mmr|match-details|name-service)\//.test(r))).toBe(true);
      expect(cold.length).toBeLessThanOrEqual(104);
      // App restart: lists re-paged, every match from the disk cache.
      const r1 = rig.mock.requests.length;
      await rig.build().open();
      const warm = rig.mock.requests.slice(r1);
      expect(warm.filter((r) => r.includes('/match-details/'))).toHaveLength(0);
      expect(warm.length).toBeLessThanOrEqual(20);
      console.log(`squad pd calls: cold ${cold.length}, warm restart ${warm.length}`);
      // The headline cost agrees in sign with the verdict for everyone ranked.
      for (const r of eligible) if (r.verdict !== 'neutral') expect(Math.sign(r.rrCostEstimate!)).toBe(r.drain! > 0 ? -1 : 1);
    } finally {
      await rig.close();
    }
  }, 60_000);

  it('5-stacks flagged outside the rank window really are (community table), and get RR × 0.75', () => {
    const acts = mockFixtures.progression.acts as string[];
    const w = squadWorld([acts[acts.length - 2], mockFixtures.progression.act], Date.UTC(2026, 10, 7), 'above', 'on');
    let outside = 0;
    for (const m of w.me) {
      const info = w.info.get(m.id);
      if (!info || info.premades.length !== 4) continue;
      const tiers = [m.tierBefore, ...info.premades.map((p) => w.tierOf(p, m.id) ?? m.tierBefore)];
      expect(fiveStackPenaltyRisk(tiers)).toBe(info.outside);
      if (info.outside) outside++;
    }
    expect(outside).toBeGreaterThanOrEqual(3);
  });

  it('MOCK_STRESS=hidden: your hidden squad gets zero pd calls and no name lookup', async () => {
    const rig = await squadRig({ stress: 'hidden' });
    try {
      rig.mock.setPhase('ingame');
      const cp = await rig.api.coreGamePlayer(ME);
      const cm = await rig.api.coreGameMatch(cp.json.MatchID);
      for (const p of cm.json.Players) if (p.PlayerIdentity?.Incognito && p.Subject !== ME) rig.hidden.add(p.Subject);
      expect(rig.hidden.has(SQUAD.drain)).toBe(true);
      const r0 = rig.mock.requests.length;
      const n0 = rig.named.length;
      const { last } = await rig.build().open();
      const calls = rig.mock.requests.slice(r0);
      for (const p of rig.hidden) {
        expect(calls.filter((c) => c.includes(p))).toEqual([]);
        expect(rig.named.slice(n0)).not.toContain(p);
      }
      const drain = last.squad.find((r) => r.puuid === SQUAD.drain)!;
      expect(drain).toMatchObject({ hidden: true, status: 'hidden' });
      expect(drain.name).toBeUndefined();
      expect(drain.theirEstMmr).toBeUndefined();
      // Their lines in your matches still count; the visible regular (Dev) is looked up as usual.
      expect(drain.games).toBe(11);
      expect(last.squad.find((r) => r.puuid === SQUAD.rare)!.status).toBe('ready');
      expect(last.team.matches.some((m) => m.premadeNames?.includes('Hidden teammate'))).toBe(true);
    } finally {
      await rig.close();
    }
  }, 60_000);

  it('party: SkillDisparityRRPenalty 0.25 with MOCK_SQUAD=penalty, 0 otherwise; MOCK_SQUAD=off has no squad', async () => {
    const pen = await squadRig({ squad: 'penalty' });
    const off = await squadRig({ squad: 'off' });
    try {
      for (const r of [pen, off]) r.mock.setPhase('idle');
      await Promise.all([pen, off].map((r) => r.api.session.ensure()));
      const core = async (r: typeof pen) => parsePartyCore((await r.api.party((await r.api.partyPlayer()).json.CurrentPartyID)).json);
      expect((await core(pen)).rrPenalty).toBe(0.25);
      expect((await core(off)).rrPenalty).toBe(0);
      off.mock.setPhase('noval');
      const { last } = await off.build().open();
      expect(last.squad.some((r) => Object.values(SQUAD).includes(r.puuid as any))).toBe(false);
    } finally {
      await pen.close();
      await off.close();
    }
  }, 60_000);
});
