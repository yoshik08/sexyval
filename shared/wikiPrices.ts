// Valorant wiki "Store" tables -> skin uuid -> VP. Pure: the service (main/services/priceScrape.ts) and
// scripts/scrape-prices.mjs fetch the pages and call these.

export const WIKI_API = 'https://valorant.fandom.com/api.php';

export const norm = (s: string): string =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, '');

export interface StoreRow {
  name: string;
  collection: string;
  vp: number;
}

/** Rows of the "Store" section: skin name (from its image file) and VP price. */
export function storeRows(text: string): StoreRow[] {
  const start = text.search(/^===\s*\[\[Store\]\]\s*===|^===\s*Store\s*===/m);
  if (start < 0) return [];
  const rest = text.slice(start + 5);
  const end = rest.search(/^===?[^=]/m);
  const section = end >= 0 ? rest.slice(0, end) : rest;
  const out: StoreRow[] = [];
  for (const row of section.split(/\n\|-/)) {
    const file = /\[\[File:([^|\]]+?)\.(?:png|jpg|jpeg|webp|gif)/i.exec(row);
    const vp = /\{\{VP\|([\d,]+)\}\}/i.exec(row);
    if (!vp) continue;
    // Newer rows often have no image yet: then the collection cell (the line after the edition) names it.
    const lines = row.split('\n');
    const ed = lines.findIndex((l) => /\{\{ci\|/i.test(l));
    const cell = ed >= 0 ? (lines[ed + 1] ?? '').replace(/^\|/, '').replace(/^data-sort-value=[^|]*\|/, '').trim() : '';
    const tpl = /\{\{collection\|([^|}]+)(?:\|([^}]+))?\}\}/i.exec(cell);
    const collection = tpl ? (tpl[2] ?? tpl[1]).trim() : cell.replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1').trim();
    out.push({ name: file ? file[1].trim() : '', collection, vp: Number(vp[1].replace(/,/g, '')) });
  }
  return out;
}

export interface WeaponSkins {
  displayName: string;
  skins?: { uuid: string; displayName: string; contentTierUuid?: string | null }[];
}

/** Wiki page title for a valorant-api weapon. */
export const wikiPage = (w: WeaponSkins) => (w.displayName === 'Melee' ? 'Melee' : w.displayName);

/** Matches one weapon page's rows to valorant-api skins. Returns prices plus rows it couldn't place. */
export function matchRows(w: WeaponSkins, rows: StoreRow[]): { prices: Record<string, number>; unmatched: string[] } {
  const byName = new Map<string, { uuid: string; displayName: string }>();
  for (const s of w.skins ?? []) if (s.contentTierUuid) byName.set(norm(s.displayName), s);
  const all = [...byName.values()];
  const prices: Record<string, number> = {};
  const unmatched: string[] = [];
  for (const r of rows) {
    // Wiki images are named after the skin ("Prime Vandal"); melee images sometimes drop the weapon word.
    let skin = r.name ? (byName.get(norm(r.name)) ?? all.find((s) => norm(s.displayName).startsWith(norm(r.name)) || norm(r.name).startsWith(norm(s.displayName)))) : undefined;
    if (!skin && r.collection) {
      // "Rogue" on the Vandal page -> "Rogue Vandal"; on the Melee page -> the one melee skin of that collection.
      const hits = all.filter((s) => norm(s.displayName).startsWith(norm(r.collection)));
      skin = hits.length === 1 ? hits[0] : byName.get(norm(`${r.collection} ${w.displayName}`));
    }
    if (skin && r.vp > 0) prices[skin.uuid.toLowerCase()] = r.vp;
    else unmatched.push(`${wikiPage(w)}: ${r.name || r.collection} (${r.vp})`);
  }
  return { prices, unmatched };
}

export interface ScrapedList {
  date: string;
  gameVersion?: string;
  source: string;
  count: number;
  prices: Record<string, number>;
}
