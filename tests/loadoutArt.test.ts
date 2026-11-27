import { describe, expect, it } from 'vitest';
import { gunArt, isTopLevel, levelIndex, moveToLevel, type GunRenderCheck } from '../shared/loadoutArt';
import type { CatalogSkin, CatalogWeapon, LoadoutGun } from '../shared/features';

const weapon: CatalogWeapon = { id: 'vandal', name: 'Vandal', category: 'Rifle', icon: 'vandal.png', defaultSkin: { id: 'std', levelId: 'std-l1', chromaId: 'std-c0', icon: 'standard.png' } };

/** Shaped like Prime Vandal: levels 2-4 use effect stills (540x240 / 240x240) as icons, four variants. */
const prime: CatalogSkin = {
  id: 'prime',
  name: 'Prime Vandal',
  weaponId: 'vandal',
  icon: 'prime.png',
  order: 0,
  firstSeen: 0,
  levels: [
    { id: 'p1', name: 'L1', icon: 'prime-l1.png' },
    { id: 'p2', name: 'L2', item: 'VFX', icon: 'prime-l2-still.png' },
    { id: 'p3', name: 'L3', item: 'Animation', icon: 'prime-l3-still.png' },
    { id: 'p4', name: 'L4', item: 'Finisher', icon: 'prime-l4-still.png' },
  ],
  chromas: [
    { id: 'pc0', name: 'Base', render: 'prime-c0.png' },
    { id: 'pc1', name: 'Variant 1', render: 'prime-c1.png' },
    { id: 'pc2', name: 'Variant 2', render: 'prime-c2.png' },
    { id: 'pc3', name: 'Variant 3', render: 'prime-c3.png' },
  ],
};

/** Shaped like Glitchpop Bulldog: every level has its own gun render. */
const glitch: CatalogSkin = {
  ...prime,
  id: 'glitch',
  name: 'Glitchpop Bulldog',
  levels: [
    { id: 'g1', name: 'L1', icon: 'glitch-l1.png' },
    { id: 'g2', name: 'L2', item: 'VFX', icon: 'glitch-l2.png' },
    { id: 'g3', name: 'L3', item: 'VFX', icon: 'glitch-l3.png' },
    { id: 'g4', name: 'L4', item: 'Finisher', icon: 'glitch-l4.png' },
  ],
  chromas: [
    { id: 'gc0', name: 'Base', render: 'glitch-c0.png' },
    { id: 'gc1', name: 'Variant 1', render: 'glitch-c1.png' },
  ],
};

const measured: GunRenderCheck = (url) => !url.includes('still');

type Gun = Pick<LoadoutGun, 'skinLevelId' | 'chromaId'>;

/** Clicks level buttons in order, like the Loadout screen, and returns the art shown after each click. */
function clickLevels(skin: CatalogSkin, start: Gun, clicks: number[], isGun: GunRenderCheck = measured): string[] {
  let gun = { ...start };
  let held: string | undefined;
  return clicks.map((li) => {
    const r = moveToLevel(skin, gun, li, held);
    held = r.held;
    gun = { ...gun, ...r.patch };
    return gunArt(weapon, skin, gun, isGun) ?? '';
  });
}

/** Every sequence of `n` clicks over the skin's levels. */
function sequences(levels: number, n: number): number[][] {
  if (n === 0) return [[]];
  return sequences(levels, n - 1).flatMap((s) => Array.from({ length: levels }, (_, li) => [...s, li]));
}

describe('loadout level art', () => {
  it('level 4 keeps showing the equipped variant after visiting a lower level (top → 2 → top)', () => {
    const start = { skinLevelId: 'p4', chromaId: 'pc2' };
    expect(clickLevels(prime, start, [3, 1, 3])).toEqual(['prime-c2.png', 'prime-l1.png', 'prime-c2.png']);
  });

  it('every level shows the same art whatever order the levels are clicked in', () => {
    for (const [skin, start, want] of [
      // Variant equipped: the top level is the variant, lower levels their own (or nearest real) render.
      [prime, { skinLevelId: 'p4', chromaId: 'pc2' }, ['prime-l1.png', 'prime-l1.png', 'prime-l1.png', 'prime-c2.png']],
      // Base variant: effect stills never show, so every Prime level falls back to the base gun.
      [prime, { skinLevelId: 'p1', chromaId: 'pc0' }, ['prime-l1.png', 'prime-l1.png', 'prime-l1.png', 'prime-l1.png']],
      [glitch, { skinLevelId: 'g1', chromaId: 'gc0' }, ['glitch-l1.png', 'glitch-l2.png', 'glitch-l3.png', 'glitch-l4.png']],
      [glitch, { skinLevelId: 'g4', chromaId: 'gc1' }, ['glitch-l1.png', 'glitch-l2.png', 'glitch-l3.png', 'glitch-c1.png']],
    ] as const) {
      for (const clicks of sequences(skin.levels.length, 5)) {
        const shown = clickLevels(skin, start, clicks);
        clicks.forEach((li, k) => expect(shown[k], `${skin.name} after clicks ${clicks.slice(0, k + 1).join('→')}`).toBe(want[li]));
      }
    }
  });

  it('below the top level the gun is on the base variant (what gets applied to Riot)', () => {
    let gun: Gun = { skinLevelId: 'p4', chromaId: 'pc3' };
    const down = moveToLevel(prime, gun, 1, undefined);
    gun = { ...gun, ...down.patch };
    expect(gun).toEqual({ skinLevelId: 'p2', chromaId: 'pc0' });
    expect(down.held).toBe('pc3');
    // Moving between lower levels keeps the parked variant.
    const across = moveToLevel(prime, gun, 2, down.held);
    expect(across.patch).toEqual({ skinLevelId: 'p3', chromaId: 'pc0' });
    expect(across.held).toBe('pc3');
    const up = moveToLevel(prime, { ...gun, ...across.patch }, 3, across.held);
    expect(up.patch).toEqual({ skinLevelId: 'p4', chromaId: 'pc3' });
    expect(up.held).toBeUndefined();
  });

  it('a parked variant from another skin is ignored', () => {
    expect(moveToLevel(prime, { chromaId: 'pc0' }, 3, 'gc1').patch).toEqual({ skinLevelId: 'p4' });
    expect(moveToLevel(prime, { chromaId: 'pc0' }, 1, 'gc1').held).toBeUndefined();
  });

  it('falls back to the nearest lower real render while an icon is still being measured', () => {
    const pending: GunRenderCheck = (url) => (url === 'glitch-l4.png' ? null : true);
    expect(gunArt(weapon, glitch, { skinLevelId: 'g4', chromaId: 'gc0' }, pending)).toBe('glitch-l3.png');
    expect(gunArt(weapon, glitch, { skinLevelId: 'g4', chromaId: 'gc0' }, () => null)).toBe('glitch-l1.png');
  });

  it('ignores a variant below the top level, an unknown level, and no skin', () => {
    expect(gunArt(weapon, glitch, { skinLevelId: 'g2', chromaId: 'gc1' }, measured)).toBe('glitch-l2.png');
    expect(gunArt(weapon, glitch, { skinLevelId: 'nope', chromaId: 'gc0' }, measured)).toBe('glitch-l1.png');
    expect(gunArt(weapon, undefined, undefined, measured)).toBe('standard.png');
    expect(levelIndex(glitch, 'nope')).toBe(0);
    expect(isTopLevel(glitch, 3)).toBe(true);
    expect(isTopLevel(glitch, 2)).toBe(false);
  });
});
