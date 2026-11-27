// Loadout: what a gun looks like at the level and variant it is on, and how level/variant picks change it.
// Pure on purpose (the renderer injects the image measurement), so tests can drive click orders.
import type { CatalogSkin, CatalogWeapon, LoadoutGun } from './features';

/** Equipped level index (0 when the level id is unknown). */
export const levelIndex = (s: CatalogSkin, levelId: string | undefined): number => Math.max(0, s.levels.findIndex((l) => l.id === levelId));
export const isTopLevel = (s: CatalogSkin, li: number): boolean => li >= s.levels.length - 1;

/**
 * Some skins (Prime, Oni, Sovereign...) use a still of the level's effect as its icon instead of the gun.
 * Those are always exactly these sizes; every gun render is sized otherwise (checked against all 513
 * upgraded-level icons on valorant-api.com). Size is readable cross-origin, pixels are not.
 */
export const EFFECT_STILL = new Set(['540x240', '240x240']);

/** true: the icon is a gun render; false: an effect still or broken; null: not measured yet. */
export type GunRenderCheck = (url: string) => boolean | null;

/**
 * What the gun looks like at the level it is on. Variants only exist at the top level (as in game),
 * and a chroma render is always the fully upgraded look, so below the top level we use that level's
 * own art, falling back to the nearest lower level that has a real gun render, then the base look.
 */
export function gunArt(w: CatalogWeapon, s: CatalogSkin | undefined, g: Pick<LoadoutGun, 'skinLevelId' | 'chromaId'> | undefined, isGunRender: GunRenderCheck): string | undefined {
  if (!s) return w.defaultSkin?.icon ?? w.icon;
  const li = levelIndex(s, g?.skinLevelId);
  const ci = s.chromas.findIndex((c) => c.id === g?.chromaId);
  if (ci > 0 && isTopLevel(s, li)) {
    const c = s.chromas[ci];
    return c.render ?? c.icon ?? s.icon;
  }
  for (let i = li; i > 0; i--) {
    const icon = s.levels[i]?.icon;
    if (icon && isGunRender(icon) === true) return icon;
  }
  return s.levels[0]?.icon ?? s.icon ?? s.chromas[0]?.render;
}

/** The gun's variant when it is one (not the base look) of this skin. */
function variantOf(s: CatalogSkin, chromaId: string | undefined): string | undefined {
  const i = s.chromas.findIndex((c) => c.id === chromaId);
  return i > 0 ? s.chromas[i].id : undefined;
}

/**
 * Moving a gun to level `li`. Below the top level only the base variant exists (as in game), so going
 * down puts the gun on the base variant and hands its variant back as `held`; landing on the top level
 * again puts the held variant back. Without this, top → lower → top silently lost the variant and the
 * top level showed the base look instead of what was equipped.
 */
export function moveToLevel(s: CatalogSkin, g: Pick<LoadoutGun, 'chromaId'>, li: number, held: string | undefined): { patch: Partial<LoadoutGun>; held: string | undefined } {
  const patch: Partial<LoadoutGun> = { skinLevelId: s.levels[li].id };
  const current = variantOf(s, g.chromaId);
  if (!isTopLevel(s, li)) {
    if (s.chromas[0]) patch.chromaId = s.chromas[0].id;
    return { patch, held: current ?? variantOf(s, held) };
  }
  const back = current ?? variantOf(s, held);
  if (back) patch.chromaId = back;
  return { patch, held: undefined };
}
