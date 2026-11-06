import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ArchivedBundle, ShopDay, ShopDayItem } from '../../../shared/storeArchive';
import { dayTotal, historyStats, shopDateAt, sightings } from '../../../shared/storeArchive';
import type { CatalogExtra, CatalogSkin } from '../../../shared/features';
import { cx, fmtNum } from '../lib/format';
import { CaretLeft, CaretRight, Check, MagnifyingGlass, Sparkle, Star, X } from '../lib/icons';
import { ownedSets, useCatalog, useOwned, useWishlist } from '../lib/store';
import { img } from '../lib/media';
import { fmtDay, useArchivedBundles, useLevelIndex, useResolvedDays } from '../lib/shopHistory';
import { Img, Panel, Segmented, tint } from '../components/ui';
import { openSkin } from '../components/SkinDetail';

// ---------------- Past bundles ----------------

function useExtraIndex(): Map<string, CatalogExtra> {
  const c = useCatalog();
  return useMemo(() => {
    const m = new Map<string, CatalogExtra>();
    for (const list of [c.buddies, c.sprays, c.cards, c.titles]) for (const x of list) for (const id of x.ownIds) m.set(id, x);
    return m;
  }, [c.buddies, c.sprays, c.cards, c.titles]);
}

const VP = ({ n, className }: { n?: number; className?: string }) =>
  n ? (
    <span className={cx('inline-flex items-baseline gap-1 whitespace-nowrap', className)}>
      <span className="t-num">{fmtNum(n)}</span>
      <span className="text-2xs font-semibold text-faint">VP</span>
    </span>
  ) : (
    <span className="text-faint">–</span>
  );

function BundleCard({ b, now }: { b: ArchivedBundle; now: number }) {
  const levels = useLevelIndex();
  const extras = useExtraIndex();
  const catalog = useCatalog();
  const inStore = !!b.endsAt && b.endsAt > now;
  return (
    <Panel className="overflow-hidden">
      <div className="flex items-center gap-5 p-5">
        <Img src={b.icon} alt="" className="h-20 w-36 shrink-0 rounded-2xl bg-white/[0.04] object-cover" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="t-title truncate text-[20px]">{b.name ?? 'Featured bundle'}</h3>
            {inStore && <span className="rounded-full bg-win/[0.14] px-2 py-0.5 text-2xs font-semibold text-win">In the store</span>}
          </div>
          <p className="mt-1 text-sm text-muted">
            Seen {fmtDay(shopDateAt(b.firstSeen))}
            {shopDateAt(b.lastSeen) !== shopDateAt(b.firstSeen) ? ` – ${fmtDay(shopDateAt(b.lastSeen))}` : ''}
            {b.endsAt ? ` · ${inStore ? 'ends' : 'ended'} ${fmtDay(shopDateAt(b.endsAt))}` : ''}
            {b.seenBy.length ? ` · ${b.seenBy.join(', ')}` : ''}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <VP n={b.total} className="text-[22px] text-ink" />
          {b.totalBase && b.totalBase !== b.total ? <div className="num text-sm text-faint line-through">{fmtNum(b.totalBase)}</div> : null}
          {b.discountPercent ? <div className="text-xs text-muted">−{b.discountPercent}%</div> : null}
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-px border-t border-line bg-line">
        {b.items.map((i) => {
          const skin = i.kind === 'skin' ? (i.skinId ? catalog.skins.find((s) => s.id === i.skinId) : levels.get(i.itemId)) : undefined;
          const extra = skin ? undefined : extras.get(i.itemId);
          const tier = skin ? catalog.tiers.find((t) => t.id === skin.tierId) : undefined;
          const content = (
            <>
              <div className="flex h-16 items-center justify-center rounded-xl" style={{ background: tier ? tint(tier.color, 0.12) : 'rgba(255,255,255,0.03)' }}>
                <Img src={img(skin?.icon ?? extra?.icon)} alt="" className="max-h-14 max-w-[85%] object-contain" />
              </div>
              <div className="mt-2 truncate text-sm text-ink">{skin?.name ?? extra?.name ?? i.kind}</div>
              <div className="mt-0.5 flex items-baseline gap-2 text-sm">
                <VP n={i.discountedPrice ?? i.basePrice} className="text-ink" />
                {i.basePrice && i.discountedPrice && i.basePrice !== i.discountedPrice ? <span className="num text-xs text-faint line-through">{fmtNum(i.basePrice)}</span> : null}
                <span className="ml-auto text-2xs capitalize text-faint">{i.kind}</span>
              </div>
            </>
          );
          return skin ? (
            <button key={i.itemId} className="press bg-surface p-3 text-left hover:bg-hover" onClick={() => openSkin(skin.id, { price: i.discountedPrice, basePrice: i.basePrice, source: `Bundle: ${b.name ?? 'Featured bundle'}` })}>
              {content}
            </button>
          ) : (
            <div key={i.itemId} className="bg-surface p-3">
              {content}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export function PastBundles() {
  const bundles = useArchivedBundles();
  const now = Date.now();
  if (!bundles.length) {
    return <div className="rounded-[28px] bg-surface px-8 py-16 text-center text-sm text-muted ring-1 ring-inset ring-white/[0.06]">No bundles captured yet. Every featured bundle SexyVal sees in any signed-in account is kept here, with exact prices, after it leaves the store.</div>;
  }
  return (
    <div data-past-bundles className="flex flex-col gap-5">
      {bundles.map((b) => (
        <BundleCard key={b.id} b={b} now={now} />
      ))}
      <p className="text-xs text-faint">A bundle is captured when SexyVal runs with valid tokens at least once while it is in the store.</p>
    </div>
  );
}

// ---------------- Calendar ----------------

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
/** Same day of the month n months away, clamped to that month's length. */
const addMonths = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d.getUTCDate(), last));
};

function Thumb({ skin, tierColor, small }: { skin?: CatalogSkin; tierColor?: string; small?: boolean }) {
  return (
    <div className={cx('flex items-center justify-center overflow-hidden rounded-md', small ? 'h-[26px]' : 'h-16')} style={{ background: tint(tierColor, small ? 0.2 : 0.14) }} title={skin?.name}>
      <Img src={img(skin?.icon)} alt="" className={cx('object-contain', small ? 'max-h-[22px] max-w-[90%]' : 'max-h-14 max-w-[85%]')} />
    </div>
  );
}

function DaySheet({ day, onClose }: { day: ShopDay; onClose: () => void }) {
  const idx = useLevelIndex();
  const catalog = useCatalog();
  const owned = useOwned();
  const sets = owned.status === 'ready' ? ownedSets(owned) : null;
  const tierOf = (s?: CatalogSkin) => catalog.tiers.find((t) => t.id === s?.tierId)?.color;
  useEffect(() => {
    const k = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const row = (it: ShopDayItem, n: number, source: string, night?: boolean) => {
    const s = idx.get(it.levelId);
    const own = sets?.levels.has(it.levelId);
    return (
      <button
        key={`${source}-${it.levelId}-${n}`}
        disabled={!s}
        onClick={() => s && openSkin(s.id, { price: it.vp || undefined, basePrice: it.baseVp, discountPercent: it.discountPercent, source })}
        className="press grid grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-4 rounded-2xl p-2 text-left hover:bg-white/[0.04]"
      >
        <Thumb skin={s} tierColor={tierOf(s)} />
        <div className="min-w-0">
          <div className="truncate text-md text-ink">{s?.name ?? 'Unknown skin'}</div>
          <div className="mt-0.5 flex items-center gap-2 text-xs">
            {own ? (
              <span className="inline-flex items-center gap-1 text-win">
                <Check size={12} weight="bold" /> You own it
              </span>
            ) : sets ? (
              <span className="text-faint">Not owned</span>
            ) : null}
          </div>
        </div>
        <div className="text-right">
          <VP n={it.vp} className="text-md text-ink" />
          {night && it.baseVp ? (
            <div className="text-xs text-faint">
              <span className="num line-through">{fmtNum(it.baseVp)}</span> · −{it.discountPercent}%
            </div>
          ) : null}
        </div>
      </button>
    );
  };
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-8" role="dialog" aria-modal="true" aria-label={`Shop on ${fmtDay(day.date)}`} onClick={onClose}>
      <div data-day-sheet className="sheet-in max-h-full w-[min(620px,100%)] overflow-auto rounded-[28px] bg-[#101012] p-6 ring-1 ring-white/10" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="t-title text-[24px]">{fmtDay(day.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h2>
            <p className="mt-1 text-sm text-muted">
              {day.label ?? 'Account'} · daily total <span className="num text-ink">{fmtNum(dayTotal(day))} VP</span>
            </p>
          </div>
          <button onClick={onClose} className="press flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-ink hover:bg-white/20" aria-label="Close">
            <X size={16} weight="bold" />
          </button>
        </div>
        <div className="flex flex-col gap-1">{day.daily.map((it, n) => row(it, n, `Daily Store · ${fmtDay(day.date)}`))}</div>
        {day.night?.length ? (
          <>
            <h3 className="t-head mb-2 mt-5 flex items-center gap-2 text-md">
              <Sparkle size={15} weight="fill" className="text-def" /> Night Market
            </h3>
            <div className="flex flex-col gap-1">{day.night.map((it, n) => row(it, n, `Night Market · ${fmtDay(day.date)}`, true))}</div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function ShopCalendar({ myPuuid }: { myPuuid?: string }) {
  const all = useResolvedDays();
  const idx = useLevelIndex();
  const catalog = useCatalog();
  const wish = useWishlist();
  const accounts = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of all) if (!m.has(d.account)) m.set(d.account, d.label ?? d.account.slice(0, 8));
    return [...m.entries()].sort(([a], [b]) => (a === myPuuid ? -1 : b === myPuuid ? 1 : 0));
  }, [all, myPuuid]);
  const [account, setAccount] = useState<string | null>(null);
  const acc = account && accounts.some(([a]) => a === account) ? account : (accounts[0]?.[0] ?? null);
  const days = useMemo(() => all.filter((d) => d.account === acc), [all, acc]);
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const today = shopDateAt(Date.now());
  const [focus, setFocus] = useState(today);
  const [open, setOpen] = useState<ShopDay | null>(null);
  const [q, setQ] = useState('');
  const grid = useRef<HTMLDivElement>(null);
  const watch = useMemo(() => new Set(wish), [wish]);
  const stats = useMemo(() => historyStats(days, watch), [days, watch]);
  const seen = useMemo(() => sightings(days), [days]);
  const tierColor = (s?: CatalogSkin) => catalog.tiers.find((t) => t.id === s?.tierId)?.color;

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    return [...seen.values()]
      .map((s) => ({ s, skin: catalog.skins.find((k) => k.id === s.skinId) }))
      .filter((x) => x.skin?.name.toLowerCase().includes(needle))
      .sort((a, b) => b.s.count - a.s.count)
      .slice(0, 6);
  }, [q, seen, catalog.skins]);
  const hit = useMemo(() => new Set(matches.flatMap((m) => m.s.dates)), [matches]);

  const d0 = new Date(`${focus}T00:00:00Z`);
  const y = d0.getUTCFullYear();
  const m = d0.getUTCMonth();
  const firstDow = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
  const daysIn = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysIn }, (_, i) => iso(y, m, i + 1))];
  while (cells.length % 7) cells.push(null);

  useEffect(() => {
    if (grid.current?.contains(document.activeElement)) grid.current.querySelector<HTMLElement>(`[data-date="${focus}"]`)?.focus();
  }, [focus]);
  const onKey = (e: KeyboardEvent) => {
    const step: Record<string, () => string> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, -1),
      PageDown: () => addMonths(focus, 1),
      Home: () => iso(y, m, 1),
      End: () => iso(y, m, daysIn),
    };
    if (step[e.key]) {
      e.preventDefault();
      setFocus(step[e.key]());
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const d = byDate.get(focus);
      if (d) setOpen(d);
    }
  };

  if (!all.length) {
    return <div className="rounded-[28px] bg-surface px-8 py-16 text-center text-sm text-muted ring-1 ring-inset ring-white/[0.06]">No shops captured yet. SexyVal saves every daily store and night market it sees, per account, from now on.</div>;
  }
  const monthName = new Date(Date.UTC(y, m, 15)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const topSkin = stats.mostRepeated ? catalog.skins.find((s) => s.id === stats.mostRepeated!.skinId) : undefined;
  return (
    <div data-calendar className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        {accounts.length > 1 && <Segmented size="sm" value={acc ?? ''} options={accounts.map(([a, l]) => [a, l])} onChange={setAccount} />}
        <div className="relative ml-auto">
          <MagnifyingGlass size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a skin" className="field w-60 pl-8" aria-label="Find a skin in past shops" />
        </div>
      </div>
      {matches.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {matches.map(({ s, skin }) => (
            <button key={s.skinId} onClick={() => setFocus(s.last)} className="press rounded-full bg-white/[0.08] px-3 py-1.5 text-xs text-ink hover:bg-white/[0.14]">
              {skin?.name} <span className="text-muted">· seen {s.count} time{s.count === 1 ? '' : 's'} · last {fmtDay(s.last)}</span>
            </button>
          ))}
        </div>
      )}
      {q.trim().length >= 2 && !matches.length && <p className="text-xs text-faint">No captured shop had a skin matching “{q.trim()}”.</p>}

      <div className="grid grid-cols-4 gap-4">
        {[
          ['Days captured', String(stats.captured)],
          ['Most repeated', topSkin ? `${topSkin.name} · ${stats.mostRepeated!.count}×` : '–'],
          ['Highest-value day', stats.bestDay ? `${fmtDay(stats.bestDay.date)} · ${fmtNum(dayTotal(stats.bestDay))} VP` : '–'],
          ['Watchlist days', String(stats.watchDays)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-2xl bg-white/[0.04] px-4 py-3">
            <div className="text-xs text-faint">{k}</div>
            <div className="mt-1 truncate text-sm font-medium text-ink" title={v}>
              {v}
            </div>
          </div>
        ))}
      </div>

      <Panel className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="t-head text-lg">{monthName}</h2>
          <div className="flex items-center gap-1.5">
            <button className="press flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.08] hover:bg-white/[0.14]" aria-label="Previous month" onClick={() => setFocus(addMonths(focus, -1))}>
              <CaretLeft size={14} weight="bold" />
            </button>
            <button className="press h-8 rounded-full bg-white/[0.08] px-3 text-xs font-medium hover:bg-white/[0.14]" onClick={() => setFocus(today)}>
              Today
            </button>
            <button className="press flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.08] hover:bg-white/[0.14]" aria-label="Next month" onClick={() => setFocus(addMonths(focus, 1))}>
              <CaretRight size={14} weight="bold" />
            </button>
          </div>
        </div>
        <div className="mb-1.5 grid grid-cols-7 gap-1.5 text-center text-2xs text-faint">
          {WEEK.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div ref={grid} role="grid" aria-label={monthName} onKeyDown={onKey} className="grid grid-cols-7 gap-1.5">
          {cells.map((date, i) => {
            if (!date) return <div key={`pad-${i}`} />;
            const d = byDate.get(date);
            const isToday = date === today;
            const starred = d && [...d.daily, ...(d.night ?? [])].some((it) => it.skinId && watch.has(it.skinId));
            const dim = hit.size > 0 && !hit.has(date);
            return (
              <button
                key={date}
                role="gridcell"
                data-date={date}
                tabIndex={date === focus ? 0 : -1}
                aria-selected={date === focus}
                aria-label={`${fmtDay(date, { weekday: 'long', day: 'numeric', month: 'long' })}${d ? `, ${fmtNum(dayTotal(d))} VP${d.night?.length ? ', night market' : ''}${starred ? ', watchlist skin' : ''}` : ', not captured'}`}
                onClick={() => {
                  setFocus(date);
                  if (d) setOpen(d);
                }}
                className={cx(
                  'relative flex h-[104px] flex-col rounded-xl p-1.5 text-left outline-none transition-[opacity,background-color] duration-180 focus-visible:ring-2 focus-visible:ring-white/70',
                  d ? 'bg-white/[0.04] hover:bg-white/[0.08]' : 'bg-white/[0.015]',
                  isToday && 'ring-1 ring-white/50',
                  hit.has(date) && 'bg-white/[0.1] ring-1 ring-def/70',
                  dim && 'opacity-35',
                )}
              >
                <div className="flex items-center justify-between px-0.5">
                  <span className={cx('num text-xs', isToday ? 'font-semibold text-ink' : 'text-muted')}>{Number(date.slice(8))}</span>
                  <span className="flex items-center gap-1">
                    {d?.night?.length ? <Sparkle size={11} weight="fill" className="text-def" aria-hidden /> : null}
                    {starred ? <Star size={11} weight="fill" className="text-warn" aria-hidden /> : null}
                  </span>
                </div>
                {d ? (
                  <>
                    <div className="mt-1 grid flex-1 grid-cols-2 gap-1">
                      {d.daily.slice(0, 4).map((it, n) => {
                        const s = idx.get(it.levelId);
                        return <Thumb key={`${it.levelId}-${n}`} skin={s} tierColor={tierColor(s)} small />;
                      })}
                    </div>
                    <div className="num mt-1 px-0.5 text-2xs text-muted">{fmtNum(dayTotal(d))} VP</div>
                  </>
                ) : (
                  <div className="flex flex-1 items-center justify-center text-faint/50">–</div>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex items-center gap-4 text-2xs text-faint">
          <span className="inline-flex items-center gap-1">
            <Sparkle size={11} weight="fill" className="text-def" /> Night market
          </span>
          <span className="inline-flex items-center gap-1">
            <Star size={11} weight="fill" className="text-warn" /> Watchlist skin
          </span>
          <span>– not captured</span>
          <span className="ml-auto">Arrow keys move between days, Page Up / Down between months</span>
        </div>
      </Panel>
      {open && <DaySheet day={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
