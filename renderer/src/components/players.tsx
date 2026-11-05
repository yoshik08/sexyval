import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LiveDensity, MatchSummary, PlayerRow, RankInfo } from '../../../shared/types';
import { trackerUrl } from '../../../shared/tracker';
import { api } from '../lib/api';
import { cx, kd } from '../lib/format';
import { ArrowSquareOut, ArrowUp } from '../lib/icons';
import { expandTo } from '../lib/motion';
import { Img, Skeleton } from './ui';

export const isHidden = (p: PlayerRow) => p.incognito && !p.isMe;

// ---------------- density + expansion ----------------

/** Auto density: compact when the Live area is under 1100 px wide or a full 10-player match is on screen. */
export function useDensity(setting: LiveDensity, container: React.RefObject<HTMLElement>, players: number, inGame: boolean): 'compact' | 'detailed' {
  const [width, setWidth] = useState(1280);
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [container]);
  if (setting !== 'auto') return setting;
  return width < 1100 || (inGame && players >= 10) ? 'compact' : 'detailed';
}

/**
 * Which rows are open. Compact: at most one per team. Detailed: all open, and a click closes just that
 * one. Changing density resets it.
 */
export function useExpansion(density: 'compact' | 'detailed') {
  const [single, setSingle] = useState<string | null>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSingle(null);
    setClosed(new Set());
  }, [density]);
  const isOpen = useCallback((id: string) => (density === 'detailed' ? !closed.has(id) : single === id), [density, closed, single]);
  const toggle = useCallback(
    (id: string) => {
      if (density === 'compact') setSingle((s) => (s === id ? null : id));
      else
        setClosed((c) => {
          const n = new Set(c);
          if (n.has(id)) n.delete(id);
          else n.add(id);
          return n;
        });
    },
    [density],
  );
  const collapse = useCallback(
    (id: string) => {
      if (density === 'compact') setSingle((s) => (s === id ? null : s));
      else setClosed((c) => new Set(c).add(id));
    },
    [density],
  );
  return { isOpen, toggle, collapse };
}

/** Click, Enter or Space toggles; Esc collapses. Keys only count on the row itself, not on a pip or button inside it. */
export function rowHandlers(id: string, open: boolean, x: { toggle: (id: string) => void; collapse: (id: string) => void }, enabled = true) {
  if (!enabled) return {};
  return {
    role: 'button',
    tabIndex: 0,
    'aria-expanded': open,
    onClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-no-toggle]')) return;
      x.toggle(id);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        x.toggle(id);
      } else if (e.key === 'Escape' && open) {
        e.stopPropagation();
        x.collapse(id);
      }
    },
  } as const;
}

/** Height-animated disclosure; content stays mounted (measurable) and inert while closed. */
export function ExpandPanel({ open, children }: { open: boolean; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      if (outer.current) outer.current.style.height = open ? 'auto' : '0px';
      if (inner.current) inner.current.style.opacity = open ? '1' : '0';
      return;
    }
    expandTo(outer.current, inner.current, open);
  }, [open]);
  return (
    <div ref={outer} className="overflow-hidden" aria-hidden={!open} {...(!open ? { inert: '' } : {})}>
      <div ref={inner}>{children}</div>
    </div>
  );
}

// ---------------- score ----------------

const scoreTone = (n: number) => (n >= 700 ? 'text-ink' : n >= 400 ? 'text-ink/85' : 'text-muted');

const TIP_W = 208;

/**
 * Tooltip rendered into <body> with fixed positioning and clamped to the window, so a card's
 * overflow:hidden can't clip it and a right-edge column can't push the page sideways.
 */
function FloatTip({ tip, children, className, label }: { tip: ReactNode; children: ReactNode; className?: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const show = () => setRect(ref.current?.getBoundingClientRect() ?? null);
  const hide = () => setRect(null);
  useEffect(() => {
    if (!rect) return;
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [rect]);
  const above = rect ? rect.top > 230 : true;
  const left = rect ? Math.min(window.innerWidth - TIP_W - 8, Math.max(8, rect.left + rect.width / 2 - TIP_W / 2)) : 0;
  return (
    <div ref={ref} className={className} tabIndex={0} aria-label={label} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {rect &&
        createPortal(
          <div
            role="tooltip"
            className="pop-in pointer-events-none fixed z-[80]"
            style={{ left, width: TIP_W, ...(above ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }), ['--origin' as string]: above ? '50% 100%' : '50% 0' }}
          >
            {tip}
          </div>,
          document.body,
        )}
    </div>
  );
}

function ScoreTip({ p }: { p: PlayerRow }) {
  const s = p.svScore!;
  const rows: [string, string][] = [
    ['ACS', String(s.parts.acs)],
    ['K/D', kd(s.parts.kd)],
    ['ADR', String(s.parts.adr)],
    ['HS%', `${s.parts.hsPct}%`],
    ['FB / round', s.parts.fbPerRound.toFixed(2)],
    ['W–L', `${s.parts.wins}–${s.parts.losses}`],
  ];
  return (
    <div className="material-thick rounded-2xl px-3.5 py-3 text-left shadow-[0_18px_44px_-10px_rgba(0,0,0,0.9)] ring-1 ring-white/10">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold">SV Score</span>
        <span className="t-num text-md">{s.score}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
        {rows.map(([k, v]) => (
          <span key={k} className="contents">
            <span className="text-muted">{k}</span>
            <span className="num text-right text-ink">{v}</span>
          </span>
        ))}
      </div>
      <div className="mt-2 text-2xs text-faint">
        SexyVal’s own 0–1000 score from the last {s.sample} match{s.sample === 1 ? '' : 'es'} with round data. Not Tracker Score.
      </div>
    </div>
  );
}

/** SV Score number. "—" when there aren't 3 matches with round data; nothing for hidden players. */
export function ScoreBadge({ p, className }: { p: PlayerRow; className?: string }) {
  if (isHidden(p)) return <span className={cx('text-xs text-faint', className)} />;
  const busy = p.last5.status === 'loading' || p.last5.status === 'idle';
  if (!p.svScore) {
    if (busy) return <Skeleton className={cx('h-3.5 w-8', className)} />;
    return (
      <span className={cx('num text-sm text-faint', className)} title="Fewer than 3 recent matches with round data">
        —
      </span>
    );
  }
  return (
    <FloatTip className={cx('outline-none', className)} label={`SV Score ${p.svScore.score}`} tip={<ScoreTip p={p} />}>
      <span data-score className={cx('t-num text-[15px] leading-none', scoreTone(p.svScore.score))}>
        {p.svScore.score}
      </span>
    </FloatTip>
  );
}

// ---------------- ranks ----------------

function RankIcon({ rank, size, className }: { rank?: RankInfo; size: number; className?: string }) {
  const box = { width: size, height: size };
  if (!rank) return <span style={box} className={cx('inline-block shrink-0 rounded-full border border-dashed border-white/15', className)} />;
  return <Img src={rank.icon} alt={rank.name} style={box} className={cx('shrink-0', className)} fallback={<span style={box} className="inline-block shrink-0" />} />;
}

/**
 * Current rank (icon) and peak (smaller icon with an up-arrow), names in the tooltip. Hidden players
 * keep only the badge the game sends in the match payload. Icons grow with a transform when the row opens.
 */
export function RankPair({ p, open }: { p: PlayerRow; open?: boolean }) {
  const grow = { transform: open ? 'scale(1.14)' : 'scale(1)', transition: 'transform 220ms var(--ease-out)' };
  if (isHidden(p) || !p.mmr) {
    return (
      <span className="flex items-center gap-1.5" title={p.rank && p.rank.tier > 2 ? p.rank.name : 'Unrated'}>
        <span style={grow} className="inline-flex origin-center">
          <RankIcon rank={p.rank && p.rank.tier > 2 ? p.rank : undefined} size={24} />
        </span>
        <span className="w-[22px]" />
      </span>
    );
  }
  if (p.mmr.status === 'loading') {
    return (
      <span className="flex items-center gap-1.5">
        <Skeleton className="h-6 w-6 rounded-full" />
        <Skeleton className="h-[18px] w-[18px] rounded-full" />
      </span>
    );
  }
  if (p.mmr.status === 'error') {
    return (
      <span className="flex w-[52px] items-center text-sm text-faint" title={`Rank unavailable${p.mmr.error ? `: ${p.mmr.error}` : ''}`}>
        —
      </span>
    );
  }
  const cur = p.mmr.current;
  const peak = p.mmr.peak;
  const curText = cur?.rank ? `${cur.rank.name} · ${cur.rr} RR` : 'Unrated';
  const peakText = peak?.rank ? `Peak ${peak.rank.name}${peak.act ? ` · ${peak.act}` : ''}` : 'No peak rank';
  return (
    <span className="flex items-center gap-1.5" title={`${curText}\n${peakText}`}>
      <span style={grow} className="inline-flex origin-center">
        <RankIcon rank={cur?.rank} size={24} />
      </span>
      <span style={grow} className="relative inline-flex origin-center" aria-label={peakText}>
        <RankIcon rank={peak?.rank} size={18} className={!peak?.rank ? 'opacity-50' : undefined} />
        {peak?.rank && <ArrowUp size={9} weight="bold" className="absolute -right-1 -top-1 rounded-full bg-black text-ink" />}
      </span>
    </span>
  );
}

// ---------------- tracker ----------------

export function TrackerButton({ p, compact }: { p: Pick<PlayerRow, 'name' | 'tag' | 'incognito' | 'isMe'>; compact?: boolean }) {
  if ((p.incognito && !p.isMe) || !trackerUrl(p.name, p.tag)) return null;
  return (
    <button
      type="button"
      data-no-toggle
      onClick={(e) => {
        e.stopPropagation();
        void api.rpc('open:tracker', p.name, p.tag);
      }}
      title="Opens tracker.gg in your browser"
      className={cx('press inline-flex items-center gap-1.5 rounded-full bg-white/[0.08] font-medium text-ink hover:bg-white/[0.14]', compact ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm')}
    >
      {compact ? 'tracker.gg' : 'Open on tracker.gg'} <ArrowSquareOut size={compact ? 12 : 14} weight="bold" />
    </button>
  );
}

// ---------------- expanded detail ----------------

function MiniMatch({ m, narrow }: { m: MatchSummary; narrow?: boolean }) {
  const tone = m.result === 'W' ? 'text-win' : m.result === 'L' ? 'text-loss' : 'text-muted';
  return (
    <div className={cx('grid items-center gap-2 rounded-xl px-1.5 py-1 text-xs', narrow ? 'grid-cols-[4px_minmax(0,1fr)_auto]' : 'grid-cols-[4px_20px_minmax(0,1fr)_64px_52px_40px]')}>
      <span className={cx('h-4 w-1 rounded-full', m.result === 'W' ? 'bg-win' : m.result === 'L' ? 'bg-loss' : 'bg-faint')} />
      {!narrow && <Img src={m.agent?.icon} alt={m.agent?.name ?? ''} className="h-5 w-5 rounded-md bg-white/5" />}
      <span className="min-w-0 truncate text-ink/90" title={`${m.map ?? 'Unknown map'} · ${m.agent?.name ?? '—'} · ${m.queueTag}`}>
        {m.map ?? 'Unknown'}
      </span>
      {narrow ? (
        <span className="num whitespace-nowrap text-right text-muted">
          {m.kills}/{m.deaths}/{m.assists} <span className={tone}>{m.result}</span>
        </span>
      ) : (
        <>
          <span className="num text-right text-ink/90">
            {m.kills}/{m.deaths}/{m.assists}
          </span>
          <span className="num text-right text-muted">{m.acs} ACS</span>
          <span className={cx('num text-right font-semibold', tone)}>{m.score !== '-' ? m.score : m.result}</span>
        </>
      )}
    </div>
  );
}

function Stat({ k, v, row }: { k: string; v: ReactNode; row?: boolean }) {
  if (row) {
    return (
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-faint">{k}</span>
        <span className="num text-sm text-ink">{v}</span>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <div className="text-2xs text-faint">{k}</div>
      <div className="num truncate text-sm text-ink">{v}</div>
    </div>
  );
}

/** Expanded content: rank names, peak act, score breakdown, last 5 as mini rows, tracker.gg. */
export function PlayerDetail({ p, narrow }: { p: PlayerRow; narrow?: boolean }) {
  if (isHidden(p)) {
    return <div className="px-1 pb-1 pt-2 text-xs text-faint">Hidden player: SexyVal doesn’t look up their name, history or rank.</div>;
  }
  const cur = p.mmr?.status === 'done' ? p.mmr.current : undefined;
  const peak = p.mmr?.status === 'done' ? p.mmr.peak : undefined;
  const s = p.svScore;
  return (
    <div className="flex flex-col gap-3 pb-1 pt-3">
      <div className={cx('grid gap-3', narrow ? 'grid-cols-1' : 'grid-cols-2')}>
        <div className="flex min-w-0 items-center gap-2.5">
          {p.mmr?.status === 'done' ? <RankIcon rank={cur?.rank} size={32} /> : <Skeleton className="h-8 w-8 rounded-full" />}
          <div className="min-w-0">
            <div className="text-2xs text-faint">Current</div>
            {narrow && cur?.rank ? (
              <>
                <div className="text-[13px] font-medium leading-snug text-ink">{cur.rank.name}</div>
                <div className="num text-xs text-muted">{cur.rr} RR</div>
              </>
            ) : (
              <div className="truncate text-sm font-medium text-ink">{p.mmr?.status === 'error' ? '—' : cur?.rank ? `${cur.rank.name} · ${cur.rr} RR` : p.mmr?.status === 'done' ? 'Unrated' : '…'}</div>
            )}
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2.5">
          {p.mmr?.status === 'done' ? <RankIcon rank={peak?.rank} size={32} /> : <Skeleton className="h-8 w-8 rounded-full" />}
          <div className="min-w-0">
            <div className="text-2xs text-faint">Peak</div>
            {narrow && peak?.rank ? (
              <>
                <div className="text-[13px] font-medium leading-snug text-ink">{peak.rank.name}</div>
                {peak.act && <div className="text-xs leading-snug text-muted">{peak.act}</div>}
              </>
            ) : (
              <div className="truncate text-sm font-medium text-ink" title={peak?.act}>
                {p.mmr?.status === 'error' ? '—' : peak?.rank ? `${peak.rank.name}${peak.act ? ` · ${peak.act}` : ''}` : p.mmr?.status === 'done' ? 'Unrated' : '…'}
              </div>
            )}
          </div>
        </div>
      </div>
      {s ? (
        <div className={cx('grid rounded-2xl bg-white/[0.04] px-3 py-2.5', narrow ? 'grid-cols-1 gap-y-1' : 'grid-cols-7 gap-x-3 gap-y-2')}>
          <Stat row={narrow} k={narrow ? 'SV Score' : 'SV'} v={<span className="t-num text-[15px]">{s.score}</span>} />
          <Stat row={narrow} k="ACS" v={s.parts.acs} />
          <Stat row={narrow} k="K/D" v={kd(s.parts.kd)} />
          <Stat row={narrow} k="ADR" v={s.parts.adr} />
          <Stat row={narrow} k="HS%" v={`${s.parts.hsPct}%`} />
          <Stat row={narrow} k={narrow ? 'FB / round' : 'FB/rd'} v={s.parts.fbPerRound.toFixed(2)} />
          <Stat row={narrow} k="W–L" v={`${s.parts.wins}–${s.parts.losses}`} />
        </div>
      ) : (
        <div className="rounded-2xl bg-white/[0.04] px-3 py-2.5 text-xs text-muted">{p.last5.status === 'loading' || p.last5.status === 'idle' ? 'Loading recent matches…' : 'No SV Score: fewer than 3 recent matches with round data.'}</div>
      )}
      {p.last5.matches.length > 0 && (
        <div className="-mx-1.5 flex flex-col">
          {p.last5.matches.map((m) => (
            <MiniMatch key={m.matchId} m={m} narrow={narrow} />
          ))}
        </div>
      )}
      <div>
        <TrackerButton p={p} compact={narrow} />
      </div>
    </div>
  );
}
