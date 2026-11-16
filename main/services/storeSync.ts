import { missedRotation, nextFetchAt, type ArchivedBundle } from '../../shared/storeArchive';
import { parseStorefront, type ShopService } from './shop';
import type { StoreArchive } from './bundles';
import type { RiotApi } from '../riot/api';
import type { AssetService } from './assets';
import type { PriceBook } from './prices';
import { log } from '../log';
import type { WishlistStore } from './wishlist';
import type { WishHit } from '../../shared/wishlist';
import type { AccountSync } from '../../shared/features';

export interface SignedInAccounts {
  signedIn(): { id: string; puuid: string; region: string; label: string; status: string }[];
  tokensFor(id: string): Promise<{ accessToken: string; entitlement: string } | null>;
}

export interface StoreSyncDeps {
  api: RiotApi;
  archive: StoreArchive;
  shop: ShopService;
  assets: AssetService;
  prices: PriceBook;
  accounts: SignedInAccounts | null;
  /** Active account (its store comes through ShopService). */
  activePuuid: () => string | null;
  activeLabel: () => string;
  onNewBundles: (b: ArchivedBundle[]) => void;
  onChange: () => void;
  wish?: WishlistStore;
  onWishlistHit?: (hits: WishHit[], puuid: string, label: string) => void;
  /** Lightweight mode: other accounts wait until Valorant closes (the active store is never delayed). */
  deferred?: () => boolean;
}

/**
 * Keeps the store archive complete: the active account's store comes through ShopService (which now
 * refreshes a minute after every rotation and hourly); every other signed-in account is fetched here,
 * one after another through the pd rate limiter, on the same cadence. Also fetches at once on start when
 * a known rotation passed while SexyVal was closed, when tokens appear, and after a game update.
 */
export class StoreSync {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastOthers = 0;
  private stopped = false;
  /** Per-account result of the last sync (Settings > Network). */
  readonly accountStatus = new Map<string, AccountSync>();

  constructor(private readonly d: StoreSyncDeps) {}

  /** Raw storefront from ShopService (active account). */
  ingestActive(sf: any, puuid: string): void {
    this.ingest(sf, { id: puuid, label: this.d.activeLabel() });
  }

  private ingest(sf: any, account: { id: string; label: string }): void {
    // The very first capture fills an empty archive; that isn't "a new bundle" worth a notification.
    const firstEver = this.d.archive.lastFetchAt === 0;
    const { newBundles } = this.d.archive.ingest(sf, account, Date.now(), {
      bundleInfo: (id) => this.d.shop.bundleInfo(id),
      skinOf: (levelId) => this.d.assets.skin(levelId)?.skinId,
    });
    // Names resolve from valorant-api.com shortly after; fill them in when they arrive.
    for (const b of this.d.archive.bundles()) if (!b.name || b.name === 'Featured bundle') void this.d.shop.bundleName(b.id).then((info) => this.d.archive.fillBundleInfo(b.id, info));
    if (newBundles.length && !firstEver) this.d.onNewBundles(newBundles);
    this.d.onChange();
    this.schedule();
  }

  private mark(a: { puuid: string; label: string }, r: { ok: boolean; at?: number; error?: string; route?: 'direct' | 'proxy' }): void {
    const prev = this.accountStatus.get(a.puuid);
    this.accountStatus.set(a.puuid, { puuid: a.puuid, label: a.label, lastOkAt: r.ok ? r.at : prev?.lastOkAt, lastTryAt: Date.now(), ok: r.ok, error: r.ok ? undefined : r.error, route: r.ok ? r.route : prev?.route });
  }

  start(): void {
    this.stopped = false;
    const now = Date.now();
    if (missedRotation(now, this.d.archive.knownEnds(now), this.d.archive.lastFetchAt)) log.info('store: a rotation passed while SexyVal was closed, fetching now');
    // Every start fetches (the active account via ShopService.start on connect); other accounts here.
    void this.syncOthers('start');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Tokens appeared (Riot Client or sign-in), or a game update landed: everyone, now. */
  syncAll(reason: string): Promise<void> {
    void this.d.shop.refresh();
    return this.syncOthers(reason);
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const now = Date.now();
    const next = nextFetchAt(now, this.d.archive.knownEnds(now), this.lastOthers || now);
    this.timer = setTimeout(() => void this.syncOthers('rotation'), Math.min(2 ** 31 - 1, Math.max(10_000, next - now)));
  }

  syncOthers(reason: string): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runOthers(reason).finally(() => {
      this.running = null;
      this.schedule();
    });
    return this.running;
  }

  private async runOthers(reason: string): Promise<void> {
    if (this.d.deferred?.() && reason === 'rotation') {
      log.info('store sync: other accounts deferred (lightweight mode)');
      return;
    }
    const accounts = this.d.accounts?.signedIn() ?? [];
    const active = this.d.activePuuid();
    const others = accounts.filter((a) => a.puuid !== active && a.status !== 'expired');
    if (!others.length || !this.d.api.session.version) return;
    log.info(`store sync (${reason}): ${others.length} other account(s)`);
    for (const a of others) {
      try {
        const t = await this.d.accounts!.tokensFor(a.id);
        if (!t) {
          this.mark(a, { ok: false, error: 'Waiting for sign-in (network or session)' });
          continue;
        }
        const res = await this.d.api.storefrontFor({ ...t, puuid: a.puuid, region: a.region });
        const view = parseStorefront(res.json, this.d.assets);
        this.d.prices.record({ status: 'done', wallet: null, ...view });
        this.ingest(res.json, { id: a.puuid, label: a.label });
        this.mark(a, { ok: true, at: Date.now(), route: this.d.api.route?.status.lastRoute });
        const hits = this.d.wish?.check(a.puuid, { status: 'done', wallet: null, ...view }, true) ?? [];
        if (hits.length) this.d.onWishlistHit?.(hits, a.puuid, a.label);
      } catch (e) {
        // Saved accounts are never touched on failure: the next rotation (or Reconnect) tries again.
        this.mark(a, { ok: false, error: (e as Error).message.slice(0, 200) });
        log.warn(`store sync for ${a.label} failed`, e);
      }
    }
    this.lastOthers = Date.now();
  }
}
