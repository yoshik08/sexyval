// yoshik.xyz/val — the web store sync contract, shared by the desktop app and (mirrored) by the
// Cloudflare Worker. Pure logic only: no Electron, no network, so every branch is unit-testable.
//
// What this feature moves off the PC, stated plainly: the Riot single-sign-on cookies that already
// power SexyVal's silent re-auth (ssid and the small set around it). Those cookies ARE the login
// credential; the Worker stores them encrypted at rest and uses them only to fetch this one account's
// own store on days the app is closed. No Riot password, and no Riot Client lockfile password, is ever
// read, stored or sent — not here, not in the service, not in the Worker. See HARD RULES in the
// feature prompt; this file is the one source of truth for the shapes that cross the wire.

import type { ShopItem } from './types';

/** Bumped if the snapshot shape changes in a way the Worker/page must notice. */
export const VAL_SNAPSHOT_VERSION = 1;

/**
 * The Riot SSO cookies silent re-auth depends on. `ssid` is the session itself; the rest travel with it
 * on auth.riotgames.com. Everything else in the partition (analytics `_ga*`, consent, hcaptcha, cloudflare
 * `__cf_bm`) is deliberately NOT captured — it is not needed to re-auth and must not leave the machine.
 */
export const RIOT_SSO_COOKIE_NAMES = ['ssid', 'clid', 'csid', 'ccid', 'tdid', 'sub', 'asid'] as const;
export type RiotSsoCookieName = (typeof RIOT_SSO_COOKIE_NAMES)[number];

/** Only riotgames.com SSO cookies are ever eligible to be uploaded. */
export function isUploadableCookie(c: { name: string; domain: string }): boolean {
  const name = c.name.toLowerCase();
  if (!(RIOT_SSO_COOKIE_NAMES as readonly string[]).includes(name)) return false;
  const d = c.domain.replace(/^\./, '').toLowerCase();
  return d === 'riotgames.com' || d.endsWith('.riotgames.com');
}

export interface ValCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Seconds since epoch, or undefined for a session cookie. */
  expirationDate?: number;
}

/** Turns captured cookies into a `Cookie:` header value for the authorize replay. */
export function cookieHeader(cookies: { name: string; value: string }[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** A `Set-Cookie` header line → name/value, so refreshed SSO cookies can be merged back in. */
export function parseSetCookie(line: string): { name: string; value: string; expires?: number } | null {
  const [pair, ...attrs] = line.split(';');
  const eq = pair.indexOf('=');
  if (eq < 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;
  let expires: number | undefined;
  for (const a of attrs) {
    const [k, v] = a.split('=');
    const key = k.trim().toLowerCase();
    if (key === 'max-age') {
      const n = Number(v);
      if (Number.isFinite(n)) expires = Math.floor(Date.now() / 1000) + n;
    } else if (key === 'expires' && !expires) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) expires = Math.floor(t / 1000);
    }
  }
  return { name, value, expires };
}

/**
 * The parsed store a page shows. A subset of ShopView: no live `status`, no desktop-only flags beyond
 * owned/watched which the desktop fills before upload. Prices are the exact VP from the storefront.
 */
export interface ValSnapshot {
  v: number;
  puuid: string;
  /** Rotation day this store belongs to (shopDateKey), YYYY-MM-DD. */
  shopDate: string;
  daily: ShopItem[];
  dailyEndsAt?: number;
  night?: { items: ShopItem[]; endsAt?: number };
  bundles?: { id: string; name: string; icon?: string; endsAt?: number; items: ShopItem[]; total?: number; totalBase?: number }[];
  wallet: { vp: number; rad: number; kc: number } | null;
  /** When this store was fetched from Riot (ms). */
  fetchedAt: number;
  /** "v3 POST" etc., for debugging; never a token. */
  source?: string;
}

/** SexyVal → Worker: register a one-time link code the browser will claim. */
export interface LinkCreateBody {
  code: string;
  puuid: string;
  region: string;
  label: string;
  /** Per-link upload secret; proves this uploader owns this puuid on later key/snapshot posts. */
  uploadSecret: string;
}

/** SexyVal → Worker: a fresh SSO cookie set for one account. */
export interface KeyUploadBody {
  puuid: string;
  region: string;
  label: string;
  cookies: ValCookie[];
}

/** SexyVal → Worker: the current parsed store, so /val is fresh the instant it is opened. */
export interface SnapshotUploadBody {
  puuid: string;
  snapshot: ValSnapshot;
}

/** Desktop → renderer: the /val sync status shown in Settings. Never carries the upload secret or cookies. */
export interface ValWebStatus {
  enabled: boolean;
  linked: boolean;
  label: string | null;
  puuid: string | null;
  /** The current one-time link code, or null when none is active. */
  code: string | null;
  codeExpiresAt: number | null;
  lastKeyAt: number | null;
  lastSnapshotAt: number | null;
  /** Date the stored cookies expire, as the Worker last reported it. */
  keyValidUntil: string | null;
  lastError: string | null;
  /** The public page URL to open. */
  url: string;
}

/** Worker → page. Never carries a cookie, a token, or the upload secret. */
export interface StoreResponse {
  snapshot: ValSnapshot | null;
  fetchedAt: number | null;
  dailyEndsAt?: number;
  /** true when the shown store is older than the current rotation (Worker couldn't refresh). */
  stale: boolean;
  /** Date-only, so the page can say "open SexyVal by {date}". null when no key is stored. */
  keyValidUntil: string | null;
  label: string | null;
}

/**
 * Shape guard for an uploaded snapshot. Strict on types, and rejects anything carrying a field named
 * "password" anywhere in the tree (hard rule: a password must never appear in a snapshot). Returns the
 * reason it was rejected, or null when the shape is acceptable.
 */
export function snapshotReject(v: unknown): string | null {
  if (!v || typeof v !== 'object') return 'not an object';
  if (hasPasswordField(v)) return 'contains a password field';
  const s = v as Record<string, unknown>;
  if (typeof s.puuid !== 'string' || !s.puuid) return 'missing puuid';
  if (typeof s.shopDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.shopDate)) return 'bad shopDate';
  if (!Array.isArray(s.daily)) return 'daily must be an array';
  if (s.daily.length > 12) return 'too many daily items';
  if (s.wallet != null && typeof s.wallet !== 'object') return 'bad wallet';
  if (s.bundles != null && (!Array.isArray(s.bundles) || s.bundles.length > 20)) return 'bad bundles';
  return null;
}

/** Recursively true if any object key is literally "password" (case-insensitive). Arrays checked too. */
export function hasPasswordField(v: unknown, depth = 0): boolean {
  if (depth > 8 || !v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => hasPasswordField(x, depth + 1));
  for (const [k, val] of Object.entries(v)) {
    if (k.toLowerCase() === 'password') return true;
    if (hasPasswordField(val, depth + 1)) return true;
  }
  return false;
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1 — easy to read and type

/** A human-typeable one-time link code, grouped as XXXX-XXXX. `rand` injectable for tests. */
export function makeLinkCode(rand: (n: number) => number[] = randomBytes): string {
  const bytes = rand(8);
  const body = bytes.map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${body.slice(0, 4)}-${body.slice(4, 8)}`;
}

/** Normalises a code the user typed on the web (strip spaces/dashes, uppercase). */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function randomBytes(n: number): number[] {
  // Overridden in the service with node crypto; this fallback keeps the module dependency-free for tests.
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(Math.random() * 256));
  return out;
}
