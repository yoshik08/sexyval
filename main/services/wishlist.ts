import { readJson, writeJson } from '../paths';
import { accountOf, lastNotified, matchOffers, migrateWish, offersOf, toggle, type WishHit, type WishState } from '../../shared/wishlist';
import type { ShopView } from '../../shared/types';

export interface WishInfo {
  skinId: string;
  lastSeen?: number;
  lastNotified?: number;
}

/** wishlist.json: per-account lists + alert history (shared/wishlist.ts). Covered by the Vault. */
export class WishlistStore {
  private state: WishState = { version: 2, accounts: {} };

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    this.state = migrateWish(await readJson<unknown>(this.file, {}));
  }

  private save(): Promise<void> {
    return writeJson(this.file, this.state);
  }

  ids(puuid: string | null): string[] {
    if (!puuid) return this.state.legacy ?? [];
    return this.state.accounts[puuid]?.skinIds ?? this.state.legacy ?? [];
  }

  async toggle(puuid: string, skinId: string): Promise<string[]> {
    const a = accountOf(this.state, puuid);
    toggle(a, skinId);
    await this.save();
    return a.skinIds;
  }

  /** Fresh store for `puuid` arrived: returns new alerts (deduplicated per appearance, persisted). */
  check(puuid: string, view: ShopView, fresh: boolean): WishHit[] {
    const a = this.state.accounts[puuid] ?? (this.state.legacy?.length ? accountOf(this.state, puuid) : undefined);
    if (!a) return [];
    const before = JSON.stringify(a.seen);
    const hits = matchOffers(a, offersOf(view), this.now(), fresh);
    if (hits.length || JSON.stringify(a.seen) !== before) void this.save();
    return hits;
  }

  info(puuid: string | null): WishInfo[] {
    const a = puuid ? this.state.accounts[puuid] : undefined;
    if (!a) return this.ids(puuid).map((skinId) => ({ skinId }));
    const ln = lastNotified(a);
    return a.skinIds.map((skinId) => ({ skinId, lastSeen: a.seen[skinId], lastNotified: ln[skinId] }));
  }
}
