// Builds shared/data/skin-prices.json: store prices (VP) for every weapon skin the Valorant wiki lists,
// keyed by valorant-api.com skin uuid. Run by hand when prices need refreshing:
//   node scripts/scrape-prices.mjs
// Source: the "Store" table on each weapon page of valorant.fandom.com (MediaWiki API, one request
// per weapon). Skins are matched to valorant-api.com by name; unmatched rows are listed at the end.
import fs from 'node:fs';
import path from 'node:path';

const UA = { 'User-Agent': 'SexyVal price list script (personal use)' };
const WIKI = 'https://valorant.fandom.com/api.php';
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', 'shared', 'data', 'skin-prices.json');

const norm = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, '');

async function json(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} on ${url}`);
  return r.json();
}

async function wikitext(page) {
  const j = await json(`${WIKI}?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json&redirects=1`);
  return j.parse?.wikitext?.['*'] ?? '';
}

/** Rows of the "Store" section: skin name (from its image file) and VP price. */
function storeRows(text) {
  const start = text.search(/^===\s*\[\[Store\]\]\s*===|^===\s*Store\s*===/m);
  if (start < 0) return [];
  const rest = text.slice(start + 5);
  const end = rest.search(/^===?[^=]/m);
  const section = end >= 0 ? rest.slice(0, end) : rest;
  const out = [];
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

const weapons = (await json('https://valorant-api.com/v1/weapons')).data;
const version = (await json('https://valorant-api.com/v1/version')).data?.version;
const prices = {};
const unmatched = [];
let rows = 0;
for (const w of weapons) {
  const page = w.displayName === 'Melee' ? 'Melee' : w.displayName;
  let text = '';
  try {
    text = await wikitext(page);
  } catch (e) {
    console.warn(`! ${page}: ${e.message}`);
    continue;
  }
  const found = storeRows(text);
  rows += found.length;
  const byName = new Map();
  for (const s of w.skins ?? []) if (s.contentTierUuid) byName.set(norm(s.displayName), s);
  for (const r of found) {
    // Wiki images are named after the skin ("Prime Vandal"); melee images sometimes drop the weapon word.
    const all = [...byName.values()];
    let skin = r.name ? (byName.get(norm(r.name)) ?? all.find((s) => norm(s.displayName).startsWith(norm(r.name)) || norm(r.name).startsWith(norm(s.displayName)))) : undefined;
    if (!skin && r.collection) {
      // "Rogue" on the Vandal page -> "Rogue Vandal"; on the Melee page -> the one melee skin of that collection.
      const hits = all.filter((s) => norm(s.displayName).startsWith(norm(r.collection)));
      if (hits.length === 1) skin = hits[0];
      else skin = byName.get(norm(`${r.collection} ${w.displayName}`));
    }
    if (skin && r.vp > 0) prices[skin.uuid.toLowerCase()] = r.vp;
    else unmatched.push(`${page}: ${r.name || r.collection} (${r.vp})`);
  }
  console.log(`${page}: ${found.length} store rows`);
  await new Promise((r) => setTimeout(r, 400)); // be gentle with the wiki
}

const tiered = weapons.flatMap((w) => (w.skins ?? []).filter((s) => s.contentTierUuid));
const date = new Date().toISOString().slice(0, 10);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ date, gameVersion: version, source: 'valorant.fandom.com weapon pages (Store tables)', count: Object.keys(prices).length, prices }, null, 0) + '\n');
console.log(`\n${rows} wiki rows -> ${Object.keys(prices).length} priced skins of ${tiered.length} tiered skins (incl. battle pass/agent gear, which are not sold). Written ${OUT}`);
if (unmatched.length) console.log(`Unmatched wiki rows (${unmatched.length}):\n  ${unmatched.join('\n  ')}`);
