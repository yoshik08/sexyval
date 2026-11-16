// Per-account wishlist and store-match alerts (pure; main/services/wishlist.ts owns the file).
//
// wishlist.json v2: { version: 2, accounts: { [puuid]: WishAccount }, legacy?: string[] }.
// v1 (1.6 and older) was one list for everyone: { skinIds, notified[] }. It becomes `legacy`, which seeds
// each account the first time that account is used, so nobody loses the list they had.

export interface WishAccount {
  skinIds: string[];
  /** skinId -> last time it was in this account's store (fresh data only). */
  seen: Record<string, number>;
  /** appearance key -> when the alert went out. One alert per item per store appearance. */
  notified: Record<string, number>;
}

export interface WishState {
  version: 2;
  accounts: Record<string, WishAccount>;
  legacy?: string[];
}

export interface Offer {
  skinId?: string;
  name: string;
  kind: 'daily' | 'night' | 'bundle';
  /** When this offer leaves the store; identifies the appearance. */
  endsAt?: number;
}

export interface WishHit {
  skinId: string;
  name: string;
  kind: Offer['kind'];
}

const KEEP_NOTIFIED_MS = 45 * 24 * 3_600_000;
const SKIN = /^[0-9a-f-]{36}$/i;

const empty = (): WishAccount => ({ skinIds: [], seen: {}, notified: {} });

export function migrateWish(raw: any): WishState {
  if (raw && raw.version === 2 && raw.accounts && typeof raw.accounts === 'object') {
    const accounts: Record<string, WishAccount> = {};
    for (const [k, v] of Object.entries<any>(raw.accounts)) {
      if (!/^[0-9a-f-]{36}$/i.test(k) || !v) continue;
      accounts[k] = {
        skinIds: Array.isArray(v.skinIds) ? v.skinIds.filter((s: unknown) => typeof s === 'string' && SKIN.test(s)) : [],
        seen: v.seen && typeof v.seen === 'object' ? v.seen : {},
        notified: v.notified && typeof v.notified === 'object' ? v.notified : {},
      };
    }
    return { version: 2, accounts, ...(Array.isArray(raw.legacy) ? { legacy: raw.legacy } : {}) };
  }
  const legacy = Array.isArray(raw?.skinIds) ? raw.skinIds.filter((s: unknown) => typeof s === 'string' && SKIN.test(s)) : [];
  return { version: 2, accounts: {}, ...(legacy.length ? { legacy } : {}) };
}

/** The account's entry, created (and seeded from the pre-1.7 shared list) on first use. */
export function accountOf(state: WishState, puuid: string): WishAccount {
  let a = state.accounts[puuid];
  if (!a) {
    a = empty();
    if (state.legacy?.length) a.skinIds = [...state.legacy];
    state.accounts[puuid] = a;
  }
  return a;
}

export function toggle(a: WishAccount, skinId: string): void {
  const id = skinId.toLowerCase();
  a.skinIds = a.skinIds.includes(id) ? a.skinIds.filter((x) => x !== id) : [...a.skinIds, id];
}

/** One store appearance: same item, same kind of offer, same end time. */
export function appearanceKey(o: Offer, now: number): string {
  const end = o.endsAt ? Math.round(o.endsAt / 60_000) : `d${Math.floor(now / 86_400_000)}`;
  return `${o.skinId}:${o.kind}:${end}`;
}

/**
 * Compares a store against the account's wishlist. Only `fresh` data (just fetched from Riot) counts:
 * a cached store shown while offline never alerts and never moves "last seen". Returns the new alerts;
 * mutates `a` (seen/notified) so the caller persists it.
 */
export function matchOffers(a: WishAccount, offers: Offer[], now: number, fresh: boolean): WishHit[] {
  if (!fresh || !a.skinIds.length) return [];
  const wish = new Set(a.skinIds);
  const hits: WishHit[] = [];
  const dup = new Set<string>();
  for (const o of offers) {
    if (!o.skinId || !wish.has(o.skinId)) continue;
    a.seen[o.skinId] = now;
    const key = appearanceKey(o, now);
    if (a.notified[key]) continue;
    // Every appearance of the skin in this store is marked, even the ones folded into one alert.
    a.notified[key] = now;
    if (dup.has(o.skinId)) continue;
    dup.add(o.skinId);
    hits.push({ skinId: o.skinId, name: o.name, kind: o.kind });
  }
  for (const [k, t] of Object.entries(a.notified)) if (now - t > KEEP_NOTIFIED_MS) delete a.notified[k];
  return hits;
}

/** skinId -> when an alert for it last went out. */
export function lastNotified(a: WishAccount): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, t] of Object.entries(a.notified)) {
    const id = k.split(':')[0];
    if (!out[id] || t > out[id]) out[id] = t;
  }
  return out;
}

export function offersOf(view: { daily: { skinId?: string; name: string }[]; dailyEndsAt?: number; night?: { items: { skinId?: string; name: string }[]; endsAt?: number }; bundles?: { endsAt?: number; items: { skinId?: string; name: string }[] }[] }): Offer[] {
  return [
    ...view.daily.map((i) => ({ skinId: i.skinId, name: i.name, kind: 'daily' as const, endsAt: view.dailyEndsAt })),
    ...(view.night?.items ?? []).map((i) => ({ skinId: i.skinId, name: i.name, kind: 'night' as const, endsAt: view.night?.endsAt })),
    ...(view.bundles ?? []).flatMap((b) => b.items.map((i) => ({ skinId: i.skinId, name: i.name, kind: 'bundle' as const, endsAt: b.endsAt }))),
  ];
}
