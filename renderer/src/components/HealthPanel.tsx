import { useEffect, useRef, useState } from 'react';
import type { HealthReport, HealthState } from '../../../shared/health';
import { api } from '../lib/api';
import { cx } from '../lib/format';
import { Btn } from './kit';
import { showToast } from './ui';

const DOT: Record<HealthState, string> = { healthy: 'bg-win', connecting: 'bg-faint pulse-dot', degraded: 'bg-warn', offline: 'bg-warn', 'auth-required': 'bg-loss', error: 'bg-loss' };
const WORD: Record<HealthState, string> = { healthy: 'Healthy', connecting: 'Connecting', degraded: 'Degraded', offline: 'Offline', 'auth-required': 'Sign-in needed', error: 'Error' };

export function useHealth(): HealthReport | null {
  const [h, setH] = useState<HealthReport | null>(null);
  useEffect(() => {
    void api.rpc<HealthReport>('health:get').then(setH).catch(() => undefined);
    return api.on<HealthReport>('health', setH);
  }, []);
  return h;
}

/** Popover above the sidebar status pill: every component's state and the one action that helps. */
export function HealthPanel({ h, onClose, onSettings }: { h: HealthReport; onClose: () => void; onSettings: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-health-pill]') && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  const reconnect = async () => {
    setBusy(true);
    try {
      await api.rpc('health:reconnect');
      showToast('Reconnecting…', 'info');
    } finally {
      setTimeout(() => setBusy(false), 1500);
    }
  };
  return (
    <div ref={ref} role="dialog" aria-label="Connection health" className="pop-in material-thick absolute bottom-[calc(100%+8px)] left-0 z-[70] w-[340px] rounded-2xl p-2 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.9)] ring-1 ring-white/10" style={{ ['--origin' as string]: '20% 100%' }}>
      <div className="px-3 pb-2 pt-1.5">
        <div className="text-sm font-semibold text-ink">Connection health</div>
        <div className="text-xs text-muted">{h.summary}</div>
      </div>
      {h.items.map((i) => (
        <div key={i.id} className="flex items-start gap-2.5 rounded-xl px-3 py-2">
          <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', DOT[i.state])} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="text-ink">{i.label}</span>
              <span className="text-2xs text-faint">{WORD[i.state]}</span>
            </div>
            <div className="text-xs leading-snug text-muted">{i.detail}</div>
          </div>
        </div>
      ))}
      <div className="flex gap-2 px-2 pb-1 pt-2">
        <Btn size="sm" onClick={() => void reconnect()} disabled={busy}>
          Reconnect
        </Btn>
        {h.items.some((i) => i.action === 'sign-in' || i.action === 'retry-accounts') && (
          <Btn size="sm" tone="ghost" onClick={onSettings}>
            Accounts…
          </Btn>
        )}
      </div>
    </div>
  );
}
