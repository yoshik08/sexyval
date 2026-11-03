import { useEffect, useSyncExternalStore } from 'react';
import type { Catalog, OwnedState, PriceMap, PriceQuote } from '../../../shared/features';
import type { Settings } from '../../../shared/types';
import { api } from './api';

/** Tiny external store: one value, many subscribers. */
function createStore<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => {
      value = v;
      subs.forEach((s) => s());
    },
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

const EMPTY_CATALOG: Catalog = { status: 'loading', skins: [], weapons: [], tiers: [], themes: {}, buddies: [], sprays: [], cards: [], titles: [] };
const EMPTY_OWNED: OwnedState = { status: 'idle', levels: [], chromas: [], buddies: [], sprays: [], cards: [], titles: [], agents: [], buddyInstances: {}, shapes: {} };

export const catalogStore = createStore<Catalog>(EMPTY_CATALOG);
export const ownedStore = createStore<OwnedState>(EMPTY_OWNED);
export const pricesStore = createStore<PriceMap>({});
export const wishlistStore = createStore<string[]>([]);
export const settingsStore = createStore<Settings | null>(null);

let started = false;
/** Wires the stores to main-process events once. */
export function startStores(): void {
  if (started) return;
  started = true;
  void api.rpc<Catalog>('catalog:get').then(catalogStore.set);
  void api.rpc<OwnedState>('owned:get').then(ownedStore.set);
  // Every catalog skin has a quote (exact / contract reward / typical), so this never needs a login.
  void api.rpc<PriceMap>('prices:get').then(pricesStore.set);
  void api.rpc<string[]>('wishlist:get').then(wishlistStore.set);
  void api.getSettings().then(settingsStore.set);
  api.on<Catalog>('catalog', catalogStore.set);
  api.on<OwnedState>('owned', ownedStore.set);
  api.on<PriceMap>('prices', pricesStore.set);
}

export function useStore<T>(store: ReturnType<typeof createStore<T>>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}

export const useCatalog = () => useStore(catalogStore);
export const useOwned = () => useStore(ownedStore);
export const usePrices = () => useStore(pricesStore);
export const useQuote = (skinId?: string): PriceQuote | undefined => usePrices()[skinId ?? ''];
export const useWishlist = () => useStore(wishlistStore);
export const useSettings = () => useStore(settingsStore);

export async function toggleWish(skinId: string): Promise<void> {
  const next = await api.rpc<string[]>('wishlist:toggle', skinId);
  if (next) wishlistStore.set(next);
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  settingsStore.set(await api.setSettings(patch));
}

/** Owned sets, memoised per OwnedState object. */
const setCache = new WeakMap<OwnedState, { levels: Set<string>; chromas: Set<string>; extras: Record<string, Set<string>> }>();
export function ownedSets(o: OwnedState) {
  let s = setCache.get(o);
  if (!s) {
    s = {
      levels: new Set(o.levels),
      chromas: new Set(o.chromas),
      extras: { buddy: new Set(o.buddies), spray: new Set(o.sprays), card: new Set(o.cards), title: new Set(o.titles) },
    };
    setCache.set(o, s);
  }
  return s;
}

export function useInterval(fn: () => void, ms: number, deps: unknown[] = []): void {
  useEffect(() => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
