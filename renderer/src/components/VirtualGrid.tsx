import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Fixed-row-height virtualized grid. Only rows near the viewport mount, so images
 * load lazily and off-screen preview videos unmount.
 */
export function VirtualGrid<T>({
  items,
  minColWidth,
  rowHeight,
  gap = 12,
  render,
  className,
  keyOf,
}: {
  items: T[];
  minColWidth: number;
  rowHeight: number;
  gap?: number;
  render: (item: T, index: number) => ReactNode;
  className?: string;
  keyOf: (item: T) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 900, height: 600, top: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      setBox({ width: el.clientWidth - padX, height: el.clientHeight, top: el.scrollTop });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const onScroll = () => setBox((b) => ({ ...b, top: el.scrollTop }));
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  // Reset scroll when the list changes (new filter).
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [items]);

  const cols = Math.max(1, Math.floor((box.width + gap) / (minColWidth + gap)));
  const colWidth = (box.width - gap * (cols - 1)) / cols;
  const rows = Math.ceil(items.length / cols);
  const stride = rowHeight + gap;
  const first = Math.max(0, Math.floor(box.top / stride) - 2);
  const last = Math.min(rows, Math.ceil((box.top + box.height) / stride) + 2);
  const visible: ReactNode[] = [];
  for (let r = first; r < last; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= items.length) break;
      visible.push(
        <div key={keyOf(items[i])} className="absolute" style={{ top: r * stride, left: c * (colWidth + gap), width: colWidth, height: rowHeight }}>
          {render(items[i], i)}
        </div>,
      );
    }
  }
  return (
    <div ref={ref} className={className} style={{ overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}>
      <div style={{ height: Math.max(0, rows * stride - gap), position: 'relative' }}>{visible}</div>
    </div>
  );
}
