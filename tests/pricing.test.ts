import { describe, expect, it } from 'vitest';
import { buildPriceMap, describeQuote, prettyContractName, quoteFor, sourceLabel } from '../shared/pricing';
import { offersCoverage, parseOffers, pricesBySkin } from '../shared/offers';
import { skinSourcesFromContracts } from '../main/services/catalog';
import { BUNDLED_LIST, PriceBook } from '../main/services/prices';
import type { Catalog, CatalogSkin } from '../shared/features';
import type { ShopView } from '../shared/types';

const tiers = [
  { id: 't-sel', name: 'Select', rank: 0 },
  { id: 't-pre', name: 'Premium', rank: 2 },
  { id: 't-ult', name: 'Ultra', rank: 4 },
  { id: 't-ex', name: 'Exclusive', rank: 3 },
];
const weapons = [
  { id: 'w-rifle', name: 'Vandal', category: 'Rifle' },
  { id: 'w-melee', name: 'Melee', category: 'Melee' },
];
const skin = (id: string, weaponId: string, tierId: string, extra: Partial<CatalogSkin> = {}): CatalogSkin => ({
  id,
  name: id,
  weaponId,
  tierId,
  order: 0,
  firstSeen: 0,
  levels: [{ id: id + '-l1', name: 'l1' }],
  chromas: [],
  ...extra,
});
const catalog = { tiers, weapons, skins: [skin('a', 'w-rifle', 't-pre'), skin('b', 'w-melee', 't-ult'), skin('c', 'w-rifle', 't-sel'), skin('d', 'w-rifle', 't-pre', { source: { kind: 'battlepass', name: 'DIMENSION: ACT 2', level: 12 } })] };

describe('quotes: store, offers, bundled list, reward, approximation', () => {
  const offers = { bySkin: { a: 1875, b: 4350, c: 875 }, loaded: true };
  it('prefers your store, then store offers, then contract reward, then no price', () => {
    const observed = { a: { vp: 1675, at: 1 }, d: { vp: 999, at: 2 } };
    expect(quoteFor(catalog.skins[0], observed, offers)).toMatchObject({ kind: 'exact', vp: 1675, source: 'store' }); // store beats offers
    expect(quoteFor(catalog.skins[1], observed, offers)).toMatchObject({ kind: 'exact', vp: 4350, source: 'offers' });
    expect(quoteFor(catalog.skins[3], {}, offers)).toMatchObject({ kind: 'reward', label: 'Battle Pass · Dimension Act 2' });
    expect(quoteFor(catalog.skins[3], observed, offers)).toMatchObject({ kind: 'exact', vp: 999, source: 'store' }); // if the store ever sells it, believe the store
    expect(quoteFor(catalog.skins[3], {}, { bySkin: { d: 1275 }, loaded: true })).toMatchObject({ kind: 'exact', source: 'offers' });
  });
  it('has no price (and no number) when no source has the skin', () => {
    expect(quoteFor(catalog.skins[2], {})).toEqual({ kind: 'none', reason: 'unavailable' }); // no offers list loaded
    expect(quoteFor(catalog.skins[2], {}, { bySkin: {}, loaded: true })).toEqual({ kind: 'none', reason: 'not-sold' }); // full list, skin absent
    expect(quoteFor(catalog.skins[2], {}).vp).toBeUndefined();
  });
  it('builds a map covering the whole catalog', () => {
    const map = buildPriceMap(catalog, {});
    expect(Object.keys(map).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('never says "unknown"; only known and approximate prices carry a number, and only approximations carry the almost-equal sign', () => {
    for (const q of [...Object.values(buildPriceMap(catalog, {})), ...Object.values(buildPriceMap(catalog, {}, offers))]) {
      const d = describeQuote(q);
      const text = `${d.primary} ${d.secondary ?? ''} ${d.short ?? ''}`;
      expect(text.toLowerCase()).not.toContain('unknown');
      if (q.kind !== 'approx') expect(text).not.toMatch(/[≈~]/);
      if (q.kind !== 'exact' && q.kind !== 'approx') expect(text).not.toMatch(/\d{3}/);
    }
    expect(describeQuote({ kind: 'exact', vp: 1775, source: 'offers' })).toEqual({ primary: '1,775', secondary: 'VP' });
    expect(describeQuote({ kind: 'approx', vp: 2175, basis: 'tier' })).toEqual({ primary: '≈ 2,175', secondary: 'VP' });
    expect(describeQuote({ kind: 'none', reason: 'not-sold' })).toMatchObject({ primary: 'Not sold separately', short: 'Not sold' });
    expect(describeQuote({ kind: 'none', reason: 'unavailable' })).toMatchObject({ primary: 'Price not available', short: 'No price' });
    const reward = describeQuote({ kind: 'reward', label: 'Battle Pass · Season 2026 Act III', source: 'battlepass' });
    expect(reward).toMatchObject({ primary: 'Battle Pass · Season 2026 Act III', short: 'Battle Pass' });
    expect(describeQuote({ kind: 'reward', label: 'Gekko Gear · Level 10', source: 'agent' }).short).toBe('Agent gear');
  });
});

describe('bundled price list and approximations for newer skins', () => {
  const list = { date: '2026-11-05', prices: { a: 1775, p1: 2175, p2: 2175, k1: 4350, s1: 875 } };
  const cat = {
    weapons: [...weapons, { id: 'w-pistol', name: 'Ghost', category: 'Sidearm' }],
    skins: [
      skin('a', 'w-rifle', 't-pre'),
      skin('p1', 'w-rifle', 't-ex', { themeId: 'prime' }),
      skin('p2', 'w-pistol', 't-ex', { themeId: 'prime' }),
      skin('pNew', 'w-pistol', 't-ex', { themeId: 'prime' }), // same collection, not listed yet
      skin('k1', 'w-melee', 't-ex', { themeId: 'other' }),
      skin('kNew', 'w-melee', 't-ex', { themeId: 'brand-new' }), // new collection, melee
      skin('gNew', 'w-rifle', 't-ex', { themeId: 'brand-new' }), // new collection, gun
      skin('s1', 'w-rifle', 't-sel'),
      skin('bp', 'w-rifle', 't-sel', { source: { kind: 'battlepass', name: 'V26: ACT 3', level: 5 } }),
      skin('noTier', 'w-rifle', ''),
    ],
  };
  it('uses the list after your store and the offers', () => {
    const m = buildPriceMap(cat, { a: { vp: 1675, at: 1 } }, { bySkin: { p1: 2475 }, loaded: false }, list);
    expect(m.a).toMatchObject({ kind: 'exact', vp: 1675, source: 'store' });
    expect(m.p1).toMatchObject({ kind: 'exact', vp: 2475, source: 'offers' });
    expect(m.p2).toMatchObject({ kind: 'exact', vp: 2175, source: 'list', seenAt: Date.parse('2026-11-05') });
  });
  it('approximates newer skins from their collection, else from the edition (guns and melee apart)', () => {
    const m = buildPriceMap(cat, {}, undefined, list);
    expect(m.pNew).toEqual({ kind: 'approx', vp: 2175, basis: 'collection' });
    expect(m.gNew).toEqual({ kind: 'approx', vp: 2175, basis: 'tier' }); // Exclusive guns in the list: 2175
    expect(m.kNew).toEqual({ kind: 'approx', vp: 4350, basis: 'tier' }); // Exclusive melee: 4350, not the gun price
    expect(m.bp.kind).toBe('reward'); // rewards are never priced
    expect(m.noTier).toEqual({ kind: 'none', reason: 'unavailable' }); // nothing to go on
  });
  it('a price seen in your store replaces the approximation', () => {
    const m = buildPriceMap(cat, { gNew: { vp: 2675, at: 5 } }, undefined, list);
    expect(m.gNew).toMatchObject({ kind: 'exact', vp: 2675, source: 'store' });
  });
  it('the bundled list is real data: hundreds of skins at standard price points', () => {
    expect(Object.keys(BUNDLED_LIST.prices).length).toBeGreaterThan(600);
    expect(BUNDLED_LIST.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const vals = Object.values(BUNDLED_LIST.prices);
    for (const v of vals) expect(v >= 500 && v <= 10_000).toBe(true);
    // A handful of real one-offs exist (VCT x ZETA 2,320, Ignite Fan 4,710); everything else is on 25 VP steps.
    expect(vals.filter((v) => v % 25 === 0).length / vals.length).toBeGreaterThan(0.98);
  });
});

describe('contract rewards', () => {
  it('formats contract names', () => {
    expect(prettyContractName('DIMENSION: ACT 2')).toBe('Dimension Act 2');
    expect(prettyContractName('GEKKO GEAR')).toBe('Gekko Gear');
    expect(prettyContractName('SEASON 2025 // ACT VI')).toBe('Season 2025 Act VI');
    expect(prettyContractName('EPISODE 9: ACT III')).toBe('Episode 9 Act III');
    expect(prettyContractName('THE DIVIDE')).toBe('The Divide'); // not roman numerals
    expect(sourceLabel({ kind: 'agent', name: 'GEKKO GEAR', level: 10 })).toBe('Gekko Gear · Level 10');
    expect(sourceLabel({ kind: 'event', name: 'REVERIE', level: 3 })).toBe('Event Pass · Reverie');
  });
  it('maps skin-level rewards to their contract, counting only real levels', () => {
    const contracts = [
      { displayName: 'IGNITION: ACT 1', content: { relationType: 'Season', chapters: [{ levels: [{ reward: { type: 'Spray', uuid: 's' } }, { reward: { type: 'EquippableSkinLevel', uuid: 'LVL-A' } }], freeRewards: [{ type: 'EquippableSkinLevel', uuid: 'FREE-B' }] }] } },
      { displayName: 'OLD', content: { relationType: 'Weird', chapters: [{ levels: [{ reward: { type: 'EquippableSkinLevel', uuid: 'NOPE' } }] }] } },
    ];
    const m = skinSourcesFromContracts(contracts);
    expect(m.get('lvl-a')).toEqual({ kind: 'battlepass', name: 'IGNITION: ACT 1', level: 2 });
    expect(m.get('free-b')?.kind).toBe('battlepass');
    expect(m.has('nope')).toBe(false);
  });
});

describe('PriceBook', () => {
  const shop = (over: Partial<ShopView>): ShopView => ({ status: 'done', daily: [], wallet: null, ...over });
  it('remembers list prices (pre-discount) from daily, night market and bundles', () => {
    const book = new PriceBook('unused.json', () => undefined);
    const changed = book.record(
      shop({
        daily: [{ offerId: 'o1', skinId: 'a', name: 'A', cost: 1775 }],
        night: { items: [{ offerId: 'o2', skinId: 'c', name: 'C', cost: 600, baseCost: 875, discountPercent: 31 }] },
        bundles: [{ id: 'b', name: 'B', items: [{ offerId: 'o3', skinId: 'b', name: 'Bm', cost: 4455, baseCost: 4950 }] }],
      }),
    );
    expect(changed).toBe(true);
    const q = book.quotes(catalog as unknown as Catalog);
    expect(q.a).toMatchObject({ kind: 'exact', vp: 1775 });
    expect(q.c).toMatchObject({ kind: 'exact', vp: 875 }); // not the 600 sale price
    expect(q.b).toMatchObject({ kind: 'exact', vp: 4950 });
    expect(q.d.kind).toBe('reward');
  });
  it('ignores items it cannot attribute and reports no change when nothing new', () => {
    const book = new PriceBook('unused.json', () => undefined);
    const v = shop({ daily: [{ offerId: 'x', name: 'no skin id', cost: 500 }, { offerId: 'y', skinId: 'a', name: 'zero', cost: 0 }] });
    expect(book.record(v)).toBe(false);
    expect(book.size).toBe(0);
  });
});

describe('HenrikDev store offers', () => {
  const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
  const SKIN = 'e7c63390-eda7-46e0-bb7a-a6abdacd2433';
  it('parses the v1 (legacy Riot offers) shape: VP cost, skin-level rewards only', () => {
    const body = {
      status: 200,
      data: {
        Offers: [
          { OfferID: 'A-L1', Cost: { [VP]: 1775 }, Rewards: [{ ItemTypeID: SKIN, ItemID: 'A-L1', Quantity: 1 }] },
          { OfferID: 'buddy', Cost: { [VP]: 475 }, Rewards: [{ ItemTypeID: 'dd3bf334-87f3-40bd-b043-682a57a8dc3a', ItemID: 'B1', Quantity: 1 }] },
          { OfferID: 'free', Cost: { [VP]: 0 }, Rewards: [{ ItemTypeID: SKIN, ItemID: 'free-l1' }] },
          { OfferID: 'kc', Cost: { 'other-currency': 10 }, Rewards: [{ ItemTypeID: SKIN, ItemID: 'kc-l1' }] },
        ],
      },
    };
    expect(parseOffers(body)).toEqual({ levels: { 'a-l1': 1775 }, skins: {} });
  });
  it('parses the v2 (flattened) shape and rejects anything else', () => {
    expect(parseOffers({ data: [{ offer_id: 'B-L1', cost: 4350, type: 'skin_level', skin_id: 'b' }, { offer_id: 'x', cost: 9, type: 'buddy' }] })).toEqual({ levels: { 'b-l1': 4350 }, skins: { b: 4350 } });
    expect(parseOffers({ errors: [{ message: 'Unauthorized', status: 401 }] })).toBeNull();
    expect(parseOffers({ data: { Offers: [] } })).toBeNull();
    expect(parseOffers(null)).toBeNull();
  });
  it('maps level offers to skins by first level, and reports coverage without contract rewards', () => {
    const bySkin = pricesBySkin({ levels: { 'a-l1': 1875 }, skins: { b: 4350 } }, catalog.skins);
    expect(bySkin).toEqual({ a: 1875, b: 4350 });
    const cov = offersCoverage(catalog.skins, bySkin);
    expect(cov).toMatchObject({ total: 3, priced: 2 }); // d is a battle pass reward
    expect(cov.missing.map((m) => m.id)).toEqual(['c']);
  });
});
