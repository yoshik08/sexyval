import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppState, DebugDump, Settings, UpdateStatus } from '../../../shared/types';
import type { AccountInfo, OffersStatus } from '../../../shared/features';
import { api } from '../lib/api';
import { ago, cx, fmtBytes } from '../lib/format';
import { saveSettings, useSettings } from '../lib/store';
import { Panel, Segmented, Select, Toggle } from '../components/ui';
import { WarningCircle } from '../lib/icons';
import { Bar, Btn, Note, PageHeader } from '../components/kit';
import { BoostTab, StretchTab } from './SystemSettings';

type Tab = 'general' | 'accounts' | 'stretch' | 'boost' | 'debug';
const TABS: [Tab, string][] = [
  ['general', 'General'],
  ['accounts', 'Accounts'],
  ['stretch', 'Stretch'],
  ['boost', 'Boost'],
  ['debug', 'Diagnostics'],
];

export function SettingsScreen({ state, initialTab }: { state: AppState | null; initialTab: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  return (
    <div className="mx-auto max-w-[1100px] px-6 xl:px-10 pb-20 pt-6">
      <PageHeader title="Settings" />
      <Segmented value={tab} options={TABS} onChange={setTab} className="mb-8" />
      {tab === 'general' && <General state={state} />}
      {tab === 'accounts' && <Accounts state={state} />}
      {tab === 'stretch' && <StretchTab />}
      {tab === 'boost' && <BoostTab />}
      {tab === 'debug' && <Debug />}
    </div>
  );
}

function Group({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h2 className="t-head mb-3 px-1 text-md text-ink">{title}</h2>
      <Panel className="divide-y divide-white/[0.06] px-6">{children}</Panel>
      {note && <p className="text-pretty mt-2.5 px-1 text-xs text-faint">{note}</p>}
    </section>
  );
}

function Row({ title, hint, children }: { title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-8 py-3.5">
      <div className="min-w-0">
        <div className="text-base text-ink">{title}</div>
        {hint && <div className="mt-0.5 text-sm text-muted">{hint}</div>}
      </div>
      {children != null && <div className="shrink-0">{children}</div>}
    </div>
  );
}

function Info({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <span className="text-sm text-muted">{k}</span>
      <span className="num truncate text-sm text-ink">{v ?? '–'}</span>
    </div>
  );
}

const ICONS: { id: Settings['appIcon']; label: string; tile: string; glyph: string }[] = [
  { id: 'mono', label: 'White', tile: '#f5f5f7', glyph: '#000' },
  { id: 'red', label: 'Ember', tile: '#ff453a', glyph: '#fff' },
  { id: 'teal', label: 'Mint', tile: '#5ad8c6', glyph: '#000' },
  { id: 'gold', label: 'Amber', tile: '#ffd60a', glyph: '#000' },
];
const CACHE_SIZES: { value: string; label: string }[] = [
  { value: '512', label: '512 MB' },
  { value: '1024', label: '1 GB' },
  { value: '2048', label: '2 GB' },
  { value: '5120', label: '5 GB' },
  { value: '10240', label: '10 GB' },
  { value: '20480', label: '20 GB' },
];

const UPDATE_LABEL: Record<UpdateStatus['state'], string> = {
  idle: 'Not checked yet',
  checking: 'Checking…',
  'up-to-date': "You're on the latest version",
  downloading: 'Downloading update…',
  downloaded: 'Update ready — installing at the next quiet moment',
  error: 'Update check failed',
};

function Updates({ s, set }: { s: Settings; set: (patch: Partial<Settings>) => void }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    void api.rpc<UpdateStatus>('update:status').then(setStatus);
    return api.on<UpdateStatus>('update', setStatus);
  }, []);
  if (!status) return null;
  if (status.portable) {
    return (
      <Group title="Updates">
        <Info k="Version" v={status.currentVersion} />
        <Row title="Portable build" hint="This build can't update itself.">
          <Btn size="sm" tone="ghost" onClick={() => void api.rpc('update:openReleases')}>
            New version on GitHub
          </Btn>
        </Row>
      </Group>
    );
  }
  return (
    <Group title="Updates">
      <Toggle checked={s.autoUpdate} onChange={(v) => set({ autoUpdate: v })} label="Install updates automatically" hint="Downloads in the background and installs itself the next time you're away, with no prompts." />
      <Row
        title="Version"
        hint={
          <>
            {status.currentVersion}
            {status.availableVersion && status.availableVersion !== status.currentVersion ? ` → ${status.availableVersion}` : ''} · {UPDATE_LABEL[status.state]}
            {status.state === 'downloading' && status.progressPercent != null ? ` (${status.progressPercent}%)` : ''}
            {status.lastCheckedAt ? ` · checked ${ago(status.lastCheckedAt)}` : ''}
          </>
        }
      >
        <Btn size="sm" tone="ghost" disabled={status.state === 'checking' || status.state === 'downloading'} onClick={() => void api.rpc('update:check')}>
          Check now
        </Btn>
      </Row>
    </Group>
  );
}

function General({ state }: { state: AppState | null }) {
  const s = useSettings();
  const [mock, setMock] = useState(false);
  const [cache, setCache] = useState<{ bytes: number; files: number } | null>(null);
  const refreshCache = () => void api.rpc<{ bytes: number; files: number }>('videos:info').then(setCache);
  const [displays, setDisplays] = useState<{ id: number; label: string }[]>([]);
  const [displayMode, setDisplayMode] = useState<string | null>(null);
  useEffect(() => {
    void api.isMock().then(setMock);
    void api.rpc<{ id: number; label: string }[]>('overlay:displays').then(setDisplays);
    void api.rpc<string | null>('overlay:displayMode').then(setDisplayMode);
    refreshCache();
  }, []);
  const set = (patch: Partial<Settings>) => void saveSettings(patch);
  const c = state?.conn;
  if (!s) return null;
  const limit = s.videoCacheMaxMb * 1024 * 1024;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-8 gap-y-10">
      <Group title="App">
        <Toggle checked={s.launchAtStartup} onChange={(v) => set({ launchAtStartup: v })} label="Launch at startup" hint="Start SexyVal when you sign in to Windows (installed build only)." />
        <Toggle checked={s.closeToTray} onChange={(v) => set({ closeToTray: v })} label="Close to tray" hint="Closing the window keeps SexyVal running in the tray." />
        <Toggle checked={s.notifications} onChange={(v) => set({ notifications: v })} label="Windows notifications" hint="A skin on your watchlist shows up in your store, or a session expires." />
      </Group>

      <Updates s={s} set={set} />

      <Group title="Agent select overlay" note="A small always-on-top window, nothing more: no injection, no memory reading, no screen capture. It never takes focus and clicks pass through it. It shows only the map and your starting side, only during agent select.">
        {displayMode === 'fullscreen' && s.overlayEnabled && (
          <div data-fullscreen-note className="flex items-start gap-2.5 py-3.5 text-sm">
            <WarningCircle size={18} weight="fill" className="mt-0.5 shrink-0 text-warn" />
            <span className="text-ink/90">
              Valorant is in Fullscreen. Switch Display Mode to <span className="text-ink">Windowed Fullscreen</span> to see the overlay.
            </span>
          </div>
        )}
        <Toggle
          checked={s.overlayEnabled}
          onChange={(v) => set({ overlayEnabled: v })}
          label="Show map and side over the game"
          hint="Works with Valorant in Windowed or Windowed Fullscreen. Windows can’t draw anything over exclusive Fullscreen."
        />
        <Toggle checked={s.overlayMatchFound} onChange={(v) => set({ overlayMatchFound: v })} label="Match found" hint="Pop up the moment your queue finds a match, before the map is known." />
        <Row title="Position">
          <Select
            value={s.overlayPosition}
            onChange={(v) => set({ overlayPosition: v })}
            options={[
              { value: 'top-center', label: 'Top center' },
              { value: 'top-left', label: 'Top left' },
              { value: 'top-right', label: 'Top right' },
            ]}
            align="right"
            width={190}
          />
        </Row>
        <Row title="Size">
          <Select value={s.overlayScale} onChange={(v) => set({ overlayScale: v })} options={[{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }]} align="right" width={190} />
        </Row>
        {displays.length > 1 && (
          <Row title="Display">
            <Select
              value={String(s.overlayDisplay ?? '')}
              onChange={(v) => set({ overlayDisplay: v ? Number(v) : null })}
              options={[{ value: '', label: 'Primary display' }, ...displays.map((d) => ({ value: String(d.id), label: d.label }))]}
              align="right"
              width={280}
            />
          </Row>
        )}
      </Group>

      <Group title="Skin videos" note="Videos are 1080p and range from about 3 to 150 MB. They stream while you watch; caching keeps the ones you play so they start instantly next time.">
        <Toggle checked={s.hoverPreviews} onChange={(v) => set({ hoverPreviews: v })} label="Hover previews" hint="Rest the pointer on a skin for a moment to see a short muted clip." />
        <Toggle checked={s.soundOn} onChange={(v) => set({ soundOn: v })} label="Play with sound" hint="Skin videos in the detail view start with their weapon audio." />
        <Toggle checked={s.cacheVideos} onChange={(v) => set({ cacheVideos: v })} label="Keep watched videos on this PC" hint="Only videos you open are kept, never hover previews." />
        <Row title="Cache limit" hint="The least recently watched videos are removed first.">
          <Select value={String(s.videoCacheMaxMb)} onChange={(v) => set({ videoCacheMaxMb: Number(v) })} options={CACHE_SIZES} align="right" width={150} />
        </Row>
        <div className="py-4">
          <div className="mb-2 flex items-baseline justify-between text-sm">
            <span className="text-muted">{cache ? `${fmtBytes(cache.bytes)} used · ${cache.files} video${cache.files === 1 ? '' : 's'}` : 'Checking…'}</span>
            <span className="num text-faint">{fmtBytes(limit)} limit</span>
          </div>
          <Bar value={cache?.bytes ?? 0} max={limit} />
          <div className="mt-3 flex justify-end">
            <Btn
              size="sm"
              onClick={async () => {
                setCache(await api.rpc('videos:clear'));
              }}
              disabled={!cache?.files}
            >
              Clear cache
            </Btn>
          </div>
        </div>
      </Group>

      <Group title="Live and history">
        <Row title="Live poll rate" hint="How often the menus and running matches are checked. Queue and agent select are checked every second.">
          <Select value={String(s.pollMs)} onChange={(v) => set({ pollMs: Number(v) })} options={[3000, 5000, 8000, 12000].map((v) => ({ value: String(v), label: `Every ${v / 1000} seconds` }))} align="right" width={190} />
        </Row>
        <Row title="History queue" hint="Which queue match history shows by default.">
          <Select
            value={s.historyQueue}
            onChange={(v) => set({ historyQueue: v })}
            options={[['', 'All queues'], ['competitive', 'Competitive'], ['unrated', 'Unrated'], ['swiftplay', 'Swiftplay'], ['deathmatch', 'Deathmatch'], ['premier', 'Premier']].map(([value, label]) => ({ value, label }))}
            align="right"
            width={190}
          />
        </Row>
        <Row title="Platform" hint="Only changes a request header. PC is the verified value.">
          <Select value={s.platformType} onChange={(v) => set({ platformType: v as Settings['platformType'] })} options={[{ value: 'PC', label: 'PC' }, { value: 'xbox', label: 'Xbox (untested)' }, { value: 'playstation', label: 'PlayStation (untested)' }]} align="right" width={190} />
        </Row>
      </Group>

      <Group title="Appearance">
        <Row title="App icon" hint="Shown in the taskbar and tray.">
          <div className="flex gap-2.5">
            {ICONS.map((i) => (
              <button
                key={i.id}
                onClick={() => set({ appIcon: i.id })}
                aria-label={`${i.label} icon`}
                aria-pressed={s.appIcon === i.id}
                title={i.label}
                className={cx('press flex h-10 w-10 items-center justify-center rounded-[13px] transition-shadow', s.appIcon === i.id ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0b0b0d]' : 'ring-1 ring-white/10 hover:ring-white/30')}
                style={{ background: i.tile }}
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={i.glyph} strokeWidth="3.2" strokeLinecap="round" aria-hidden>
                  <path d="M18 18 6 6M17.5 7.5h-6M12.5 16.5h-6" />
                </svg>
              </button>
            ))}
          </div>
        </Row>
      </Group>

      <Group title="Riot connection">
        <Info k="Riot Client" v={c?.riotClient === 'up' ? 'Running' : 'Not running'} />
        <Info k="Valorant" v={c?.valorant ? 'Running' : 'Closed'} />
        <Info k="Instant updates" v={c?.events === 'connected' ? 'Connected' : c?.events === 'connecting' ? 'Connecting…' : 'Off (polling)'} />
        <Info k="Token source" v={c?.tokenSource === 'riot-client' ? 'Riot Client' : c?.tokenSource === 'signin' ? `Signed in (${c.account ?? '?'})` : 'None'} />
        <Info k="Region" v={c?.region ? `${c.region} / ${c.shard}` : undefined} />
        <Info k="Game version" v={c?.version} />
        <Info k="Account ID" v={c?.puuid ? `${c.puuid.slice(0, 8)}…` : undefined} />
      </Group>

      {mock && (
        <Group title="Mock mode" note="You are running against the built-in fake Riot server. Pick a scenario to drive it.">
          <div className="flex flex-wrap gap-2 py-4">
            {(['auto', 'offline', 'noval', 'idle', 'queue', 'pregame', 'ingame'] as const).map((p) => (
              <Btn key={p} size="sm" onClick={() => void api.mockSetPhase(p)}>
                {p === 'noval' ? 'Valorant closed' : p === 'offline' ? 'Client closed' : p}
              </Btn>
            ))}
          </div>
        </Group>
      )}

      <p className="text-pretty col-span-2 max-w-3xl px-1 text-xs text-faint">
        Personal, unofficial tool. Not affiliated with Riot Games. The only overlay is the optional agent-select pill with the map and your starting side (a plain always-on-top window). No agent locking, no gameplay automation: party, queue and loadout changes only happen when you press a button. Tokens stay in memory in the main process.
      </p>
    </div>
  );
}

function Accounts({ state }: { state: AppState | null }) {
  const [list, setList] = useState<AccountInfo[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.rpc<AccountInfo[]>('accounts:list').then(setList);
    return api.on<AccountInfo[]>('accounts', setList);
  }, []);
  const c = state?.conn;
  return (
    <div className="flex max-w-[820px] flex-col gap-8">
      <Note>
        <span className="text-ink">This is an unofficial login flow.</span> “Sign in with Riot” opens Riot’s own login page and SexyVal never sees your password; it reads the token from the redirect. Riot can change the flow or show captchas at any time. Cookies stay in a private per-account browser partition and tokens are kept in memory only.
      </Note>
      <Group title="Token source">
        <Row title={c?.tokenSource === 'riot-client' ? 'Riot Client' : c?.tokenSource === 'signin' ? 'Signed-in session' : 'None'} hint={c?.tokenSource === 'riot-client' ? 'Preferred while the Riot Client runs.' : c?.tokenSource === 'signin' ? c.account : 'Start the Riot Client or sign in.'}>
          <Btn
            tone="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await api.rpc('accounts:add');
              setBusy(false);
              setList(await api.rpc('accounts:list'));
            }}
          >
            {busy ? 'Waiting for login…' : 'Sign in with Riot'}
          </Btn>
        </Row>
      </Group>
      <PriceSource />
      <section>
        <h2 className="t-head mb-3 px-1 text-md">Signed-in accounts</h2>
        <Panel className="divide-y divide-white/[0.06]">
          {list.map((a) => (
            <div key={a.id} className="flex items-center gap-4 px-6 py-4">
              <span className={cx('h-2.5 w-2.5 rounded-full', a.status === 'ok' ? 'bg-win' : a.status === 'expired' ? 'bg-loss' : a.status === 'error' ? 'bg-warn' : 'bg-faint')} />
              <div className="min-w-0 flex-1">
                <div className="text-base">
                  {a.name ?? 'Account'}
                  <span className="text-faint">#{a.tag ?? '?'}</span>
                  {a.active && <span className="ml-2 rounded-full bg-white/[0.12] px-2 py-0.5 text-2xs font-semibold text-ink">Active</span>}
                </div>
                <div className="text-sm text-muted">
                  {a.region?.toUpperCase() ?? 'Region not known yet'} · {a.status}
                  {a.error ? ` · ${a.error}` : ''}
                </div>
              </div>
              {!a.active && (
                <Btn size="sm" onClick={() => void api.rpc('accounts:switch', a.id)}>
                  Switch
                </Btn>
              )}
              {a.status === 'expired' && (
                <Btn size="sm" tone="primary" onClick={() => void api.rpc('accounts:signInAgain', a.id)}>
                  Sign in again
                </Btn>
              )}
              <Btn size="sm" tone="danger" onClick={() => void api.rpc('accounts:remove', a.id)}>
                Remove
              </Btn>
            </div>
          ))}
          {!list.length && <div className="px-6 py-5 text-sm text-muted">No signed-in accounts. The Riot Client is used while it is running.</div>}
        </Panel>
        <p className="mt-2.5 px-1 text-xs text-faint">Riot Client tokens win while it runs; otherwise the active signed-in account is used. Sessions refresh silently about every 50 minutes.</p>
      </section>
    </div>
  );
}

const OFFER_STATE: Record<OffersStatus['state'], string> = {
  'no-key': 'No key: prices come from your store and the bundled price list.',
  loading: 'Checking…',
  ok: 'Connected',
  'bad-key': 'HenrikDev rejected this key.',
  removed: 'HenrikDev reports that Riot removed store offers. Prices come from your store and the bundled price list.',
  'rate-limited': 'Rate limited; SexyVal tries again later.',
  error: 'Could not reach HenrikDev.',
};

/** HenrikDev key. The saved key never comes back to this page: only "set, ending in …". */
function PriceSource() {
  const s = useSettings();
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<OffersStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.rpc<OffersStatus>('offers:status').then(setStatus);
  }, [s?.henrikKey]);
  // A fetch started elsewhere (key saved, game update): follow it until it settles.
  useEffect(() => {
    if (status?.state !== 'loading') return;
    const t = setInterval(() => void api.rpc<OffersStatus>('offers:status').then(setStatus), 800);
    return () => clearInterval(t);
  }, [status?.state]);
  const save = async (key: string) => {
    setBusy(true);
    await saveSettings({ henrikKey: key });
    setDraft('');
    setStatus(await api.rpc<OffersStatus>('offers:refresh'));
    setBusy(false);
  };
  const has = !!s?.henrikKey;
  const cov = status?.coverage;
  return (
    <Group
      title="Price source"
      note={
        <>
          Prices come from your own store first, then the HenrikDev store offers list (needs a key; unofficial, third party, free at api.henrikdev.xyz), then the price list bundled with SexyVal. Skins newer than all of these show an approximate price (≈) until they appear in your store. The key is stored in settings.json on this PC, sent only to api.henrikdev.xyz and never logged.
        </>
      }
    >
      <Row title="HenrikDev API key" hint={has ? `Saved, ending in ${s!.henrikKey.slice(-4)}` : 'Not set'}>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void save(draft.trim());
          }}
        >
          <input
            data-henrik-key
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={has ? 'Replace key' : 'HDEV-…'}
            className="field w-[220px]"
            aria-label="HenrikDev API key"
          />
          <Btn type="submit" size="sm" tone="primary" disabled={busy || !draft.trim()}>
            Save
          </Btn>
          {has && (
            <Btn size="sm" tone="ghost" disabled={busy} onClick={() => void save('')}>
              Remove
            </Btn>
          )}
        </form>
      </Row>
      <Row
        title="Store offers"
        hint={
          <span className={cx(status?.state === 'bad-key' || status?.state === 'error' ? 'text-loss' : status?.state === 'removed' || status?.state === 'rate-limited' ? 'text-warn' : '')}>
            {status ? OFFER_STATE[status.state] : '…'}
            {cov ? ` · ${cov.priced.toLocaleString('en-US')} of ${cov.total.toLocaleString('en-US')} store skins priced` : ''}
            {status?.fetchedAt ? ` · fetched ${ago(status.fetchedAt)}` : ''}
          </span>
        }
      >
        {has && (
          <Btn size="sm" disabled={busy || status?.state === 'loading'} onClick={async () => setStatus(await api.rpc<OffersStatus>('offers:refresh'))}>
            Check now
          </Btn>
        )}
      </Row>
    </Group>
  );
}

function Debug() {
  const [d, setD] = useState<DebugDump | null>(null);
  const [key, setKey] = useState<string>('pregameMatch');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const load = () => void api.getDebug().then(setD);
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  const keys = useMemo(() => Object.keys(d?.raw ?? {}).sort(), [d]);
  const active = d?.raw[key] ?? (keys[0] ? d?.raw[keys[0]] : undefined);
  const activeKey = d?.raw[key] ? key : keys[0];
  const text = active ? JSON.stringify(active.data, null, 2) : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  const unknown = Object.entries(d?.unknownKeys ?? {}).filter(([, v]) => v.length);
  return (
    <div className="flex flex-col gap-6">
      <Panel className="px-6 py-4">
        <h3 className="t-head text-md">Fields we do not parse yet</h3>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {unknown.length ? (
            unknown.flatMap(([k, v]) =>
              v.map((f) => (
                <span key={k + f} className="rounded-full bg-warn/[0.12] px-2.5 py-1 font-mono text-2xs text-warn">
                  {k}.{f}
                </span>
              )),
            )
          ) : (
            <span className="text-sm text-muted">None seen yet. Enter agent select to capture the pregame JSON.</span>
          )}
        </div>
      </Panel>
      <div className="grid grid-cols-[210px_1fr] gap-6">
        <Panel className="max-h-[520px] overflow-y-auto p-2">
          {keys.length ? (
            keys.map((k) => (
              <button key={k} onClick={() => setKey(k)} className={cx('block w-full truncate rounded-xl px-3 py-2 text-left text-sm transition-colors', activeKey === k ? 'bg-white/[0.1] text-ink' : 'text-muted hover:text-ink')}>
                {k}
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-sm text-muted">No responses captured.</div>
          )}
        </Panel>
        <Panel className="min-w-0">
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-xs text-muted">
              {activeKey ?? '—'} {active && <span className="text-faint">· {ago(active.at)} · tokens redacted</span>}
            </span>
            <Btn size="sm" tone="ghost" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </Btn>
          </div>
          <pre className="max-h-[420px] select-text overflow-auto whitespace-pre px-5 pb-5 font-mono text-2xs leading-relaxed text-ink/85">{text || '—'}</pre>
        </Panel>
      </div>
      <Panel>
        <h3 className="t-head px-5 pb-1 pt-4 text-md">Log</h3>
        <pre className="max-h-[220px] select-text overflow-auto whitespace-pre-wrap px-5 pb-5 font-mono text-2xs leading-relaxed text-muted">{(d?.logs ?? []).slice(-120).join('\n')}</pre>
      </Panel>
    </div>
  );
}
