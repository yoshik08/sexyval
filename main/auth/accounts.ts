import { BrowserWindow, session as electronSession } from 'electron';
import crypto from 'node:crypto';
import { AUTHORIZE_URL, normalizeRegion, parseAuthRedirect, type AuthRedirect } from '../../shared/connection';
import type { AccountInfo } from '../../shared/features';
import { httpRequest } from '../riot/http';
import type { SignInProvider } from '../riot/session';
import { readJsonStrict, writeJsonWithBackup } from '../paths';
import { isUploadableCookie, type ValCookie } from '../../shared/valWeb';
import { log } from '../log';

interface StoredAccount {
  id: string;
  puuid?: string;
  name?: string;
  tag?: string;
  region?: string;
  addedAt: number;
  lastOkAt?: number;
}

interface Tokens {
  accessToken: string;
  idToken: string;
  entitlement: string;
  expiresAt: number;
}

export interface AuthUrls {
  authorize: string;
  entitlements: string;
  userinfo: string;
  geo: string;
}

export const REAL_AUTH_URLS: AuthUrls = {
  authorize: AUTHORIZE_URL,
  entitlements: 'https://entitlements.auth.riotgames.com/api/token/v1',
  userinfo: 'https://auth.riotgames.com/userinfo',
  geo: 'https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant',
};

const REAUTH_EVERY = 50 * 60 * 1000;
/** Offline retries: 30 s, 1, 2, 4, 8, 15 min, then every 15 min. Nothing ever deletes the account. */
export function offlineBackoff(attempt: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempt));
}

/**
 * What a silent re-login attempt means. Only a page Riot actually served as its login form counts as
 * "expired"; no answer, a failed load or a timeout on anything else is the network, never the account.
 */
export function classifyReauth(o: { redirect: boolean; lastUrl?: string; loadFailed: boolean; finishedLoads: number }): 'ok' | 'login-required' | 'network' {
  if (o.redirect) return 'ok';
  if (o.loadFailed || o.finishedLoads === 0) return 'network';
  try {
    const u = new URL(o.lastUrl ?? '');
    if (/(^|\.)(authenticate|auth)\.riotgames\.com$/i.test(u.hostname) && !/\/authorize/i.test(u.pathname)) return 'login-required';
    if (/login|signin/i.test(u.pathname)) return 'login-required';
  } catch {
    // no URL
  }
  return 'network';
}

/**
 * "Sign in with Riot": Riot's real login page in a BrowserWindow with a persistent partition.
 * We never see or store the password. Cookies stay in the partition ("stay signed in").
 * Tokens are held in memory only.
 */
export class AccountManager implements SignInProvider {
  private accounts: StoredAccount[] = [];
  private activeId: string | null = null;
  private tokens = new Map<string, Tokens>();
  private status = new Map<string, AccountInfo['status']>();
  private errors = new Map<string, string>();
  private reauthInflight = new Map<string, Promise<boolean>>();
  private timer: NodeJS.Timeout | null = null;
  /** Offline backoff per account: attempts so far and when the next try is due. */
  private offline = new Map<string, { attempts: number; next: number; timer?: NodeJS.Timeout }>();
  /** accounts.json was there but unreadable at start: never overwrite it with what we have in memory. */
  private readOnly = false;

  /** accounts.json couldn't be read at start (health panel). */
  get storageReadOnly(): boolean {
    return this.readOnly;
  }

  constructor(
    private readonly file: string,
    private readonly urls: AuthUrls,
    private readonly onChange: () => void,
    private readonly onExpired: (label: string) => void,
  ) {}

  async load(): Promise<void> {
    type F = { accounts?: StoredAccount[]; activeId?: string | null };
    let r = await readJsonStrict<F>(this.file);
    if (r.state === 'unreadable') {
      log.error(`accounts.json unreadable (${r.error}); trying the backup`);
      const b = await readJsonStrict<F>(`${this.file}.bak`);
      if (b.state === 'ok') r = b;
      // Nothing readable: keep the file untouched so a later run can still read it.
      else this.readOnly = true;
    }
    const d: F = r.state === 'ok' ? r.data : {};
    this.accounts = Array.isArray(d.accounts) ? d.accounts : [];
    this.activeId = d.activeId && this.accounts.some((a) => a.id === d.activeId) ? d.activeId : (this.accounts[0]?.id ?? null);
    for (const a of this.accounts) this.status.set(a.id, 'pending');
    this.timer = setInterval(() => {
      if (this.activeId) void this.silentReauth(this.activeId);
    }, REAUTH_EVERY);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private save(): void {
    if (this.readOnly) {
      log.warn('accounts.json was unreadable at start: not overwriting it');
      return;
    }
    void writeJsonWithBackup(this.file, { accounts: this.accounts, activeId: this.activeId }).catch((e) => log.warn('saving accounts failed', e));
  }

  private partition(id: string): string {
    return `persist:riot-${id}`;
  }

  list(): AccountInfo[] {
    return this.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      tag: a.tag,
      puuid: a.puuid,
      region: a.region,
      status: this.status.get(a.id) ?? 'pending',
      retryAt: this.status.get(a.id) === 'offline' ? this.offline.get(a.id)?.next : undefined,
      active: a.id === this.activeId,
      lastOkAt: a.lastOkAt,
      error: this.errors.get(a.id),
    }));
  }

  hasAccount(): boolean {
    return !!this.activeId;
  }

  /** Waits for the window to hit the playvalorant.com/opt_in redirect. Blocks that navigation. */
  private capture(win: BrowserWindow, timeoutMs: number | null): Promise<AuthRedirect | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: AuthRedirect | null) => {
        if (done) return;
        done = true;
        if (t) clearTimeout(t);
        resolve(r);
        if (!win.isDestroyed()) win.destroy();
      };
      const check = (e: { preventDefault(): void } | null, url: string) => {
        const r = parseAuthRedirect(url);
        if (r) {
          e?.preventDefault();
          finish(r);
        }
      };
      const wc = win.webContents;
      wc.on('will-redirect', (e, url) => check(e, url));
      wc.on('will-navigate', (e, url) => check(e, url));
      wc.on('did-redirect-navigation', (_e, url) => check(null, url));
      wc.on('did-navigate', (_e, url) => check(null, url));
      wc.on('did-navigate-in-page', (_e, url) => check(null, url));
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('closed', () => finish(null));
      const t = timeoutMs ? setTimeout(() => finish(null), timeoutMs) : null;
    });
  }

  /** Opens the visible login window. Resolves with the new account or null if cancelled. */
  async add(): Promise<AccountInfo | null> {
    const id = crypto.randomBytes(6).toString('hex');
    const win = new BrowserWindow({
      width: 480,
      height: 760,
      title: 'Sign in with Riot',
      autoHideMenuBar: true,
      backgroundColor: '#0b0e13',
      // Capture runs must never take focus (the game may be running); the mock login needs no window.
      show: !(process.env.SEXYVAL_SCREENSHOTS || process.env.SEXYVAL_LIVE_SHOTS),
      webPreferences: { partition: this.partition(id), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const pending = this.capture(win, null);
    void win.loadURL(this.urls.authorize).catch(() => undefined);
    const r = await pending;
    if (!r) {
      await electronSession.fromPartition(this.partition(id)).clearStorageData().catch(() => undefined);
      return null;
    }
    const acct: StoredAccount = { id, addedAt: Date.now() };
    try {
      await this.complete(acct, r);
    } catch (e) {
      log.warn('sign-in completion failed', e);
      await electronSession.fromPartition(this.partition(id)).clearStorageData().catch(() => undefined);
      throw e;
    }
    // Same Riot account added twice: keep the newest partition.
    const dupe = this.accounts.find((a) => a.puuid && a.puuid === acct.puuid);
    if (dupe) await this.remove(dupe.id);
    this.accounts.push(acct);
    this.activeId = id;
    this.save();
    this.onChange();
    return this.list().find((a) => a.id === id) ?? null;
  }

  /** Entitlement + userinfo + region for freshly captured tokens. */
  private async complete(acct: StoredAccount, r: AuthRedirect): Promise<void> {
    const auth = { Authorization: `Bearer ${r.accessToken}` };
    const ent = await httpRequest(this.urls.entitlements, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: {} });
    const entitlement = ent.json?.entitlements_token;
    if (ent.status !== 200 || typeof entitlement !== 'string') throw new Error(`Entitlement request failed (HTTP ${ent.status})`);
    const info = await httpRequest(this.urls.userinfo, { headers: auth });
    if (info.status !== 200 || typeof info.json?.sub !== 'string') throw new Error(`userinfo failed (HTTP ${info.status})`);
    acct.puuid = info.json.sub;
    acct.name = info.json?.acct?.game_name ?? acct.name;
    acct.tag = info.json?.acct?.tag_line ?? acct.tag;
    try {
      const geo = await httpRequest(this.urls.geo, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: { id_token: r.idToken } });
      const live = normalizeRegion(geo.json?.affinities?.live);
      if (live) acct.region = live;
    } catch (e) {
      log.warn('riot-geo failed; region falls back to cache/log', e);
    }
    acct.lastOkAt = Date.now();
    this.tokens.set(acct.id, { accessToken: r.accessToken, idToken: r.idToken, entitlement, expiresAt: Date.now() + r.expiresIn * 1000 });
    this.status.set(acct.id, 'ok');
    this.errors.delete(acct.id);
    log.info(`signed in as ${acct.name ?? '?'}#${acct.tag ?? '?'} (${acct.region ?? 'region unknown'})`);
  }

  /** Hidden window on the same partition; cookies make Riot redirect straight back. */
  silentReauth(id: string): Promise<boolean> {
    const existing = this.reauthInflight.get(id);
    if (existing) return existing;
    const p = (async () => {
      const acct = this.accounts.find((a) => a.id === id);
      if (!acct) return false;
      const prevStatus = this.status.get(id);
      if (prevStatus !== 'ok') {
        this.status.set(id, 'recovering');
        this.onChange();
      }
      const win = new BrowserWindow({ show: false, webPreferences: { partition: this.partition(id), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      const seen = { lastUrl: '', loadFailed: false, finishedLoads: 0 };
      win.webContents.on('did-finish-load', () => {
        seen.finishedLoads++;
        seen.lastUrl = win.isDestroyed() ? seen.lastUrl : win.webContents.getURL();
      });
      // -3 is ERR_ABORTED: our own preventDefault on the redirect, not a failure.
      win.webContents.on('did-fail-load', (_e, code, _d, url, mainFrame) => {
        if (mainFrame && code !== -3) {
          seen.loadFailed = true;
          seen.lastUrl = url;
        }
      });
      const pending = this.capture(win, 20_000);
      void win.loadURL(this.urls.authorize).catch(() => undefined);
      const r = await pending;
      const outcome = classifyReauth({ redirect: !!r, ...seen });
      if (outcome === 'login-required') {
        this.clearOffline(id);
        this.tokens.delete(id);
        this.status.set(id, 'expired');
        this.errors.set(id, 'Riot asked to log in again. Your account and its data are kept.');
        log.info(`account ${acct.name ?? '?'}: Riot needs a new sign-in`);
        this.onExpired(`${acct.name ?? 'Account'}#${acct.tag ?? ''}`);
        this.onChange();
        return false;
      }
      if (outcome === 'network') {
        this.markOffline(id, 'Riot can’t be reached right now (network). Retrying automatically.');
        return false;
      }
      try {
        await this.complete(acct, r!);
        this.clearOffline(id);
        this.save();
        this.onChange();
        return true;
      } catch (e) {
        const msg = (e as Error).message;
        // complete() talks to Riot too: an HTTP answer is an error, no answer is the network.
        if (/HTTP \d/.test(msg)) {
          this.status.set(id, 'error');
          this.errors.set(id, msg);
          this.onChange();
        } else this.markOffline(id, `Riot can’t be reached right now (${msg}). Retrying automatically.`);
        return false;
      }
    })().finally(() => this.reauthInflight.delete(id));
    this.reauthInflight.set(id, p);
    return p;
  }

  private markOffline(id: string, msg: string): void {
    const o = this.offline.get(id) ?? { attempts: 0, next: 0 };
    if (o.timer) clearTimeout(o.timer);
    const wait = offlineBackoff(o.attempts);
    o.attempts++;
    o.next = Date.now() + wait;
    o.timer = setTimeout(() => void this.silentReauth(id), wait);
    o.timer.unref?.();
    this.offline.set(id, o);
    this.status.set(id, 'offline');
    this.errors.set(id, msg);
    log.warn(`account ${id}: offline, retry ${o.attempts} in ${Math.round(wait / 1000)} s`);
    this.onChange();
  }

  private clearOffline(id: string): void {
    const o = this.offline.get(id);
    if (o?.timer) clearTimeout(o.timer);
    this.offline.delete(id);
  }

  /** Manual "Retry now" (Settings > Accounts, connection panel): skips the backoff wait. */
  retry(id: string): Promise<boolean> {
    this.clearOffline(id);
    return this.silentReauth(id);
  }

  /** Waiting out an offline backoff: don't open another hidden window on every token request. */
  private waiting(id: string): boolean {
    const o = this.offline.get(id);
    return this.status.get(id) === 'offline' && !!o && Date.now() < o.next;
  }

  async getTokens() {
    const id = this.activeId;
    if (!id) return null;
    let t = this.tokens.get(id);
    if (!t || t.expiresAt - Date.now() < 2 * 60 * 1000) {
      if (this.status.get(id) === 'expired' || this.waiting(id)) return null;
      const ok = await this.silentReauth(id);
      if (!ok) return null;
      t = this.tokens.get(id);
    }
    const acct = this.accounts.find((a) => a.id === id);
    if (!t || !acct?.puuid) return null;
    return { accessToken: t.accessToken, entitlement: t.entitlement, subject: acct.puuid, region: acct.region ?? null, label: `${acct.name ?? '?'}#${acct.tag ?? '?'}` };
  }

  /** Signed-in accounts with what store sync needs (no tokens). */
  signedIn(): { id: string; puuid: string; region: string; label: string; status: AccountInfo['status'] }[] {
    return this.accounts
      .filter((a) => a.puuid && a.region)
      .map((a) => ({ id: a.id, puuid: a.puuid!, region: a.region!, label: `${a.name ?? '?'}#${a.tag ?? '?'}`, status: this.status.get(a.id) ?? 'pending' }));
  }

  /**
   * The Riot SSO cookies in an account's partition, filtered to the uploadable set (ssid and the few
   * around it). Used only by the /val web-sync hand-off, which the user turns on explicitly. These
   * cookies are the login session itself, so this is the one place SexyVal ever reads them out of the
   * partition; nothing else copies them, and they are never written to disk here.
   */
  async ssoCookies(id: string): Promise<ValCookie[]> {
    const all = await electronSession
      .fromPartition(this.partition(id))
      .cookies.get({ domain: 'riotgames.com' })
      .catch(() => [] as Electron.Cookie[]);
    return all
      .filter((c) => isUploadableCookie({ name: c.name, domain: c.domain ?? '' }))
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain ?? '', path: c.path ?? '/', secure: c.secure ?? true, httpOnly: c.httpOnly ?? false, expirationDate: c.expirationDate }));
  }

  /** The active account as a /val link target, but only when it is a saved sign-in (has a partition with SSO cookies). */
  activeSignIn(): { id: string; puuid: string; region: string; label: string } | null {
    const id = this.activeId;
    if (!id) return null;
    const a = this.accounts.find((x) => x.id === id);
    if (!a?.puuid || !a.region) return null;
    return { id, puuid: a.puuid, region: a.region, label: `${a.name ?? '?'}#${a.tag ?? '?'}` };
  }

  /** A signed-in account by puuid (so the service can re-read cookies for the linked account on every open). */
  signInByPuuid(puuid: string): { id: string; puuid: string; region: string; label: string } | null {
    const a = this.accounts.find((x) => x.puuid === puuid);
    if (!a?.puuid || !a.region) return null;
    return { id: a.id, puuid: a.puuid, region: a.region, label: `${a.name ?? '?'}#${a.tag ?? '?'}` };
  }

  /** Tokens for a specific account (store sync), re-authenticating silently when needed. Null if expired. */
  async tokensFor(id: string): Promise<{ accessToken: string; entitlement: string } | null> {
    let t = this.tokens.get(id);
    if (!t || t.expiresAt - Date.now() < 2 * 60 * 1000) {
      if (this.status.get(id) === 'expired' || this.waiting(id)) return null;
      if (!(await this.silentReauth(id))) return null;
      t = this.tokens.get(id);
    }
    return t ? { accessToken: t.accessToken, entitlement: t.entitlement } : null;
  }

  reauth(): Promise<boolean> {
    return this.activeId ? this.silentReauth(this.activeId) : Promise.resolve(false);
  }

  switchTo(id: string): void {
    if (!this.accounts.some((a) => a.id === id)) return;
    this.activeId = id;
    this.save();
    this.onChange();
  }

  async remove(id: string): Promise<void> {
    this.clearOffline(id);
    this.accounts = this.accounts.filter((a) => a.id !== id);
    this.tokens.delete(id);
    this.status.delete(id);
    this.errors.delete(id);
    await electronSession.fromPartition(this.partition(id)).clearStorageData().catch(() => undefined);
    if (this.activeId === id) this.activeId = this.accounts[0]?.id ?? null;
    this.save();
    this.onChange();
  }

  /** "Sign in again" for an expired account: visible window on the same partition. */
  async signInAgain(id: string): Promise<boolean> {
    const acct = this.accounts.find((a) => a.id === id);
    if (!acct) return false;
    const win = new BrowserWindow({ width: 480, height: 760, title: 'Sign in with Riot', autoHideMenuBar: true, webPreferences: { partition: this.partition(id), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const pending = this.capture(win, null);
    void win.loadURL(this.urls.authorize).catch(() => undefined);
    const r = await pending;
    if (!r) return false;
    await this.complete(acct, r);
    this.clearOffline(id);
    this.save();
    this.onChange();
    return true;
  }
}
