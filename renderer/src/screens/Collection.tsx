import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CatalogExtra, CatalogSkin, ExtraKind, OwnedFilter, SkinFilter, SkinSort } from '../../../shared/features';
import { countSkins, extraOwned, filterExtras, filterSkins, isSkinOwned, previewVideo } from '../../../shared/collection';
import { api } from '../lib/api';
import { fmtNum } from '../lib/format';
import { img } from '../lib/media';
import { ArrowClockwise, MagnifyingGlass, Sparkle, X } from '../lib/icons';
import { countTo } from '../lib/motion';
import { ownedSets, useCatalog, useOwned, usePreviews, usePrices } from '../lib/store';
import { Img, OwnedMark, PriceTag, Segmented, Select, Skeleton } from '../components/ui';
import { Btn } from '../components/kit';
import { SkinTile, type TileData } from '../components/SkinTile';
import { VirtualGrid } from '../components/VirtualGrid';
import { openSkin } from '../components/SkinDetail';

type Tab = 'skins' | 'buddy' | 'spray' | 'card' | 'title';
const TABS: [Tab, string][] = [
  ['skins', 'Skins'],
  ['buddy', 'Buddies'],
  ['spray', 'Sprays'],
  ['card', 'Cards'],
  ['title', 'Titles'],
];
const TITLES: Record<Tab, string> = { skins: 'Weapon skins', buddy: 'Buddies', spray: 'Sprays', card: 'Player cards', title: 'Titles' };

function ExtraTile({ item, owned }: { item: CatalogExtra; owned: boolean | null }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      tabIndex={0}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      className="relative flex h-full flex-col overflow-hidden rounded-[22px] bg-surface ring-1 ring-inset ring-white/[0.06] transition-shadow duration-[320ms] ease-out hover:ring-white/[0.16]"
    >
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        {item.kind === 'title' ? (
          <span className="t-head text-center text-lg text-ink">{item.text}</span>
        ) : (
          <Img src={img(hover && item.anim ? item.anim : item.kind === 'card' ? (item.large ?? item.icon) : item.icon)} alt={item.name} className="max-h-full max-w-full object-contain drop-shadow-[0_10px_18px_rgba(0,0,0,0.5)]" />
        )}
      </div>
      <div className="flex items-center gap-2 px-4 pb-3.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{item.name}</span>
        {item.anim && <Sparkle size={13} weight="fill" className="shrink-0 text-faint" aria-label="Animated" />}
        {owned && <OwnedMark />}
      </div>
    </div>
  );
}

export function CollectionScreen() {
  const catalog = useCatalog();
  const owned = useOwned();
  const prices = usePrices();
  const [tab, setTab] = useState<Tab>('skins');
  const [f, setF] = useState<SkinFilter>({ owned: 'all', sort: 'owned' });
  const sets = owned.status === 'ready' ? ownedSets(owned) : null;
  const tierBy = useMemo(() => new Map(catalog.tiers.map((t) => [t.id, t])), [catalog.tiers]);
  const weaponBy = useMemo(() => new Map(catalog.weapons.map((w) => [w.id, w])), [catalog.weapons]);

  const counts = useMemo(() => countSkins(catalog.skins, sets), [catalog.skins, sets]);
  const skins = useMemo(() => filterSkins(catalog.skins, f, sets, catalog.tiers), [catalog.skins, f, sets, catalog.tiers]);
  const extrasAll = useMemo(() => (tab === 'skins' ? [] : catalog[tab === 'buddy' ? 'buddies' : tab === 'spray' ? 'sprays' : tab === 'card' ? 'cards' : 'titles']), [tab, catalog]);
  const extraSet = sets && tab !== 'skins' ? sets.extras[tab as ExtraKind] : null;
  const extras = useMemo(() => filterExtras(extrasAll, f, extraSet), [extrasAll, f, extraSet]);
  const extraOwnedCount = useMemo(() => (extraSet ? extrasAll.filter((i) => extraOwned(i, extraSet)).length : 0), [extrasAll, extraSet]);

  const themes = useMemo(
    () =>
      Object.entries(catalog.themes)
        .filter(([id]) => counts.byTheme[id])
        .sort((a, b) => a[1].localeCompare(b[1])),
    [catalog.themes, counts.byTheme],
  );
  const signedOut = owned.status === 'signed-out' || owned.status === 'idle';
  const ownedNow = tab === 'skins' ? counts.all.owned : extraOwnedCount;
  const totalNow = tab === 'skins' ? counts.all.total : extrasAll.length;
  const shown = tab === 'skins' ? skins.length : extras.length;
  const filtered = !!(f.search || f.weaponId || f.tierId || f.themeId || f.owned !== 'all');

  const num = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => countTo(num.current, ownedNow), [ownedNow, tab]);

  const hoverOn = usePreviews();
  const tileFor = (s: CatalogSkin): TileData => {
    const tier = tierBy.get(s.tierId ?? '');
    const pv = previewVideo(s);
    return {
      id: s.id,
      name: s.name,
      art: s.icon,
      sub: [weaponBy.get(s.weaponId)?.name, tier?.name].filter(Boolean).join(' · '),
      tierColor: tier?.color,
      owned: sets ? isSkinOwned(s, sets) : null,
      previewVideo: pv,
      hasVideo: !!pv,
      price: <PriceTag quote={prices[s.id]} size="sm" />,
    };
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-6 xl:px-10 pt-6">
        <div className="flex items-end justify-between gap-8">
          <div>
            <h1 className="t-title text-page">{TITLES[tab]}</h1>
            <p className="mt-1.5 h-5 text-sm text-muted">
              {signedOut ? 'The full catalog works without signing in. Start the Riot Client to see what you own.' : owned.status === 'loading' ? 'Checking what you own…' : owned.status === 'error' ? <span className="text-loss">{owned.error}</span> : null}
            </p>
          </div>
          {!signedOut && owned.status !== 'loading' && (
            <div className="text-right">
              <div className="t-num leading-none">
                <span ref={num} className="text-stat text-ink">
                  {fmtNum(ownedNow)}
                </span>
                <span className="ml-1.5 text-md text-faint">of {fmtNum(totalNow)}</span>
              </div>
              <div className="mt-1.5 text-xs text-muted">owned</div>
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Segmented value={tab} options={TABS} onChange={(t) => setTab(t)} />
          <label className="relative">
            <MagnifyingGlass size={15} weight="bold" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
            <input
              value={f.search ?? ''}
              onChange={(e) => setF({ ...f, search: e.target.value })}
              placeholder="Search"
              aria-label="Search"
              className="h-9 w-56 rounded-full bg-white/[0.08] pl-9 pr-8 text-sm text-ink outline-none transition-colors duration-[200ms] focus:bg-white/[0.13]"
            />
            {f.search && (
              <button onClick={() => setF({ ...f, search: '' })} className="press absolute right-2.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-white/20 text-black" aria-label="Clear search">
                <X size={10} weight="bold" />
              </button>
            )}
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <Segmented<OwnedFilter> size="sm" value={f.owned} onChange={(o) => setF({ ...f, owned: o })} options={[['all', 'All'], ['owned', 'Owned'], ['not-owned', 'Not owned']]} />
          {tab === 'skins' && (
            <>
              <Select
                value={f.weaponId ?? ''}
                onChange={(v) => setF({ ...f, weaponId: v || undefined })}
                options={[{ value: '', label: 'All weapons' }, ...catalog.weapons.map((w) => ({ value: w.id, label: w.name, hint: sets && counts.byWeapon[w.id] ? `${counts.byWeapon[w.id].owned}/${counts.byWeapon[w.id].total}` : undefined }))]}
              />
              <Select value={f.tierId ?? ''} onChange={(v) => setF({ ...f, tierId: v || undefined })} options={[{ value: '', label: 'All tiers' }, ...[...catalog.tiers].sort((a, b) => a.rank - b.rank).map((t) => ({ value: t.id, label: t.name }))]} />
              <Select
                value={f.themeId ?? ''}
                width={280}
                onChange={(v) => setF({ ...f, themeId: v || undefined })}
                options={[{ value: '', label: 'All collections' }, ...themes.map(([id, name]) => ({ value: id, label: name, hint: sets ? `${counts.byTheme[id].owned}/${counts.byTheme[id].total}` : undefined }))]}
              />
              <Select<SkinSort>
                value={f.sort}
                onChange={(v) => setF({ ...f, sort: v })}
                options={[
                  { value: 'owned', label: 'Owned first' },
                  { value: 'tier', label: 'Tier' },
                  { value: 'name', label: 'Name' },
                  { value: 'newest', label: 'Newest seen' },
                ]}
              />
            </>
          )}
          <div className="ml-auto flex items-center gap-3 text-sm text-muted">
            <span className="num">{fmtNum(shown)} shown</span>
            <Btn tone="ghost" size="sm" onClick={() => void api.rpc('owned:refresh')} title="Re-read what you own">
              <ArrowClockwise size={14} weight="bold" /> Refresh
            </Btn>
          </div>
        </div>
      </div>

      <div className="mt-4 min-h-0 flex-1">
        {catalog.status === 'error' && !catalog.skins.length ? (
          <div className="mx-6 xl:mx-10 rounded-2xl bg-loss/[0.1] px-4 py-3 text-sm">The catalog could not be loaded: {catalog.error}</div>
        ) : catalog.status === 'loading' && !catalog.skins.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(206px,1fr))] gap-6 px-6 xl:px-10">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-[290px] rounded-[22px]" />
            ))}
          </div>
        ) : shown === 0 ? (
          <div className="mx-auto mt-16 flex max-w-sm flex-col items-center text-center">
            <MagnifyingGlass size={30} className="text-faint" />
            <h2 className="t-head mt-3 text-lg">Nothing matches</h2>
            <p className="mt-1 text-sm text-muted">{filtered ? 'Try a different search or clear the filters.' : 'There is nothing in this list yet.'}</p>
            {filtered && (
              <Btn className="mt-4" onClick={() => setF({ owned: 'all', sort: f.sort })}>
                Clear filters
              </Btn>
            )}
          </div>
        ) : tab === 'skins' ? (
          <VirtualGrid
            className="h-full px-6 xl:px-10 pb-10"
            items={skins}
            minColWidth={206}
            rowHeight={290}
            gap={22}
            keyOf={(s) => s.id}
            render={(s) => <SkinTile t={tileFor(s)} previews={hoverOn} onOpen={(art) => openSkin(s.id, undefined, art)} />}
          />
        ) : (
          <VirtualGrid
            className="h-full px-6 xl:px-10 pb-10"
            items={extras}
            minColWidth={tab === 'card' ? 170 : tab === 'title' ? 260 : 190}
            rowHeight={tab === 'card' ? 340 : tab === 'title' ? 112 : 200}
            gap={20}
            keyOf={(s) => s.id}
            render={(s) => <ExtraTile item={s} owned={extraSet ? extraOwned(s, extraSet) : null} />}
          />
        )}
      </div>
    </div>
  );
}
