import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import type { AppState, Connection, View } from '../../shared/types';
import { api } from './lib/api';
import { cx } from './lib/format';
import { Broadcast, Compass, Crosshair, GearSix, SquaresFour, Storefront, Target, UserCircle, UsersThree, type IconProps } from './lib/icons';
import { withViewTransition } from './lib/motion';
import { startStores, useSettings } from './lib/store';
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
  const sub = conn?.mock ? 'Mock data' : status === 'connected' ? (conn?.valorant ? 'Riot Client and Valorant' : 'Riot Client · Valorant closed') : (conn?.message ?? 'Start the Riot Client');
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
  const [hl, setHl] = useState<{ y: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current?.querySelector<HTMLElement>(`[data-nav="${view}"]`);
    setHl(el ? { y: el.offsetTop, h: el.offsetHeight } : null);
  }, [view]);
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
  const [alert, setAlert] = useState<Alert | null>(null);
  const settings = useSettings();

  useEffect(() => {
    startStores();
    void api.getState().then((s) => s && setState(s));
    const offState = api.onState(setState);
    const offNav = api.onNav((v) => {
      const [main, tab] = v.split(':') as [View, string | undefined];
      closeSkin();
      setView(main);
      setSub(tab);
    });
    const offAlert = api.on<Alert>('alert', setAlert);
    return () => {
      offState();
      offNav();
      offAlert();
    };
  }, []);

  const go = (v: View, tab?: string) => {
    if (v === view && tab === sub) return;
    closeSkin();
    withViewTransition(() => {
      setView(v);
      setSub(tab);
    });
  };

  const connected = state?.conn.status === 'connected';
  const valorant = !!state?.conn.valorant;

  return (
    <div className="flex h-full">
      <Sidebar view={view} go={go} conn={state?.conn} />
      <main className="relative min-w-0 flex-1 overflow-hidden">
        {/* window drag strip; stops short of the native window controls */}
        <div className="drag absolute inset-x-0 top-0 z-20 h-10 pr-[148px]" />
        <div className={cx('h-full pt-10 [scrollbar-gutter:stable]', view === 'collection' ? 'overflow-hidden' : 'overflow-y-auto')}>
          {view === 'live' && <LiveScreen state={state} onLoadout={() => go('loadout')} />}
          {view === 'shop' && <ShopScreen initialTab={sub === 'night' ? 'night' : sub === 'bundles' ? 'bundles' : 'daily'} connected={connected} />}
          {view === 'collection' && <CollectionScreen />}
          {view === 'loadout' && <LoadoutScreen connected={connected} />}
          {view === 'progress' && <ProgressScreen connected={connected} />}
          {view === 'party' && <PartyScreen connected={connected} valorant={valorant} />}
          {view === 'profiles' && <ProfilesScreen connected={connected} myPuuid={state?.conn.puuid} initialQuery={profileQuery} historyQueue={settings?.historyQueue ?? ''} />}
          {view === 'hub' && (
            <HubScreen
              connected={connected}
              riotClient={state?.conn.riotClient === 'up'}
              initialTab={sub as any}
              onProfile={(q) => {
                setProfileQuery(q);
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
