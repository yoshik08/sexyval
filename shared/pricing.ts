import type { Catalog, CatalogSkin, PriceMap, PriceQuote, SkinSource } from './features';

/**
 * Riot no longer serves a full price list (`store/v1/offers` returns 404; the client learns prices
 * from the storefront it is shown). So prices come from three layers, best first:
 *   1. exact   - observed in the live store and remembered on disk
 *   2. reward  - the skin is a contract reward and is not sold
 *   3. typical - the standard price of its tier, flagged as an estimate
 */

/** Standard list prices per tier. Guns are the base; melee costs about double. */
const GUN_PRICE: Record<string, number> = { Select: 875, Deluxe: 1275, Premium: 1775, Exclusive: 2175, Ultra: 2475 };
const MELEE_PRICE: Record<string, number> = { Select: 1750, Deluxe: 2550, Premium: 3550, Exclusive: 4350, Ultra: 4950 };

export function typicalPrice(category: string | undefined, tierName: string | undefined): number | undefined {
  if (!tierName) return undefined;
  const table = category === 'Melee' ? MELEE_PRICE : GUN_PRICE;
  return table[tierName];
}

const SMALL = new Set(['of', 'the', 'and', 'a', 'in']);

/** 'DIMENSION: ACT 2' -> 'Dimension Act 2', 'SEASON 2025 // ACT VI' -> 'Season 2025 Act VI'. */
export function prettyContractName(raw: string): string {
  const words = raw
    .replace(/\s*(?::|\/\/)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ');
  return words
    .map((w, i) => {
      // Roman numerals only follow "Act" (Act VI); anywhere else "I"/"V" are ordinary words.
      if (words[i - 1] === 'act' && /^(?:i{1,3}|iv|vi{0,3}|ix|x{1,3})$/.test(w)) return w.toUpperCase();
      return i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

export function sourceLabel(src: SkinSource): string {
  const name = prettyContractName(src.name);
  if (src.kind === 'battlepass') return `Battle Pass · ${name}`;
  if (src.kind === 'event') return `Event Pass · ${name}`;
  return `${name} · Level ${src.level}`;
}

/** A price observed in the live store, remembered between sessions. */
export interface ObservedPrice {
  vp: number;
  at: number;
}

export function quoteFor(skin: CatalogSkin, catalog: Pick<Catalog, 'tiers' | 'weapons'>, observed: Record<string, ObservedPrice>): PriceQuote {
  const seen = observed[skin.id];
  if (seen && seen.vp > 0) return { kind: 'exact', vp: seen.vp, seenAt: seen.at };
  if (skin.source) return { kind: 'reward', label: sourceLabel(skin.source), source: skin.source.kind };
  const tier = catalog.tiers.find((t) => t.id === skin.tierId)?.name;
  const category = catalog.weapons.find((w) => w.id === skin.weaponId)?.category;
  const vp = typicalPrice(category, tier);
  return vp ? { kind: 'typical', vp } : { kind: 'typical' };
}

export function buildPriceMap(catalog: Pick<Catalog, 'skins' | 'tiers' | 'weapons'>, observed: Record<string, ObservedPrice>): PriceMap {
  const out: PriceMap = {};
  for (const s of catalog.skins) out[s.id] = quoteFor(s, catalog, observed);
  return out;
}

const SHORT: Record<NonNullable<PriceQuote['source']>, string> = { battlepass: 'Battle Pass', event: 'Event Pass', agent: 'Agent gear' };

/** Display strings. Never says "unknown": a quote always has a number or a reason. */
export function describeQuote(q: PriceQuote | undefined): { primary: string; secondary?: string; short?: string; estimate: boolean } {
  if (!q) return { primary: '—', estimate: false };
  if (q.kind === 'reward') return { primary: q.label ?? 'Contract reward', short: q.source ? SHORT[q.source] : 'Reward', estimate: false };
  if (q.vp == null) return { primary: 'Not sold separately', estimate: false };
  const n = q.vp.toLocaleString('en-US');
  return q.kind === 'exact' ? { primary: n, secondary: 'VP', estimate: false } : { primary: `≈ ${n}`, secondary: 'VP', estimate: true };
}
