import type { Catalog, CatalogSkin, PriceMap, PriceQuote, SkinSource } from './features';

/**
 * Riot no longer serves a full price list (`store/v1/offers` returns 404; the client learns prices
 * from the storefront it is shown). Prices come from these layers, best first:
 *   1. exact (store)  - seen in your own store and remembered on disk (prices.json)
 *   2. exact (offers) - HenrikDev store offers, cached per game version (offers.json)
 *   3. exact (list)   - the bundled price list scraped from the Valorant wiki (shared/data/skin-prices.json)
 *   4. reward         - the skin is a contract reward and is not sold
 *   5. approx         - newer skins: its collection's price, else its edition's usual price, shown with ≈
 *   6. none           - nothing to go on; the UI says so in words
 */

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

/** Store-offer prices by skin id, and whether a complete offers list was loaded at all. */
export interface OfferPrices {
  bySkin: Record<string, number>;
  loaded: boolean;
}

export const NO_OFFERS: OfferPrices = { bySkin: {}, loaded: false };

/** The bundled price list (shared/data/skin-prices.json, built by scripts/scrape-prices.mjs). */
export interface PriceList {
  /** YYYY-MM-DD the list was built. */
  date: string;
  prices: Record<string, number>;
}

export const NO_LIST: PriceList = { date: '', prices: {} };

/** A known price (store, offers, list) or null. */
function knownQuote(skin: CatalogSkin, observed: Record<string, ObservedPrice>, offers: OfferPrices, list: PriceList): PriceQuote | null {
  const seen = observed[skin.id];
  if (seen && seen.vp > 0) return { kind: 'exact', vp: seen.vp, seenAt: seen.at, source: 'store' };
  const offer = offers.bySkin[skin.id];
  if (offer && offer > 0) return { kind: 'exact', vp: offer, source: 'offers' };
  const listed = list.prices[skin.id];
  if (listed && listed > 0) return { kind: 'exact', vp: listed, source: 'list', seenAt: Date.parse(list.date) || undefined };
  return null;
}

/** Single-skin quote without approximation (approximations need the whole catalog: see buildPriceMap). */
export function quoteFor(skin: CatalogSkin, observed: Record<string, ObservedPrice>, offers: OfferPrices = NO_OFFERS, list: PriceList = NO_LIST): PriceQuote {
  const known = knownQuote(skin, observed, offers, list);
  if (known) return known;
  if (skin.source) return { kind: 'reward', label: sourceLabel(skin.source), source: skin.source.kind };
  // A full offers list that lacks the skin means it is not sold on its own (bundle-only, event, retired).
  return { kind: 'none', reason: offers.loaded ? 'not-sold' : 'unavailable' };
}

function mostCommon(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | undefined;
  let n = 0;
  for (const [v, c] of counts) {
    if (c > n || (c === n && best != null && v > best)) {
      best = v;
      n = c;
    }
  }
  return best;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Every catalog skin's quote. Skins with no known price and no contract source get an approximation,
 * flagged as such: the price its collection's other skins sell for (same melee / gun kind), else the
 * usual price of its edition (median of the known prices of that tier and kind). A price seen later
 * in your store replaces it.
 */
export function buildPriceMap(
  catalog: Pick<Catalog, 'skins'> & Partial<Pick<Catalog, 'weapons'>>,
  observed: Record<string, ObservedPrice>,
  offers: OfferPrices = NO_OFFERS,
  list: PriceList = NO_LIST,
): PriceMap {
  const melee = new Set((catalog.weapons ?? []).filter((w) => w.category === 'Melee').map((w) => w.id));
  const kind = (s: CatalogSkin) => (melee.has(s.weaponId) ? 'm' : 'g');
  const out: PriceMap = {};
  const byTheme = new Map<string, number[]>();
  const byTier = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, v: number) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const s of catalog.skins) {
    const q = quoteFor(s, observed, offers, list);
    out[s.id] = q;
    if (q.kind !== 'exact' || !q.vp) continue;
    if (s.themeId) push(byTheme, s.themeId + '|' + kind(s), q.vp);
    if (s.tierId) push(byTier, s.tierId + '|' + kind(s), q.vp);
  }
  for (const s of catalog.skins) {
    const q = out[s.id];
    if (q.kind !== 'none' || q.reason === 'not-sold') continue;
    const fromTheme = s.themeId ? mostCommon(byTheme.get(s.themeId + '|' + kind(s)) ?? []) : undefined;
    if (fromTheme) {
      out[s.id] = { kind: 'approx', vp: fromTheme, basis: 'collection' };
      continue;
    }
    const fromTier = s.tierId ? median(byTier.get(s.tierId + '|' + kind(s)) ?? []) : undefined;
    if (fromTier) out[s.id] = { kind: 'approx', vp: fromTier, basis: 'tier' };
  }
  return out;
}

const SHORT: Record<SkinSource['kind'], string> = { battlepass: 'Battle Pass', event: 'Event Pass', agent: 'Agent gear' };

/** Display strings. Approximations carry "≈"; everything else is a known price or a reason in words. */
export function describeQuote(q: PriceQuote | undefined): { primary: string; secondary?: string; short?: string } {
  if (!q) return { primary: '—' };
  if (q.kind === 'reward') return { primary: q.label ?? 'Contract reward', short: q.source && q.source in SHORT ? SHORT[q.source as SkinSource['kind']] : 'Reward' };
  if (q.kind === 'exact' && q.vp) return { primary: q.vp.toLocaleString('en-US'), secondary: 'VP' };
  if (q.kind === 'approx' && q.vp) return { primary: '≈ ' + q.vp.toLocaleString('en-US'), secondary: 'VP' };
  return q.reason === 'not-sold' ? { primary: 'Not sold separately', short: 'Not sold' } : { primary: 'Price not available', short: 'No price' };
}
