import path from 'node:path';
import {
  bundlesFromStorefront,
  dayFromStorefront,
  dayKey,
  isBundleFile,
  isShopHistoryFile,
  mergeBundle,
  mergeShopDay,
  type ArchivedBundle,
  type BundleFile,
  type ShopDay,
  type ShopHistoryFile,
} from '../../shared/storeArchive';
import { JsonStore } from './jsonStore';

export interface Account {
  /** PUUID. */
  id: string;
  /** Name#Tag. */
  label: string;
}

export interface IngestExtras {
  /** Bundle DataAssetID -> name / art (valorant-api.com). */
  bundleInfo?: (id: string) => { name?: string; icon?: string } | undefined;
  /** Skin level id -> skin id. */
  skinOf?: (levelId: string) => string | undefined;
}

/**
 * Every featured bundle (bundles.json) and every daily shop + night market per account and day
 * (shop-history.json) SexyVal has seen, merged and kept forever.
 */
export class StoreArchive {
  readonly bundleStore: JsonStore<BundleFile & { lastFetchAt?: number }>;
  readonly historyStore: JsonStore<ShopHistoryFile>;

  constructor(dir: string) {
    this.bundleStore = new JsonStore(path.join(dir, 'bundles.json'), (x): x is BundleFile => isBundleFile(x), () => ({ v: 1, bundles: {} }));
    this.historyStore = new JsonStore(path.join(dir, 'shop-history.json'), (x): x is ShopHistoryFile => isShopHistoryFile(x), () => ({ v: 1, days: {} }));
  }

  async load(): Promise<void> {
    await Promise.all([this.bundleStore.load(), this.historyStore.load()]);
  }

  async flush(): Promise<void> {
    await Promise.all([this.bundleStore.flush(), this.historyStore.flush()]);
  }

  get lastFetchAt(): number {
    return this.bundleStore.data.lastFetchAt ?? 0;
  }

  /** Feed one raw storefront for one account. Returns bundles seen for the first time ever. */
  ingest(sf: any, account: Account, now = Date.now(), x: IngestExtras = {}): { newBundles: ArchivedBundle[]; day?: ShopDay } {
    const b = this.bundleStore.data;
    const fresh: ArchivedBundle[] = [];
    for (const seen of bundlesFromStorefront(sf, now)) {
      const info = x.bundleInfo?.(seen.id);
      const items = seen.items.map((i) => (i.kind === 'skin' ? { ...i, skinId: x.skinOf?.(i.itemId) } : i));
      const prev = b.bundles[seen.id];
      b.bundles[seen.id] = mergeBundle(prev, { ...seen, items, name: info?.name, icon: info?.icon }, account.label, now);
      if (!prev) fresh.push(b.bundles[seen.id]);
    }
    b.lastFetchAt = now;
    this.bundleStore.save();

    let day: ShopDay | undefined;
    const d = dayFromStorefront(sf, account.id, now, x.skinOf);
    if (d) {
      const h = this.historyStore.data;
      const k = dayKey(account.id, d.date);
      h.days[k] = mergeShopDay(h.days[k], { ...d, label: account.label }, now);
      day = h.days[k];
      this.historyStore.save();
    }
    return { newBundles: fresh, day };
  }

  /** Bundle names often resolve a moment after the first sighting (valorant-api.com). */
  fillBundleInfo(id: string, info: { name?: string; icon?: string }): void {
    const b = this.bundleStore.data.bundles[id];
    if (!b) return;
    let changed = false;
    if (info.name && (!b.name || b.name === 'Featured bundle')) {
      b.name = info.name;
      changed = true;
    }
    if (info.icon && !b.icon) {
      b.icon = info.icon;
      changed = true;
    }
    if (changed) this.bundleStore.save();
  }

  bundles(): ArchivedBundle[] {
    return Object.values(this.bundleStore.data.bundles).sort((a, b) => b.firstSeen - a.firstSeen);
  }

  days(): ShopDay[] {
    return Object.values(this.historyStore.data.days);
  }

  /** Rotation end times we know of (bundles still in the store). */
  knownEnds(now = Date.now()): number[] {
    return this.bundles()
      .map((b) => b.endsAt)
      .filter((e): e is number => !!e && e > now - 7 * 86400_000);
  }

  /** Mock / first run: add days that aren't there yet (never replaces captured ones). */
  seedDays(days: ShopDay[]): number {
    const h = this.historyStore.data;
    let n = 0;
    for (const d of days) {
      const k = dayKey(d.account, d.date);
      if (!h.days[k]) {
        h.days[k] = d;
        n++;
      }
    }
    if (n) this.historyStore.save();
    return n;
  }
}
