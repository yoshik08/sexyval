// Store archive: every featured bundle and every daily shop / night market SexyVal sees, kept forever.
// Pure: parsing, merging, date keying and fetch scheduling. Files are handled in main/services/bundles.ts.

export const ITEM_KIND: Record<string, ArchItem['kind']> = {
  'e7c63390-eda7-46e0-bb7a-a6abdacd2433': 'skin',
  'dd3bf334-87f3-40bd-b043-682a57a8dc3a': 'buddy',
  '3f296c07-64c3-494c-923b-fe692a4fa1bd': 'card',
  'd5f120f8-ff8c-4aac-92ea-f2b5acbe9475': 'spray',
  'de7caa6b-adf7-4588-bbd1-143831e786c6': 'title',
};
const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';

export interface ArchItem {
  kind: 'skin' | 'buddy' | 'card' | 'spray' | 'title' | 'other';
  itemTypeId: string;
  /** Skin level / buddy level / card / spray / title id. */
  itemId: string;
  skinId?: string;
  basePrice?: number;
  discountedPrice?: number;
}

export interface ArchivedBundle {
  id: string;
  name?: string;
  icon?: string;
  items: ArchItem[];
  total?: number;
  totalBase?: number;
  /** 0-100. */
  discountPercent?: number;
  firstSeen: number;
  lastSeen: number;
  /** DurationRemainingInSeconds turned into a time. */
  endsAt?: number;
  /** Accounts (Name#Tag) that saw it. */
  seenBy: string[];
}

export interface ShopDayItem {
  levelId: string;
  skinId?: string;
  vp: number;
  /** Night market only. */
  baseVp?: number;
  discountPercent?: number;
}

export interface ShopDay {
  account: string;
  label?: string;
  /** Rotation date, YYYY-MM-DD (the shop's own reset day, not local midnight). */
  date: string;
  daily: ShopDayItem[];
  night?: ShopDayItem[];
  firstSeen: number;
  lastSeen: number;
}

export interface BundleFile {
  v: 1;
  bundles: Record<string, ArchivedBundle>;
}

export interface ShopHistoryFile {
  v: 1;
  /** Key `${account}|${date}`. */
  days: Record<string, ShopDay>;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pos = (v: unknown) => (num(v) > 0 ? num(v) : undefined);
const lc = (v: unknown) => String(v ?? '').toLowerCase();

function cost(c: any): number {
  if (!c || typeof c !== 'object') return 0;
  if (typeof c[VP] === 'number') return c[VP];
  const first = Object.values(c).find((x) => typeof x === 'number');
  return typeof first === 'number' ? first : 0;
}

/** DiscountPercent comes as a fraction (0.33) or a percent (33); normalise to 0-100. */
export function percent(v: unknown): number | undefined {
  const n = num(v);
  if (!n) return undefined;
  return Math.round(n <= 1 ? n * 100 : n);
}

/** Every featured bundle in a raw storefront (all item types, not just skins). */
export function bundlesFromStorefront(sf: any, now: number): Omit<ArchivedBundle, 'firstSeen' | 'lastSeen' | 'seenBy' | 'name' | 'icon'>[] {
  const raw: any[] = Array.isArray(sf?.FeaturedBundle?.Bundles) ? sf.FeaturedBundle.Bundles : sf?.FeaturedBundle?.Bundle ? [sf.FeaturedBundle.Bundle] : [];
  return raw
    .filter((b) => b && (b.DataAssetID || b.ID))
    .map((b) => {
      let items: ArchItem[] = [];
      if (Array.isArray(b.Items) && b.Items.length) {
        items = b.Items.map((x: any) => {
          const type = lc(x?.Item?.ItemTypeID);
          return { kind: ITEM_KIND[type] ?? 'other', itemTypeId: type, itemId: lc(x?.Item?.ItemID), basePrice: pos(x?.BasePrice), discountedPrice: pos(x?.DiscountedPrice) };
        });
      } else if (Array.isArray(b.ItemOffers)) {
        items = b.ItemOffers.map((x: any) => {
          const rw = x?.Offer?.Rewards?.[0];
          const type = lc(rw?.ItemTypeID);
          return { kind: ITEM_KIND[type] ?? 'other', itemTypeId: type, itemId: lc(rw?.ItemID), basePrice: pos(cost(x?.Offer?.Cost)), discountedPrice: pos(cost(x?.DiscountedCost)) };
        });
      }
      const secs = num(b.DurationRemainingInSeconds);
      return {
        id: lc(b.DataAssetID ?? b.ID),
        items: items.filter((i) => i.itemId),
        total: pos(cost(b.TotalDiscountedCost)),
        totalBase: pos(cost(b.TotalBaseCost)),
        discountPercent: percent(b.TotalDiscountPercent ?? b.DiscountPercent),
        endsAt: secs > 0 ? Math.round((now + secs * 1000) / 60_000) * 60_000 : undefined,
      };
    });
}

/** Merge, never overwrite: lastSeen moves forward, firstSeen back, missing fields fill in, accounts accumulate. */
export function mergeBundle(prev: ArchivedBundle | undefined, seen: Omit<ArchivedBundle, 'firstSeen' | 'lastSeen' | 'seenBy'>, account: string, now: number): ArchivedBundle {
  if (!prev) return { ...seen, firstSeen: now, lastSeen: now, seenBy: account ? [account] : [] };
  const items = [...prev.items];
  for (const it of seen.items) {
    const i = items.findIndex((x) => x.itemId === it.itemId);
    if (i < 0) items.push(it);
    // Known values win; the new sighting only fills what was missing.
    else items[i] = { ...it, ...(Object.fromEntries(Object.entries(items[i]).filter(([, v]) => v != null)) as ArchItem) };
  }
  return {
    ...prev,
    name: prev.name && prev.name !== 'Featured bundle' ? prev.name : (seen.name ?? prev.name),
    icon: prev.icon ?? seen.icon,
    items,
    total: prev.total ?? seen.total,
    totalBase: prev.totalBase ?? seen.totalBase,
    discountPercent: prev.discountPercent ?? seen.discountPercent,
    firstSeen: Math.min(prev.firstSeen, now),
    lastSeen: Math.max(prev.lastSeen, now),
    endsAt: seen.endsAt ?? prev.endsAt,
    seenBy: account && !prev.seenBy.includes(account) ? [...prev.seenBy, account] : prev.seenBy,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
export const utcDate = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/**
 * The shop's rotation date from when it ends: the UTC date at the middle of its 24 h window. Riot resets
 * the daily shop at a fixed UTC time, so this never depends on the PC's time zone or daylight saving.
 */
export function shopDateKey(endsAt: number): string {
  return utcDate(endsAt - 12 * 3600_000);
}

/** Today's (or any time's) shop date for a 00:00 UTC reset, for "today" on the calendar. */
export function shopDateAt(t: number): string {
  return utcDate(t);
}

export function dayFromStorefront(sf: any, account: string, now: number, resolve?: (levelId: string) => string | undefined): Omit<ShopDay, 'firstSeen' | 'lastSeen'> | null {
  const panel = sf?.SkinsPanelLayout;
  const secs = num(panel?.SingleItemOffersRemainingDurationInSeconds);
  if (!panel || secs <= 0) return null;
  const offers: any[] = Array.isArray(panel.SingleItemStoreOffers) ? panel.SingleItemStoreOffers : [];
  const ids: string[] = Array.isArray(panel.SingleItemOffers) && panel.SingleItemOffers.length ? panel.SingleItemOffers : offers.map((o) => o?.OfferID);
  const daily = ids.filter(Boolean).map((id) => {
    const o = offers.find((x) => x?.OfferID === id);
    const levelId = lc(o?.Rewards?.[0]?.ItemID ?? id);
    return { levelId, skinId: resolve?.(levelId), vp: cost(o?.Cost) };
  });
  const bonus: any[] = Array.isArray(sf?.BonusStore?.BonusStoreOffers) ? sf.BonusStore.BonusStoreOffers : [];
  const night = bonus.map((b) => {
    const levelId = lc(b?.Offer?.Rewards?.[0]?.ItemID ?? b?.Offer?.OfferID);
    const base = cost(b?.Offer?.Cost);
    return { levelId, skinId: resolve?.(levelId), vp: cost(b?.DiscountCosts) || base, baseVp: base || undefined, discountPercent: percent(b?.DiscountPercent) };
  });
  const endsAt = Math.round((now + secs * 1000) / 60_000) * 60_000;
  return { account, date: shopDateKey(endsAt), daily, night: night.length ? night : undefined };
}

export function mergeShopDay(prev: ShopDay | undefined, seen: Omit<ShopDay, 'firstSeen' | 'lastSeen'>, now: number): ShopDay {
  if (!prev) return { ...seen, firstSeen: now, lastSeen: now };
  const fill = (a: ShopDayItem[], b: ShopDayItem[]) => (a.length ? a.map((x) => ({ ...x, skinId: x.skinId ?? b.find((y) => y.levelId === x.levelId)?.skinId, vp: x.vp || (b.find((y) => y.levelId === x.levelId)?.vp ?? 0) })) : b);
  return {
    ...prev,
    label: prev.label ?? seen.label,
    daily: fill(prev.daily, seen.daily),
    night: prev.night?.length ? fill(prev.night, seen.night ?? []) : seen.night,
    firstSeen: Math.min(prev.firstSeen, now),
    lastSeen: Math.max(prev.lastSeen, now),
  };
}

export const dayKey = (account: string, date: string) => `${account}|${date}`;

/** Store fetch cadence: a minute after every rotation, and at least once an hour. */
export const SAFETY_MS = 60 * 60_000;
export const AFTER_ROTATION_MS = 60_000;

/** When to fetch next: one minute after the soonest upcoming rotation, capped by the hourly safety net. */
export function nextFetchAt(now: number, ends: (number | undefined)[], lastFetch: number): number {
  const safety = lastFetch + SAFETY_MS;
  const rotations = ends.filter((e): e is number => !!e).map((e) => e + AFTER_ROTATION_MS).filter((t) => t > now);
  return Math.max(now, Math.min(safety, ...rotations));
}

/** After a restart: true when a rotation we knew about passed while the app was closed (fetch at once). */
export function missedRotation(now: number, knownEnds: (number | undefined)[], lastFetch: number): boolean {
  return knownEnds.some((e) => !!e && e > lastFetch && e <= now);
}

/** Validates a parsed file; anything else is treated as corrupt (and backed up, never dropped). */
export function isBundleFile(x: any): x is BundleFile {
  return !!x && x.v === 1 && x.bundles && typeof x.bundles === 'object' && Object.values(x.bundles).every((b: any) => b && typeof b.id === 'string' && Array.isArray(b.items));
}

export function isShopHistoryFile(x: any): x is ShopHistoryFile {
  return !!x && x.v === 1 && x.days && typeof x.days === 'object' && Object.values(x.days).every((d: any) => d && typeof d.date === 'string' && Array.isArray(d.daily));
}

// ---------- calendar helpers (renderer) ----------

export interface SkinSighting {
  skinId: string;
  count: number;
  last: string;
  dates: string[];
}

/** Per-skin sightings across one account's days (daily and night market). */
export function sightings(days: ShopDay[]): Map<string, SkinSighting> {
  const m = new Map<string, SkinSighting>();
  for (const d of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const it of [...d.daily, ...(d.night ?? [])]) {
      if (!it.skinId) continue;
      const s = m.get(it.skinId) ?? { skinId: it.skinId, count: 0, last: d.date, dates: [] };
      if (!s.dates.includes(d.date)) {
        s.count++;
        s.dates.push(d.date);
      }
      s.last = d.date;
      m.set(it.skinId, s);
    }
  }
  return m;
}

export function dayTotal(d: ShopDay): number {
  return d.daily.reduce((a, i) => a + (i.vp || 0), 0);
}

/** Days captured, most repeated skin, highest-value day, how many days had a watchlist skin. */
export function historyStats(days: ShopDay[], watch: Set<string>) {
  const s = sightings(days);
  const top = [...s.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))[0];
  const best = [...days].sort((a, b) => dayTotal(b) - dayTotal(a))[0];
  const watchDays = days.filter((d) => [...d.daily, ...(d.night ?? [])].some((i) => i.skinId && watch.has(i.skinId))).length;
  return { captured: days.length, mostRepeated: top && top.count > 1 ? top : undefined, bestDay: best, watchDays };
}
