import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import type { AppState, Connection, View } from '../../shared/types';
import type { UiResumeState } from '../../shared/update';
import { api } from './lib/api';
import { cx } from './lib/format';
import { Broadcast, Compass, Crosshair, Gauge, GearSix, SquaresFour, Storefront, Target, UserCircle, UsersThree, type IconProps } from './lib/icons';
import { withViewTransition } from './lib/motion';
import { playerNavStore, startStores, useLoadoutDirty, useSettings, useStore, useVideoPlaying } from './lib/store';
import { MmrScreen } from './screens/Mmr';
import { Toasts } from './components/ui';
import { closeSkin, SkinDetail } from './components/SkinDetail';
import { Btn } from './components/kit';
import { LiveScreen } from './screens/Live';
import { ShopScreen } from './screens/Shop';
import { SettingsScreen } from './screens/Settings';
import { CollectionScreen } from './screens/Collection';
import { ProgressScreen } from './screens/Progress';
import { PartyScreen } from './screens/Party';
import { LoadoutScreen } from './screens/Loadout';
import { ProfilesScreen } from './screens/Profiles';
import { HubScreen } from './screens/Hub';

type NavItem = { id: View; label: string; Icon: ComponentType<IconProps> };
// Groups are separated by space only: no section labels above anything.
const GROUPS: NavItem[][] = [
  [{ id: 'live', label: 'Live', Icon: Broadcast }],
  [
    { id: 'shop', label: 'Store', Icon: Storefront },
    { id: 'collection', label: 'Collection', Icon: SquaresFour },
    { id: 'loadout', label: 'Loadout', Icon: Crosshair },
  ],
  [
    { id: 'progress', label: 'Missions', Icon: Target },
    { id: 'profiles', label: 'Profiles', Icon: UserCircle },
    { id: 'mmr', label: 'MMR', Icon: Gauge },
    { id: 'party', label: 'Party', Icon: UsersThree },
    { id: 'hub', label: 'Hub', Icon: Compass },
  ],
];
const SETTINGS: NavItem = { id: 'settings', label: 'Settings', Icon: GearSix };

function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-[22px] w-[22px] items-center justify-center rounded-[7px] bg-white text-black">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" aria-hidden>
          <path d="M18 18 6 6M17.5 7.5h-6M12.5 16.5h-6" />
        </svg>
      </span>
      <span className="t-title text-[16px] tracking-[-0.02em] text-ink">SexyVal</span>
    </div>
  );
}

function ConnectionPill({ conn }: { conn?: Connection }) {
  const status = conn?.status ?? 'connecting';
  const dot = { waiting: 'bg-warn', connecting: 'bg-faint', connected: 'bg-win', error: 'bg-loss' }[status];
  const title = { waiting: 'Waiting for Riot', connecting: 'Connecting', connected: 'Connected', error: 'Connection problem' }[status];
  // Phase text ("In queue", "Agent select", …) comes from the main process (shared/phase.ts).
  const sub =
    status === 'connected'
      ? conn?.valorant
        ? `${conn.mock ? 'Mock' : 'Valorant'} · ${conn.message}`
        : `${conn?.mock ? 'Mock' : 'Riot Client'} · Valorant closed`
      : conn?.mock
        ? 'Mock data'
        : (conn?.message ?? 'Start the Riot Client');
  return (
    <div className="rounded-2xl bg-white/[0.05] px-3.5 py-3" title={conn?.message}>
      <div className="flex items-center gap-2 text-sm font-medium text-ink">
        <span className={cx('h-2 w-2 rounded-full', dot, status === 'connected' && 'pulse-dot')} />
        {title}
        {conn?.tokenSource === 'signin' && conn.account && <span className="truncate text-xs font-normal text-muted">{conn.account}</span>}
      </div>
      <div className="mt-0.5 truncate pl-4 text-xs text-muted">{sub}</div>
    </div>
  );
}

function Sidebar({ view, go, conn }: { view: View; go: (v: View) => void; conn?: Connection }) {
  const wrap = useRef<HTMLDivElement>(null);
  const highlight = useRef<HTMLSpanElement>(null);
  // Mirrors `view` for the ResizeObserver/font callbacks below, so `measure` can stay referentially
  // stable instead of being torn down and recreated (with a spurious initial fire) on every tab switch.
  const viewRef = useRef(view);
  const [hl, setHl] = useState<{ y: number; h: number } | null>(null);
  const measure = useCallback((skipSlide: boolean) => {
    const el = wrap.current?.querySelector<HTMLElement>(`[data-nav="${viewRef.current}"]`);
    const next = el ? { y: el.offsetTop, h: el.offsetHeight } : null;
    if (skipSlide && highlight.current) {
      // Layout-driven re-measure: snap instead of sliding, by killing the transition for one paint.
      const bar = highlight.current;
      bar.style.transition = 'none';
      setHl(next);
      requestAnimationFrame(() => requestAnimationFrame(() => (bar.style.transition = '')));
    } else {
      setHl(next);
    }
  }, []);
  useLayoutEffect(() => {
    viewRef.current = view;
    measure(false);
  }, [view, measure]);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // The item itself has a fixed height (h-10), so only the container's size can move it; one
    // long-lived observer on `wrap` catches resize, maximize, Windows snap and DPI changes.
    const ro = new ResizeObserver(() => measure(true));
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  useEffect(() => {
    document.fonts?.ready?.then(() => measure(true));
  }, [measure]);
  const item = ({ id, label, Icon }: NavItem) => {
    const on = view === id;
    return (
      <button
        key={id}
        data-nav={id}
        onClick={() => go(id)}
        aria-current={on ? 'page' : undefined}
        className={cx('press relative z-10 flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] font-medium', on ? 'text-ink' : 'text-muted hover:text-ink')}
      >
        <Icon size={20} weight={on ? 'fill' : 'regular'} />
        {label}
      </button>
    );
  };
  return (
    <nav className="no-drag relative flex w-[var(--sidebar-w)] shrink-0 flex-col bg-[#060607] px-3 pb-3 pt-[60px]" aria-label="Main">
      <div className="drag absolute inset-x-0 top-0 flex h-10 items-center px-5">
        <Wordmark />
      </div>
      <div ref={wrap} className="relative flex flex-1 flex-col gap-5 overflow-y-auto">
        <span
          ref={highlight}
          aria-hidden
          className={cx('absolute left-0 right-0 top-0 rounded-xl bg-white/[0.1] transition-[transform,height] duration-[360ms] ease-out', !hl && 'opacity-0')}
          style={hl ? { transform: `translateY(${hl.y}px)`, height: hl.h } : undefined}
        />
        {GROUPS.map((g, i) => (
          <div key={i} className="flex flex-col gap-0.5">
            {g.map(item)}
          </div>
        ))}
        <div className="mt-auto flex flex-col gap-0.5">{item(SETTINGS)}</div>
      </div>
      <div className="mt-3">
        <ConnectionPill conn={conn} />
      </div>
    </nav>
  );
}

interface Alert {
  kind: 'session-expired';
  label: string;
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState<View>('live');
  const [sub, setSub] = useState<string | undefined>();
  const [profileQuery, setProfileQuery] = useState<string | undefined>();
  const [profileTab, setProfileTab] = useState<'history' | 'lifetime' | undefined>();
  const [mmrQuery, setMmrQuery] = useState<string | undefined>();
  const [alert, setAlert] = useState<Alert | null>(null);
  const playerNav = useStore(playerNavStore);
  const settings = useSettings();
  const videoPlaying = useVideoPlaying();
  const loadoutDirty = useLoadoutDirty();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | null>(null);

  useEffect(() => {
    startStores();
    void api.getState().then((s) => s && setState(s));
    const offState = api.onState(setState);
    const offNav = api.onNav((v) => {
      const [main, tab] = v.split(':') as [View, string | undefined];
      closeSkin();
      // "mmr:<puuid>" / "profiles:<puuid>" open that player (tray, screenshots).
      const isId = !!tab && /^[0-9a-f-]{36}$/i.test(tab);
      if (main === 'mmr' && isId) setMmrQuery(tab);
      if (main === 'profiles' && isId) {
        setProfileQuery(tab);
        setProfileTab('lifetime');
      }
      setView(main);
      setSub(isId ? undefined : tab);
    });
    const offAlert = api.on<Alert>('alert', setAlert);
    // After a silent update relaunch: the window and tab it last showed, restored once.
    const offResume = api.on<UiResumeState>('resume', (ui) => {
      setView(ui.view as View);
      setSub(ui.sub);
      if (ui.profileQuery) setProfileQuery(ui.profileQuery);
      pendingScroll.current = ui.scrollTop;
    });
    return () => {
      offState();
      offNav();
      offAlert();
      offResume();
    };
  }, []);

  // Reported to main on every change (plus a slow heartbeat for scroll drift) so a silent update
  // relaunch can restore roughly where the user left off, and so the safe-moment check knows
  // whether a video is playing or a loadout edit is unsaved.
  useEffect(() => {
    const report = () => {
      void api.rpc('ui:report', {
        nav: { view, sub, scrollTop: scrollRef.current?.scrollTop ?? 0, profileQuery },
        videoPlaying,
        unsavedLoadoutChanges: loadoutDirty,
      });
    };
    report();
    const t = setInterval(report, 2000);
    return () => clearInterval(t);
  }, [view, sub, profileQuery, videoPlaying, loadoutDirty]);

  useLayoutEffect(() => {
    if (pendingScroll.current != null && scrollRef.current) {
      scrollRef.current.scrollTop = pendingScroll.current;
      pendingScroll.current = null;
    }
  }, [view]);

  const go = (v: View, tab?: string) => {
    if (v === view && tab === sub) return;
    closeSkin();
    withViewTransition(() => {
      setView(v);
      setSub(tab);
    });
  };

  // A Live row's "Full profile" / "Estimated MMR" opens that player by PUUID (no Name#Tag round-trip).
  useEffect(() => {
    if (!playerNav) return;
    if (playerNav.view === 'mmr') setMmrQuery(playerNav.query);
    else {
      setProfileQuery(playerNav.query);
      setProfileTab('lifetime');
    }
    go(playerNav.view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerNav?.n]);

  const connected = state?.conn.status === 'connected';
  const valorant = !!state?.conn.valorant;
  const matchPlayers = [...(state?.pregame?.allies ?? []), ...(state?.coregame?.myTeam ?? []), ...(state?.coregame?.enemyTeam ?? [])];

  return (
    <div className="flex h-full">
      <Sidebar view={view} go={go} conn={state?.conn} />
      <main className="relative min-w-0 flex-1 overflow-hidden">
        {/* window drag strip; stops short of the native window controls */}
        <div className="drag absolute inset-x-0 top-0 z-20 h-10 pr-[148px]" />
        <div ref={scrollRef} className={cx('h-full pt-10 [scrollbar-gutter:stable]', view === 'collection' ? 'overflow-hidden' : 'overflow-y-auto')}>
          {view === 'live' && <LiveScreen state={state} onLoadout={() => go('loadout')} />}
          {view === 'shop' && <ShopScreen initialTab={sub === 'night' || sub === 'bundles' || sub === 'past' || sub === 'history' ? sub : 'daily'} connected={connected} myPuuid={state?.conn.puuid} />}
          {view === 'collection' && <CollectionScreen />}
          {view === 'loadout' && <LoadoutScreen connected={connected} />}
          {view === 'progress' && <ProgressScreen connected={connected} />}
          {view === 'party' && <PartyScreen connected={connected} valorant={valorant} />}
          {view === 'profiles' && <ProfilesScreen connected={connected} myPuuid={state?.conn.puuid} initialQuery={profileQuery} initialTab={profileTab} historyQueue={settings?.historyQueue ?? ''} />}
          {view === 'mmr' && <MmrScreen connected={connected} myPuuid={state?.conn.puuid} initialQuery={mmrQuery} players={matchPlayers} />}
          {view === 'hub' && (
            <HubScreen
              connected={connected}
              riotClient={state?.conn.riotClient === 'up'}
              initialTab={sub as any}
              onProfile={(q) => {
                setProfileQuery(q);
                setProfileTab('history');
                go('profiles');
              }}
            />
          )}
          {view === 'settings' && <SettingsScreen state={state} initialTab={(sub as any) ?? 'general'} />}
        </div>
      </main>
      <SkinDetail />
      {alert && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" role="alertdialog" aria-modal="true">
          <div className="sheet-in w-[440px] rounded-[28px] bg-[#101012] p-7 ring-1 ring-white/10">
            <h2 className="t-head text-lg text-ink">Session expired</h2>
            <p className="text-pretty mt-2 text-sm text-muted">
              <span className="text-ink">{alert.label}</span> needs to sign in again. Riot ended the saved session.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <Btn tone="ghost" onClick={() => setAlert(null)}>
                Later
              </Btn>
              <Btn
                tone="danger"
                onClick={() => {
                  setAlert(null);
                  go('settings', 'accounts');
                }}
              >
                Remove account
              </Btn>
              <Btn
                tone="primary"
                onClick={() => {
                  setAlert(null);
                  go('settings', 'accounts');
                }}
              >
                Sign in again
              </Btn>
            </div>
          </div>
        </div>
      )}
      <Toasts />
    </div>
  );
}
