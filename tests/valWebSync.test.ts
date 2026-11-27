import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShopView } from '../shared/types';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0' } }));

// Every Worker call goes through httpRequest: record them and answer per path.
const calls: { url: string; body: any; auth?: string }[] = [];
let answer: (url: string) => { status: number; json: any } | Error = () => ({ status: 200, json: { ok: true } });
vi.mock('../main/riot/http', () => ({
  httpRequest: async (url: string, opts: { body?: unknown; headers?: Record<string, string> }) => {
    calls.push({ url, body: opts.body, auth: opts.headers?.Authorization });
    const a = answer(url);
    if (a instanceof Error) throw a;
    return { status: a.status, json: a.json, text: '', headers: new Headers(), url };
  },
}));

const { ValWebSync } = await import('../main/services/valWebSync');

const A = { id: 'a1', puuid: 'puuid-a', region: 'ap', label: 'A#1' };
const B = { id: 'b1', puuid: 'puuid-b', region: 'ap', label: 'B#2' };
const shopFor = (puuid: string): ShopView => ({ status: 'done', puuid, daily: [{ offerId: 'o1', name: 'Reaver Vandal', cost: 1775 }], dailyEndsAt: Date.now() + 3600e3, wallet: { vp: 1, rad: 2, kc: 3 }, fetchedAt: Date.now() }) as ShopView;

async function make(active: typeof A) {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'valweb-')), 'val-web.json');
  let enabled = false;
  let current = active;
  const svc = new ValWebSync({
    file,
    setEnabled: (on) => (enabled = on),
    isEnabled: () => enabled,
    activeSignIn: () => current,
    signInByPuuid: (p) => [A, B].find((x) => x.puuid === p) ?? null,
    ssoCookies: async () => [{ name: 'ssid', value: 'secret-cookie', domain: 'auth.riotgames.com', path: '/', secure: true, httpOnly: true }],
    currentShop: () => shopFor(current.puuid),
    onChange: () => undefined,
  });
  await svc.load();
  return { svc, file, setActive: (x: typeof A) => (current = x), isOn: () => enabled };
}
const flush = () => new Promise((r) => setTimeout(r, 20));
const paths = () => calls.map((c) => new URL(c.url).pathname);

beforeEach(() => {
  calls.length = 0;
  answer = () => ({ status: 200, json: { ok: true, keyValidUntil: '2026-12-28' } });
});

describe('ValWebSync', () => {
  it('connect needs consent and sends link, key and the store on screen', async () => {
    const { svc, isOn } = await make(A);
    await expect(svc.connect(false)).rejects.toThrow(/Consent/);
    expect(calls).toHaveLength(0);
    const st = await svc.connect(true);
    await flush();
    expect(st.linked).toBe(true);
    expect(st.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(st.url).toBe('https://yoshik.xyz/val');
    expect(isOn()).toBe(true);
    expect(paths()).toEqual(expect.arrayContaining(['/api/link', '/api/key', '/api/snapshot']));
    // The status the renderer sees never carries the secret or a cookie.
    expect(JSON.stringify(svc.status())).not.toMatch(/secret-cookie|uploadSecret/);
  });

  it('disconnect keeps the link when the Worker cannot be reached', async () => {
    const { svc, file, isOn } = await make(A);
    await svc.connect(true);
    await flush();
    answer = () => new Error('ECONNRESET');
    await expect(svc.disconnect()).rejects.toThrow(/wasn’t deleted/);
    expect(svc.status().linked).toBe(true);
    expect(svc.status().lastError).toMatch(/wasn’t deleted/);
    expect(isOn()).toBe(true);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).uploadSecret).toBeTruthy();
  });

  it('disconnect keeps the link on a server error, clears it on 200 or 401', async () => {
    const { svc, isOn } = await make(A);
    await svc.connect(true);
    await flush();
    answer = () => ({ status: 500, json: { error: 'boom' } });
    await expect(svc.disconnect()).rejects.toThrow(/HTTP 500/);
    expect(svc.status().linked).toBe(true);
    answer = () => ({ status: 401, json: { error: 'unauthorized' } }); // nothing of ours left on the Worker
    const st = await svc.disconnect();
    expect(st.linked).toBe(false);
    expect(isOn()).toBe(false);
  });

  it('linking a different account revokes the previous one with its own secret first', async () => {
    const { svc, setActive } = await make(A);
    await svc.connect(true);
    await flush();
    const secretA = calls.find((c) => c.url.endsWith('/api/link'))!.auth;
    calls.length = 0;
    setActive(B);
    await svc.connect(true);
    expect(paths()[0]).toBe('/api/revoke');
    expect(calls[0].body).toEqual({ puuid: 'puuid-a' });
    expect(calls[0].auth).toBe(secretA);
    expect(calls[1].body.puuid).toBe('puuid-b');
    expect(calls[1].auth).not.toBe(secretA);
  });

  it('does not switch accounts when the old one cannot be revoked', async () => {
    const { svc, setActive } = await make(A);
    await svc.connect(true);
    await flush();
    setActive(B);
    answer = (u) => (u.endsWith('/api/revoke') ? new Error('offline') : { status: 200, json: { ok: true } });
    await expect(svc.connect(true)).rejects.toThrow();
    expect(svc.status().puuid).toBe('puuid-a');
  });

  it('ignores stores and account events for other accounts', async () => {
    const { svc } = await make(A);
    await svc.connect(true);
    await flush();
    calls.length = 0;
    svc.onShop(shopFor('puuid-b'), 'puuid-b');
    svc.onAccountActive('puuid-b');
    await flush();
    expect(calls).toHaveLength(0);
  });
});
