// Builds shared/data/skin-prices.json (the price list bundled with the app): store prices (VP) for every
// weapon skin the Valorant wiki lists, keyed by valorant-api.com skin uuid. Run by hand:
//   npm run build:main && node scripts/scrape-prices.mjs
// The running app does the same once per game version (main/services/priceScrape.ts) and saves its copy
// to the user data folder; this file stays the fallback. Parsing lives in shared/wikiPrices.ts.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const wiki = require(path.join(root, 'dist-electron', 'shared', 'wikiPrices.js'));
const UA = { 'User-Agent': 'SexyVal price list script (personal use)' };
const OUT = path.join(root, 'shared', 'data', 'skin-prices.json');

async function json(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} on ${url}`);
  return r.json();
}

const weapons = (await json('https://valorant-api.com/v1/weapons')).data;
const version = (await json('https://valorant-api.com/v1/version')).data?.version;
const prices = {};
const unmatched = [];
let rows = 0;
for (const w of weapons) {
  const page = wiki.wikiPage(w);
  let text = '';
  try {
    text = (await json(`${wiki.WIKI_API}?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json&redirects=1`)).parse?.wikitext?.['*'] ?? '';
  } catch (e) {
    console.warn(`! ${page}: ${e.message}`);
    continue;
  }
  const found = wiki.storeRows(text);
  rows += found.length;
  const m = wiki.matchRows(w, found);
  Object.assign(prices, m.prices);
  unmatched.push(...m.unmatched);
  console.log(`${page}: ${found.length} store rows`);
  await new Promise((r) => setTimeout(r, 400)); // be gentle with the wiki
}

const tiered = weapons.flatMap((w) => (w.skins ?? []).filter((s) => s.contentTierUuid));
const date = new Date().toISOString().slice(0, 10);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ date, gameVersion: version, source: 'valorant.fandom.com weapon pages (Store tables)', count: Object.keys(prices).length, prices }, null, 0) + '\n');
console.log(`\n${rows} wiki rows -> ${Object.keys(prices).length} priced skins of ${tiered.length} tiered skins (incl. battle pass/agent gear, which are not sold). Written ${OUT}`);
if (unmatched.length) console.log(`Unmatched wiki rows (${unmatched.length}):\n  ${unmatched.join('\n  ')}`);
