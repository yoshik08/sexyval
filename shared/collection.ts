import type { CatalogExtra, CatalogSkin, CatalogTier, SkinFilter } from './features';

/**
 * Parses Owned Items. Docs (valorant-api-types OwnedItems.ts) give
 * { EntitlementsByTypes: [{ ItemTypeID, Entitlements: [{ TypeID, ItemID, InstanceID? }] }] };
 * some clients see the flat { ItemTypeID, Entitlements: [...] } for a single type. Accept both.
 */
export function parseOwnedItems(json: any, itemTypeId: string): { items: { itemId: string; instanceId?: string }[]; shape: string } {
  const out: { itemId: string; instanceId?: string }[] = [];
  const push = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const e of list) {
      const itemId = (e as any)?.ItemID;
      if (typeof itemId === 'string' && itemId) out.push({ itemId: itemId.toLowerCase(), instanceId: typeof (e as any)?.InstanceID === 'string' ? (e as any).InstanceID : undefined });
    }
  };
  if (Array.isArray(json?.EntitlementsByTypes)) {
    for (const g of json.EntitlementsByTypes) {
      if (!g || (g.ItemTypeID && String(g.ItemTypeID).toLowerCase() !== itemTypeId.toLowerCase())) continue;
      push(g.Entitlements);
    }
    return { items: out, shape: 'EntitlementsByTypes' };
  }
  if (Array.isArray(json?.Entitlements)) {
    push(json.Entitlements);
    return { items: out, shape: 'Entitlements' };
  }
  return { items: out, shape: 'unknown' };
}

export interface OwnedSets {
  levels: Set<string>;
  chromas: Set<string>;
}

/** A skin counts as owned when its level 1 (base) is owned. */
export function isSkinOwned(skin: Pick<CatalogSkin, 'levels'>, owned: OwnedSets): boolean {
  const base = skin.levels[0]?.id;
  return !!base && owned.levels.has(base.toLowerCase());
}

/** Level i owned: level 1 follows the skin; others need their own entitlement. */
export function levelOwned(skin: CatalogSkin, index: number, owned: OwnedSets): boolean {
  const l = skin.levels[index];
  if (!l) return false;
  return owned.levels.has(l.id.toLowerCase());
}

/** Chroma 0 is the base look and comes with the skin; variants need a Skin Variant entitlement. */
export function chromaOwned(skin: CatalogSkin, index: number, owned: OwnedSets): boolean {
  const c = skin.chromas[index];
  if (!c) return false;
  if (index === 0) return isSkinOwned(skin, owned);
  return owned.chromas.has(c.id.toLowerCase());
}

export function extraOwned(item: CatalogExtra, owned: Set<string>): boolean {
  return item.ownIds.some((id) => owned.has(id.toLowerCase()));
}

export function tierRank(tiers: CatalogTier[], tierId?: string): number {
  return tiers.find((t) => t.id === tierId)?.rank ?? -1;
}

export function filterSkins(skins: CatalogSkin[], f: SkinFilter, owned: OwnedSets | null, tiers: CatalogTier[]): CatalogSkin[] {
  const q = (f.search ?? '').trim().toLowerCase();
  const out = skins.filter((s) => {
    if (f.weaponId && s.weaponId !== f.weaponId) return false;
    if (f.tierId && s.tierId !== f.tierId) return false;
    if (f.themeId && s.themeId !== f.themeId) return false;
    if (q && !s.name.toLowerCase().includes(q)) return false;
    if (owned && f.owned !== 'all') {
      const o = isSkinOwned(s, owned);
      if (f.owned === 'owned' ? !o : o) return false;
    }
    return true;
  });
  const byName = (a: CatalogSkin, b: CatalogSkin) => a.name.localeCompare(b.name);
  const byTier = (x: CatalogSkin, y: CatalogSkin) => tierRank(tiers, y.tierId) - tierRank(tiers, x.tierId) || byName(x, y);
  // Owned first (when ownership is known), then the usual tier order.
  if (f.sort === 'owned') out.sort((x, y) => Number(owned ? isSkinOwned(y, owned) : 0) - Number(owned ? isSkinOwned(x, owned) : 0) || byTier(x, y));
  else if (f.sort === 'name') out.sort(byName);
  else if (f.sort === 'tier') out.sort(byTier);
  // "newest": no release date exists in the catalog. Approximation: first time SexyVal saw the
  // skin, then catalog order (newer skins tend to be listed first per weapon).
  else out.sort((a, b) => b.firstSeen - a.firstSeen || a.order - b.order);
  return out;
}

export function filterExtras(items: CatalogExtra[], f: { owned: SkinFilter['owned']; search?: string }, owned: Set<string> | null): CatalogExtra[] {
  const q = (f.search ?? '').trim().toLowerCase();
  return items.filter((i) => {
    if (q && !i.name.toLowerCase().includes(q) && !(i.text ?? '').toLowerCase().includes(q)) return false;
    if (owned && f.owned !== 'all') {
      const o = extraOwned(i, owned);
      if (f.owned === 'owned' ? !o : o) return false;
    }
    return true;
  });
}

export interface Counter {
  owned: number;
  total: number;
}

/** Owned/total overall, per weapon and per collection (theme). */
export function countSkins(skins: CatalogSkin[], owned: OwnedSets | null): { all: Counter; byWeapon: Record<string, Counter>; byTheme: Record<string, Counter> } {
  const all: Counter = { owned: 0, total: 0 };
  const byWeapon: Record<string, Counter> = {};
  const byTheme: Record<string, Counter> = {};
  for (const s of skins) {
    const o = owned ? isSkinOwned(s, owned) : false;
    const w = (byWeapon[s.weaponId] ??= { owned: 0, total: 0 });
    all.total++;
    w.total++;
    if (o) {
      all.owned++;
      w.owned++;
    }
    if (s.themeId) {
      const t = (byTheme[s.themeId] ??= { owned: 0, total: 0 });
      t.total++;
      if (o) t.owned++;
    }
  }
  return { all, byWeapon, byTheme };
}

/** First level/chroma with a video, used for card hover previews. */
export function previewVideo(skin: CatalogSkin): string | undefined {
  return skin.levels.find((l) => l.video)?.video ?? skin.chromas.find((c) => c.video)?.video;
}

/** Index of skins by any level/chroma id -> skin id (shop offers use level ids). */
export function skinIndex(skins: CatalogSkin[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of skins) {
    m.set(s.id.toLowerCase(), s.id);
    for (const l of s.levels) m.set(l.id.toLowerCase(), s.id);
    for (const c of s.chromas) m.set(c.id.toLowerCase(), s.id);
  }
  return m;
}
