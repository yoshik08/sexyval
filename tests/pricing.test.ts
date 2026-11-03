import { describe, expect, it } from 'vitest';
import { buildPriceMap, describeQuote, prettyContractName, quoteFor, sourceLabel, typicalPrice } from '../shared/pricing';
import { skinSourcesFromContracts } from '../main/services/catalog';
import { PriceBook } from '../main/services/prices';
import type { Catalog, CatalogSkin } from '../shared/features';
import type { ShopView } from '../shared/types';

const tiers = [
  { id: 't-sel', name: 'Select', rank: 0 },
  { id: 't-pre', name: 'Premium', rank: 2 },
  { id: 't-ult', name: 'Ultra', rank: 4 },
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

describe('typical prices', () => {
  it('uses the standard gun ladder and doubles it for melee', () => {
    expect(typicalPrice('Rifle', 'Select')).toBe(875);
    expect(typicalPrice('Sniper', 'Deluxe')).toBe(1275);
    expect(typicalPrice('Rifle', 'Premium')).toBe(1775);
    expect(typicalPrice('Rifle', 'Exclusive')).toBe(2175);
    expect(typicalPrice('Rifle', 'Ultra')).toBe(2475);
    expect(typicalPrice('Melee', 'Premium')).toBe(3550);
    expect(typicalPrice('Melee', 'Ultra')).toBe(4950);
  });
  it('returns nothing for an unknown tier rather than guessing', () => {
    expect(typicalPrice('Rifle', 'Mythic')).toBeUndefined();
    expect(typicalPrice('Rifle', undefined)).toBeUndefined();
  });
});

describe('quotes: every skin gets an answer', () => {
  it('prefers exact, then contract reward, then typical', () => {
    const observed = { a: { vp: 1675, at: 1 }, d: { vp: 999, at: 2 } };
    expect(quoteFor(catalog.skins[0], catalog, observed)).toMatchObject({ kind: 'exact', vp: 1675 });
    expect(quoteFor(catalog.skins[1], catalog, observed)).toMatchObject({ kind: 'typical', vp: 4950 }); // melee Ultra
    expect(quoteFor(catalog.skins[2], catalog, {})).toMatchObject({ kind: 'typical', vp: 875 });
    expect(quoteFor(catalog.skins[3], catalog, {})).toMatchObject({ kind: 'reward', label: 'Battle Pass · Dimension Act 2' });
    expect(quoteFor(catalog.skins[3], catalog, observed).kind).toBe('exact'); // if the store ever sells it, believe the store
  });
  it('builds a map covering the whole catalog', () => {
    const map = buildPriceMap(catalog, {});
    expect(Object.keys(map).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('never renders the word "unknown"', () => {
    for (const q of Object.values(buildPriceMap(catalog, {}))) {
      const d = describeQuote(q);
      expect(`${d.primary} ${d.secondary ?? ''}`.toLowerCase()).not.toContain('unknown');
    }
    expect(describeQuote({ kind: 'typical', vp: 1775 })).toEqual({ primary: '≈ 1,775', secondary: 'VP', estimate: true });
    expect(describeQuote({ kind: 'exact', vp: 1775 })).toEqual({ primary: '1,775', secondary: 'VP', estimate: false });
    expect(describeQuote({ kind: 'typical' }).primary).toBe('Not sold separately');
    const reward = describeQuote({ kind: 'reward', label: 'Battle Pass · Season 2026 Act III', source: 'battlepass' });
    expect(reward).toMatchObject({ primary: 'Battle Pass · Season 2026 Act III', short: 'Battle Pass', estimate: false });
    expect(describeQuote({ kind: 'reward', label: 'Gekko Gear · Level 10', source: 'agent' }).short).toBe('Agent gear');
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
