// yoshik.xyz/val web store sync — the desktop side of the hand-off.
//
// When the user turns this on (consent-gated, Settings > Network), SexyVal:
//   1. mints a per-link upload secret + a one-time link code, registers them with the Worker, and shows
//      the code so the user can claim the page at yoshik.xyz/val once;
//   2. on every app open / silent re-auth of the linked account, uploads a FRESH Riot SSO cookie set and
//      the current parsed store to the Worker over direct HTTPS, so the page is fresh and the Worker can
//      refresh the store itself on days the PC is closed.
//
// What never happens here: no Riot password, no lockfile password, no cookie, and no upload secret is
// ever written to accounts.json, the Vault, or a log. The only thing persisted locally is val-web.json,
// which holds the puuid, region, label and the upload secret (a bearer credential for THIS puuid's own
// store only — not a Riot credential). The SSO cookies are read from the partition, posted, and dropped.

import { httpRequest } from '../riot/http';
import { readJson, writeJson } from '../paths';
import { log } from '../log';
import {
  cookieHeader as _ch, // referenced only to keep the shared module the single source of the name set
  makeLinkCode,
  type KeyUploadBody,
  type LinkCreateBody,
  type SnapshotUploadBody,
  type ValCookie,
  type ValSnapshot,
  type ValWebStatus,
} from '../../shared/valWeb';
import { shopDateKey } from '../../shared/storeArchive';
import type { ShopItem, ShopView } from '../../shared/types';
import crypto from 'node:crypto';

void _ch; // (kept imported so a rename in shared/valWeb.ts surfaces here too)

/**
 * Where SexyVal talks to the Worker. Direct to the Worker's own URL (robust, no proxy dependency for the
 * desktop → Worker channel). The public *page* lives at this URL too, and at yoshik.xyz/val once the proxy
 * route is deployed. Overridable for tests / a future custom domain.
 */
const BASE = process.env.SEXYVAL_VAL_BASE || 'https://sexyval-val.weirdaxf.workers.dev';
/** What the user opens on their phone (the proxy route in front of the same Worker). */
const PAGE = process.env.SEXYVAL_VAL_PAGE || 'https://yoshik.xyz/val';
const CODE_TTL_MS = 15 * 60_000;
/** Don't re-upload the key more than this often on repeated account events (reauth is ~50 min anyway). */
const KEY_MIN_INTERVAL_MS = 5 * 60_000;

interface LocalState {
  linked: boolean;
  puuid: string;
  region: string;
  label: string;
  /** Bearer secret for this puuid's own key/snapshot/revoke posts. Not a Riot credential. */
  uploadSecret: string;
  /** The current one-time link code and when it stops working (display only). */
  code?: string;
  codeExpiresAt?: number;
  lastKeyAt?: number;
  lastSnapshotAt?: number;
  /** Latest value the Worker reported for when the stored cookies expire (date only). */
  keyValidUntil?: string;
  lastError?: string;
}

export interface ValWebDeps {
  file: string;
  /** Flip the persisted setting (so it survives restarts and the health panel can read it). */
  setEnabled: (on: boolean) => void;
  isEnabled: () => boolean;
  /** The active signed-in account, or null when the active account isn't a saved sign-in. */
  activeSignIn: () => { id: string; puuid: string; region: string; label: string } | null;
  /** A signed-in account by puuid (to re-read its cookies on later opens). */
  signInByPuuid: (puuid: string) => { id: string; puuid: string; region: string; label: string } | null;
  /** Read the uploadable SSO cookies for an account id. */
  ssoCookies: (id: string) => Promise<ValCookie[]>;
  /** The store currently on screen (any account); uploaded at once when it belongs to the linked account. */
  currentShop: () => ShopView | null;
  onChange: () => void;
}

export class ValWebSync {
  private state: LocalState | null = null;
  private pushing = false;

  constructor(private readonly d: ValWebDeps) {}

  async load(): Promise<void> {
    this.state = await readJson<LocalState | null>(this.d.file, null);
    // Setting on but no local state (reinstall / cleared data): treat as off, don't claim to be linked.
    if (this.d.isEnabled() && !this.state?.linked) this.d.setEnabled(false);
  }

  private async save(): Promise<void> {
    if (this.state) await writeJson(this.d.file, this.state);
  }

  status(): ValWebStatus {
    const s = this.state;
    return {
      enabled: this.d.isEnabled(),
      linked: !!s?.linked,
      label: s?.label ?? null,
      puuid: s?.puuid ?? null,
      code: s?.code && (s.codeExpiresAt ?? 0) > Date.now() ? s.code : null,
      codeExpiresAt: s?.codeExpiresAt ?? null,
      lastKeyAt: s?.lastKeyAt ?? null,
      lastSnapshotAt: s?.lastSnapshotAt ?? null,
      keyValidUntil: s?.keyValidUntil ?? null,
      lastError: s?.lastError ?? null,
      url: publicUrl(),
    };
  }

  /**
   * Consent-gated connect: `consented` must be true (the UI only sends it from the consent screen).
   * Links the active signed-in account, registers a one-time code with the Worker, and does the first
   * key + snapshot upload. Returns the status (with the code to show), or throws a user-facing error.
   */
  async connect(consented: boolean): Promise<ValWebStatus> {
    if (!consented) throw new Error('Consent is required to turn on /val sync.');
    const acct = this.d.activeSignIn();
    if (!acct) {
      throw new Error('Sign in with Riot first (Settings > Accounts). /val needs a saved Riot sign-in, not the Riot Client token.');
    }
    // Re-linking to another account: delete the old account's key on the Worker first, or it would stay
    // there (and keep being refreshed by the cron) with no local secret left to revoke it.
    if (this.state?.linked && this.state.puuid !== acct.puuid) await this.revokeRemote(this.state);
    const uploadSecret = this.state?.puuid === acct.puuid && this.state.uploadSecret ? this.state.uploadSecret : crypto.randomBytes(32).toString('base64url');
    const code = makeLinkCode((n) => Array.from(crypto.randomBytes(n)));
    const codeExpiresAt = Date.now() + CODE_TTL_MS;
    const body: LinkCreateBody = { code, puuid: acct.puuid, region: acct.region, label: acct.label, uploadSecret };
    // Bearer lets us re-link an account we already own (the Worker protects an active binding from takeover).
    const res = await this.post('/api/link', body, uploadSecret);
    if (res.status !== 200) throw new Error(httpMsg('Couldn’t reach the /val service', res));
    this.state = {
      linked: true,
      puuid: acct.puuid,
      region: acct.region,
      label: acct.label,
      uploadSecret,
      code,
      codeExpiresAt,
      lastKeyAt: this.state?.puuid === acct.puuid ? this.state.lastKeyAt : undefined,
      lastSnapshotAt: this.state?.puuid === acct.puuid ? this.state.lastSnapshotAt : undefined,
      keyValidUntil: undefined,
      lastError: undefined,
    };
    this.d.setEnabled(true);
    await this.save();
    this.d.onChange();
    // First hand-off right away so the page works the moment it's claimed.
    void this.pushKey('connect').catch((e) => log.warn('val: first key push failed', e));
    this.pushCurrentShop();
    return this.status();
  }

  /**
   * Disconnect: the Worker deletes the key + store, then local state is wiped. If the Worker can't be
   * reached, nothing local is forgotten (the upload secret is the only way to revoke the server copy, and
   * the cron would otherwise keep that key alive): it throws so the user can try again.
   */
  async disconnect(): Promise<ValWebStatus> {
    const s = this.state;
    if (s?.linked) {
      try {
        await this.revokeRemote(s);
      } catch (e) {
        s.lastError = (e as Error).message;
        await this.save();
        this.d.onChange();
        throw e;
      }
    }
    this.state = null;
    this.d.setEnabled(false);
    await writeJson(this.d.file, null);
    this.d.onChange();
    return this.status();
  }

  /** The active account changed or re-authenticated: push a fresh key + snapshot if it's the linked one. */
  onAccountActive(puuid: string | null): void {
    if (!this.d.isEnabled() || !this.state?.linked) return;
    if (!puuid || puuid !== this.state.puuid) return;
    void this.pushKey('account').catch((e) => log.warn('val: key push failed', e));
  }

  /** The active store refreshed: upload its snapshot if it belongs to the linked account. */
  onShop(view: ShopView, puuid: string): void {
    if (!this.d.isEnabled() || !this.state?.linked || puuid !== this.state.puuid) return;
    if (view.status !== 'done') return;
    void this.pushSnapshot(view).catch((e) => log.warn('val: snapshot push failed', e));
  }

  /** Manual "Sync now" from Settings. */
  async pushNow(): Promise<ValWebStatus> {
    await this.pushKey('manual');
    this.pushCurrentShop();
    return this.status();
  }

  /** Revoke one account's server copy. 200 = deleted; 401 = the Worker holds nothing under this secret. */
  private async revokeRemote(s: LocalState): Promise<void> {
    const res = await this.post('/api/revoke', { puuid: s.puuid }, s.uploadSecret).catch((e) => {
      log.warn('val: revoke request failed', e);
      return null;
    });
    if (res && (res.status === 200 || res.status === 401)) return;
    throw new Error(res ? httpMsg('The /val service didn’t confirm the delete', res) + '. Nothing was removed; try again.' : 'Couldn’t reach the /val service, so your key wasn’t deleted from it yet. Check your connection and try again.');
  }

  private pushCurrentShop(): void {
    const v = this.d.currentShop();
    if (v?.puuid) this.onShop(v, v.puuid);
  }

  private async pushKey(reason: string): Promise<void> {
    const s = this.state;
    if (!s?.linked || this.pushing) return;
    if (reason !== 'manual' && reason !== 'connect' && s.lastKeyAt && Date.now() - s.lastKeyAt < KEY_MIN_INTERVAL_MS) return;
    const acct = this.d.signInByPuuid(s.puuid);
    if (!acct) {
      s.lastError = 'The linked account is no longer signed in.';
      await this.save();
      this.d.onChange();
      return;
    }
    this.pushing = true;
    try {
      const cookies = await this.d.ssoCookies(acct.id);
      if (!cookies.some((c) => c.name.toLowerCase() === 'ssid')) {
        s.lastError = 'No Riot session cookie yet — open after a successful sign-in.';
        await this.save();
        this.d.onChange();
        return;
      }
      const body: KeyUploadBody = { puuid: s.puuid, region: acct.region, label: acct.label, cookies };
      const res = await this.post('/api/key', body, s.uploadSecret);
      if (res.status !== 200) {
        s.lastError = httpMsg('Key upload failed', res);
      } else {
        s.lastKeyAt = Date.now();
        s.lastError = undefined;
        const until = res.json?.keyValidUntil;
        if (typeof until === 'string') s.keyValidUntil = until;
        log.info(`val: session key uploaded (${reason})`);
      }
      await this.save();
      this.d.onChange();
    } finally {
      this.pushing = false;
    }
  }

  private async pushSnapshot(view: ShopView): Promise<void> {
    const s = this.state;
    if (!s?.linked) return;
    const snapshot = toSnapshot(view, s.puuid);
    if (!snapshot) return;
    const body: SnapshotUploadBody = { puuid: s.puuid, snapshot };
    const res = await this.post('/api/snapshot', body, s.uploadSecret);
    if (res.status === 200) {
      s.lastSnapshotAt = Date.now();
      await this.save();
      this.d.onChange();
    } else {
      log.warn(`val: snapshot upload HTTP ${res.status}`);
    }
  }

  /** Direct HTTPS to the Worker. Never routed through the store proxy / WARP; never logs the body. */
  private post(path: string, body: unknown, bearer?: string) {
    return httpRequest(`${BASE}${path}`, {
      method: 'POST',
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
      body,
      timeoutMs: 12000,
    });
  }
}

export function publicUrl(): string {
  return PAGE;
}

function httpMsg(prefix: string, res: { status: number; json: any }): string {
  const detail = typeof res.json?.error === 'string' ? `: ${res.json.error}` : '';
  return `${prefix} (HTTP ${res.status}${detail})`;
}

/**
 * The app's art URLs are svasset://img/<base64url> (main's disk-cached image protocol), which only exists
 * inside SexyVal. The web page needs the real https URL, and its CSP only allows media.valorant-api.com.
 */
export function webArtUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  let url = u;
  if (u.startsWith('svasset://img/')) {
    try {
      url = Buffer.from(u.slice('svasset://img/'.length), 'base64url').toString('utf8');
    } catch {
      return undefined;
    }
  }
  try {
    const p = new URL(url);
    return p.protocol === 'https:' && p.hostname === 'media.valorant-api.com' ? p.href : undefined;
  } catch {
    return undefined;
  }
}

const webItem = (i: ShopItem): ShopItem => ({ ...i, icon: webArtUrl(i.icon), tier: i.tier ? { ...i.tier, icon: webArtUrl(i.tier.icon) } : undefined });

/** ShopView → the snapshot the page shows. Returns null when there's nothing worth sending yet. */
export function toSnapshot(view: ShopView, puuid: string): ValSnapshot | null {
  if (!view.daily.length) return null;
  const endsAt = view.dailyEndsAt ?? Date.now();
  return {
    v: 1,
    puuid,
    shopDate: shopDateKey(endsAt),
    daily: view.daily.map(webItem),
    dailyEndsAt: view.dailyEndsAt,
    night: view.night ? { ...view.night, items: view.night.items.map(webItem) } : undefined,
    bundles: view.bundles?.map((b) => ({ ...b, icon: webArtUrl(b.icon), items: b.items.map(webItem) })),
    wallet: view.wallet,
    fetchedAt: view.fetchedAt ?? Date.now(),
    source: view.source,
  };
}
