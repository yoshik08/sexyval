import { describe, expect, it } from 'vitest';
import { chromaOwned, countSkins, extraOwned, filterExtras, filterSkins, isSkinOwned, levelOwned, parseOwnedItems, previewVideo, skinIndex } from '../shared/collection';
import type { CatalogExtra, CatalogSkin, CatalogTier } from '../shared/features';

const tiers: CatalogTier[] = [
  { id: 'select', name: 'Select', rank: 0 },
  { id: 'premium', name: 'Premium', rank: 2 },
  { id: 'ultra', name: 'Ultra', rank: 4 },
];

// Sample skins with and without videos.
const skin = (id: string, name: string, weaponId: string, tierId: string, themeId: string, opts: { video?: boolean; firstSeen?: number; order?: number } = {}): CatalogSkin => ({
  id,
  name,
  weaponId,
  tierId,
  themeId,
  order: opts.order ?? 0,
  firstSeen: opts.firstSeen ?? 0,
  levels: [
    { id: `${id}-l1`, name: `${name}`, video: opts.video ? `https://cdn/${id}-l1.mp4` : undefined },
    { id: `${id}-l2`, name: `${name} Level 2`, item: 'Animation', video: opts.video ? `https://cdn/${id}-l2.mp4` : undefined },
  ],
  chromas: [
    { id: `${id}-c0`, name: name },
    { id: `${id}-c1`, name: `${name} Variant 1`, video: opts.video ? `https://cdn/${id}-c1.mp4` : undefined },
  ],
});

const skins = [
  skin('a', 'Prime Vandal', 'vandal', 'premium', 'prime', { video: true, order: 0, firstSeen: 100 }),
  skin('b', 'Prime Spectre', 'spectre', 'premium', 'prime', { video: true, order: 1, firstSeen: 100 }),
  skin('c', 'Basic Vandal', 'vandal', 'select', 'basic', { order: 2, firstSeen: 300 }),
  skin('d', 'Zenith Phantom', 'phantom', 'ultra', 'zenith', { video: true, order: 3, firstSeen: 200 }),
];

const owned = { levels: new Set(['a-l1', 'a-l2', 'c-l1', 'b-l2']), chromas: new Set(['a-c1']) };

describe('owned state', () => {
  it('a skin is owned when level 1 is owned', () => {
    expect(isSkinOwned(skins[0], owned)).toBe(true);
    expect(isSkinOwned(skins[2], owned)).toBe(true);
    // level 2 alone does not make the skin owned
    expect(isSkinOwned(skins[1], owned)).toBe(false);
    expect(isSkinOwned(skins[3], owned)).toBe(false);
  });
  it('tracks levels and chromas separately', () => {
    expect(levelOwned(skins[0], 1, owned)).toBe(true);
    expect(levelOwned(skins[2], 1, owned)).toBe(false);
    expect(chromaOwned(skins[0], 0, owned)).toBe(true); // base chroma comes with the skin
    expect(chromaOwned(skins[0], 1, owned)).toBe(true);
    expect(chromaOwned(skins[2], 1, owned)).toBe(false);
    expect(chromaOwned(skins[3], 0, owned)).toBe(false);
  });
  it('counts overall, per weapon and per collection', () => {
    const c = countSkins(skins, owned);
    expect(c.all).toEqual({ owned: 2, total: 4 });
    expect(c.byWeapon.vandal).toEqual({ owned: 2, total: 2 });
    expect(c.byWeapon.spectre).toEqual({ owned: 0, total: 1 });
    expect(c.byTheme.prime).toEqual({ owned: 1, total: 2 });
    expect(countSkins(skins, null).all).toEqual({ owned: 0, total: 4 });
  });
  it('extras: owned via item id or any level id', () => {
    const buddy: CatalogExtra = { kind: 'buddy', id: 'bud', name: 'Buddy', ownIds: ['bud', 'bud-l1'] };
    expect(extraOwned(buddy, new Set(['bud-l1']))).toBe(true);
    expect(extraOwned(buddy, new Set(['other']))).toBe(false);
  });
});

describe('filters and sort', () => {
  it('owned / not owned', () => {
    expect(filterSkins(skins, { owned: 'owned', sort: 'name' }, owned, tiers).map((s) => s.id)).toEqual(['c', 'a']);
    expect(filterSkins(skins, { owned: 'not-owned', sort: 'name' }, owned, tiers).map((s) => s.id)).toEqual(['b', 'd']);
    // without owned data the owned filter is ignored
    expect(filterSkins(skins, { owned: 'owned', sort: 'name' }, null, tiers)).toHaveLength(4);
  });
  it('weapon, tier, collection and search', () => {
    expect(filterSkins(skins, { owned: 'all', sort: 'name', weaponId: 'vandal' }, owned, tiers).map((s) => s.id)).toEqual(['c', 'a']);
    expect(filterSkins(skins, { owned: 'all', sort: 'name', tierId: 'premium' }, owned, tiers).map((s) => s.id)).toEqual(['b', 'a']);
    expect(filterSkins(skins, { owned: 'all', sort: 'name', themeId: 'zenith' }, owned, tiers).map((s) => s.id)).toEqual(['d']);
    expect(filterSkins(skins, { owned: 'all', sort: 'name', search: '  prime ' }, owned, tiers).map((s) => s.id)).toEqual(['b', 'a']);
  });
  it('sorts by tier (high first), name, and newest (first seen, then catalog order)', () => {
    expect(filterSkins(skins, { owned: 'all', sort: 'tier' }, null, tiers).map((s) => s.id)).toEqual(['d', 'b', 'a', 'c']);
    expect(filterSkins(skins, { owned: 'all', sort: 'newest' }, null, tiers).map((s) => s.id)).toEqual(['c', 'd', 'a', 'b']);
  });
  it('filters extras by owned and search (titles match text)', () => {
    const titles: CatalogExtra[] = [
      { kind: 'title', id: 't1', name: 'Tiger', text: 'Tiger', ownIds: ['t1'] },
      { kind: 'title', id: 't2', name: 'Duelist', text: 'Duelist', ownIds: ['t2'] },
    ];
    expect(filterExtras(titles, { owned: 'owned' }, new Set(['t2'])).map((t) => t.id)).toEqual(['t2']);
    expect(filterExtras(titles, { owned: 'all', search: 'tig' }, null).map((t) => t.id)).toEqual(['t1']);
  });
  it('preview video and skin index', () => {
    expect(previewVideo(skins[0])).toBe('https://cdn/a-l1.mp4');
    expect(previewVideo(skins[2])).toBeUndefined(); // skin without any video
    const idx = skinIndex(skins);
    expect(idx.get('a-l2')).toBe('a');
    expect(idx.get('d-c1')).toBe('d');
  });
});

describe('owned items response shapes', () => {
  const type = 'e7c63390-eda7-46e0-bb7a-a6abdacd2433';
  it('docs shape: EntitlementsByTypes', () => {
    const r = parseOwnedItems({ EntitlementsByTypes: [{ ItemTypeID: type, Entitlements: [{ TypeID: 'x', ItemID: 'ABC' }, { TypeID: 'x', ItemID: 'def', InstanceID: 'i1' }] }] }, type);
    expect(r.shape).toBe('EntitlementsByTypes');
    expect(r.items).toEqual([{ itemId: 'abc', instanceId: undefined }, { itemId: 'def', instanceId: 'i1' }]);
  });
  it('ignores other item types in EntitlementsByTypes', () => {
    const r = parseOwnedItems({ EntitlementsByTypes: [{ ItemTypeID: 'other', Entitlements: [{ ItemID: 'zzz' }] }, { ItemTypeID: type, Entitlements: [{ ItemID: 'yes' }] }] }, type);
    expect(r.items.map((i) => i.itemId)).toEqual(['yes']);
  });
  it('flat shape: { ItemTypeID, Entitlements }', () => {
    expect(parseOwnedItems({ ItemTypeID: type, Entitlements: [{ ItemID: 'q' }] }, type)).toEqual({ items: [{ itemId: 'q', instanceId: undefined }], shape: 'Entitlements' });
  });
  it('unknown/garbage', () => {
    expect(parseOwnedItems(null, type)).toEqual({ items: [], shape: 'unknown' });
    expect(parseOwnedItems({ Entitlements: [null, { ItemID: 5 }] }, type).items).toEqual([]);
  });
});
