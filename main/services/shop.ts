import type { ShopItem, ShopView } from '../../shared/types';
import type { RiotApi } from '../riot/api';
import type { AssetService } from './assets';
import { httpRequest, HttpError } from '../riot/http';
import { assetUrl } from './assets';
import { readJson, writeJson } from '../paths';
import { log } from '../log';

export const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
export const RAD = 'e59aa87c-4cbf-517a-5983-6e81511be9b7';
export const KC = '85ca954a-41f2-ce94-9b45-8ca3dd39a00d';
const SKIN_TYPE = 'e7c63390-eda7-46e0-bb7a-a6abdacd2433';

function costOf(cost: any, currency = VP): number {
  if (!cost || typeof cost !== 'object') return 0;
  const v = cost[currency];
  if (typeof v === 'number') return v;
  const first = Object.values(cost).find((x) => typeof x === 'number');
  return typeof first === 'number' ? first : 0;
}

function secs(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Date.now() + n * 1000 : undefined;
}

function item(assets: AssetService, offerId: string, levelId: string, extra: Partial<ShopItem>): ShopItem {
  const skin = assets.skin(levelId);
  return { offerId, levelId: levelId.toLowerCase(), skinId: skin?.skinId, name: skin?.name ?? 'Unknown item', icon: skin?.icon, tier: skin?.tier, cost: 0, ...extra };
}

export function parseStorefront(sf: any, assets: AssetService): Pick<ShopView, 'daily' | 'dailyEndsAt' | 'night' | 'bundles'> {
  const panel = sf?.SkinsPanelLayout ?? {};
  const ids: string[] = Array.isArray(panel.SingleItemOffers) ? panel.SingleItemOffers : [];
  const offers: any[] = Array.isArray(panel.SingleItemStoreOffers) ? panel.SingleItemStoreOffers : [];
  const daily: ShopItem[] = (ids.length ? ids : offers.map((o) => o?.OfferID))
    .filter(Boolean)
    .map((id: string) => {
      const offer = offers.find((o) => o?.OfferID === id);
      return item(assets, id, offer?.Rewards?.[0]?.ItemID ?? id, { cost: costOf(offer?.Cost) });
    });

  let night: ShopView['night'];
  const bonus = sf?.BonusStore;
  const bonusOffers: any[] = Array.isArray(bonus?.BonusStoreOffers) ? bonus.BonusStoreOffers : [];
  if (bonusOffers.length) {
    night = {
      endsAt: secs(bonus?.BonusStoreRemainingDurationInSeconds),
      items: bonusOffers.map((b) => {
        const offer = b?.Offer ?? {};
        const levelId = offer?.Rewards?.[0]?.ItemID ?? offer?.OfferID ?? '';
        const base = costOf(offer?.Cost);
        return item(assets, String(b?.BonusOfferID ?? offer?.OfferID ?? levelId), levelId, {
          cost: costOf(b?.DiscountCosts) || base,
          baseCost: base,
          discountPercent: Number(b?.DiscountPercent) || undefined,
        });
      }),
    };
  }

  // Bundles: Storefront.ts bundleSchema. Items[] (v2) or ItemOffers[] (nullable).
  const bundlesRaw: any[] = Array.isArray(sf?.FeaturedBundle?.Bundles) ? sf.FeaturedBundle.Bundles : sf?.FeaturedBundle?.Bundle ? [sf.FeaturedBundle.Bundle] : [];
  const bundles = bundlesRaw.map((b) => {
    let items: ShopItem[] = [];
    if (Array.isArray(b?.Items) && b.Items.length) {
      items = b.Items.filter((x: any) => String(x?.Item?.ItemTypeID ?? '').toLowerCase() === SKIN_TYPE).map((x: any) =>
        item(assets, String(x.Item.ItemID), String(x.Item.ItemID), {
          cost: Number(x.DiscountedPrice) || Number(x.BasePrice) || 0,
          baseCost: Number(x.BasePrice) || undefined,
          discountPercent: Math.round((Number(x.DiscountPercent) || 0) * (Number(x.DiscountPercent) <= 1 ? 100 : 1)) || undefined,
        }),
      );
    } else if (Array.isArray(b?.ItemOffers)) {
      items = b.ItemOffers.filter((x: any) => String(x?.Offer?.Rewards?.[0]?.ItemTypeID ?? '').toLowerCase() === SKIN_TYPE).map((x: any) => {
        const lvl = String(x.Offer.Rewards[0].ItemID);
        const base = costOf(x.Offer?.Cost);
        return item(assets, String(x.BundleItemOfferID ?? lvl), lvl, { cost: costOf(x.DiscountedCost) || base, baseCost: base, discountPercent: Number(x.DiscountPercent) || undefined });
      });
    }
    return {
      id: String(b?.DataAssetID ?? b?.ID ?? ''),
      name: 'Featured bundle',
      endsAt: secs(b?.DurationRemainingInSeconds),
      items,
      total: costOf(b?.TotalDiscountedCost) || undefined,
      totalBase: costOf(b?.TotalBaseCost) || undefined,
    };
  });
  return { daily, dailyEndsAt: secs(panel.SingleItemOffersRemainingDurationInSeconds), night, bundles };
}

export interface ShopHooks {
  onChange: (v: ShopView) => void;
  onError: (msg: string) => void;
  isOwnedLevel: (levelId: string) => boolean;
  onWishlistHit: (names: string[]) => void;
  /** Fresh storefront parsed and decorated (feeds the price book). */
  onLoaded?: (view: ShopView) => void;
  /** Called after any successful refresh (owned items may have changed after a purchase). */
  afterRefresh: (walletChanged: boolean) => void;
}

export class ShopService {
  view: ShopView = { status: 'idle', daily: [], wallet: null };
  private timer: NodeJS.Timeout | null = null;
  private puuid: string | null = null;
  private bundleNames = new Map<string, { name: string; icon?: string }>();
  private wishlist: { skinIds: string[]; notified: string[] } = { skinIds: [], notified: [] };

  constructor(
    private readonly api: RiotApi,
    private readonly assets: AssetService,
    private readonly hooks: ShopHooks,
    private readonly wishlistFile: string,
  ) {}

  async loadWishlist(): Promise<string[]> {
    const w = await readJson<{ skinIds?: string[]; notified?: string[] }>(this.wishlistFile, {});
    this.wishlist = { skinIds: Array.isArray(w.skinIds) ? w.skinIds : [], notified: Array.isArray(w.notified) ? w.notified : [] };
    return this.wishlist.skinIds;
  }

  async toggleWish(skinId: string): Promise<string[]> {
    const id = skinId.toLowerCase();
    this.wishlist.skinIds = this.wishlist.skinIds.includes(id) ? this.wishlist.skinIds.filter((x) => x !== id) : [...this.wishlist.skinIds, id];
    await writeJson(this.wishlistFile, this.wishlist);
    this.decorate();
    this.hooks.onChange(this.view);
    return this.wishlist.skinIds;
  }

  get wishlistIds(): string[] {
    return this.wishlist.skinIds;
  }

  start(puuid: string): void {
    if (this.puuid === puuid && this.view.status !== 'idle') return;
    this.puuid = puuid;
    void this.refresh();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.puuid = null;
  }

  private async bundleName(id: string): Promise<{ name: string; icon?: string }> {
    const hit = this.bundleNames.get(id);
    if (hit) return hit;
    try {
      const r = await httpRequest(`https://valorant-api.com/v1/bundles/${id}`, { timeoutMs: 10000 });
      const v = { name: r.json?.data?.displayName ?? 'Featured bundle', icon: assetUrl(r.json?.data?.displayIcon) };
      this.bundleNames.set(id, v);
      return v;
    } catch {
      return { name: 'Featured bundle' };
    }
  }

  /** Owned + wishlist flags on every item. */
  private decorate(): void {
    const wish = new Set(this.wishlist.skinIds);
    const mark = (i: ShopItem) => {
      i.owned = i.levelId ? this.hooks.isOwnedLevel(i.levelId) : false;
      i.watched = !!i.skinId && wish.has(i.skinId);
    };
    this.view.daily.forEach(mark);
    this.view.night?.items.forEach(mark);
    this.view.bundles?.forEach((b) => b.items.forEach(mark));
  }

  refreshOwnedFlags(): void {
    this.decorate();
    this.hooks.onChange(this.view);
  }

  private running = false;
  private queued = false;

  /** Overlapping calls coalesce: one more refresh runs right after the current one. */
  async refresh(): Promise<ShopView> {
    if (this.running) {
      this.queued = true;
      return this.view;
    }
    this.running = true;
    try {
      return await this.doRefresh();
    } finally {
      this.running = false;
      if (this.queued) {
        this.queued = false;
        void this.refresh();
      }
    }
  }

  /** The asset index loads in parallel with the first storefront; names and art are filled in by one more pass. */
  reresolve(): void {
    if (this.view.status !== 'idle') void this.refresh();
  }

  private async doRefresh(): Promise<ShopView> {
    const puuid = this.puuid ?? this.api.session.puuid;
    if (!puuid) {
      this.view = { ...this.view, status: 'error', error: 'Not signed in: start the Riot Client or sign in (Settings > Accounts)' };
      this.hooks.onChange(this.view);
      return this.view;
    }
    const prevVp = this.view.wallet?.vp;
    this.view = { ...this.view, status: 'loading', error: undefined };
    this.hooks.onChange(this.view);
    try {
      const [{ res, source, v2Status }, wallet] = await Promise.all([
        this.api.storefront(puuid),
        this.api.wallet(puuid).catch((e) => {
          log.warn('wallet failed', e);
          return null;
        }),
      ]);
      const parsed = parseStorefront(res.json, this.assets);
      for (const b of parsed.bundles ?? []) {
        const n = await this.bundleName(b.id);
        b.name = n.name;
        b.icon = n.icon;
      }
      const bal = wallet?.json?.Balances ?? null;
      this.view = {
        status: 'done',
        ...parsed,
        wallet: bal ? { vp: Number(bal[VP]) || 0, rad: Number(bal[RAD]) || 0, kc: Number(bal[KC]) || 0 } : null,
        fetchedAt: Date.now(),
        source,
        v2Status,
      };
      this.decorate();
      this.hooks.onLoaded?.(this.view);
      this.checkWishlist();
      this.schedule();
      this.hooks.afterRefresh(prevVp != null && this.view.wallet?.vp !== prevVp);
    } catch (e) {
      const msg = e instanceof HttpError ? `Shop failed: HTTP ${e.status} on ${e.path}. ${e.body.slice(0, 160)}` : `Shop failed: ${(e as Error).message}`;
      // Keep the last good items on screen; never a blank page.
      this.view = { ...this.view, status: 'error', error: `${msg} (raw response in Settings > Debug)` };
      this.hooks.onError(msg);
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.refresh(), 60_000);
    }
    this.hooks.onChange(this.view);
    return this.view;
  }

  private checkWishlist(): void {
    if (!this.wishlist.skinIds.length) return;
    const rotation = String(this.view.dailyEndsAt ? Math.round(this.view.dailyEndsAt / 60000) : '');
    const all = [...this.view.daily, ...(this.view.night?.items ?? []), ...(this.view.bundles ?? []).flatMap((b) => b.items)];
    const hits = all.filter((i) => i.watched && !this.wishlist.notified.includes(`${i.skinId}:${rotation}`));
    if (!hits.length) return;
    this.wishlist.notified = [...this.wishlist.notified, ...hits.map((h) => `${h.skinId}:${rotation}`)].slice(-200);
    void writeJson(this.wishlistFile, this.wishlist);
    this.hooks.onWishlistHit(hits.map((h) => h.name));
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const ends = [this.view.dailyEndsAt, this.view.night?.endsAt].filter((x): x is number => !!x);
    if (!ends.length) return;
    const delay = Math.min(Math.max(Math.min(...ends) - Date.now() + 5000, 10_000), 2 ** 31 - 1);
    this.timer = setTimeout(() => void this.refresh(), delay);
  }
}
