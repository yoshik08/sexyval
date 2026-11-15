import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../lib/format';
import { img } from '../lib/media';
import { useCatalog } from '../lib/store';
import { MagnifyingGlass } from '../lib/icons';
import { Img } from './ui';
import { openSkin } from './SkinDetail';

export interface PaletteNav {
  label: string;
  hint?: string;
  view: string;
  sub?: string;
}

type Item = { key: string; label: string; hint?: string; icon?: string; run: () => void };

/**
 * Ctrl+K: jump anywhere. Screens and their tabs, a Name#Tag to open (profile or MMR), and any skin in the
 * catalog (opens its sheet). Arrow keys + Enter, Esc closes.
 */
export function CommandPalette({ open, onClose, navs, go, openPlayer }: { open: boolean; onClose: () => void; navs: PaletteNav[]; go: (view: string, sub?: string) => void; openPlayer: (view: 'profiles' | 'mmr', q: string) => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const catalog = useCatalog();
  useEffect(() => {
    if (open) {
      setQ('');
      setI(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);
  const items = useMemo<Item[]>(() => {
    const t = q.trim().toLowerCase();
    const out: Item[] = [];
    if (/^.+#.+$/.test(q.trim())) {
      out.push({ key: 'p', label: `Open profile of ${q.trim()}`, hint: 'Player', run: () => openPlayer('profiles', q.trim()) });
      out.push({ key: 'm', label: `Estimated MMR of ${q.trim()}`, hint: 'Player', run: () => openPlayer('mmr', q.trim()) });
    }
    const words = t.split(/\s+/).filter(Boolean);
    const hit = (s: string) => words.every((w) => s.toLowerCase().includes(w));
    for (const n of navs) if (!t || hit(`${n.label} ${n.hint ?? ''}`)) out.push({ key: `n:${n.view}:${n.sub ?? ''}`, label: n.label, hint: n.hint ?? 'Go to', run: () => go(n.view, n.sub) });
    if (t.length >= 2) {
      let n = 0;
      for (const s of catalog.skins) {
        if (n >= 30) break;
        if (hit(s.name)) {
          n++;
          out.push({ key: `s:${s.id}`, label: s.name, hint: 'Skin', icon: img(s.icon), run: () => openSkin(s.id) });
        }
      }
    }
    return out;
  }, [q, navs, catalog.skins, go, openPlayer]);
  useEffect(() => setI(0), [q]);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [i]);
  if (!open) return null;
  const run = (it?: Item) => {
    if (!it) return;
    onClose();
    it.run();
  };
  return (
    <div className="fixed inset-0 z-[75] flex items-start justify-center bg-black/55 pt-[12vh]" onMouseDown={onClose}>
      <div className="pop-in material-thick w-[min(620px,92vw)] overflow-hidden rounded-[22px] shadow-[0_30px_80px_-12px_rgba(0,0,0,0.95)] ring-1 ring-white/10" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="flex items-center gap-3 border-b border-white/[0.08] px-4">
          <MagnifyingGlass size={17} weight="bold" className="text-faint" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setI((x) => Math.min(items.length - 1, x + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setI((x) => Math.max(0, x - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(items[i]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="Go to a screen, type Name#Tag, or search a skin"
            className="h-14 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-faint"
          />
          <kbd className="rounded-md bg-white/[0.08] px-1.5 py-0.5 text-2xs text-muted">Esc</kbd>
        </div>
        <div ref={list} className="max-h-[360px] overflow-y-auto p-1.5">
          {items.map((it, k) => (
            <button
              key={it.key}
              data-active={k === i}
              onMouseEnter={() => setI(k)}
              onClick={() => run(it)}
              className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm', k === i ? 'bg-white/[0.1] text-ink' : 'text-ink/85')}
            >
              {it.icon ? <Img src={it.icon} alt="" className="h-6 w-12 object-contain" /> : <span className="w-0" />}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.hint && <span className="text-xs text-faint">{it.hint}</span>}
            </button>
          ))}
          {!items.length && <div className="px-3 py-6 text-center text-sm text-muted">Nothing found.</div>}
        </div>
        <div className="flex gap-4 border-t border-white/[0.08] px-4 py-2 text-2xs text-faint">
          <span>↑↓ choose · Enter open</span>
          <span>Ctrl+1…0 jumps to sidebar items</span>
        </div>
      </div>
    </div>
  );
}
