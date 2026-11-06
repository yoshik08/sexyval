import { afterAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { bundlesFromStorefront, dayFromStorefront, dayTotal, historyStats, mergeBundle, mergeShopDay, missedRotation, nextFetchAt, percent, shopDateKey, sightings, type ShopDay } from '../shared/storeArchive';
import { StoreArchive } from '../main/services/bundles';
import { JsonStore } from '../main/services/jsonStore';

process.env.SEXYVAL_QUIET = '1';
const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
const SKIN = 'e7c63390-eda7-46e0-bb7a-a6abdacd2433';
const CARD = '3f296c07-64c3-494c-923b-fe692a4fa1bd';
const H = 3600_000;
const T0 = Date.UTC(2026, 10, 6, 15, 0); // 6 Nov 2026 15:00 UTC

function storefront(opts: { bundle?: string; bundleSecs?: number; dailySecs?: number; daily?: string[]; night?: boolean } = {}) {
  const daily = opts.daily ?? ['lvl-a', 'lvl-b', 'lvl-c', 'lvl-d'];
  const b = {
    ID: 'offer-1',
    DataAssetID: opts.bundle ?? 'BUNDLE-1',
    Items: [
      { Item: { ItemTypeID: SKIN, ItemID: 'SKIN-LVL-1' }, BasePrice: 1775, DiscountedPrice: 1189, DiscountPercent: 0.33 },
      { Item: { ItemTypeID: CARD, ItemID: 'CARD-1' }, BasePrice: 375, DiscountedPrice: 251, DiscountPercent: 0.33 },
    ],
    TotalBaseCost: { [VP]: 2150 },
    TotalDiscountedCost: { [VP]: 1440 },
    TotalDiscountPercent: 0.33,
    DurationRemainingInSeconds: opts.bundleSecs ?? 3 * 86400,
  };
  return {
    FeaturedBundle: { Bundles: [b] },
    SkinsPanelLayout: {
      SingleItemOffers: daily,
      SingleItemStoreOffers: daily.map((id, i) => ({ OfferID: id, Cost: { [VP]: 875 + i * 400 }, Rewards: [{ ItemTypeID: SKIN, ItemID: id }] })),
      SingleItemOffersRemainingDurationInSeconds: opts.dailySecs ?? 9 * 3600,
    },
    BonusStore: opts.night ? { BonusStoreOffers: [{ Offer: { OfferID: 'n1', Cost: { [VP]: 2175 }, Rewards: [{ ItemTypeID: SKIN, ItemID: 'night-1' }] }, DiscountPercent: 32, DiscountCosts: { [VP]: 1479 } }] } : undefined,
  };
}

describe('shared/storeArchive: bundles', () => {
  it('captures every item type with exact base and discounted prices', () => {
    const [b] = bundlesFromStorefront(storefront(), T0);
    expect(b).toMatchObject({ id: 'bundle-1', total: 1440, totalBase: 2150, discountPercent: 33, endsAt: T0 + 3 * 86400_000 });
    expect(b.items).toEqual([
      { kind: 'skin', itemTypeId: SKIN, itemId: 'skin-lvl-1', basePrice: 1775, discountedPrice: 1189 },
      { kind: 'card', itemTypeId: CARD, itemId: 'card-1', basePrice: 375, discountedPrice: 251 },
    ]);
    expect(percent(0.33)).toBe(33);
    expect(percent(33)).toBe(33);
  });

  it('merge never overwrites: lastSeen moves, missing fields fill, accounts accumulate', () => {
    const [seen] = bundlesFromStorefront(storefront(), T0);
    const first = mergeBundle(undefined, { ...seen, items: [{ ...seen.items[0], basePrice: undefined }], name: 'Featured bundle' }, 'A#1', T0);
    const again = mergeBundle(first, { ...seen, name: 'Snowfall', icon: 'icon.png' }, 'B#2', T0 + H);
    expect(again.firstSeen).toBe(T0);
    expect(again.lastSeen).toBe(T0 + H);
    expect(again.name).toBe('Snowfall');
    expect(again.icon).toBe('icon.png');
    expect(again.seenBy).toEqual(['A#1', 'B#2']);
    expect(again.items.find((i) => i.itemId === 'skin-lvl-1')!.basePrice).toBe(1775);
    expect(again.items).toHaveLength(2);
    // A later sighting with different numbers doesn't replace known prices or names.
    const later = mergeBundle(again, { ...seen, name: 'Other', items: [{ ...seen.items[0], basePrice: 9999 }] }, 'A#1', T0 + 2 * H);
    expect(later.name).toBe('Snowfall');
    expect(later.items[0].basePrice).toBe(1775);
    expect(later.seenBy).toEqual(['A#1', 'B#2']);
  });
});

describe('shared/storeArchive: shop days', () => {
  it('keys a shop by its rotation date in UTC, wherever and whenever it was fetched', () => {
    // A 00:00 UTC reset: fetched at 15:00 UTC (9 h left) and at 23:59 UTC (1 min left) is the same day.
    const a = dayFromStorefront(storefront({ dailySecs: 9 * 3600 }), 'me', T0)!;
    const b = dayFromStorefront(storefront({ dailySecs: 60 }), 'me', Date.UTC(2026, 10, 6, 23, 59))!;
    const c = dayFromStorefront(storefront({ dailySecs: 24 * 3600 - 60 }), 'me', Date.UTC(2026, 10, 6, 0, 1))!;
    expect([a.date, b.date, c.date]).toEqual(['2026-11-06', '2026-11-06', '2026-11-06']);
    // Shortly after the reset it is already the next day, even though it is still the 6th in the Americas.
    expect(dayFromStorefront(storefront({ dailySecs: 24 * 3600 - 120 }), 'me', Date.UTC(2026, 10, 7, 0, 2))!.date).toBe('2026-11-07');
  });

  it('daylight saving changes nothing (Europe 25 Oct, US 1 Nov 2026)', () => {
    for (const day of [Date.UTC(2026, 9, 25), Date.UTC(2026, 9, 26), Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 2)]) {
      const end = day + 24 * H;
      for (const hoursLeft of [23.9, 12, 3, 0.1]) {
        const d = dayFromStorefront(storefront({ dailySecs: hoursLeft * 3600 }), 'me', end - hoursLeft * H)!;
        expect(d.date).toBe(new Date(day).toISOString().slice(0, 10));
      }
    }
    // A reset that isn't at midnight UTC still keys by the middle of its own window.
    expect(shopDateKey(Date.UTC(2026, 10, 7, 9))).toBe('2026-11-06');
  });

  it('night market items keep base price and discount', () => {
    const d = dayFromStorefront(storefront({ night: true }), 'me', T0)!;
    expect(d.daily.map((x) => x.vp)).toEqual([875, 1275, 1675, 2075]);
    expect(d.night).toEqual([{ levelId: 'night-1', skinId: undefined, vp: 1479, baseVp: 2175, discountPercent: 32 }]);
  });

  it('merge keeps the first capture and fills gaps; days never seen stay absent', () => {
    const d = dayFromStorefront(storefront(), 'me', T0)!;
    const first = mergeShopDay(undefined, { ...d, daily: d.daily.map((x) => ({ ...x, skinId: undefined })) }, T0);
    const second = mergeShopDay(first, { ...d, daily: d.daily.map((x) => ({ ...x, skinId: `skin-${x.levelId}` })), night: [{ levelId: 'n', vp: 1 }] }, T0 + H);
    expect(second.daily[0].skinId).toBe('skin-lvl-a');
    expect(second.firstSeen).toBe(T0);
    expect(second.lastSeen).toBe(T0 + H);
    expect(second.night).toHaveLength(1);
  });

  it('sightings, totals and stats', () => {
    const day = (date: string, skins: string[], vp = 1000): ShopDay => ({ account: 'me', date, daily: skins.map((s) => ({ levelId: s, skinId: s, vp })), firstSeen: 0, lastSeen: 0 });
    const days = [day('2026-10-01', ['prime', 'a', 'b', 'c']), day('2026-10-05', ['prime', 'd', 'e', 'f'], 2000), day('2026-10-12', ['prime', 'g', 'h', 'i'])];
    const s = sightings(days).get('prime')!;
    expect(s).toMatchObject({ count: 3, last: '2026-10-12', dates: ['2026-10-01', '2026-10-05', '2026-10-12'] });
    expect(dayTotal(days[1])).toBe(8000);
    const st = historyStats(days, new Set(['d', 'g']));
    expect(st.captured).toBe(3);
    expect(st.mostRepeated?.skinId).toBe('prime');
    expect(st.bestDay?.date).toBe('2026-10-05');
    expect(st.watchDays).toBe(2);
  });
});

describe('shared/storeArchive: when to fetch', () => {
  it('a minute after the soonest rotation, at least hourly', () => {
    expect(nextFetchAt(T0, [T0 + 10 * 60_000, T0 + 5 * H], T0)).toBe(T0 + 11 * 60_000);
    expect(nextFetchAt(T0, [T0 + 5 * H], T0)).toBe(T0 + H); // safety net wins
    expect(nextFetchAt(T0, [undefined, T0 - H], T0 - 2 * H)).toBe(T0); // overdue: now
  });

  it('offline then restart: a rotation that passed while closed is detected', () => {
    const lastFetch = T0 - 10 * H;
    expect(missedRotation(T0, [T0 - 2 * H], lastFetch)).toBe(true);
    expect(missedRotation(T0, [T0 + 2 * H], lastFetch)).toBe(false);
    expect(missedRotation(T0, [T0 - 12 * H], lastFetch)).toBe(false); // ended before the last fetch: already captured
  });
});

describe('StoreArchive files', () => {
  const dirs: string[] = [];
  const tmp = async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'sexyval-archive-'));
    dirs.push(d);
    return d;
  };
  afterAll(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('two accounts, one bundle: merged, both days kept, survives a restart', async () => {
    const dir = await tmp();
    const a = new StoreArchive(dir);
    await a.load();
    const r1 = a.ingest(storefront(), { id: 'puuid-a', label: 'A#1' }, T0, { bundleInfo: () => ({ name: 'Snowfall' }), skinOf: (l) => `skin:${l}` });
    expect(r1.newBundles).toHaveLength(1);
    const r2 = a.ingest(storefront({ daily: ['lvl-x', 'lvl-y', 'lvl-z', 'lvl-w'] }), { id: 'puuid-b', label: 'B#2' }, T0 + 60_000);
    expect(r2.newBundles).toHaveLength(0);
    expect(a.bundles()[0].seenBy).toEqual(['A#1', 'B#2']);
    expect(a.bundles()[0].items[0].skinId).toBe('skin:skin-lvl-1');
    expect(a.days().map((d) => d.account).sort()).toEqual(['puuid-a', 'puuid-b']);
    await a.flush();
    // Restart: everything is read back; the bundle left the store but stays in the archive.
    const b = new StoreArchive(dir);
    await b.load();
    expect(b.bundles()).toHaveLength(1);
    expect(b.bundles()[0].name).toBe('Snowfall');
    expect(b.days()).toHaveLength(2);
    expect(b.lastFetchAt).toBe(T0 + 60_000);
    b.ingest(storefront({ bundle: 'BUNDLE-2' }), { id: 'puuid-a', label: 'A#1' }, T0 + 4 * 86400_000);
    expect(b.bundles().map((x) => x.id)).toEqual(['bundle-2', 'bundle-1']);
  });

  it('a corrupt file is backed up, not dropped', async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, 'bundles.json'), '{"v":1,"bundles":{"x":');
    const a = new StoreArchive(dir);
    await a.load();
    expect(a.bundles()).toEqual([]);
    const files = await fs.readdir(dir);
    const backup = files.find((f) => /^bundles\.corrupt-\d+\.json$/.test(f));
    expect(backup).toBeTruthy();
    expect(await fs.readFile(path.join(dir, backup!), 'utf8')).toBe('{"v":1,"bundles":{"x":');
  });

  it('a failed write is retried and the in-memory copy is kept', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'blocked', 'store.json');
    // A file where the folder should be makes every write fail until it is removed.
    await fs.writeFile(path.join(dir, 'blocked'), 'x');
    const s = new JsonStore<{ v: 1; n: number }>(file, (x: any): x is { v: 1; n: number } => x?.v === 1, () => ({ v: 1, n: 0 }), { retries: 2, retryDelayMs: 5, laterMs: 30, debounceMs: 1 });
    s.data.n = 42;
    await s.flush().catch(() => undefined);
    s.save();
    await s.flush();
    expect(s.lastError).toBeTruthy();
    expect(s.data.n).toBe(42);
    await fs.rm(path.join(dir, 'blocked'));
    await new Promise((r) => setTimeout(r, 120));
    await s.flush();
    expect(JSON.parse(await fs.readFile(file, 'utf8')).n).toBe(42);
    expect(s.lastError).toBeNull();
  });
});
