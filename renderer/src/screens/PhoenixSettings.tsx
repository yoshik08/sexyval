import { useEffect, useState } from 'react';
import type { NetworkStatus, PerfStatus } from '../../../shared/features';
import type { Settings } from '../../../shared/types';
import { parseProxy, cacheLabel } from '../../../shared/netRoute';
import { validClientId } from '../../../shared/presence';
import { LITE_EFFECTS } from '../../../shared/perf';
import { api } from '../lib/api';
import { ago, cx } from '../lib/format';
import { saveSettings, useSettings } from '../lib/store';
import { Panel, Segmented, Skeleton, showToast, Toggle } from '../components/ui';
import { act, Btn, ErrorNote, Note } from '../components/kit';

type DiscordStatus = { state: string; detail: string; activity: { details?: string; state?: string } | null; lastUpdateAt?: number };

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
    </div>
  );
}

// ---------------- Integrations (Discord Rich Presence) ----------------
const PRIVACY: [keyof Settings['discordPrivacy'], string, string][] = [
  ['mode', 'Game mode', 'Competitive, Unrated…'],
  ['map', 'Map', 'Shown once the map is known'],
  ['agent', 'Your agent', 'Only after you lock in'],
  ['party', 'Party size', 'When you’re in a party of 2+'],
  ['elapsed', 'Elapsed time', 'Time in queue or in the match'],
  ['rank', 'Your rank', 'Off by default'],
];

export function IntegrationsTab() {
  const s = useSettings();
  const [st, setSt] = useState<DiscordStatus | null>(null);
  const [id, setId] = useState('');
  useEffect(() => setId(s?.discordClientId ?? ''), [s?.discordClientId]);
  useEffect(() => {
    const t = () => void api.rpc<DiscordStatus>('discord:status').then(setSt);
    t();
    const h = setInterval(t, 3000);
    return () => clearInterval(h);
  }, []);
  if (!s) return <Skeleton className="h-72" />;
  const idOk = validClientId(id);
  return (
    <div className="flex flex-col gap-6">
      <Panel className="divide-y divide-white/[0.06] px-6">
        <Toggle checked={s.discordEnabled} onChange={(on) => void saveSettings({ discordEnabled: on })} label="Discord Rich Presence" hint="Shows what you’re playing on your Discord profile. Turns on and off instantly." />
        <div className="py-4">
          <div className="text-sm text-ink">Discord application ID</div>
          <div className="mt-0.5 text-xs text-muted">Create an application at discord.com/developers/applications (its name is what Discord shows, e.g. “VALORANT”) and paste its Application ID.</div>
          <input value={id} onChange={(e) => setId(e.target.value.replace(/\D/g, ''))} onBlur={() => void saveSettings({ discordClientId: id })} placeholder="1234567890123456789" className="field mt-3 w-72 font-mono text-xs" inputMode="numeric" />
          {id && !idOk && <p className="mt-2 text-xs text-warn">An application ID is 17–20 digits.</p>}
        </div>
        {st && s.discordEnabled && (
          <div className="flex items-center justify-between gap-4 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm text-ink">
                <span className={cx('h-2 w-2 rounded-full', st.state === 'connected' ? 'bg-win' : st.state === 'connecting' ? 'bg-faint' : 'bg-warn')} />
                {st.detail}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted">{st.activity ? `Showing: ${[st.activity.details, st.activity.state].filter(Boolean).join(' — ')}` : 'Showing nothing (Valorant isn’t running)'}</div>
            </div>
            <Btn size="sm" tone="ghost" onClick={() => void api.rpc<DiscordStatus>('discord:reconnect').then(setSt)}>
              Reconnect
            </Btn>
          </div>
        )}
      </Panel>
      <section>
        <h2 className="t-head mb-3 px-1 text-md text-ink">What Discord may show</h2>
        <Panel className="divide-y divide-white/[0.06] px-6">
          {PRIVACY.map(([k, label, hint]) => (
            <Toggle key={k} checked={s.discordPrivacy[k]} onChange={(on) => void saveSettings({ discordPrivacy: { ...s.discordPrivacy, [k]: on } })} label={label} hint={hint} />
          ))}
        </Panel>
      </section>
      <Note>Never shown: your Riot ID, other players, enemy agents or anything Valorant hides. When Valorant closes or you turn this off, the activity is cleared at once.</Note>
    </div>
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
