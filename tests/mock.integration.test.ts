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
