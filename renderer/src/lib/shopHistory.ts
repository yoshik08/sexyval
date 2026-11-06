import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ArchivedBundle, ShopDay } from '../../../shared/storeArchive';
import { sightings } from '../../../shared/storeArchive';
import type { CatalogSkin } from '../../../shared/features';
import { api } from './api';
import { useCatalog } from './store';

/** Captured shops and bundles from main (shop-history.json / bundles.json), reloaded when the archive changes. */
let days: ShopDay[] = [];
let bundles: ArchivedBundle[] = [];
let started = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

function start(): void {
  if (started) return;
  started = true;
  const load = () =>
    void Promise.all([api.rpc<ShopDay[]>('store:history'), api.rpc<ArchivedBundle[]>('store:bundles')]).then(([d, b]) => {
      days = d ?? [];
      bundles = b ?? [];
      emit();
    });
  load();
  let t: ReturnType<typeof setTimeout> | null = null;
  api.on('store-archive', () => {
    if (t) clearTimeout(t);
    t = setTimeout(load, 400);
  });
}

const subscribe = (fn: () => void) => {
  start();
  subs.add(fn);
  return () => subs.delete(fn);
};

export const useShopDays = () => useSyncExternalStore(subscribe, () => days);
export const useArchivedBundles = () => useSyncExternalStore(subscribe, () => bundles);

/** Skin level id -> catalog skin. */
export function useLevelIndex(): Map<string, CatalogSkin> {
  const catalog = useCatalog();
  return useMemo(() => {
    const m = new Map<string, CatalogSkin>();
    for (const s of catalog.skins) {
      m.set(s.id, s);
      for (const l of s.levels) m.set(l.id, s);
    }
    return m;
  }, [catalog.skins]);
}

/** Days with every item's skin id filled from the catalog (older captures may only have the level id). */
export function useResolvedDays(): ShopDay[] {
  const all = useShopDays();
  const idx = useLevelIndex();
  return useMemo(() => all.map((d) => ({ ...d, daily: d.daily.map((i) => ({ ...i, skinId: i.skinId ?? idx.get(i.levelId)?.id })), night: d.night?.map((i) => ({ ...i, skinId: i.skinId ?? idx.get(i.levelId)?.id })) })), [all, idx]);
}

/** How often a skin showed up in any captured shop (all accounts). */
export function useSeen(skinId: string | undefined): { count: number; last?: string } {
  const resolved = useResolvedDays();
  useEffect(() => start(), []);
  return useMemo(() => {
    if (!skinId) return { count: 0 };
    const s = sightings(resolved.map((d) => ({ ...d, account: '' }))).get(skinId);
    return s ? { count: s.count, last: s.last } : { count: 0 };
  }, [resolved, skinId]);
}

export const fmtDay = (date: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
