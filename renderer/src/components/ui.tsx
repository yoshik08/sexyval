import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PriceQuote } from '../../../shared/features';
import { describeQuote } from '../../../shared/pricing';
import type { Connection, Last5State, MatchSummary, RankInfo, SideInfo, Toast } from '../../../shared/types';
import { UNVERIFIED_NOTE } from '../../../shared/side';
import { api } from '../lib/api';
import { cx, kd } from '../lib/format';
import { Check, CaretDown, WarningCircle, Info, X } from '../lib/icons';
import { reveal } from '../lib/motion';

/** Image with fade-in and graceful fallback (assets can be missing). */
export function Img({ src, alt, className, fallback, ...rest }: { src?: string; alt: string; className?: string; fallback?: ReactNode } & Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt' | 'className'>) {
  // Track by src (no reset effect): a cached image can finish loading before effects run.
  const [loaded, setLoaded] = useState<string>();
  const [failed, setFailed] = useState<string>();
  if (!src || failed === src) return <>{fallback ?? <div className={cx(className, 'rounded-md bg-white/5')} aria-label={alt} />}</>;
  return (
    <img
      key={src}
      src={src}
      alt={alt}
      draggable={false}
      ref={(el) => {
        if (el?.complete && el.naturalWidth > 0 && loaded !== src) setLoaded(src);
      }}
      onLoad={() => setLoaded(src)}
      onError={() => setFailed(src)}
      className={cx(className, 'transition-opacity duration-240 ease-out', loaded === src ? 'opacity-100' : 'opacity-0')}
      {...rest}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} />;
}

/** Hex "#rrggbb" + alpha 0..1 -> rgba(). Tier colours come from the game as hex. */
export function tint(hex: string | undefined, alpha: number): string {
  const h = (hex ?? '#a1a1a6').replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Known price, approximation (≈, muted), contract source, or the reason there is no price. */
export function PriceTag({ quote, className, size = 'md' }: { quote?: PriceQuote; className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const d = describeQuote(quote);
  const num = size === 'lg' ? 'text-xl' : size === 'md' ? 'text-md' : 'text-sm';
  const title =
    quote?.kind === 'reward'
      ? 'A contract reward: it is earned, not bought.'
      : quote?.kind === 'exact'
        ? quote.source === 'offers'
          ? 'Price from the store offers list (HenrikDev)'
          : quote.source === 'list'
            ? 'Price from the Valorant wiki price list bundled with SexyVal'
            : 'Price as shown in your store'
        : quote?.kind === 'approx'
          ? quote.basis === 'collection'
            ? 'Approximate: what the other skins in this collection cost. Updates when it appears in your store.'
            : 'Approximate: the usual price for this edition. Updates when it appears in your store.'
        : quote?.kind === 'none'
          ? quote.reason === 'not-sold'
            ? 'Not in the store offers list: sold only in a bundle, or not sold at all.'
            : 'No price source has this skin yet. It appears once the skin shows up in your store.'
          : undefined;
  if (quote?.kind === 'reward') {
    // Tiles are narrow: say the type ("Battle Pass"); the sheet spells out which pass.
    return (
      <span title={d.primary} className={cx('whitespace-nowrap text-sm font-medium text-muted', className)}>
        {size === 'lg' ? d.primary : d.short}
      </span>
    );
  }
  if (quote?.kind !== 'exact' && quote?.kind !== 'approx') {
    return (
      <span title={d.primary === d.short ? title : `${d.primary}. ${title ?? ''}`} className={cx('whitespace-nowrap text-sm font-medium text-muted', className)}>
        {size === 'sm' ? (d.short ?? d.primary) : d.primary}
      </span>
    );
  }
  return (
    <span title={title} className={cx('inline-flex items-baseline gap-1 whitespace-nowrap', quote?.kind === 'approx' ? 'text-muted' : 'text-ink', className)}>
      <span className={cx('t-num', num)}>{d.primary}</span>
      {d.secondary && <span className="text-2xs font-semibold text-faint">{d.secondary}</span>}
    </span>
  );
}

/** Small tier gem + name, tinted with the tier colour (colour = meaning, not decoration). */
export function TierMark({ name, color, icon, className }: { name?: string; color?: string; icon?: string; className?: string }) {
  if (!name) return null;
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-xs font-medium', className)} style={{ color: color ?? '#a1a1a6' }}>
      {icon ? <Img src={icon} alt="" className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full" style={{ background: color ?? '#a1a1a6' }} />}
      {name}
    </span>
  );
}

export function OwnedMark({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex h-5 w-5 items-center justify-center rounded-full bg-win text-black', className)} aria-label="Owned" title="Owned">
      <Check size={12} weight="bold" />
    </span>
  );
}

/** Sliding-thumb segmented control (Apple): the thumb travels between options instead of re-colouring them. */
export function Segmented<T extends string>({ value, options, onChange, className, size = 'md' }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void; className?: string; size?: 'sm' | 'md' }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const idx = options.findIndex(([v]) => v === value);
  const measure = useCallback(() => {
    const el = wrap.current?.children[idx + 1] as HTMLElement | undefined; // child 0 is the thumb
    if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth });
  }, [idx]);
  useLayoutEffect(measure, [measure, options.length]);
  useEffect(() => {
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [measure]);
  return (
    <div ref={wrap} role="tablist" className={cx('relative inline-flex rounded-full bg-white/[0.08] p-[3px]', size === 'sm' ? 'h-8' : 'h-9', className)}>
      <span
        aria-hidden
        className={cx('absolute bottom-[3px] top-[3px] rounded-full bg-white/[0.16] transition-[transform,width] duration-[320ms] ease-out', !thumb && 'opacity-0')}
        style={thumb ? { transform: `translateX(${thumb.x}px)`, width: thumb.w } : undefined}
      />
      {options.map(([v, label]) => (
        <button
          key={v}
          role="tab"
          aria-selected={v === value}
          onClick={() => onChange(v)}
          className={cx('press relative z-10 rounded-full px-3.5 text-sm font-medium', v === value ? 'text-ink' : 'text-muted hover:text-ink')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Popover select. Portalled to <body> with fixed positioning so a toolbar with backdrop-filter
 * (which becomes the containing block for fixed children) or overflow:hidden can never clip it.
 */
export function Select<T extends string>({ value, onChange, options, placeholder, className, align = 'left', width }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; hint?: ReactNode }[]; placeholder?: string; className?: string; align?: 'left' | 'right'; width?: number }) {
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [active, setActive] = useState(0);
  const cur = options.find((o) => o.value === value);

  const toggle = () => {
    if (!open) {
      setRect(btn.current?.getBoundingClientRect() ?? null);
      setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    }
    setOpen((o) => !o);
  };
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        btn.current?.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(options.length - 1, a + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const o = options[active];
        if (o) onChange(o.value);
        setOpen(false);
        btn.current?.focus();
      }
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', close);
    };
  }, [open, active, options, onChange]);
  useEffect(() => {
    if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const w = width ?? Math.max(rect?.width ?? 0, 200);
  const left = rect ? (align === 'right' ? Math.max(8, rect.right - w) : Math.min(rect.left, window.innerWidth - w - 8)) : 0;
  const flip = rect ? rect.bottom + 330 > window.innerHeight && rect.top > 340 : false;
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        className={cx('press inline-flex h-9 items-center gap-2 rounded-full bg-white/[0.08] pl-3.5 pr-2.5 text-sm font-medium text-ink hover:bg-white/[0.12]', open && 'bg-white/[0.14]', className)}
      >
        <span className="truncate">{cur?.label ?? placeholder ?? '—'}</span>
        <CaretDown size={13} weight="bold" className={cx('shrink-0 text-muted transition-transform duration-180 ease-out', open && 'rotate-180')} />
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={list}
            role="listbox"
            className="material-thick pop-in fixed z-[60] max-h-[320px] overflow-y-auto rounded-2xl p-1.5 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.9)] ring-1 ring-white/10"
            style={{ left, width: w, ...(flip ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }), ['--origin' as string]: flip ? '50% 100%' : '50% 0' }}
          >
            {options.map((o, i) => (
              <button
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                data-active={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={cx('flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm', i === active ? 'bg-white/[0.1]' : '')}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint != null && <span className="num text-xs text-faint">{o.hint}</span>}
                {o.value === value && <Check size={14} weight="bold" className="shrink-0" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

export function RankBadge({ rank, compact }: { rank?: RankInfo; compact?: boolean }) {
  if (!rank || rank.tier <= 2) {
    return <span className="text-xs text-faint">{compact ? '–' : 'Unranked'}</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Img src={rank.icon} alt={rank.name} className="h-6 w-6 shrink-0" fallback={<span className="h-6 w-6 shrink-0" />} />
      {!compact && <span className="rank-name truncate text-sm font-medium text-ink/90">{rank.name}</span>}
    </span>
  );
}

const PIP: Record<string, string> = { W: 'bg-win', L: 'bg-loss', D: 'bg-muted', '-': 'bg-faint/60' };

function PipTip({ m }: { m: MatchSummary }) {
  return (
    <div className="tip material-thick rounded-2xl px-3.5 py-3 shadow-[0_18px_44px_-10px_rgba(0,0,0,0.9)] ring-1 ring-white/10">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">{m.map ?? 'Unknown map'}</span>
        <span className="text-xs text-muted">{m.queueTag}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted">
        {m.agent?.icon && <Img src={m.agent.icon} alt={m.agent.name} className="h-4 w-4 rounded-sm" />}
        <span>{m.agent?.name ?? '—'}</span>
        <span className="ml-auto text-ink">{m.score}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 text-xs">
        <span className="text-muted">K / D / A</span>
        <span className="num text-right text-ink">
          {m.kills} / {m.deaths} / {m.assists}
        </span>
        <span className="text-muted">ACS</span>
        <span className="num text-right text-ink">{m.acs}</span>
      </div>
    </div>
  );
}

export function Last5Pips({ last5, size = 'md' }: { last5: Last5State; size?: 'sm' | 'md' }) {
  const dims = size === 'sm' ? 'h-3.5 w-2' : 'h-5 w-2.5';
  if (last5.status === 'skipped') return <span className="text-xs text-faint">Hidden</span>;
  const slots = Array.from({ length: 5 }, (_, i) => last5.matches[i]);
  const loading = last5.status === 'loading' || last5.status === 'idle';
  if (last5.status === 'error' && !last5.matches.length) {
    return (
      <span className="text-xs text-loss" title={last5.error}>
        Failed
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {slots.map((m, i) =>
        m ? (
          <div key={m.matchId} className="tip-wrap" tabIndex={0}>
            <div className={cx(dims, 'rounded-full', PIP[m.result])} />
            <PipTip m={m} />
          </div>
        ) : loading ? (
          <Skeleton key={i} className={cx(dims, 'rounded-full')} />
        ) : (
          <div key={i} className={cx(dims, 'rounded-full border border-line2')} />
        ),
      )}
    </div>
  );
}

export function SummaryStats({ last5 }: { last5: Last5State }) {
  const s = last5.summary;
  if (last5.status === 'skipped') return <><Cell>–</Cell><Cell>–</Cell><Cell>–</Cell></>;
  if (!s) {
    const busy = last5.status === 'loading' || last5.status === 'idle';
    return busy ? (
      <>
        <Cell><Skeleton className="ml-auto h-3 w-8" /></Cell>
        <Cell><Skeleton className="ml-auto h-3 w-8" /></Cell>
        <Cell><Skeleton className="ml-auto h-3 w-8" /></Cell>
      </>
    ) : (
      <><Cell>–</Cell><Cell>–</Cell><Cell>–</Cell></>
    );
  }
  return (
    <>
      <Cell>
        <span className="text-win">{s.wins}</span>
        <span className="text-faint">-</span>
        <span className="text-loss">{s.losses}</span>
      </Cell>
      <Cell className={s.kd >= 1 ? 'text-ink' : 'text-muted'}>{kd(s.kd)}</Cell>
      <Cell className={s.acs >= 230 ? 'text-ink' : 'text-muted'}>{s.acs}</Cell>
    </>
  );
}

function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('num text-right text-sm', className)}>{children}</div>;
}

/** Starting side from the hardcoded rule (Red attacks first). Renders nothing for modes without sides. */
export function SideBadge({ side, large }: { side: SideInfo; large?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef(side.side);
  useEffect(() => {
    if (prev.current !== side.side) reveal(ref.current);
    prev.current = side.side;
  }, [side.side]);
  if (!side.side) return null;
  const tone = side.side === 'ATK' ? 'text-atk bg-atk/[0.12]' : 'text-def bg-def/[0.12]';
  const word = side.side === 'ATK' ? 'Attack' : 'Defense';
  return (
    <div className="tip-wrap" tabIndex={0} title={side.verified ? undefined : UNVERIFIED_NOTE}>
      <div ref={ref} className={cx('flex flex-col items-center justify-center', tone, large ? 'h-[108px] w-[152px] rounded-[26px]' : 'h-9 w-[72px] rounded-full')}>
        <span className={cx('t-title leading-none', large ? 'text-[48px]' : 'text-md')}>{side.side}</span>
        {large && <span className="mt-1.5 text-xs font-medium opacity-80">{word} first</span>}
      </div>
      <div className="tip material-thick w-64 rounded-2xl px-3.5 py-3 text-xs text-muted shadow-[0_18px_44px_-10px_rgba(0,0,0,0.9)] ring-1 ring-white/10">
        <span className="text-ink">Red attacks first, Blue defends first.</span> {side.verified ? 'Checked on competitive matches.' : `For this queue it is ${UNVERIFIED_NOTE}.`}
      </div>
    </div>
  );
}

/** iOS-style switch. Green is a state colour (on), the one place the interface uses it for a control. */
export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="group flex w-full items-center justify-between gap-6 py-3.5 text-left">
      <span>
        <span className="block text-base text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-sm text-muted">{hint}</span>}
      </span>
      <span className={cx('relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors duration-[240ms] ease-out', checked ? 'bg-win' : 'bg-white/[0.16]')}>
        <span className={cx('absolute left-[2px] top-[2px] h-[22px] w-[22px] rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.5)] transition-transform duration-[320ms] ease-out group-active:w-[26px]', checked ? 'translate-x-[18px] group-active:translate-x-[14px]' : 'translate-x-0')} />
      </span>
    </button>
  );
}

export function StatusChip({ conn }: { conn?: Connection }) {
  const status = conn?.status ?? 'connecting';
  const color = { waiting: 'bg-warn', connecting: 'bg-muted', connected: 'bg-win', error: 'bg-loss' }[status];
  const label = { waiting: 'Waiting', connecting: 'Connecting', connected: 'Online', error: 'Error' }[status];
  return (
    <div className="no-drag flex items-center gap-2 rounded-full bg-white/[0.08] px-3 py-1.5 text-xs" title={conn?.message}>
      <span className={cx('h-1.5 w-1.5 rounded-full', color, status === 'connected' && 'pulse-dot')} />
      <span className="font-medium text-ink">{label}</span>
    </div>
  );
}

const TOAST_ICON = { info: Info, warn: WarningCircle, error: WarningCircle };
export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(
    () =>
      api.onToast((t) => {
        setItems((xs) => [...xs.slice(-3), t]);
        setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), t.level === 'error' ? 8000 : 4500);
      }),
    [],
  );
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[70] flex w-[360px] flex-col gap-2">
      {items.map((t) => {
        const Icon = TOAST_ICON[t.level];
        return (
          <div key={t.id} role="status" className="toast-in material-thick pointer-events-auto flex items-start gap-3 rounded-2xl px-4 py-3 text-sm shadow-[0_18px_50px_-10px_rgba(0,0,0,0.9)] ring-1 ring-white/10">
            <Icon size={18} weight="fill" className={cx('mt-0.5 shrink-0', t.level === 'error' ? 'text-loss' : t.level === 'warn' ? 'text-warn' : 'text-muted')} />
            <span className="text-ink/90">{t.message}</span>
            <button className="press ml-auto shrink-0 text-faint hover:text-ink" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} aria-label="Dismiss">
              <X size={14} weight="bold" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <h2 className="t-head text-lg text-ink">{children}</h2>
      {right}
    </div>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('rounded-[20px] bg-surface ring-1 ring-inset ring-white/[0.07]', className)}>{children}</section>;
}
