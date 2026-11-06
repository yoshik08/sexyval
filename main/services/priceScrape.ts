import { matchRows, storeRows, WIKI_API, wikiPage, type ScrapedList, type WeaponSkins } from '../../shared/wikiPrices';
import type { PriceList } from '../../shared/pricing';
import { httpRequest } from '../riot/http';
import { readJson, writeJson } from '../paths';
import { log } from '../log';

const UA = { 'User-Agent': 'SexyVal price list (personal use)' };

/**
 * Re-runs the wiki price scrape once per game version, in the background, and keeps the result in the
 * user data folder. The list bundled with the app stays the fallback; a failed scrape keeps whatever
 * list was there before.
 */
export class PriceScrapeService {
  private running: Promise<void> | null = null;
  list: ScrapedList | null = null;

  constructor(
    private readonly file: string,
    private readonly onList: (l: PriceList) => void,
    private readonly delayMs = 400,
  ) {}

  async load(): Promise<void> {
    const l = await readJson<ScrapedList | null>(this.file, null);
    if (l && l.prices && typeof l.prices === 'object' && Object.keys(l.prices).length > 100) {
      this.list = l;
      this.onList({ date: l.date, prices: l.prices });
    }
  }

  /** Never awaited by the UI. Skips when this game version was already scraped. */
  ensure(gameVersion: string | undefined): void {
    if (!gameVersion || this.running || this.list?.gameVersion === gameVersion) return;
    this.running = this.scrape(gameVersion)
      .catch((e) => log.warn('price scrape failed; keeping the previous list', e))
      .finally(() => (this.running = null));
  }

  private async scrape(gameVersion: string): Promise<void> {
    const wr = await httpRequest('https://valorant-api.com/v1/weapons', { timeoutMs: 30_000 });
    const weapons: WeaponSkins[] = Array.isArray(wr.json?.data) ? wr.json.data : [];
    if (!weapons.length) throw new Error(`weapons HTTP ${wr.status}`);
    const prices: Record<string, number> = {};
    let pages = 0;
    for (const w of weapons) {
      const page = wikiPage(w);
      try {
        const r = await httpRequest(`${WIKI_API}?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json&redirects=1`, { headers: UA, timeoutMs: 20_000 });
        const text = r.json?.parse?.wikitext?.['*'] ?? '';
        if (text) pages++;
        Object.assign(prices, matchRows(w, storeRows(text)).prices);
      } catch (e) {
        log.warn(`price scrape: ${page} failed`, e);
      }
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    // A wiki outage or layout change must not replace a good list with a thin one.
    const previous = Object.keys(this.list?.prices ?? {}).length;
    if (Object.keys(prices).length < Math.max(100, previous * 0.8)) throw new Error(`only ${Object.keys(prices).length} prices from ${pages} pages`);
    this.list = { date: new Date().toISOString().slice(0, 10), gameVersion, source: 'valorant.fandom.com weapon pages (Store tables)', count: Object.keys(prices).length, prices };
    await writeJson(this.file, this.list);
    this.onList({ date: this.list.date, prices });
    log.info(`price scrape: ${this.list.count} prices for ${gameVersion}`);
  }
}
