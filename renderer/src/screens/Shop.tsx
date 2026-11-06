import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CatalogSkin } from '../../../shared/features';
import { previewVideo } from '../../../shared/collection';
import type { ShopItem, ShopView } from '../../../shared/types';
import { api } from '../lib/api';
import { countdown, cx, fmtNum, useNow } from '../lib/format';
import { ArrowClockwise, Storefront } from '../lib/icons';
import { countTo, staggerIn } from '../lib/motion';
import { useCatalog, usePreviews } from '../lib/store';
import { ErrorNote } from '../components/kit';
import { Img, Segmented, Skeleton } from '../components/ui';
import { SkinTile, type TileData } from '../components/SkinTile';
import { openSkin } from '../components/SkinDetail';
import { PastBundles, ShopCalendar } from './StoreArchive';

type Tab = 'daily' | 'bundles' | 'night' | 'past' | 'history';

/** A currency in the wallet: the number eases to its new value when a purchase or refresh changes it. */
function Balance({ value, label, dot }: { value: number; label: string; dot: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => countTo(ref.current, value), [value]);
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={cx('mb-px h-1.5 w-1.5 self-center rounded-full', dot)} />
      <span ref={ref} className="t-num text-[20px] text-ink">
        {fmtNum(value)}
      </span>
      <span className="text-xs text-muted">{label}</span>
    </div>
  );
}

function ShopPrice({ item, sale }: { item: ShopItem; sale?: boolean }) {
  const was = sale && item.baseCost && item.baseCost !== item.cost ? item.baseCost : undefined;
  return (
    <div>
      <div className="inline-flex items-baseline gap-1 whitespace-nowrap">
        <span className="t-num text-md text-ink">{item.cost ? fmtNum(item.cost) : '—'}</span>
        <span className="text-2xs font-semibold text-faint">VP</span>
      </div>
      {was && <div className="num text-xs text-faint line-through">{fmtNum(was)}</div>}
    </div>
  );
}

export function ShopScreen({ initialTab, connected, myPuuid }: { initialTab: Tab; connected: boolean; myPuuid?: string }) {
  const [shop, setShop] = useState<ShopView | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const now = useNow(1000);
  const grid = useRef<HTMLDivElement>(null);
  const catalog = useCatalog();
  const previews = usePreviews();
  const skinById = useMemo(() => new Map<string, CatalogSkin>(catalog.skins.map((s) => [s.id, s])), [catalog.skins]);
  const weaponName = useMemo(() => new Map(catalog.weapons.map((w) => [w.id, w.name])), [catalog.weapons]);

  useEffect(() => setTab(initialTab), [initialTab]);
  useEffect(() => {
    void api.getShop().then(setShop);
    return api.onShop(setShop);
  }, []);
  // Stagger the tiles in when a tab first shows items, not on every background refresh.
  const hasItems = !!shop?.daily.length;
  useLayoutEffect(() => staggerIn(grid.current), [tab, hasItems]);

  const night = shop?.night;
  const bundles = shop?.bundles?.filter((b) => b.items.length) ?? [];
  const active: Tab = tab === 'night' && !night ? 'daily' : tab === 'bundles' && !bundles.length ? 'daily' : tab;
  const endsAt = active === 'night' ? night?.endsAt : active === 'bundles' ? bundles[0]?.endsAt : shop?.dailyEndsAt;
  const loading = !shop || shop.status === 'loading' || (shop.status === 'idle' && connected);
  const options: [Tab, string][] = [['daily', 'Daily']];
  if (bundles.length) options.push(['bundles', bundles.length > 1 ? `Bundles · ${bundles.length}` : 'Bundle']);
  if (night) options.push(['night', 'Night Market']);
  options.push(['past', 'Past bundles'], ['history', 'History']);
  const archive = active === 'past' || active === 'history';

  const tile = (i: ShopItem, source: string, sale?: boolean): TileData => {
    const sk = i.skinId ? skinById.get(i.skinId) : undefined;
    const pv = sk ? previewVideo(sk) : undefined;
    return {
      id: i.skinId ?? i.offerId,
      name: i.name,
      art: i.icon,
      sub: [sk ? weaponName.get(sk.weaponId) : undefined, i.tier?.name].filter(Boolean).join(' · '),
      tierColor: i.tier?.color,
      owned: i.owned,
      watched: i.watched,
      previewVideo: pv,
      hasVideo: !!pv,
      price: <ShopPrice item={i} sale={sale} />,
      badge: sale && i.discountPercent ? <span className="rounded-full bg-white px-2 py-0.5 text-xs font-bold text-black">-{i.discountPercent}%</span> : undefined,
    };
  };
  const open = (i: ShopItem, source: string) => (art: HTMLElement | null) => i.skinId && openSkin(i.skinId, { price: i.cost || undefined, basePrice: i.baseCost, discountPercent: i.discountPercent, source }, art);
  const cell = (i: ShopItem, source: string, sale?: boolean, h = 'h-[318px]') => (
    <div key={i.offerId} data-row className={h}>
      <SkinTile t={tile(i, source, sale)} onOpen={open(i, source)} previews={previews} />
    </div>
  );

  return (
    <div className="mx-auto max-w-[1240px] px-6 xl:px-10 pb-20 pt-6">
      <div className="flex items-end justify-between gap-8">
        <div>
          <h1 className="t-title text-page">{active === 'night' ? 'Night Market' : active === 'bundles' ? 'Bundles' : active === 'past' ? 'Past bundles' : active === 'history' ? 'Store history' : 'Daily Store'}</h1>
          <p className="num mt-1.5 h-5 text-sm text-muted">{archive ? 'Every store SexyVal has seen, kept after it rotates.' : endsAt ? <>Resets in {countdown(endsAt - now)}</> : null}</p>
        </div>
        <div className="flex shrink-0 items-center gap-5 xl:gap-7">
          {shop?.wallet ? (
            <>
              <Balance value={shop.wallet.vp} label="VP" dot="bg-white" />
              <Balance value={shop.wallet.rad} label="Radianite" dot="bg-def" />
              <Balance value={shop.wallet.kc} label="Kingdom" dot="bg-warn" />
            </>
          ) : loading ? (
            <Skeleton className="h-6 w-64" />
          ) : null}
          <button
            onClick={() => void api.refreshShop()}
            disabled={!connected || shop?.status === 'loading'}
            className="press flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-ink hover:bg-white/[0.14] disabled:opacity-40"
            aria-label="Refresh store"
            title="Refresh store"
          >
            <ArrowClockwise size={16} weight="bold" className={cx(shop?.status === 'loading' && 'animate-[spin_0.8s_linear_infinite]')} />
          </button>
        </div>
      </div>

      {options.length > 1 && <Segmented className="mt-6" value={active} options={options} onChange={setTab} />}

      <div className="mt-6">
        {shop?.status === 'error' && !archive && <ErrorNote>{shop.error}</ErrorNote>}

        {active === 'past' ? (
          <PastBundles />
        ) : active === 'history' ? (
          <ShopCalendar myPuuid={myPuuid} />
        ) : !connected && !shop?.daily.length ? (
          <div className="mt-6 flex flex-col items-center rounded-[28px] bg-surface px-8 py-20 text-center ring-1 ring-inset ring-white/[0.06]">
            <Storefront size={36} weight="duotone" className="text-faint" />
            <h2 className="t-head mt-4 text-lg">Your store needs the Riot Client</h2>
            <p className="text-pretty mt-1.5 max-w-sm text-sm text-muted">Start the Riot Client, or sign in from Settings. Valorant itself does not need to be open.</p>
          </div>
        ) : active === 'bundles' ? (
          <div ref={grid} className="flex flex-col gap-14">
            {bundles.map((b) => (
              <section key={b.id}>
                <div className="mb-5 flex items-end justify-between gap-6">
                  <div className="flex min-w-0 items-center gap-4">
                    {b.icon && <Img src={b.icon} alt="" className="h-16 w-16 shrink-0 rounded-2xl bg-white/[0.04] object-cover" />}
                    <div className="min-w-0">
                      <h2 className="t-title truncate text-[length:clamp(20px,1vw_+_10px,24px)]">{b.name}</h2>
                      <p className="mt-1 text-sm text-muted">
                        {b.items.length} skin{b.items.length === 1 ? '' : 's'}
                        {b.endsAt ? ` · ends in ${countdown(b.endsAt - now)}` : ''}
                      </p>
                    </div>
                  </div>
                  {b.total ? (
                    <div className="shrink-0 text-right">
                      <div className="inline-flex items-baseline gap-1.5">
                        <span className="t-num text-[26px] text-ink">{fmtNum(b.total)}</span>
                        <span className="text-xs font-semibold text-faint">VP</span>
                      </div>
                      {b.totalBase && b.totalBase !== b.total && <div className="num text-sm text-faint line-through">{fmtNum(b.totalBase)}</div>}
                    </div>
                  ) : null}
                </div>
                <div className="grid grid-cols-4 gap-x-4 gap-y-8 xl:gap-x-6 xl:gap-y-9">{b.items.map((i) => cell(i, `Bundle: ${b.name}`, true))}</div>
              </section>
            ))}
          </div>
        ) : (
          <div ref={grid} className={cx('grid gap-x-4 gap-y-8 xl:gap-x-6 xl:gap-y-9', active === 'night' ? 'grid-cols-3' : 'grid-cols-4')}>
            {(active === 'night' ? (night?.items ?? []) : (shop?.daily ?? [])).map((i) => cell(i, active === 'night' ? 'Night Market' : 'Daily Store', active === 'night', active === 'night' ? 'h-[360px]' : 'h-[318px]'))}
            {loading && !shop?.daily.length && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[318px] rounded-[22px]" />)}
          </div>
        )}
      </div>
    </div>
  );
}
