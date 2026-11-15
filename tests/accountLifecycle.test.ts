import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startMockServer, type MockHandle } from '../mock/server';
import { ME } from '../mock/data';
import { RiotSession } from '../main/riot/session';
import { OwnedService } from '../main/services/owned';
import { computeHealth, type HealthInput } from '../shared/health';

vi.mock('electron', () => ({ BrowserWindow: class {}, session: { fromPartition: () => ({ clearStorageData: async () => undefined }) }, app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0' } }));
const { classifyReauth, offlineBackoff, AccountManager } = await import('../main/auth/accounts');

const B = '0b0b0b0b-0000-4000-8000-00000000000b';
const sess = (mock: MockHandle, extra: Record<string, unknown> = {}) =>
  new RiotSession({ lockfilePath: mock.lockfilePath, shooterLogPath: path.join(os.tmpdir(), 'sexyval-no-log'), overrideGlz: `${mock.base}/glz`, overridePd: `${mock.base}/pd`, overrideShared: `${mock.base}/shared`, loadCache: async () => ({}), accountCheckMs: 0, ...extra });

describe('Riot Client account hot-swap', () => {
  let mock: MockHandle;
  beforeAll(async () => {
    mock = await startMockServer();
    mock.setPhase('idle');
  });
  afterAll(() => mock.close());

  it('A → B → A inside the same Riot Client (same lockfile) changes the account and bumps the generation each time', async () => {
    const s = sess(mock);
    await s.ensure();
    expect(s.puuid).toBe(ME);
    const g0 = s.generation;
    mock.setSubject(B);
    await s.ensure();
    expect(s.puuid).toBe(B);
    expect(s.isCurrent(g0)).toBe(false);
    const g1 = s.generation;
    mock.setSubject(ME);
    await s.ensure();
    expect(s.puuid).toBe(ME);
    expect(s.generation).toBe(g1 + 1);
    // No switch: no new generation.
    await s.ensure();
    expect(s.generation).toBe(g1 + 1);
  });

  it('pinned mode keeps the saved sign-in even while the Riot Client has another account', async () => {
    const s = sess(mock, {
      accountMode: () => 'pinned',
      signin: { hasAccount: () => true, reauth: async () => true, getTokens: async () => ({ accessToken: 'x', entitlement: 'eyJhbGciOiJSUzI1NiJ9.eyJtb2NrIjp0cnVlfQ.bW9ja3NpZw', subject: B, region: 'eu', label: 'B#1' }) },
    });
    mock.setSubject(ME);
    await s.ensure();
    expect(s.tokenSource).toBe('signin');
    expect(s.puuid).toBe(B);
  });

  it('owned items that arrive after an account switch are discarded and read again', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const session = { generation: 1, puuid: 'A' as string | null, isCurrent(g: number) { return g === this.generation; } };
    let calls = 0;
    const api = { session, ownedItems: async () => { calls++; if (calls <= 7) await gate; return { json: { EntitlementsByTypes: [] } }; } };
    const states: string[] = [];
    const o = new OwnedService(api as any, (s) => states.push(s.status));
    const first = o.refresh();
    session.generation = 2; // switched while the 7 requests were in flight
    session.puuid = 'B';
    release();
    await first;
    expect(o.state.status).not.toBe('ready');
    // It reads again on its own, under the new account.
    await new Promise((r) => setTimeout(r, 50));
    expect(o.state.status).toBe('ready');
    expect(calls).toBe(14);
  });
});

describe('saved accounts survive network trouble', () => {
  it('only Riot’s own login page means "expired"; failures and timeouts are the network', () => {
    expect(classifyReauth({ redirect: true, loadFailed: false, finishedLoads: 1 })).toBe('ok');
    expect(classifyReauth({ redirect: false, loadFailed: true, finishedLoads: 0, lastUrl: 'https://auth.riotgames.com/authorize?x' })).toBe('network');
    expect(classifyReauth({ redirect: false, loadFailed: false, finishedLoads: 0 })).toBe('network');
    expect(classifyReauth({ redirect: false, loadFailed: false, finishedLoads: 1, lastUrl: 'https://authenticate.riotgames.com/?client_id=play-valorant-web-prod' })).toBe('login-required');
    expect(classifyReauth({ redirect: false, loadFailed: false, finishedLoads: 1, lastUrl: 'https://auth.riotgames.com/login' })).toBe('login-required');
    // A captive portal / firewall block page is not Riot asking for a login.
    expect(classifyReauth({ redirect: false, loadFailed: false, finishedLoads: 1, lastUrl: 'http://10.0.0.1/blocked' })).toBe('network');
  });

  it('offline retries back off and cap at 15 minutes', () => {
    expect(offlineBackoff(0)).toBe(30_000);
    expect(offlineBackoff(1)).toBe(60_000);
    expect(offlineBackoff(10)).toBe(15 * 60_000);
  });

  it('an unreadable accounts.json is never overwritten; the .bak is used when it is good', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-acc-'));
    const file = path.join(dir, 'accounts.json');
    await fs.writeFile(file, '{"accounts":[{"id":"a1","pu');
    await fs.writeFile(`${file}.bak`, JSON.stringify({ accounts: [{ id: 'a1', puuid: 'p1', name: 'Kept', tag: '1', addedAt: 1 }], activeId: 'a1' }));
    const m = new AccountManager(file, {} as any, () => undefined, () => undefined);
    await m.load();
    m.stop();
    expect(m.list().map((a) => a.name)).toEqual(['Kept']);
    expect(m.storageReadOnly).toBe(false);

    await fs.rm(`${file}.bak`);
    const m2 = new AccountManager(file, {} as any, () => undefined, () => undefined);
    await m2.load();
    m2.stop();
    expect(m2.storageReadOnly).toBe(true);
    m2.switchTo('nothing'); // would normally save
    await (m2 as any).remove('none');
    expect(await fs.readFile(file, 'utf8')).toBe('{"accounts":[{"id":"a1","pu');
  });

  it('accounts reload after a restart with their data', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-acc-'));
    const file = path.join(dir, 'accounts.json');
    await fs.writeFile(file, JSON.stringify({ accounts: [{ id: 'a1', puuid: 'p1', name: 'Yoshi', tag: '7', region: 'ap', addedAt: 1 }], activeId: 'a1' }));
    const m = new AccountManager(file, {} as any, () => undefined, () => undefined);
    await m.load();
    m.stop();
    expect(m.list()).toMatchObject([{ name: 'Yoshi', region: 'ap', status: 'pending', active: true }]);
  });
});

describe('connection health', () => {
  const base: HealthInput = { riotClient: 'up', lockfile: true, tokenSource: 'riot-client', connStatus: 'connected', events: 'connected', accounts: [], accountsReadOnly: false, pinned: false };
  it('all good is healthy', () => expect(computeHealth(base).overall).toBe('healthy'));
  it('a dead event socket degrades but does not block', () => {
    const h = computeHealth({ ...base, events: 'off' });
    expect(h.overall).toBe('degraded');
    expect(h.items.find((i) => i.id === 'events')?.action).toBe('reconnect');
  });
  it('Riot Client closed + saved sign-in expired = sign-in needed, never "offline"', () => {
    const h = computeHealth({ ...base, riotClient: 'down', lockfile: false, tokenSource: 'none', connStatus: 'waiting', events: 'off', accounts: [{ label: 'A#1', status: 'expired' }] });
    expect(h.overall).toBe('auth-required');
  });
  it('a saved account that is offline while the Riot Client works is only degraded', () => {
    const h = computeHealth({ ...base, accounts: [{ label: 'A#1', status: 'offline' }] });
    expect(h.overall).toBe('degraded');
    expect(h.items.find((i) => i.id === 'accounts')?.state).toBe('degraded');
  });
  it('a saved sign-in that was simply not needed yet is fine', () => expect(computeHealth({ ...base, accounts: [{ label: 'A#1', status: 'pending' }] }).overall).toBe('healthy'));
  it('unreadable account storage is an error', () => expect(computeHealth({ ...base, accountsReadOnly: true }).overall).toBe('error'));
});
