import type { Catalog, OffersStatus } from '../../shared/features';
import { offersCoverage, parseOffers, pricesBySkin, type ParsedOffers } from '../../shared/offers';
import { NO_OFFERS, type OfferPrices } from '../../shared/pricing';
import { httpRequest } from '../riot/http';
import { readJson, writeJson } from '../paths';
import { log } from '../log';

const DAY = 24 * 60 * 60 * 1000;
const VERSIONS = ['v1', 'v2'] as const;

interface Stored {
  v: 1;
  /** valorant-api.com game version the offers were fetched for. */
  version?: string;
  fetchedAt: number;
  api: 'v1' | 'v2';
  offers: ParsedOffers;
}

/**
 * Exact skin prices from the HenrikDev store-offers endpoint (unofficial third-party API). Fetched at
 * most once per game version or once a day (the free key allows 30 requests a minute; this uses one
 * or two), cached in offers.json. The key comes from Settings and is sent only to api.henrikdev.xyz,
 * never logged. HenrikDev's spec now documents this endpoint as removed (404); that is reported as
 * "removed" and no number is made up in its place.
 */
export class OffersService {
  status: OffersStatus = { state: 'no-key' };
  private stored: Stored | null = null;
  private preferred: 'v1' | 'v2' = 'v1';
  private busy: Promise<void> | null = null;
  private lastKey = '';

  constructor(
    private readonly file: string,
    private readonly base: string,
    private readonly key: () => string,
    private readonly onChange: () => void,
    private readonly onRaw?: (key: string, data: unknown) => void,
  ) {}

  async load(): Promise<void> {
    const s = await readJson<Stored | null>(this.file, null);
    if (s && s.v === 1 && s.offers && typeof s.offers === 'object') {
      this.stored = s;
      this.preferred = s.api === 'v2' ? 'v2' : 'v1';
    }
  }

  prices(catalog: Catalog): OfferPrices {
    if (!this.stored) return NO_OFFERS;
    return { bySkin: pricesBySkin(this.stored.offers, catalog.skins), loaded: true };
  }

  /** Fetch if the key changed, the game version changed, or the cache is a day old. Never throws. */
  refresh(catalog: Catalog, force = false): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.run(catalog, force).finally(() => (this.busy = null));
    return this.busy;
  }

  private async run(catalog: Catalog, force: boolean): Promise<void> {
    const key = this.key().trim();
    const keyChanged = key !== this.lastKey;
    this.lastKey = key;
    if (!key) {
      this.set({ state: 'no-key', ...this.cacheInfo() });
      return;
    }
    const s = this.stored;
    const fresh = s && s.version === catalog.version && Date.now() - s.fetchedAt < DAY;
    if (fresh && !force && !keyChanged) {
      this.set({ state: 'ok', ...this.cacheInfo() });
      this.report(catalog);
      return;
    }
    this.set({ ...this.status, state: 'loading' });
    const order = this.preferred === 'v2' ? ['v2', 'v1'] : [...VERSIONS];
    let last: OffersStatus = { state: 'error', message: 'No response' };
    for (const v of order as ('v1' | 'v2')[]) {
      try {
        const res = await httpRequest(`${this.base}/valorant/${v}/store-offers`, { headers: { Authorization: key, 'User-Agent': 'SexyVal' }, timeoutMs: 20000 });
        this.onRaw?.(`henrikOffers:${v}`, { status: res.status, body: res.json ?? res.text.slice(0, 2000) });
        if (res.status === 401 || res.status === 403) {
          last = { state: 'bad-key', message: `HenrikDev rejected the API key (HTTP ${res.status})` };
          break; // same key for both versions: no point trying the other
        }
        if (res.status === 429) {
          last = { state: 'rate-limited', message: 'HenrikDev rate limit reached; trying again later' };
          break;
        }
        if (res.status === 404) {
          const removed = /RiotImplementationRemoved|removed/i.test(res.text);
          last = { state: removed ? 'removed' : 'error', message: removed ? 'HenrikDev says Riot removed store offers (404)' : `HTTP 404 on ${v}` };
          continue;
        }
        const parsed = res.status === 200 ? parseOffers(res.json) : null;
        if (!parsed) {
          last = { state: 'error', message: res.status === 200 ? `${v} answered in a shape SexyVal doesn't recognise` : `HTTP ${res.status} on ${v}` };
          continue;
        }
        this.preferred = v;
        this.stored = { v: 1, version: catalog.version, fetchedAt: Date.now(), api: v, offers: parsed };
        await writeJson(this.file, this.stored).catch((e) => log.warn('offers: could not save cache', e));
        this.set({ state: 'ok', ...this.cacheInfo() });
        log.info(`offers: ${Object.keys(parsed.levels).length} skin offers from HenrikDev ${v}`);
        this.report(catalog);
        this.onChange();
        return;
      } catch (e) {
        last = { state: 'error', message: (e as Error).message };
      }
    }
    // Keep any earlier cache: an exact price from an older fetch is still exact.
    this.set({ ...last, ...this.cacheInfo() });
    log.warn(`offers: ${last.state}${last.message ? ` (${last.message})` : ''}`);
  }

  private cacheInfo(): Pick<OffersStatus, 'fetchedAt' | 'count' | 'api'> {
    return this.stored ? { fetchedAt: this.stored.fetchedAt, count: Object.keys(this.stored.offers.levels).length + Object.keys(this.stored.offers.skins).length, api: this.stored.api } : {};
  }

  private set(s: OffersStatus): void {
    this.status = s;
  }

  /** Coverage check: how many store skins (not contract rewards) got a price, and which did not. */
  report(catalog: Catalog): void {
    if (!this.stored || !catalog.skins.length) return;
    const c = offersCoverage(catalog.skins, pricesBySkin(this.stored.offers, catalog.skins));
    this.status = { ...this.status, coverage: { total: c.total, priced: c.priced, missing: c.missing.length } };
    const names = c.missing.slice(0, 40).map((m) => m.name).join(', ');
    log.info(`offers coverage: ${c.priced}/${c.total} store skins priced${c.missing.length ? `; missing ${c.missing.length}: ${names}${c.missing.length > 40 ? ', …' : ''}` : ''}`);
    this.onRaw?.('offersCoverage', { ...c, missing: c.missing.map((m) => m.name) });
  }
}
