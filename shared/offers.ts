// Store offers from the HenrikDev API (unofficial, third party). Two response shapes are accepted:
//   v1: Riot's legacy store/v1/offers body: data.Offers[] { OfferID, Cost{currency: n}, Rewards[] { ItemTypeID, ItemID } }
//   v2: a flattened array: data[] { offer_id, cost, type: 'skin_level', skin_id? }
// HenrikDev's own spec now says this endpoint "unconditionally returns 404 (RiotImplementationRemoved)";
// the parser stays so prices come back by themselves if it is ever restored.

export const VP_CURRENCY = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
export const SKIN_LEVEL_TYPE = 'e7c63390-eda7-46e0-bb7a-a6abdacd2433';

export interface ParsedOffers {
  /** Skin level uuid (lowercase) -> VP. */
  levels: Record<string, number>;
  /** Skin uuid (lowercase) -> VP, when the response names the skin directly (v2 skin_id). */
  skins: Record<string, number>;
}

const lc = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');
const vp = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/** Returns null when the body matches neither shape (or holds no skin offers). */
export function parseOffers(body: any): ParsedOffers | null {
  const data = body?.data ?? body;
  const out: ParsedOffers = { levels: {}, skins: {} };
  if (Array.isArray(data?.Offers)) {
    for (const o of data.Offers) {
      const cost = vp(o?.Cost?.[VP_CURRENCY]);
      if (!cost) continue;
      for (const r of Array.isArray(o?.Rewards) ? o.Rewards : []) {
        if (lc(r?.ItemTypeID) === SKIN_LEVEL_TYPE && lc(r?.ItemID)) out.levels[lc(r.ItemID)] = cost;
      }
    }
  } else if (Array.isArray(data)) {
    for (const o of data) {
      if (o?.type !== 'skin_level') continue;
      const cost = vp(o?.cost);
      if (!cost) continue;
      if (lc(o?.offer_id)) out.levels[lc(o.offer_id)] = cost;
      if (lc(o?.skin_id)) out.skins[lc(o.skin_id)] = cost;
    }
  } else {
    return null;
  }
  return Object.keys(out.levels).length || Object.keys(out.skins).length ? out : null;
}

/** Skin id -> VP. A skin's offer is its first level (that is what the store sells). */
export function pricesBySkin(offers: ParsedOffers, skins: { id: string; levels: { id: string }[] }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of skins) {
    const v = offers.skins[s.id] ?? offers.levels[lc(s.levels[0]?.id)];
    if (v) out[s.id] = v;
  }
  return out;
}

/** Which store skins (contract rewards excluded) got a price, and which did not. */
export function offersCoverage(skins: { id: string; name: string; source?: unknown }[], bySkin: Record<string, number>): { total: number; priced: number; missing: { id: string; name: string }[] } {
  const sellable = skins.filter((s) => !s.source);
  const missing = sellable.filter((s) => !bySkin[s.id]).map((s) => ({ id: s.id, name: s.name }));
  return { total: sellable.length, priced: sellable.length - missing.length, missing };
}
