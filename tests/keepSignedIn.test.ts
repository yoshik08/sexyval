import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, session: { fromPartition: () => ({}) }, app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0' } }));
const { persistentCookie, cookieSetDetails, loginPageAction, LOGIN_RETRY_MS } = await import('../main/auth/accounts');

const cookie = (over: Partial<Electron.Cookie>): Electron.Cookie =>
  ({ name: 'ssid', value: 'v', domain: 'auth.riotgames.com', hostOnly: true, path: '/', secure: true, httpOnly: true, session: true, sameSite: 'no_restriction', ...over }) as Electron.Cookie;

describe('keeping a Riot sign-in across restarts', () => {
  const now = Date.UTC(2026, 10, 28);

  it('re-saves a session-only ssid with a 30-day expiry, unchanged otherwise', () => {
    const d = persistentCookie(cookie({}), now)!;
    expect(d.expirationDate).toBe(now / 1000 + 30 * 86400);
    expect(d).toMatchObject({ url: 'https://auth.riotgames.com/', name: 'ssid', value: 'v', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction' });
    // Host-only stays host-only: no domain attribute.
    expect(d.domain).toBeUndefined();
  });

  it('keeps a domain cookie on its domain', () => {
    const d = persistentCookie(cookie({ name: 'tdid', domain: '.riotgames.com', hostOnly: false }), now)!;
    expect(d.domain).toBe('.riotgames.com');
    expect(d.url).toBe('https://riotgames.com/');
  });

  it('leaves cookies that already persist, and anything that is not a Riot sign-in cookie', () => {
    expect(persistentCookie(cookie({ session: false, expirationDate: now / 1000 + 86400 }), now)).toBeNull();
    expect(persistentCookie(cookie({ name: '_ga', domain: '.riotgames.com' }), now)).toBeNull();
    expect(persistentCookie(cookie({ name: '__cf_bm' }), now)).toBeNull();
    expect(persistentCookie(cookie({ domain: 'riotgames.com.evil.example' }), now)).toBeNull();
  });

  it('restores a cookie exactly as it was, with its own expiry', () => {
    const d = cookieSetDetails(cookie({ session: false, expirationDate: 123 }), 123);
    expect(d).toMatchObject({ name: 'ssid', value: 'v', expirationDate: 123, domain: undefined });
  });
});

describe('a login page on silent re-auth', () => {
  it('retries twice (2 min, then 6 min) before the account counts as signed out', () => {
    expect(loginPageAction(1)).toEqual({ expire: false, retryInMs: LOGIN_RETRY_MS[0] });
    expect(loginPageAction(2)).toEqual({ expire: false, retryInMs: LOGIN_RETRY_MS[1] });
    expect(loginPageAction(3)).toEqual({ expire: true });
    expect(LOGIN_RETRY_MS).toEqual([120_000, 360_000]);
  });
});
