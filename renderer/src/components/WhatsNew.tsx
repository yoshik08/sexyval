import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { Btn } from './kit';

/** **bold** inside a line. */
function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') ? <strong key={i} className="font-semibold text-ink">{p.slice(2, -2)}</strong> : <Fragment key={i}>{p}</Fragment>));
}

/** Shown once after an update: that version's GitHub release notes (a tiny markdown subset: headings, bullets, bold). */
export function WhatsNew() {
  const [n, setN] = useState<{ version: string; from: string; notes: string } | null>(null);
  useEffect(() => {
    void api.rpc<typeof n>('app:whatsNew').then(setN).catch(() => undefined);
  }, []);
  if (!n) return null;
  const lines = n.notes.split(/\r?\n/).filter((l) => l.trim());
  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/70 p-8" role="dialog" aria-modal="true" onClick={() => setN(null)}>
      <div className="sheet-in max-h-full w-full max-w-[560px] overflow-y-auto rounded-[28px] bg-[#101012] p-7 ring-1 ring-white/10" onClick={(e) => e.stopPropagation()}>
        <div className="text-xs text-muted">Updated from {n.from}</div>
        <h2 className="t-title mt-1 text-[28px] text-ink">What’s new in {n.version}</h2>
        <div className="mt-4 flex flex-col gap-2 text-sm leading-relaxed text-ink/80">
          {lines.map((l, i) =>
            /^#+\s/.test(l) ? (
              <h3 key={i} className="t-head mt-2 text-md text-ink">{l.replace(/^#+\s/, '')}</h3>
            ) : /^[-*]\s/.test(l) ? (
              <div key={i} className="flex gap-2.5">
                <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-white/50" />
                <span>{inline(l.replace(/^[-*]\s/, ''))}</span>
              </div>
            ) : (
              <p key={i}>{inline(l)}</p>
            ),
          )}
        </div>
        <div className="mt-6 flex justify-end">
          <Btn tone="primary" onClick={() => setN(null)}>Got it</Btn>
        </div>
      </div>
    </div>
  );
}
