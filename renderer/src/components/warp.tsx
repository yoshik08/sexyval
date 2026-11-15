import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { WarpStatus } from '../../../shared/warp';
import { api } from '../lib/api';
import { cx } from '../lib/format';
import { Cloud } from '../lib/icons';
import { Btn } from './kit';
import { Segmented } from './ui';

const STATE_TEXT: Record<WarpStatus['phase'], string> = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  'registration-missing': 'Disconnected · not registered yet',
  'not-installed': 'Not installed',
  'service-down': "WARP service isn't running",
  error: 'Status unknown',
};

const pct = (s: WarpStatus) => (s.install.total ? Math.min(100, Math.round((s.install.received / s.install.total) * 100)) : null);
const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

/**
 * Sidebar row above Settings: Cloudflare WARP on/off through the official warp-cli, or a button that
 * fetches Cloudflare's installer. Every state shown is the one warp-cli reports.
 */
export function WarpRow() {
  const [s, setS] = useState<WarpStatus | null>(null);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [pending, setPending] = useState<'on' | 'off' | null>(null);

  const call = useCallback((method: string, ...args: unknown[]) => {
    setRpcError(null);
    api
      .rpc<WarpStatus | null>(method, ...args)
      .then((next) => next && setS(next))
      .catch((e: unknown) => setRpcError(e instanceof Error ? e.message.replace(/^Error invoking remote method 'rpc': (Error: )?/, '') : String(e)));
  }, []);
  const refresh = useCallback(() => call('warp:status'), [call]);

  useEffect(() => {
    const off = api.on<WarpStatus>('warp', setS);
    refresh();
    // Re-check when the window comes back (e.g. after Cloudflare's installer closes) and now and then.
    const onFocus = () => refresh();
    const onVis = () => document.visibilityState === 'visible' && refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    const t = setInterval(() => document.visibilityState === 'visible' && refresh(), 15_000);
    return () => {
      off();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(t);
    };
  }, [refresh]);

  useEffect(() => {
    if (s && !s.busy) setPending(null);
  }, [s]);

  const phase = s?.phase;
  const installing = s?.install.stage === 'downloading' || s?.install.stage === 'installing';
  const toggleable = phase === 'connected' || phase === 'disconnected' || phase === 'registration-missing' || phase === 'connecting' || phase === 'error';
  const value = phase === 'connected' ? 'on' : phase === 'disconnected' || phase === 'registration-missing' ? 'off' : ('' as 'on' | 'off');

  let right: ReactNode = null;
  if (!s) right = null;
  else if (phase === 'not-installed' || installing || s.install.stage === 'error')
    right = (
      <Btn size="sm" tone="primary" className="!h-7 !px-2.5 !text-xs" disabled={installing} onClick={() => call('warp:install')}>
        {s.install.stage === 'downloading' ? `${pct(s) ?? '…'}${pct(s) != null ? '%' : ''}` : s.install.stage === 'installing' ? 'Installing' : 'Install WARP'}
      </Btn>
    );
  else if (phase === 'service-down')
    right = (
      <Btn size="sm" className="!h-7 !px-2.5 !text-xs" onClick={refresh}>
        Retry
      </Btn>
    );
  else if (toggleable)
    right = (
      <div className={cx(s.busy && 'pointer-events-none opacity-60')} aria-busy={s.busy}>
        <Segmented
          size="sm"
          className="!h-7 [&>button]:!px-2.5 [&>button]:!text-xs"
          value={value}
          options={[
            ['on', 'On'],
            ['off', 'Off'],
          ]}
          onChange={(v) => {
            if (v === value) return;
            setPending(v);
            call('warp:set', v === 'on');
          }}
        />
      </div>
    );

  const dot = phase === 'connected' ? 'bg-win' : phase === 'connecting' || s?.busy ? 'bg-warn' : phase === 'service-down' || phase === 'error' ? 'bg-loss' : 'bg-faint';
  let line = s ? STATE_TEXT[s.phase] : 'Checking…';
  if (s?.busy && pending) line = pending === 'on' ? 'Connecting…' : 'Disconnecting…';
  if (s?.install.stage === 'downloading') {
    line = s.install.total && s.install.received >= s.install.total ? 'Checking signature…' : s.install.total ? `${mb(s.install.received)} of ${mb(s.install.total)}` : mb(s.install.received);
    // A damaged download is fetched again on its own; say so instead of silently restarting at 0%.
    if ((s.install.attempt ?? 1) > 1 && line !== 'Checking signature…') line = `Retrying · ${line}`;
  }
  if (s?.install.stage === 'installing') line = "Finish in Cloudflare's installer";
  const error = rpcError ?? (s?.install.stage === 'error' ? s.install.error : s?.error);

  return (
    <div className="px-3 pb-2">
      <div className="flex h-9 items-center gap-2.5">
        <Cloud size={20} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 text-[14px] font-medium text-muted">WARP</span>
        {right}
      </div>
      <div className="flex items-center gap-1.5 pl-[30px] text-xs text-muted" aria-live="polite">
        <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
        <span className="truncate">{line}</span>
      </div>
      {s?.install.stage === 'downloading' && (
        <div className="ml-[30px] mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.08]">
          <div className="h-full rounded-full bg-white transition-[width] duration-150" style={{ width: `${pct(s) ?? 0}%` }} />
        </div>
      )}
      {error && (
        <p className="ml-[30px] mt-1 line-clamp-4 select-text break-words text-2xs text-loss" title={error}>
          {error}
        </p>
      )}
      <p className="mt-1 text-2xs text-faint">Whole PC, not just Valorant. Set it before you launch: switching mid-match can drop you.</p>
    </div>
  );
}
