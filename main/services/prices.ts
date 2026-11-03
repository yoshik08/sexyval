import type { Catalog, PriceMap } from '../../shared/features';
import type { ShopItem, ShopView } from '../../shared/types';
import { buildPriceMap, type ObservedPrice } from '../../shared/pricing';
import { readJson, writeJson } from '../paths';

interface Stored {
  v: 1;
  prices: Record<string, ObservedPrice>;
}

/**
 * Remembers every skin price the live store has shown us. Riot has no price-list endpoint any more,
 * so this grows each time the daily shop, night market or a bundle rotates. Persisted so a signed-out
 * or offline session still shows exact prices for everything seen before.
 */
export class PriceBook {
  private observed: Record<string, ObservedPrice> = {};
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly onChange: () => void,
  ) {}

  async load(): Promise<void> {
    const s = await readJson<Partial<Stored>>(this.file, {});
    const prices = s.prices && typeof s.prices === 'object' ? s.prices : {};
    for (const [id, p] of Object.entries(prices)) {
      if (p && typeof p.vp === 'number' && p.vp > 0) this.observed[id] = { vp: p.vp, at: Number(p.at) || 0 };
    }
  }

  get size(): number {
    return Object.keys(this.observed).length;
  }

  /** List price of an item: the pre-discount price when there is one. */
  private static listPrice(i: ShopItem): number {
    return i.baseCost && i.baseCost > 0 ? i.baseCost : i.cost;
  }

  /** Feed a fresh storefront. Returns true when something new or changed was learned. */
  record(view: ShopView, now = Date.now()): boolean {
    const items: ShopItem[] = [...view.daily, ...(view.night?.items ?? []), ...(view.bundles ?? []).flatMap((b) => b.items)];
    let changed = false;
    for (const i of items) {
      const vp = PriceBook.listPrice(i);
      if (!i.skinId || !(vp > 0)) continue;
      const prev = this.observed[i.skinId];
      if (!prev || prev.vp !== vp) changed = true;
      this.observed[i.skinId] = { vp, at: now };
    }
    if (changed) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => void this.flush(), 500);
      this.onChange();
    }
    return changed;
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await writeJson(this.file, { v: 1, prices: this.observed } satisfies Stored);
  }

  quotes(catalog: Catalog): PriceMap {
    return buildPriceMap(catalog, this.observed);
  }
}
