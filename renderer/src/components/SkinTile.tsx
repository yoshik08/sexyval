import { memo, useState, type ReactNode } from 'react';
import { cx } from '../lib/format';
import { img } from '../lib/media';
import { BellRinging, Play } from '../lib/icons';
import { Img, OwnedMark, tint } from './ui';
import { HoverPreview } from './VideoPlayer';

export interface TileData {
  id: string;
  name: string;
  /** Remote art url (or an svasset: url); passed through img(). */
  art?: string;
  /** Second line, e.g. "Rifle · Ultra". */
  sub?: ReactNode;
  tierColor?: string;
  owned?: boolean | null;
  watched?: boolean;
  /** Remote url of the clip to preview on hover; omitted when the skin has no video. */
  previewVideo?: string;
  hasVideo?: boolean;
  /** Right side of the title row. */
  price: ReactNode;
  /** Small pill over the art, e.g. "-31%". */
  badge?: ReactNode;
}

/**
 * A skin as a product shot: the render floats on a soft light in the tier's colour. No card frame; the
 * tile is the art, with the name and price underneath. Hovering lifts the render; resting the pointer
 * (350 ms) plays a short muted preview when one exists and previews are enabled.
 */
export const SkinTile = memo(function SkinTile({ t, onOpen, previews = true, className }: { t: TileData; onOpen: (art: HTMLElement | null) => void; previews?: boolean; className?: string }) {
  const [hover, setHover] = useState(false);
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const enter = () => {
    if (!previews || !t.previewVideo) return;
    setTimer(setTimeout(() => setHover(true), 350));
  };
  const leave = () => {
    if (timer) clearTimeout(timer);
    setTimer(null);
    setHover(false);
  };
  const color = t.tierColor ?? '#a1a1a6';
  return (
    <button
      data-skin-card
      onClick={(e) => onOpen(e.currentTarget.querySelector('[data-art]'))}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={leave}
      className={cx('group/tile press relative flex h-full w-full flex-col text-left outline-none', className)}
    >
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-[22px] bg-surface ring-1 ring-inset ring-white/[0.06] transition-[box-shadow] duration-[320ms] ease-out [@media(hover:hover)]:group-hover/tile:ring-white/[0.16] group-focus-visible/tile:ring-white/40">
        <div className="absolute inset-0 transition-opacity duration-[320ms] ease-out" style={{ background: `radial-gradient(ellipse 78% 58% at 50% 64%, ${tint(color, 0.3)}, ${tint(color, 0.08)} 52%, transparent 74%)` }} />
        <Img
          data-art={t.id}
          src={img(t.art)}
          alt={t.name}
          className="absolute inset-x-[7%] top-[10%] h-[70%] w-[86%] object-contain drop-shadow-[0_16px_24px_rgba(0,0,0,0.55)] transition-transform duration-[420ms] ease-out [@media(hover:hover)]:group-hover/tile:-translate-y-1 [@media(hover:hover)]:group-hover/tile:scale-[1.045]"
        />
        {t.previewVideo && <HoverPreview src={t.previewVideo} active={hover} />}
        <div className="absolute left-3 top-3 flex items-center gap-1.5">
          {t.badge}
          {t.watched && (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-black/50 text-warn" title="Watching this skin">
              <BellRinging size={13} weight="fill" />
            </span>
          )}
        </div>
        {t.owned && <OwnedMark className="absolute right-3 top-3" />}
        {t.hasVideo && !hover && (
          <span className="absolute bottom-3 right-3 flex h-7 w-7 items-center justify-center rounded-full bg-black/45 text-white/90 opacity-0 transition-opacity duration-[240ms] ease-out [@media(hover:hover)]:group-hover/tile:opacity-100">
            <Play size={12} weight="fill" />
          </span>
        )}
      </div>
      {/* Caption: name and price side by side; stacks when the tile is narrow (see .tile-meta). */}
      <div className="tile-meta">
        <div className="tile-meta-row flex items-start justify-between gap-3 px-1.5 pb-0.5 pt-3">
          <div className="min-w-0 max-w-full">
            <div className="truncate text-[14px] font-semibold leading-5 text-ink">{t.name}</div>
            <div className="mt-px truncate text-xs text-muted">{t.sub}</div>
          </div>
          <div className="tile-price shrink-0 pt-px text-right">{t.price}</div>
        </div>
      </div>
    </button>
  );
});
