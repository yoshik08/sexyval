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

interface Pt {
  x: number;
  y: number;
  label: string;
}

/** Single-series line with crosshair + tooltip. One y-axis only. */
export function LineChart({ points, height = 160, title, format = (v: number) => String(v), baseline }: { points: Pt[]; height?: number; title: string; format?: (v: number) => string; baseline?: number }) {
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
