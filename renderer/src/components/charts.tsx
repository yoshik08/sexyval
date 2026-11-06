import { useLayoutEffect, useState } from 'react';

/** Width of an element in CSS px, kept current. Charts draw at their real size so text never scales with the window. */
function useWidth<T extends HTMLElement>(fallback: number) {
  const [el, ref] = useState<T | null>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    if (!el) return;
    setW(Math.max(120, Math.round(el.getBoundingClientRect().width)));
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [ref, w] as const;
}

// Chart colors validated with the dataviz palette script against the panel surface (#11161d):
// gain/loss diverging pair passes lightness, chroma, CVD and contrast checks.
export const CHART = { series: '#29a894', gain: '#29a894', loss: '#ff4655', grid: 'rgba(236,232,225,0.07)', axis: '#5f6875' };
/** Fixed categorical order for multi-line charts (validated on #0b0b0d: lightness, chroma, CVD ΔE ≥ 13, contrast). */
export const SERIES = ['#7b7be0', '#b87a1e', '#29a894'] as const;

export interface Series {
  key: string;
  label: string;
  color: string;
  /** One value per x index; undefined = gap. */
  values: (number | undefined)[];
  dashed?: boolean;
}

/** Several lines on one y-axis with a legend, a crosshair and one tooltip listing every series. */
export function MultiLineChart({ series, height = 220, title, format = (v: number) => String(v), tip, yTicks }: { series: Series[]; height?: number; title: string; format?: (v: number) => string; tip?: (i: number) => React.ReactNode; yTicks?: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [box, W] = useWidth<HTMLDivElement>(720);
  const H = height;
  const pad = { l: 64, r: 12, t: 10, b: 18 };
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  if (n < 2 || !all.length) return <div className="flex h-[120px] items-center justify-center text-sm text-muted">Not enough data for {title.toLowerCase()}.</div>;
  const min = Math.floor(Math.min(...all) - 0.3);
  const max = Math.ceil(Math.max(...all) + 0.3);
  const span = max - min || 1;
  const x = (i: number) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b);
  const path = (vals: (number | undefined)[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v == null) return void (pen = false);
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d;
  };
  const ticks = yTicks?.filter((t) => t >= min && t <= max) ?? [min, min + span / 2, max];
  return (
    <div ref={box} className="relative">
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-hidden>
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <svg width="18" height="6">
              <line x1="1" x2="17" y1="3" y2="3" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeDasharray={s.dashed ? '3 3' : undefined} />
            </svg>
            {s.label}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        className="block w-full"
        role="img"
        aria-label={title}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1)))));
        }}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={CHART.grid} />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize="11" fill={CHART.axis}>
              {format(t)}
            </text>
          </g>
        ))}
        {series.map((s) => (
          <path key={s.key} d={path(s.values)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? '4 4' : undefined} />
        ))}
        {hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="rgba(236,232,225,0.25)" />
            {series.map((s) => (s.values[hover] != null ? <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r="4.5" fill={s.color} stroke="#0b0b0d" strokeWidth="2" /> : null))}
          </>
        )}
      </svg>
      {hover != null && (
        <div
          className="pointer-events-none absolute top-6 z-10 min-w-[180px] rounded-sm border border-line2 bg-raised px-2.5 py-1.5 text-xs shadow-lg shadow-black/40"
          style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(${hover > n / 2 ? 'calc(-100% - 8px)' : '8px'})` }}
        >
          {tip?.(hover)}
          <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3">
            {series.map((s) =>
              s.values[hover] != null ? (
                <span key={s.key} className="contents">
                  <span className="inline-flex items-center gap-1.5 text-muted">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span className="num text-right text-ink">{format(s.values[hover]!)}</span>
                </span>
              ) : null,
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface Pt {
  x: number;
  y: number;
  label: string;
}

/** Single-series line with crosshair + tooltip. One y-axis only. */
export function LineChart({ points, height = 160, title, format = (v: number) => String(v), baseline, marks }: { points: Pt[]; height?: number; title: string; format?: (v: number) => string; baseline?: number; marks?: { index: number; label?: string }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [box, W] = useWidth<HTMLDivElement>(560);
  const H = height;
  const pad = { l: 44, r: 12, t: 10, b: 18 };
  if (points.length < 2) return <div className="flex h-[120px] items-center justify-center text-sm text-muted">Not enough data for {title.toLowerCase()}.</div>;
  const ys = points.map((p) => p.y);
  const min = Math.min(...ys, baseline ?? Infinity);
  const max = Math.max(...ys, baseline ?? -Infinity);
  const span = max - min || 1;
  const x = (i: number) => pad.l + (i / (points.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
  const ticks = [min, min + span / 2, max];
  const h = hover != null ? points[hover] : null;
  return (
    <div ref={box} className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W} height={H} className="block w-full"
        role="img"
        aria-label={title}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, i)));
        }}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={CHART.grid} />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize="11" fill={CHART.axis}>
              {format(Math.round(t * 100) / 100)}
            </text>
          </g>
        ))}
        {baseline != null && <line x1={pad.l} x2={W - pad.r} y1={y(baseline)} y2={y(baseline)} stroke="rgba(236,232,225,0.25)" strokeDasharray="3 3" />}
        {marks?.filter((m) => m.index > 0).map((m) => (
          <g key={m.index}>
            <line x1={x(m.index)} x2={x(m.index)} y1={pad.t} y2={H - pad.b} stroke="rgba(236,232,225,0.22)" strokeDasharray="2 3" />
            {m.label && (
              <text x={x(m.index) + 4} y={pad.t + 10} fontSize="10" fill={CHART.axis}>
                {m.label}
              </text>
            )}
          </g>
        ))}
        <path d={d} fill="none" stroke={CHART.series} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="rgba(236,232,225,0.25)" />
            <circle cx={x(hover)} cy={y(points[hover].y)} r="4.5" fill={CHART.series} stroke="#11161d" strokeWidth="2" />
          </>
        )}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute top-1 rounded-sm border border-line2 bg-raised px-2.5 py-1.5 text-xs shadow-lg shadow-black/40"
          style={{ left: `${(x(hover!) / W) * 100}%`, transform: `translateX(${hover! > points.length / 2 ? 'calc(-100% - 8px)' : '8px'})` }}
        >
          <div className="text-muted">{h.label}</div>
          <div className="num text-ink">{format(h.y)}</div>
        </div>
      )}
    </div>
  );
}

/** Diverging bars around zero (e.g. RR gained/lost per match), with hover tooltip. */
export function DeltaBars({ values, height = 120, title }: { values: { v: number; label: string }[]; height?: number; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [box, W] = useWidth<HTMLDivElement>(560);
  const H = height;
  if (!values.length) return <div className="flex h-[80px] items-center justify-center text-sm text-muted">No {title.toLowerCase()} yet.</div>;
  const m = Math.max(1, ...values.map((d) => Math.abs(d.v)));
  const zero = H / 2;
  const slot = W / values.length;
  const bw = Math.max(3, Math.min(18, slot - 2)); // 2px surface gap between bars
  const h = hover != null ? values[hover] : null;
  return (
    <div ref={box} className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block w-full" role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
        <line x1="0" x2={W} y1={zero} y2={zero} stroke="rgba(236,232,225,0.25)" />
        {values.map((d, i) => {
          const len = (Math.abs(d.v) / m) * (H / 2 - 6);
          const x = i * slot + (slot - bw) / 2;
          const r = Math.min(4, bw / 2, len);
          const up = d.v >= 0;
          // 4px rounded end away from the baseline, square at the baseline.
          const path = up
            ? `M${x},${zero} V${zero - len + r} Q${x},${zero - len} ${x + r},${zero - len} H${x + bw - r} Q${x + bw},${zero - len} ${x + bw},${zero - len + r} V${zero} Z`
            : `M${x},${zero} V${zero + len - r} Q${x},${zero + len} ${x + r},${zero + len} H${x + bw - r} Q${x + bw},${zero + len} ${x + bw},${zero + len - r} V${zero} Z`;
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={i * slot} y="0" width={slot} height={H} fill="transparent" />
              <path d={path} fill={up ? CHART.gain : CHART.loss} opacity={hover == null || hover === i ? 1 : 0.5} />
            </g>
          );
        })}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute top-0 rounded-sm border border-line2 bg-raised px-2.5 py-1.5 text-xs shadow-lg shadow-black/40"
          style={{ left: `${((hover! + 0.5) / values.length) * 100}%`, transform: `translateX(${hover! > values.length / 2 ? 'calc(-100% - 8px)' : '8px'})` }}
        >
          <div className="text-muted">{h.label}</div>
          <div className="num text-ink">{h.v > 0 ? `+${h.v}` : h.v} RR</div>
        </div>
      )}
    </div>
  );
}

/** Horizontal magnitude bars (single hue) with direct value labels; table-like for accessibility. */
export function HBars({ rows, max = 100, unit = '%' }: { rows: { key: string; label: string; value: number; sub: string; icon?: React.ReactNode }[]; max?: number; unit?: string }) {
  return (
    <div className="flex flex-col gap-2" role="table">
      {rows.map((r) => (
        <div key={r.key} role="row" className="grid grid-cols-[minmax(0,150px)_minmax(40px,1fr)_auto] items-center gap-3" title={`${r.label}: ${r.value}${unit} · ${r.sub}`}>
          <div role="cell" className="flex min-w-0 items-center gap-2 text-sm">
            {r.icon}
            <span className="truncate">{r.label}</span>
          </div>
          <div role="cell" className="h-2 overflow-hidden rounded-full bg-white/5">
            <div className="h-full rounded-full" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: CHART.series }} />
          </div>
          <div role="cell" className="num text-right text-sm">
            {r.value}
            {unit}
            <div className="text-2xs text-faint">{r.sub}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
