import { useEffect, useState } from 'react';
import type { NetworkStatus, PerfStatus } from '../../../shared/features';
import type { Settings } from '../../../shared/types';
import type { ValWebStatus } from '../../../shared/valWeb';
import { parseProxy, cacheLabel } from '../../../shared/netRoute';
import { LITE_EFFECTS } from '../../../shared/perf';
import { ago, cx } from '../lib/format';
import { api } from '../lib/api';
import { saveSettings, useSettings } from '../lib/store';
import { Panel, Segmented, Skeleton, showToast } from '../components/ui';
import { act, Btn, ErrorNote, Note } from '../components/kit';

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-4">
      <div className="min-w-0">
        <div className="text-sm text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ---------------- Network (Smart Store Sync) ----------------
export function NetworkTab() {
  const s = useSettings();
  const [st, setSt] = useState<NetworkStatus | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => void act<NetworkStatus>('network:status').then((r) => r.ok && setSt(r.data));
  useEffect(load, []);
  useEffect(() => setUrl(s?.proxyUrl ?? ''), [s?.proxyUrl]);
  if (!s) return <Skeleton className="h-72" />;
  const parsed = url.trim() ? parseProxy(url) : null;
  const saveUrl = () => (parsed?.ok || !url.trim() ? saveSettings({ proxyUrl: url.trim() }) : showToast(parsed && !parsed.ok ? parsed.error : 'Invalid', 'error'));
  const warpProxy = st?.warp.mode?.toLowerCase() === 'proxy';
  return (
    <div className="flex flex-col gap-6">
      <Panel className="divide-y divide-white/[0.06] px-6">
        <Row label="Store connection" hint="Applies to store and wallet requests only. Sign-in and live game data always go direct.">
          <Segmented
            size="sm"
            value={s.netMode}
            options={[
              ['direct', 'Direct'],
              ['fallback', 'Direct, then proxy'],
              ['proxy', 'Proxy only'],
            ]}
            onChange={(v: Settings['netMode']) => void saveSettings({ netMode: v })}
          />
        </Row>
        <div className="py-4">
          <div className="text-sm text-ink">Proxy on this PC</div>
          <div className="mt-0.5 text-xs text-muted">socks5:// or http:// on 127.0.0.1 only. A proxy elsewhere would sit between you and Riot, so it is refused.</div>
          <div className="mt-3 flex gap-2">
            <input value={url} onChange={(e) => setUrl(e.target.value)} onBlur={saveUrl} placeholder="socks5://127.0.0.1:40000" className="field w-80 font-mono text-xs" spellCheck={false} />
            <Btn
              size="sm"
              disabled={busy || !parsed?.ok}
              onClick={async () => {
                setBusy(true);
                const r = await act<{ ok: boolean; ms?: number; error?: string }>('network:test', url.trim());
                setBusy(false);
                if (r.ok && r.data.ok) showToast(`Proxy works (${r.data.ms} ms)`);
                else showToast(r.ok ? (r.data.error ?? 'Proxy failed') : r.error, 'error');
                load();
              }}
            >
              Test
            </Btn>
            {st?.warp.installed && (
              <Btn size="sm" tone="ghost" onClick={() => setUrl(`socks5://127.0.0.1:${st.warp.proxyPort ?? 40000}`)}>
                Use WARP’s proxy
              </Btn>
            )}
          </div>
          {parsed && !parsed.ok && <p className="mt-2 text-xs text-warn">{parsed.error}</p>}
          {st?.warp.installed && (
            <p className="mt-3 text-xs text-muted">
              Cloudflare WARP is in <span className="text-ink">{st.warp.mode ?? 'unknown'}</span> mode.{' '}
              {warpProxy
                ? 'Its SOCKS5 proxy is available to SexyVal.'
                : 'WARP only offers a proxy in proxy mode (run “warp-cli mode proxy” yourself; that replaces the PC-wide tunnel until you switch back with “warp-cli mode warp”). SexyVal never changes WARP’s mode.'}
            </p>
          )}
        </div>
      </Panel>

      <section>
        <div className="mb-3 flex items-center justify-between px-1">
          <h2 className="t-head text-md text-ink">Sync status</h2>
          <Btn
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await act('network:syncNow');
              setBusy(false);
              load();
            }}
          >
            Sync now
          </Btn>
        </div>
        {!st ? (
          <Skeleton className="h-28" />
        ) : (
          <Panel className="divide-y divide-white/[0.06]">
            {st.active && (
              <div className="flex items-center gap-4 px-6 py-3">
                <span className={cx('h-2 w-2 rounded-full', st.active.status === 'error' ? 'bg-warn' : 'bg-win')} />
                <div className="min-w-0 flex-1 text-sm text-ink">{st.active.label} <span className="text-faint">· active</span></div>
                <div className="text-xs text-muted">{st.active.status === 'error' ? `Failed${st.active.cached ? `, showing the store ${cacheLabel(st.active.fetchedAt, Date.now()).toLowerCase()}` : ''}` : cacheLabel(st.active.fetchedAt, Date.now())}</div>
              </div>
            )}
            {st.others.map((o) => (
              <div key={o.puuid} className="flex items-center gap-4 px-6 py-3">
                <span className={cx('h-2 w-2 rounded-full', o.ok ? 'bg-win' : 'bg-warn')} />
                <div className="min-w-0 flex-1 truncate text-sm text-ink">{o.label}</div>
                <div className="truncate text-xs text-muted" title={o.error}>
                  {o.ok ? `Synced ${ago(o.lastOkAt!)}${o.route === 'proxy' ? ' via proxy' : ''}` : `${o.error ?? 'Failed'}${o.lastOkAt ? ` · last good ${ago(o.lastOkAt)}` : ''}`}
                </div>
              </div>
            ))}
            {!st.active && !st.others.length && <div className="px-6 py-4 text-sm text-muted">No account signed in yet.</div>}
            <div className="px-6 py-3 text-xs text-faint">
              {st.route.lastRoute ? `Last store request went ${st.route.lastRoute === 'proxy' ? 'through the proxy' : 'direct'}${st.route.lastOkAt ? ` ${ago(st.route.lastOkAt)}` : ''}.` : 'No store request yet this run.'}
              {st.route.lastError && ` Last error: ${st.route.lastError}`}
            </div>
          </Panel>
        )}
      </section>
      <Note>A failed sync never signs an account out or clears its store: the last good store stays on screen with the time it was fetched, and the next rotation tries again. Use a proxy only where your network’s rules allow it.</Note>

      <ValWebPanel />
    </div>
  );
}

const CONSENT = [
  'SexyVal sends a Riot session key (the cookies that keep you signed in — never your password) to a server I run on Cloudflare.',
  'The server stores that key encrypted and uses it only to fetch your own store, at the daily reset, on days this app is closed.',
  'Your store (skin IDs, prices, rotation date) is kept for up to 48 hours so the page can show it. No other player, no match data, no purchases.',
  'The key stays usable while you open SexyVal every so often (about once a month). If it expires, the server deletes it and the page asks you to open SexyVal again.',
  'This uses Riot’s unofficial game-client store endpoint, not an official Riot API. Turning it on is your choice; turning it off deletes the key and your store from the server immediately.',
];

// ---------------- yoshik.xyz/val (web store sync) ----------------
function ValWebPanel() {
  const [st, setSt] = useState<ValWebStatus | null>(null);
  const [stage, setStage] = useState<'idle' | 'consent'>('idle');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    void act<ValWebStatus>('val:status').then((r) => r.ok && setSt(r.data));
    const off = api.on<ValWebStatus>('val', setSt);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  const connect = async () => {
    setBusy(true);
    const r = await act<ValWebStatus>('val:connect', true);
    setBusy(false);
    if (r.ok) {
      setSt(r.data);
      setStage('idle');
      setAgree(false);
    } else showToast(r.error, 'error');
  };
  const disconnect = async () => {
    if (!window.confirm('Disconnect /val? Your session key and saved store are deleted from the server right away.')) return;
    setBusy(true);
    const r = await act<ValWebStatus>('val:disconnect');
    setBusy(false);
    if (r.ok) setSt(r.data);
    else showToast(r.error, 'error');
  };
  const copy = (text: string, what: string) => void navigator.clipboard?.writeText(text).then(() => showToast(`${what} copied`)).catch(() => undefined);

  const codeLive = st?.code && (st.codeExpiresAt ?? 0) > now;
  const codeMins = st?.codeExpiresAt ? Math.max(0, Math.ceil((st.codeExpiresAt - now) / 60000)) : 0;

  return (
    <section>
      <div className="mb-3 flex items-center gap-2 px-1">
        <h2 className="t-head text-md text-ink">Web store · yoshik.xyz/val</h2>
        {st?.linked && <span className="rounded-full bg-win/15 px-2 py-0.5 text-2xs font-semibold text-win">Connected</span>}
      </div>

      {!st?.linked && stage === 'idle' && (
        <Panel className="px-6 py-5">
          <p className="text-pretty text-sm text-muted">
            See this account’s daily store from your phone at <span className="text-ink">yoshik.xyz/val</span> — even on days you don’t open SexyVal or Valorant.{' '}
            <span className="text-ink">It sends your Riot sign-in cookies to a server</span>, so read the details before you turn it on.
          </p>
          <div className="mt-4">
            <Btn tone="primary" size="sm" onClick={() => setStage('consent')}>
              Set up /val…
            </Btn>
          </div>
        </Panel>
      )}

      {!st?.linked && stage === 'consent' && (
        <Panel className="px-6 py-5">
          <h3 className="text-base text-ink">Before you turn this on</h3>
          <ul className="mt-3 flex flex-col gap-2.5">
            {CONSENT.map((line, i) => (
              <li key={i} className="flex gap-2.5 text-sm text-muted">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-faint" />
                <span className="text-pretty">{line}</span>
              </li>
            ))}
          </ul>
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm text-ink">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 h-4 w-4 accent-white" />
            <span>I understand my Riot session cookies will be stored on the server, encrypted, for up to ~30 days.</span>
          </label>
          <div className="mt-4 flex gap-2">
            <Btn tone="primary" size="sm" disabled={!agree || busy} onClick={connect}>
              {busy ? 'Connecting…' : 'Turn on and get my code'}
            </Btn>
            <Btn size="sm" tone="ghost" onClick={() => (setStage('idle'), setAgree(false))}>
              Cancel
            </Btn>
          </div>
        </Panel>
      )}

      {st?.linked && (
        <div className="flex flex-col gap-3">
          {codeLive && (
            <Panel className="px-6 py-5">
              <p className="text-sm text-muted">
                Open <button onClick={() => copy(st.url, 'Link')} className="text-ink underline decoration-white/30 underline-offset-2">{st.url.replace(/^https?:\/\//, '')}</button> on your phone and enter this code once:
              </p>
              <button
                onClick={() => copy(st.code!, 'Code')}
                className="press mt-3 w-full rounded-2xl bg-white/[0.06] py-5 text-center ring-1 ring-inset ring-white/10 hover:bg-white/[0.09]"
                title="Copy code"
              >
                <span className="t-num text-[34px] tracking-[0.28em] text-ink">{st.code}</span>
              </button>
              <p className="mt-2.5 text-xs text-faint">Expires in {codeMins} min. One use. After you’ve linked your phone, you don’t need it again.</p>
            </Panel>
          )}
          <Panel className="divide-y divide-white/[0.06] px-6">
            <div className="flex items-center justify-between gap-6 py-3.5">
              <div className="min-w-0">
                <div className="text-sm text-ink">{st.label ?? 'Linked account'}</div>
                <div className="mt-0.5 text-xs text-muted">
                  {st.lastKeyAt ? `Session key sent ${ago(st.lastKeyAt)}` : 'Session key not sent yet'}
                  {st.keyValidUntil ? ` · valid until ${st.keyValidUntil}` : ''}
                </div>
              </div>
              <Btn
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const r = await act<ValWebStatus>('val:syncNow');
                  setBusy(false);
                  if (r.ok) setSt(r.data);
                  else showToast(r.error, 'error');
                }}
              >
                Sync now
              </Btn>
            </div>
            <div className="flex items-center justify-between gap-6 py-3.5">
              <div className="text-sm text-muted">{st.lastSnapshotAt ? `Store uploaded ${ago(st.lastSnapshotAt)}` : 'Store not uploaded yet'}</div>
              {!codeLive && (
                <Btn
                  size="sm"
                  tone="ghost"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const r = await act<ValWebStatus>('val:connect', true);
                    setBusy(false);
                    if (r.ok) setSt(r.data);
                    else showToast(r.error, 'error');
                  }}
                >
                  New phone code
                </Btn>
              )}
            </div>
          </Panel>
          {st.lastError && <ErrorNote>{st.lastError}</ErrorNote>}
          <div className="px-1">
            <Btn size="sm" tone="danger" disabled={busy} onClick={disconnect}>
              Disconnect /val
            </Btn>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------- Performance (lightweight mode) ----------------
export function PerformanceTab() {
  const s = useSettings();
  const [st, setSt] = useState<PerfStatus | null>(null);
  const load = (sample = false) => void act<PerfStatus>('perf:status', sample).then((r) => r.ok && setSt(r.data));
  useEffect(() => {
    load(true);
    const h = setInterval(() => load(true), 5000);
    return () => clearInterval(h);
  }, []);
  if (!s) return <Skeleton className="h-72" />;
  return (
    <div className="flex flex-col gap-6">
      <Panel className="divide-y divide-white/[0.06] px-6">
        <Row label="Lightweight mode" hint="Keeps SexyVal out of the game’s way. Live, overlay, account switching and your store never wait.">
          <Segmented
            size="sm"
            value={s.perfMode}
            options={[
              ['auto', 'While Valorant runs'],
              ['always', 'Always'],
              ['normal', 'Off'],
            ]}
            onChange={(v: Settings['perfMode']) => void saveSettings({ perfMode: v })}
          />
        </Row>
        {st && (
          <div className="grid grid-cols-4 gap-6 py-4 text-sm">
            {[
              ['Now', st.active ? 'Lightweight' : 'Normal'],
              ['Valorant', st.valorantRunning ? 'Running' : 'Not running'],
              ['SexyVal CPU', st.metrics ? `${st.metrics.cpuPercent}%` : '—'],
              ['SexyVal memory', st.metrics ? `${st.metrics.memoryMB} MB` : '—'],
            ].map(([k, v]) => (
              <div key={k}>
                <div className="text-2xs text-faint">{k}</div>
                <div className="t-num text-lg text-ink">{v}</div>
              </div>
            ))}
          </div>
        )}
        {st?.deferred.length ? <div className="py-3 text-xs text-muted">Waiting for Valorant to close: {st.deferred.join(', ')}</div> : null}
      </Panel>
      <section>
        <h2 className="t-head mb-3 px-1 text-md text-ink">What lightweight mode changes</h2>
        <Panel className="px-6 py-4">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            {LITE_EFFECTS.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Panel>
      </section>
      {st?.metrics && <p className="text-xs text-faint">CPU and memory cover all {st.metrics.processes} SexyVal processes (Electron’s own figures, refreshed every 5 s).</p>}
      {!st && <ErrorNote>Loading…</ErrorNote>}
    </div>
  );
}
