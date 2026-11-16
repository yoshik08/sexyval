import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0', getAppMetrics: () => [] } }));

import { NetRouter, socks5Agent } from '../main/riot/netRoute';
import { isBlockedError, parseProxy } from '../shared/netRoute';
import { accountOf, matchOffers, migrateWish, type Offer } from '../shared/wishlist';
import { WishlistStore } from '../main/services/wishlist';
import { buildActivity, DEFAULT_PRIVACY, discordBackoff, validClientId } from '../shared/presence';
import { decodeFrames, DiscordPresence, encodeFrame } from '../main/services/discord';
import { mergeRows, rowFromDetails, sideOfRound, gapsOf } from '../shared/warehouse';
import { WarehouseService } from '../main/services/warehouse';
import { computeInsights, MIN_ELIGIBLE, wilson } from '../shared/insights';
import { liteActive } from '../shared/perf';
import { computeHealth } from '../shared/health';
import { ShopService } from '../main/services/shop';
import { StoreSync } from '../main/services/storeSync';
import type { TrimmedDetails } from '../shared/last5';
import type { WRow } from '../shared/warehouse';

const ME = '11111111-1111-1111-1111-111111111111';
const ALT = '22222222-2222-2222-2222-222222222222';
const SKIN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'sv-phx-'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await wait(15);
  }
}
const listen = (srv: net.Server | http.Server) => new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as net.AddressInfo).port)));

/** Minimal SOCKS5 server (no auth, CONNECT only) that counts open tunnels. */
function socksServer() {
  const open = new Set<net.Socket>();
  const srv = net.createServer((c) => {
    open.add(c);
    c.on('close', () => open.delete(c));
    c.once('data', () => {
      c.write(Buffer.from([5, 0]));
      c.once('data', (req) => {
        const len = req[4];
        const host = req.subarray(5, 5 + len).toString();
        const port = req.readUInt16BE(5 + len);
        const up = net.connect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          c.pipe(up).pipe(c);
        });
        up.on('error', () => c.destroy());
        c.on('close', () => up.destroy());
      });
    });
  });
  return { srv, open };
}

describe('Smart Store Sync routing (F4)', () => {
  it('accepts only loopback proxies without a login', () => {
    expect(parseProxy('socks5://127.0.0.1:40000')).toEqual({ ok: true, proxy: { scheme: 'socks5', host: '127.0.0.1', port: 40000 } });
    expect(parseProxy('http://localhost:8080').ok).toBe(true);
    expect(parseProxy('socks5://10.0.0.5:1080').ok).toBe(false);
    expect(parseProxy('socks5://user:pw@127.0.0.1:1080').ok).toBe(false);
    expect(parseProxy('socks5://127.0.0.1').ok).toBe(false);
    expect(parseProxy('https://127.0.0.1:443').ok).toBe(false);
  });

  it('tells a blocked network from an HTTP answer', () => {
    expect(isBlockedError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe(true);
    expect(isBlockedError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    expect(isBlockedError({ status: 403, message: 'HTTP 403' })).toBe(false);
    expect(isBlockedError(new Error('bad json'))).toBe(false);
  });

  it('falls back to the proxy when direct is blocked, then closes the proxy connection', async () => {
    const target = http.createServer((_q, s) => s.end('store'));
    const tport = await listen(target);
    const { srv, open } = socksServer();
    const sport = await listen(srv);
    const made: any[] = [];
    const router = new NetRouter(
      () => ({ mode: 'fallback', proxyUrl: `socks5://127.0.0.1:${sport}` }),
      (p) => {
        const a = socks5Agent(p);
        made.push(a);
        return a;
      },
    );
    const dead = net.createServer();
    const deadPort = await listen(dead);
    await new Promise((r) => dead.close(r));
    let calls = 0;
    const body = await router.run(async (d) => {
      calls++;
      // Direct: nothing listens on deadPort → refused, which is "blocked"
      const url = d ? `http://127.0.0.1:${tport}/` : `http://127.0.0.1:${deadPort}/`;
      const r = await fetch(url, { dispatcher: d as any });
      return r.text();
    });
    expect(body).toBe('store');
    expect(calls).toBe(2);
    expect(router.status.lastRoute).toBe('proxy');
    expect(router.status.proxyState).toBe('ok');
    expect(router.open).toBe(0);
    expect(made).toHaveLength(1);
    expect(made[0].closed).toBe(true);
    await until(() => open.size === 0);
    srv.close();
    target.close();
  });

  it('a dead proxy fails cleanly, keeps nothing open, and an HTTP error never triggers the proxy', async () => {
    const router = new NetRouter(() => ({ mode: 'proxy', proxyUrl: 'socks5://127.0.0.1:9' }));
    await expect(router.run((d) => fetch('http://example.invalid/', { dispatcher: d as any }))).rejects.toThrow();
    expect(router.status.proxyState).toBe('failed');
    expect(router.status.proxyError).toMatch(/proxy running/);
    expect(router.open).toBe(0);

    let used = 0;
    const fb = new NetRouter(() => ({ mode: 'fallback', proxyUrl: 'socks5://127.0.0.1:9' }), (p) => (used++, socks5Agent(p)));
    await expect(fb.run(async () => Promise.reject(Object.assign(new Error('HTTP 401'), { status: 401 })))).rejects.toThrow('401');
    expect(used).toBe(0);
  });

  it('a misconfigured proxy is reported, never silently skipped', async () => {
    const router = new NetRouter(() => ({ mode: 'proxy', proxyUrl: 'socks5://192.168.1.2:1080' }));
    await expect(router.run(async () => 'x')).rejects.toThrow(/Only a proxy running on this PC/);
  });
});

describe('Store cache and account switches during sync (F4/F1)', () => {
  const view = (name: string, puuid: string) => ({ status: 'done' as const, daily: [{ offerId: name, skinId: SKIN, name, cost: 1775 }], wallet: null, fetchedAt: 1000, puuid });

  it('a switch shows the new account’s own cached store, and a failed refresh keeps it labeled as cached', async () => {
    const dir = await tmp();
    const cache = path.join(dir, 'store-cache.json');
    await fs.writeFile(cache, JSON.stringify({ [ME]: view('Mine', ME), [ALT]: view('Alt', ALT) }));
    const wish = new WishlistStore(path.join(dir, 'wishlist.json'));
    await wish.load();
    const seen: any[] = [];
    const api: any = {
      session: { puuid: ME, generation: 0, isCurrent: () => true },
      storefront: () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })),
      wallet: () => Promise.resolve(null),
    };
    const hits: unknown[] = [];
    const shop = new ShopService(api, {} as any, { onChange: (v) => seen.push(structuredClone(v)), onError: () => undefined, isOwnedLevel: () => false, onWishlistHit: (h) => hits.push(h), afterRefresh: () => undefined }, wish, cache);
    await shop.loadCache();
    shop.start(ME);
    await until(() => shop.view.status === 'error');
    expect(shop.view.daily[0].name).toBe('Mine');
    expect(shop.view.cached).toBe(true);
    shop.start(ALT);
    expect(shop.view.daily[0].name).toBe('Alt'); // never the previous account's items
    await until(() => shop.view.status === 'error');
    expect(shop.view.daily[0].name).toBe('Alt');
    expect(shop.view.cached).toBe(true);
    expect(hits).toEqual([]); // cached data never alerts
    shop.stop();
  });

  it('other accounts wait in lightweight mode on a rotation, but not on a manual sync', async () => {
    let fetched = 0;
    const sync = new StoreSync({
      api: { session: { version: '1' }, storefrontFor: async () => (fetched++, { json: {} }) } as any,
      archive: { lastFetchAt: 1, ingest: () => ({ newBundles: [] }), bundles: () => [], knownEnds: () => [] } as any,
      shop: { refresh: async () => undefined } as any,
      assets: { skin: () => undefined } as any,
      prices: { record: () => undefined } as any,
      accounts: { signedIn: () => [{ id: 'b', puuid: ALT, region: 'eu', label: 'Alt', status: 'ok' }], tokensFor: async () => ({ accessToken: 'x', entitlement: 'y' }) },
      activePuuid: () => ME,
      activeLabel: () => 'Me',
      onNewBundles: () => undefined,
      onChange: () => undefined,
      deferred: () => true,
    });
    await sync.syncOthers('rotation');
    expect(fetched).toBe(0);
    await sync.syncOthers('manual');
    expect(fetched).toBe(1);
    expect(sync.accountStatus.get(ALT)?.ok).toBe(true);
    sync.stop();
  });
});

describe('Wishlist per account (F7)', () => {
  const offers = (end: number): Offer[] => [
    { skinId: SKIN, name: 'Prime Vandal', kind: 'daily', endsAt: end },
    { skinId: SKIN, name: 'Prime Vandal', kind: 'bundle', endsAt: end },
  ];

  it('one notification per appearance, again on a new appearance, none for cached data', () => {
    const s = migrateWish({ version: 2, accounts: {} });
    const a = accountOf(s, ME);
    a.skinIds = [SKIN];
    expect(matchOffers(a, offers(1_000_000), 10, false)).toEqual([]); // cached: nothing
    expect(a.seen[SKIN]).toBeUndefined();
    expect(matchOffers(a, offers(1_000_000), 10, true)).toHaveLength(1); // daily + bundle same skin → one alert
    expect(matchOffers(a, offers(1_000_000), 20, true)).toEqual([]); // refetch of the same store
    expect(matchOffers(a, offers(2_000_000), 30, true)).toHaveLength(1); // the next rotation
    expect(a.seen[SKIN]).toBe(30);
  });

  it('migrates the old shared list to each account on first use and keeps accounts apart', async () => {
    const dir = await tmp();
    const f = path.join(dir, 'wishlist.json');
    await fs.writeFile(f, JSON.stringify({ skinIds: [SKIN], notified: [`${SKIN}:123`] }));
    const w = new WishlistStore(f, () => 50);
    await w.load();
    expect(w.ids(ME)).toEqual([SKIN]);
    await w.toggle(ALT, SKIN); // ALT seeded with the legacy list, then removes it
    expect(w.ids(ALT)).toEqual([]);
    expect(w.ids(ME)).toEqual([SKIN]);
    const hits = w.check(ME, { status: 'done', wallet: null, daily: [{ offerId: 'o', skinId: SKIN, name: 'P', cost: 1 }], dailyEndsAt: 999_999 }, true);
    expect(hits).toHaveLength(1);
    expect(w.check(ALT, { status: 'done', wallet: null, daily: [{ offerId: 'o', skinId: SKIN, name: 'P', cost: 1 }], dailyEndsAt: 999_999 }, true)).toEqual([]);
    // persisted across restarts
    await wait(50);
    const again = new WishlistStore(f, () => 60);
    await again.load();
    expect(again.check(ME, { status: 'done', wallet: null, daily: [{ offerId: 'o', skinId: SKIN, name: 'P', cost: 1 }], dailyEndsAt: 999_999 }, true)).toEqual([]);
    expect(again.info(ME)[0]).toMatchObject({ skinId: SKIN, lastSeen: 60, lastNotified: 50 });
  });
});

describe('Discord Rich Presence (F5)', () => {
  const pipeName = (tag: string) => `\\\\?\\pipe\\sv-test-discord-${process.pid}-${tag}`;
  function fakeDiscord(name: string) {
    const frames: { op: number; data: any }[] = [];
    const conns = new Set<net.Socket>();
    const srv = net.createServer((c) => {
      conns.add(c);
      let buf = Buffer.alloc(0);
      c.on('data', (chunk) => {
        const r = decodeFrames(Buffer.concat([buf, chunk]));
        buf = r.rest as Buffer<ArrayBuffer>;
        for (const f of r.frames) {
          frames.push(f);
          if (f.op === 0) c.write(encodeFrame(1, { evt: 'READY', data: { v: 1 } }));
        }
      });
      c.on('close', () => conns.delete(c));
      c.on('error', () => undefined);
    });
    return { srv, frames, conns, listen: () => new Promise<void>((r) => srv.listen(name, () => r())) };
  }
  const running = (on: boolean) => ({ valorantRunning: on, state: { phase: 'ingame' as const, coregame: { matchId: 'm', mode: '', modeName: 'Competitive', queueId: 'competitive', queueTag: 'comp', myTeamId: 'Blue', myTeam: [{ puuid: ME, isMe: true, incognito: false, teamId: 'Blue', last5: {} as any, agent: { id: 'a', name: 'Jett' }, name: 'Yoshi', tag: '767' }], enemyTeam: [], map: { id: 'm', name: 'Ascent' } } }, phaseSince: 1_700_000_000_000 });

  it('never shows the Riot ID or hidden data, and only what privacy allows', () => {
    const a = buildActivity(running(true) as any, DEFAULT_PRIVACY)!;
    expect(JSON.stringify(a)).not.toMatch(/Yoshi|767/);
    expect(a.details).toBe('Competitive · Ascent');
    expect(a.state).toBe('In a match · Jett');
    expect(buildActivity(running(true) as any, { ...DEFAULT_PRIVACY, map: false, agent: false })!.details).toBe('Competitive');
    expect(buildActivity(running(false) as any, DEFAULT_PRIVACY)).toBeNull();
    expect(validClientId('123')).toBe(false);
    expect(validClientId('123456789012345678')).toBe(true);
    expect([0, 1, 2, 3, 4, 5].map(discordBackoff)).toEqual([15_000, 30_000, 60_000, 120_000, 300_000, null]);
  });

  it('enable → activity, Valorant closes → cleared at once, disable → cleared and disconnected', async () => {
    const name = pipeName('a');
    const d = fakeDiscord(name);
    await d.listen();
    const cfg = { enabled: true, clientId: '123456789012345678', privacy: DEFAULT_PRIVACY };
    const p = new DiscordPresence(() => cfg, undefined, (i) => net.connect(i === 0 ? name : pipeName('none')));
    p.update(running(true) as any);
    p.apply();
    await until(() => p.status.state === 'connected');
    await until(() => d.frames.some((f) => f.data?.cmd === 'SET_ACTIVITY' && f.data.args.activity));
    expect(d.frames[0]).toMatchObject({ op: 0, data: { client_id: '123456789012345678' } });
    p.update(running(false) as any); // within the 15 s rate window: clearing still goes out now
    await until(() => d.frames.filter((f) => f.data?.cmd === 'SET_ACTIVITY').at(-1)?.data.args.activity === null);
    p.update(running(true) as any);
    cfg.enabled = false;
    p.apply();
    expect(p.status.state).toBe('off');
    await until(() => d.conns.size === 0);
    d.srv.close();
  });

  it('Discord quitting leaves no stale activity, and Reconnect picks it up again', async () => {
    const name = pipeName('b');
    let d = fakeDiscord(name);
    await d.listen();
    const p = new DiscordPresence(() => ({ enabled: true, clientId: '123456789012345678', privacy: DEFAULT_PRIVACY }), undefined, () => net.connect(name));
    p.update(running(true) as any);
    p.apply();
    await until(() => p.status.state === 'connected' && !!p.status.activity);
    for (const c of d.conns) c.destroy();
    d.srv.close();
    await until(() => p.status.state === 'discord-closed');
    expect(p.status.activity).toBeNull();
    d = fakeDiscord(name);
    await d.listen();
    p.reconnect();
    await until(() => p.status.state === 'connected');
    await until(() => d.frames.some((f) => f.data?.cmd === 'SET_ACTIVITY'));
    p.shutdown();
    await until(() => d.conns.size === 0);
    d.srv.close();
  });
});

function match(id: string, t: number, opts: { me?: string; won?: boolean; map?: string; agent?: string; queue?: string; fd?: number; atkWin?: number } = {}): TrimmedDetails {
  const me = opts.me ?? ME;
  const won = opts.won ?? true;
  const rounds = Array.from({ length: 20 }, (_, i) => ({ roundNum: i, winningTeam: i < 12 ? (i < (opts.atkWin ?? 6) ? 'Red' : 'Blue') : i % 2 ? 'Red' : 'Blue' }));
  return {
    matchId: id,
    startTime: t,
    mapId: opts.map ?? '/Game/Maps/Ascent',
    queueId: opts.queue ?? 'competitive',
    players: [
      { subject: me, teamId: 'Red', characterId: opts.agent ?? 'jett', score: 4000, roundsPlayed: 20, kills: 18, deaths: 14, assists: 3, firstBloods: 3, firstDeaths: opts.fd ?? 2 },
      { subject: 'other', teamId: 'Blue', score: 3000, roundsPlayed: 20, kills: 14, deaths: 18, assists: 2 },
    ],
    teams: [
      { teamId: 'Red', won, roundsWon: won ? 13 : 7 },
      { teamId: 'Blue', won: !won, roundsWon: won ? 7 : 13 },
    ],
    roundResults: rounds,
  };
}

describe('Lifetime warehouse (F9)', () => {
  it('sides follow halves and overtime', () => {
    expect(sideOfRound('Red', 0)).toBe('atk');
    expect(sideOfRound('Red', 12)).toBe('def');
    expect(sideOfRound('Blue', 24)).toBe('def');
    expect(sideOfRound('Blue', 25)).toBe('atk');
    expect(sideOfRound('Neutral', 3)).toBeNull();
  });

  it('ingests incrementally, dedupes by matchId, joins RR, reports gaps and keeps accounts apart', async () => {
    const dir = await tmp();
    const matches = path.join(dir, 'matches');
    const updates = path.join(dir, 'mmr-updates');
    await fs.mkdir(matches);
    await fs.mkdir(updates);
    const ids = ['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002'];
    await fs.writeFile(path.join(matches, `${ids[0]}.v2.json`), JSON.stringify(match(ids[0], 1000)));
    await fs.writeFile(path.join(matches, `${ids[1]}.v2.json`), JSON.stringify(match(ids[1], 2000, { me: ALT })));
    await fs.writeFile(path.join(updates, `${ME}.json`), JSON.stringify({ v: 1, updates: [{ matchId: ids[0], startTime: 1000, seasonId: 'act1', tierBefore: 12, tierAfter: 12, rrBefore: 40, rrAfter: 61, rrEarned: 21, afkPenalty: 0 }, { matchId: 'missing-1', startTime: 500, seasonId: 'act1', tierBefore: 12, tierAfter: 12, rrBefore: 60, rrAfter: 40, rrEarned: -20, afkPenalty: 0 }] }));
    const deps = { acts: () => [], mapName: () => 'Ascent', agentName: () => 'Jett' };
    const w = new WarehouseService(matches, updates, path.join(dir, 'warehouse'), deps);
    const f1 = await w.ingest(ME);
    expect(f1.rows.map((r) => r.matchId)).toEqual([ids[0]]);
    expect(f1.rows[0]).toMatchObject({ rr: 21, act: 'act1', result: 'W', fk: 3, fd: 2, atk: [6, 12] });
    expect(f1.checked).toEqual([ids[1]]);
    const f2 = await w.ingest(ME);
    expect(f2.rows).toHaveLength(1);
    const v = await w.view(ME);
    expect(v.gaps).toEqual({ missing: 1, oldest: 500, newest: 500 });
    expect(v.rank).toHaveLength(2);
    expect((await new WarehouseService(matches, updates, path.join(dir, 'warehouse'), deps).ingest(ALT)).rows.map((r) => r.matchId)).toEqual([ids[1]]);
    // restart: read back from disk, still one row
    const fresh = new WarehouseService(matches, updates, path.join(dir, 'warehouse'), deps);
    expect((await fresh.ingest(ME)).rows).toHaveLength(1);
    expect(await fresh.export(ME, 'csv')).toMatch(/^matchId,startedAt/);
    // lightweight mode: background ingest doesn't read new files
    await fs.writeFile(path.join(matches, 'aaaaaaaa-0000-0000-0000-000000000003.v2.json'), JSON.stringify(match('aaaaaaaa-0000-0000-0000-000000000003', 3000)));
    const paused = new WarehouseService(matches, updates, path.join(dir, 'warehouse'), { ...deps, paused: () => true });
    expect((await paused.ingest(ME, true)).rows).toHaveLength(1);
    expect((await paused.ingest(ME)).rows).toHaveLength(2);
  });

  it('merging keeps one row per match', () => {
    const r = rowFromDetails(match('x', 1), ME)!;
    expect(mergeRows([r], [r, { ...r, rr: 5 }])).toHaveLength(1);
    expect(gapsOf([r], [])).toEqual({ missing: 0 });
  });
});

describe('Performance Intelligence (F8)', () => {
  const rows = (n: number, f: (i: number) => Partial<TrimmedDetails> & { won?: boolean; map?: string; agent?: string; atkWin?: number }) =>
    Array.from({ length: n }, (_, i) => {
      const o = f(i);
      return rowFromDetails(match(`m${i}`, 1_000_000 + i * 86_400_000, o), ME)!;
    });

  it('says nothing with too little data', () => {
    const r = computeInsights(rows(MIN_ELIGIBLE - 1, () => ({})));
    expect(r.insights).toEqual([]);
    expect(r.notes[0]).toMatch(/at least 10/);
  });

  it('finds a real map gap, is deterministic, and every insight states its sample and method', () => {
    const data: WRow[] = [...rows(30, (i) => ({ map: '/Game/Maps/Bind', won: i % 5 === 0 })), ...rows(40, (i) => ({ map: '/Game/Maps/Ascent', won: i % 4 !== 0 }))].map((r, i) => ({ ...r, matchId: `r${i}` }));
    const a = computeInsights(data, { mapName: (id) => id?.split('/').pop() });
    const b = computeInsights(data, { mapName: (id) => id?.split('/').pop() });
    expect(a).toEqual(b);
    expect(a.insights.find((i) => i.id === 'map-weak-/Game/Maps/Bind')).toBeTruthy();
    expect(a.insights.find((i) => i.id === 'map-strong-/Game/Maps/Ascent')).toBeTruthy();
    for (const i of a.insights) {
      expect(i.n).toBeGreaterThan(0);
      expect(i.method.length).toBeGreaterThan(10);
    }
  });

  it('noise produces no map verdicts', () => {
    const data = rows(40, (i) => ({ map: i % 2 ? '/Game/Maps/Bind' : '/Game/Maps/Ascent', won: i % 2 === Math.floor(i / 2) % 2 }));
    expect(computeInsights(data).insights.filter((i) => i.id.startsWith('map-'))).toEqual([]);
  });

  it('wilson interval is sane', () => {
    const [lo, hi] = wilson(5, 10);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});

describe('Lightweight mode and health (F10/F6)', () => {
  it('transitions follow the mode, the game and Boost', () => {
    expect(liteActive('auto', false, false)).toBe(false);
    expect(liteActive('auto', true, false)).toBe(true);
    expect(liteActive('always', false, false)).toBe(true);
    expect(liteActive('normal', true, false)).toBe(false);
    expect(liteActive('normal', true, true)).toBe(true);
  });

  it('store, proxy and Discord states are explained; Discord never blocks the app', () => {
    const base = { riotClient: 'up' as const, lockfile: true, tokenSource: 'riot-client' as const, connStatus: 'connected' as const, events: 'connected' as const, accounts: [], accountsReadOnly: false, pinned: false, vault: { lastSnapshotAt: 1, now: 2 } };
    expect(computeHealth(base).overall).toBe('healthy');
    const h = computeHealth({ ...base, store: { status: 'error', cached: true, fetchedAt: 1, blocked: true }, proxy: { mode: 'fallback', state: 'failed', error: 'refused' }, discord: { state: 'discord-closed', detail: 'Discord isn’t running' } });
    expect(h.items.find((i) => i.id === 'store')).toMatchObject({ state: 'offline', action: 'open-network' });
    expect(h.items.find((i) => i.id === 'proxy')).toMatchObject({ state: 'degraded' });
    expect(h.items.find((i) => i.id === 'discord')).toMatchObject({ state: 'degraded', action: 'reconnect' });
    expect(h.overall).toBe('degraded');
  });
});
