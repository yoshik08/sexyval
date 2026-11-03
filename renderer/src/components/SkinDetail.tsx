import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CatalogChroma, CatalogLevel, CatalogSkin } from '../../../shared/features';
import { chromaOwned, isSkinOwned, levelOwned } from '../../../shared/collection';
import { cx, fmtNum } from '../lib/format';
import { img } from '../lib/media';
import { morphArt } from '../lib/motion';
import { BellRinging, Bell, Check, Lock, Play, X } from '../lib/icons';
import { ownedSets, saveSettings, toggleWish, useCatalog, useOwned, useQuote, useSettings, useWishlist } from '../lib/store';
import { Btn } from './kit';
import { Img, PriceTag, TierMark, tint } from './ui';
import { VideoPlayer } from './VideoPlayer';

/** Extra facts when the skin is opened from the store (price you actually see, discount, where it is). */
export interface SkinContext {
  price?: number;
  basePrice?: number;
  discountPercent?: number;
  source?: string;
}

let openState: { skinId: string; ctx?: SkinContext } | null = null;
let returnFocus: HTMLElement | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());
const destArt = () => document.querySelector<HTMLElement>('[data-art-dest]');

/** Opens the detail sheet. `from` is the tile's art element: it becomes the shared element that travels into the sheet. */
export function openSkin(skinId: string, ctx?: SkinContext, from?: HTMLElement | null): void {
  returnFocus = document.activeElement as HTMLElement | null;
  morphArt(
    from ?? null,
    () => {
      openState = { skinId, ctx };
      emit();
    },
    destArt,
  );
}

export function closeSkin(): void {
  if (!openState) return;
  const id = openState.skinId;
  const back = () => document.querySelector<HTMLElement>(`[data-art="${CSS.escape(id)}"]`);
  morphArt(
    destArt(),
    () => {
      openState = null;
      emit();
    },
    back,
  );
  returnFocus?.focus?.({ preventScroll: true });
}

const useOpen = () =>
  useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => openState,
  );

type Sel = { kind: 'level' | 'chroma'; index: number };

const levelLabel = (l: CatalogLevel, i: number) => (i === 0 ? 'Base' : (l.item ?? `Level ${i + 1}`).replace(/([a-z])([A-Z])/g, '$1 $2'));
/** "Elderflame Judge Level 4 (Variant 1 Red)" -> "Red". */
function variantLabel(c: CatalogChroma, skinName: string, i: number): string {
  const m = /\(([^)]+)\)/.exec(c.name);
  if (m) return m[1].replace(/^Variant\s*\d+\s*/i, '').trim() || m[1];
  return i === 0 ? 'Default' : c.name.replace(skinName, '').trim() || `Variant ${i}`;
}

export function SkinDetail() {
  const open = useOpen();
  const catalog = useCatalog();
  const skin = useMemo(() => catalog.skins.find((s) => s.id === open?.skinId), [catalog.skins, open?.skinId]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeSkin();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label={skin?.name ?? 'Skin'}>
      <button className="absolute inset-0 cursor-default bg-black/75" aria-label="Close" tabIndex={-1} onClick={closeSkin} />
      <section className="relative grid h-[min(88vh,800px)] w-[min(1240px,100%)] grid-cols-1 overflow-hidden rounded-[32px] bg-[#09090a] ring-1 ring-white/10 lg:grid-cols-[minmax(0,1fr)_clamp(340px,32vw,400px)]">
        {skin ? <Body key={skin.id} skin={skin} ctx={open.ctx} /> : <div className="col-span-full p-10 text-sm text-muted">This skin is not in the catalog yet.</div>}
        <button onClick={closeSkin} className="press absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-ink hover:bg-white/20" aria-label="Close">
          <X size={16} weight="bold" />
        </button>
      </section>
    </div>
  );
}

function Body({ skin, ctx }: { skin: CatalogSkin; ctx?: SkinContext }) {
  const catalog = useCatalog();
  const owned = useOwned();
  const quote = useQuote(skin.id);
  const wish = useWishlist();
  const settings = useSettings();
  const sets = owned.status === 'ready' ? ownedSets(owned) : null;
  const tier = catalog.tiers.find((t) => t.id === skin.tierId);
  const theme = skin.themeId ? catalog.themes[skin.themeId] : undefined;
  const weapon = catalog.weapons.find((w) => w.id === skin.weaponId);
  const color = tier?.color ?? '#a1a1a6';

  // Start on the first thing that has a video; fall back to the base level's still.
  const firstVideo = skin.levels.findIndex((l) => l.video);
  const [sel, setSel] = useState<Sel>({ kind: 'level', index: Math.max(0, firstVideo) });
  const [sequence, setSequence] = useState(false);
  const level = skin.levels[sel.kind === 'level' ? sel.index : 0];
  const chroma = sel.kind === 'chroma' ? skin.chromas[sel.index] : undefined;
  const videoSrc = chroma ? chroma.video : level?.video;
  const still = chroma ? (chroma.render ?? chroma.icon) : (level?.icon ?? skin.chromas[0]?.render ?? skin.icon);
  const videoLevels = skin.levels.map((l, i) => (l.video ? i : -1)).filter((i) => i >= 0);
  const isOwned = sets ? isSkinOwned(skin, sets) : null;

  const playAll = () => {
    if (!videoLevels.length) return;
    setSequence(true);
    setSel({ kind: 'level', index: videoLevels[0] });
  };
  const next = () => {
    if (!sequence) return;
    const after = videoLevels.find((i) => sel.kind === 'level' && i > sel.index);
    if (after == null) setSequence(false);
    else setSel({ kind: 'level', index: after });
  };

  // Pointer parallax on the still: answers the user's movement, so it is allowed to be playful.
  const art = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  const onMove = useCallback((e: React.PointerEvent) => {
    const r = stage.current?.getBoundingClientRect();
    if (!r || !art.current) return;
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => art.current && (art.current.style.transform = `translate3d(${px * 18}px, ${py * 12}px, 0) rotate(${px * 1.6}deg)`));
  }, []);
  const onLeave = useCallback(() => {
    cancelAnimationFrame(raf.current);
    if (art.current) art.current.style.transform = '';
  }, []);

  const caption = quote?.kind === 'typical' ? `Estimated from the standard ${tier?.name ?? ''} price. Once this skin appears in your store, the exact price is saved here.` : quote?.kind === 'reward' ? 'This one is earned, not bought.' : quote?.kind === 'exact' ? 'Price as shown in your store.' : '';
  return (
    <>
      {/* stage */}
      <div ref={stage} onPointerMove={onMove} onPointerLeave={onLeave} className="relative min-h-[320px] overflow-hidden bg-[#050506]">
        <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse 70% 60% at 50% 58%, ${tint(color, 0.3)}, ${tint(color, 0.07)} 55%, transparent 78%)` }} />
        <div ref={art} className="absolute inset-0 transition-transform duration-[420ms] ease-out">
          <Img data-art-dest src={img(still)} alt={skin.name} className="absolute inset-x-[8%] top-[12%] h-[70%] w-[84%] object-contain drop-shadow-[0_26px_36px_rgba(0,0,0,0.6)]" />
        </div>
        {videoSrc ? (
          <VideoPlayer key={`${sel.kind}-${sel.index}`} src={videoSrc} alt={skin.name} autoPlay sound={settings?.soundOn ?? true} onSoundChange={(on) => void saveSettings({ soundOn: on })} onEnded={next} className="absolute inset-0" />
        ) : (
          <p className="absolute bottom-5 left-6 text-xs text-faint">Riot has not published a video for this {chroma ? 'variant' : 'level'}.</p>
        )}
      </div>

      {/* info */}
      <aside className="flex min-h-0 flex-col gap-6 overflow-y-auto p-6 xl:gap-7 xl:p-8">
        <div>
          <h2 className="t-title pr-10 text-page text-ink">{skin.name}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted">
            <span>{weapon?.name ?? 'Weapon'}</span>
            {theme && (
              <>
                <span className="text-faint">·</span>
                <span>{theme}</span>
              </>
            )}
            <TierMark name={tier?.name} color={tier?.color} icon={img(tier?.icon)} className="ml-1" />
          </div>
        </div>

        <div>
          {ctx?.price ? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="t-num text-[36px] leading-none text-ink">{fmtNum(ctx.price)}</span>
                <span className="text-sm font-semibold text-faint">VP</span>
                {ctx.basePrice && ctx.basePrice !== ctx.price && <span className="num text-sm text-faint line-through">{fmtNum(ctx.basePrice)}</span>}
                {ctx.discountPercent ? <span className="rounded-full bg-white px-2 py-0.5 text-xs font-bold text-black">-{ctx.discountPercent}%</span> : null}
              </div>
              {ctx.source && <p className="mt-2 text-sm text-muted">In your store · {ctx.source}</p>}
            </>
          ) : (
            <>
              <PriceTag quote={quote} size="lg" className="[&_.t-num]:text-[36px] [&_.t-num]:leading-none" />
              {caption && <p className="text-pretty mt-2 text-sm text-muted">{caption}</p>}
            </>
          )}
          <div className="mt-4 flex items-center gap-3">
            {isOwned != null && (
              <span className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium', isOwned ? 'bg-win/[0.14] text-win' : 'bg-white/[0.07] text-muted')}>
                {isOwned ? <Check size={14} weight="bold" /> : <Lock size={14} weight="bold" />}
                {isOwned ? 'In your collection' : 'Not owned'}
              </span>
            )}
            <Btn onClick={() => void toggleWish(skin.id)} tone={wish.includes(skin.id) ? 'primary' : 'default'} className="ml-auto">
              {wish.includes(skin.id) ? <BellRinging size={15} weight="fill" /> : <Bell size={15} weight="bold" />}
              {wish.includes(skin.id) ? 'Watching' : 'Watch'}
            </Btn>
          </div>
          {owned.status === 'signed-out' && <p className="mt-3 text-xs text-faint">Start the Riot Client or sign in to see what you own.</p>}
        </div>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="t-head text-md text-ink">Levels</h3>
            {videoLevels.length > 1 && (
              <button onClick={playAll} disabled={sequence} className="press inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink disabled:text-faint">
                <Play size={12} weight="fill" /> {sequence ? 'Playing all' : 'Play all'}
              </button>
            )}
          </div>
          <div className="flex flex-col gap-1">
            {skin.levels.map((l, i) => {
              const active = sel.kind === 'level' && sel.index === i;
              const lo = sets ? levelOwned(skin, i, sets) : null;
              return (
                <button
                  key={l.id}
                  onClick={() => {
                    setSequence(false);
                    setSel({ kind: 'level', index: i });
                  }}
                  className={cx('press flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-left transition-colors', active ? 'bg-white/[0.12]' : 'hover:bg-white/[0.06]')}
                >
                  <span className="num w-5 text-sm text-faint">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{levelLabel(l, i)}</span>
                  {l.video && <Play size={11} weight="fill" className={active ? 'text-ink' : 'text-faint'} />}
                  {lo != null && <span className={cx('h-1.5 w-1.5 rounded-full', lo ? 'bg-win' : 'bg-white/20')} title={lo ? 'Owned' : 'Not owned'} />}
                </button>
              );
            })}
          </div>
        </section>

        {skin.chromas.length > 1 && (
          <section>
            <h3 className="t-head mb-3 text-md text-ink">Variants</h3>
            <div className="flex flex-wrap gap-2.5">
              {skin.chromas.map((c, i) => {
                const active = sel.kind === 'chroma' && sel.index === i;
                const co = sets ? chromaOwned(skin, i, sets) : null;
                return (
                  <button
                    key={c.id}
                    onClick={() => {
                      setSequence(false);
                      setSel({ kind: 'chroma', index: i });
                    }}
                    title={variantLabel(c, skin.name, i)}
                    className={cx('press relative flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.06] transition-shadow', active ? 'ring-2 ring-white' : 'ring-1 ring-white/10 hover:ring-white/30')}
                  >
                    {c.swatch ? <Img src={img(c.swatch)} alt={variantLabel(c, skin.name, i)} className="h-9 w-9 rounded-lg object-cover" /> : <span className="num text-xs text-muted">{i + 1}</span>}
                    {co != null && <span className={cx('absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full ring-2 ring-[#09090a]', co ? 'bg-win' : 'bg-white/25')} />}
                  </button>
                );
              })}
            </div>
            <p className="mt-2.5 text-sm text-muted">{chroma ? variantLabel(chroma, skin.name, sel.index) : 'Choose a variant to preview it.'}</p>
          </section>
        )}
      </aside>
    </>
  );
}
