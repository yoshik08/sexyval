import { BrowserWindow, session as electronSession } from 'electron';
import crypto from 'node:crypto';
import { AUTHORIZE_URL, normalizeRegion, parseAuthRedirect, type AuthRedirect } from '../../shared/connection';
import type { AccountInfo } from '../../shared/features';
import { httpRequest } from '../riot/http';
import type { SignInProvider } from '../riot/session';
import { readJson, writeJson } from '../paths';
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

  constructor(
    private readonly file: string,
    private readonly urls: AuthUrls,
    private readonly onChange: () => void,
    private readonly onExpired: (label: string) => void,
  ) {}

  async load(): Promise<void> {
    const d = await readJson<{ accounts?: StoredAccount[]; activeId?: string | null }>(this.file, {});
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
    void writeJson(this.file, { accounts: this.accounts, activeId: this.activeId });
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
      const win = new BrowserWindow({ show: false, webPreferences: { partition: this.partition(id), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      const pending = this.capture(win, 20_000);
      void win.loadURL(this.urls.authorize).catch(() => undefined);
      const r = await pending;
      if (!r) {
        this.tokens.delete(id);
        this.status.set(id, 'expired');
        this.errors.set(id, 'Session expired: Riot asked to log in again');
        this.onExpired(`${acct.name ?? 'Account'}#${acct.tag ?? ''}`);
        this.onChange();
        return false;
      }
      try {
        await this.complete(acct, r);
        this.save();
        this.onChange();
        return true;
      } catch (e) {
        this.status.set(id, 'error');
        this.errors.set(id, (e as Error).message);
        this.onChange();
        return false;
      }
    })().finally(() => this.reauthInflight.delete(id));
    this.reauthInflight.set(id, p);
    return p;
  }

  async getTokens() {
    const id = this.activeId;
    if (!id) return null;
    let t = this.tokens.get(id);
    if (!t || t.expiresAt - Date.now() < 2 * 60 * 1000) {
      if (this.status.get(id) === 'expired') return null;
      const ok = await this.silentReauth(id);
      if (!ok) return null;
      t = this.tokens.get(id);
    }
    const acct = this.accounts.find((a) => a.id === id);
    if (!t || !acct?.puuid) return null;
    return { accessToken: t.accessToken, entitlement: t.entitlement, subject: acct.puuid, region: acct.region ?? null, label: `${acct.name ?? '?'}#${acct.tag ?? '?'}` };
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
    this.save();
    this.onChange();
    return true;
  }
}
