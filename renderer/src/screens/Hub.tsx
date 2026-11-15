import { useEffect, useMemo, useState, type ComponentType } from 'react';
import type { FriendRequestView, FriendView, LeaderboardView } from '../../../shared/features';
import { ago, cx } from '../lib/format';
import { img } from '../lib/media';
import { Img, Panel, RankBadge, Skeleton } from '../components/ui';
import { act, Btn, ErrorNote, Note, PageHeader, TabBar, useRpc } from '../components/kit';
import { useInterval } from '../lib/store';
import { ArrowRight, Desktop, DeviceMobile, GameController, Star, type IconProps } from '../lib/icons';
import { PlayerName } from '../components/PlayerName';

type Tab = 'friends' | 'leaderboard' | 'agents' | 'maps' | 'weapons';

/** Game text carries style tags like <whitebold>Wingman</> or <debuffred>; show the words only. */
const plainText = (s: unknown) => String(s ?? '').replace(/<\/?[a-z]*>/gi, '');
/** Ability slots as the keys players know. */
const SLOT_KEY: Record<string, string> = { Ability1: 'Q', Ability2: 'E', Grenade: 'C', Ultimate: 'X', Passive: 'Passive' };

const PLATFORM_GROUPS: { key: FriendView['platform']; label: string; hint: string; Icon: ComponentType<IconProps> }[] = [
  { key: 'valorant', label: 'In Valorant', hint: 'Playing or in the menus', Icon: GameController },
  { key: 'mobile', label: 'Riot Mobile', hint: 'Online on the phone app only: can chat, can’t queue', Icon: DeviceMobile },
  { key: 'client', label: 'Online elsewhere', hint: 'Riot Client open, or another Riot game', Icon: Desktop },
  { key: 'offline', label: 'Offline', hint: '', Icon: Desktop },
];

function FriendRow({ f, onProfile, watched, onWatch }: { f: FriendView; onProfile: (q: string) => void; watched: boolean; onWatch: (on: boolean) => void }) {
  const Icon = PLATFORM_GROUPS.find((g) => g.key === f.platform)?.Icon ?? Desktop;
  const dot = !f.online ? 'bg-faint' : f.platform === 'mobile' ? 'bg-[#5ab0ff]' : f.state === 'away' ? 'bg-warn' : f.platform === 'valorant' ? 'bg-win' : 'bg-white/60';
  return (
    <div className={cx('flex items-center gap-3 border-b border-line px-5 py-2.5 last:border-b-0', !f.online && 'opacity-55')}>
      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-muted" title={PLATFORM_GROUPS.find((g) => g.key === f.platform)?.label}>
        <Icon size={16} weight={f.platform === 'valorant' ? 'fill' : 'regular'} />
        <span className={cx('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface', dot)} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">
          <PlayerName name={f.name} tag={f.tag} />
          {f.note && <span className="ml-2 text-xs text-faint">“{f.note}”</span>}
        </div>
        <div className="text-xs text-muted">{f.online ? (f.status ?? 'Online') + (f.partySize && f.partySize > 1 ? ` · party of ${f.partySize}` : '') : f.lastOnline ? `Last online ${ago(f.lastOnline)}` : 'Offline'}</div>
      </div>
      {f.rank && <RankBadge rank={f.rank} compact />}
      {f.level && <span className="num w-12 text-right text-xs text-muted">Lv {f.level}</span>}
      <button
        className={cx('press shrink-0 rounded-full p-1.5 hover:bg-white/[0.08]', watched ? 'text-warn' : 'text-faint hover:text-ink')}
        title={watched ? 'Watching: you get a notification when they come online or finish a match' : 'Watch: notify me when they come online or finish a match'}
        aria-pressed={watched}
        onClick={() => onWatch(!watched)}
      >
        <Star size={14} weight={watched ? 'fill' : 'regular'} />
      </button>
      <button className="press shrink-0 rounded-full p-1.5 text-faint hover:bg-white/[0.08] hover:text-ink" title="Open profile" aria-label={`Open ${f.name}'s profile`} onClick={() => onProfile(`${f.name}#${f.tag}`)}>
        <ArrowRight size={14} weight="bold" />
      </button>
    </div>
  );
}

function Friends({ riotClient, onProfile }: { riotClient: boolean; onProfile: (q: string) => void }) {
  const { data, setData, error, reload } = useRpc<{ friends: FriendView[]; requests: FriendRequestView[] }>('hub:friends', [], riotClient);
  const [nt, setNt] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useInterval(() => riotClient && void reload(), 15000, [riotClient, reload]);
  const [q, setQ] = useState('');
  const [watch, setWatch] = useState<string[]>([]);
  useEffect(() => {
    void act<string[]>('hub:watchList').then((r) => r.ok && setWatch(r.data));
  }, []);
  const toggleWatch = async (p: string, on: boolean) => {
    const r = await act<string[]>('hub:watch', p, on);
    if (r.ok) setWatch(r.data);
  };
  if (!riotClient) return <Note>Friends and presence come from the Riot Client’s local chat API. Start the Riot Client to see them (a web sign-in can’t reach chat).</Note>;
  const ql = q.trim().toLowerCase();
  const match = (f: FriendView) => !ql || `${f.name}#${f.tag} ${f.note ?? ''}`.toLowerCase().includes(ql);
  // Watched friends first inside each group.
  const groups = PLATFORM_GROUPS.map((g) => ({ ...g, list: (data?.friends ?? []).filter((f) => (f.platform ?? (f.online ? 'client' : 'offline')) === g.key && match(f)).sort((a, b) => Number(watch.includes(b.puuid)) - Number(watch.includes(a.puuid))) }));
  const onlineCount = (data?.friends ?? []).filter((f) => f.online).length;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_clamp(280px,26vw,340px)] gap-4 xl:gap-5">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search friends" aria-label="Search friends" className="field mr-2 h-8 w-48" />
          <span className="num text-ink">{onlineCount} online</span>
          {groups.slice(0, 3).map((g) => (
            <span key={g.key} className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1" title={g.hint}>
              <g.Icon size={12} weight="bold" /> {g.label} <span className="num text-ink">{g.list.length}</span>
            </span>
          ))}
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        {!data && !error && <Skeleton className="h-40" />}
        {data &&
          groups
            .filter((g) => g.list.length)
            .map((g) => (
              <Panel key={g.key}>
                <div className="flex items-center gap-2 border-b border-line px-5 py-3">
                  <span className="label">{g.label} · {g.list.length}</span>
                  {g.hint && <span className="text-2xs text-faint">{g.hint}</span>}
                </div>
                {g.list.map((f) => (
                  <FriendRow key={f.puuid} f={f} onProfile={onProfile} watched={watch.includes(f.puuid)} onWatch={(on) => void toggleWatch(f.puuid, on)} />
                ))}
              </Panel>
            ))}
        {data && !data.friends.length && <Note>No friends yet.</Note>}
      </div>
      <div className="flex flex-col gap-5">
        <Panel className="p-5">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await act<{ friends: FriendView[]; requests: FriendRequestView[] }>('hub:friendRequest', nt);
              if (r.ok) {
                setData(r.data);
                setNt('');
                setErr(null);
              } else setErr(r.error);
            }}
          >
            <div className="label">Send friend request</div>
            <div className="mt-2 flex gap-2">
              <input value={nt} onChange={(e) => setNt(e.target.value)} placeholder="Name#TAG" className="field min-w-0 flex-1" />
              <Btn type="submit" disabled={!nt.includes('#')}>Send</Btn>
            </div>
            {err && <p className="mt-2 text-xs text-loss">{err}</p>}
          </form>
        </Panel>
        <Panel>
          <div className="border-b border-line px-5 py-3 label">Requests · {data?.requests.length ?? 0}</div>
          {(data?.requests ?? []).map((r) => (
            <div key={r.puuid} className="flex items-center gap-2 border-b border-line px-5 py-2.5 text-sm last:border-b-0">
              <span className={cx('font-display text-2xs font-bold uppercase tracking-label', r.direction === 'in' ? 'text-win' : 'text-muted')}>{r.direction === 'in' ? 'In' : 'Out'}</span>
              <PlayerName name={r.name} tag={r.tag} className="min-w-0 flex-1 truncate" />
              {r.direction === 'out' ? (
                <Btn tone="danger" onClick={async () => { const x = await act<any>('hub:cancelRequest', r.puuid); if (x.ok) setData(x.data); }}>Cancel</Btn>
              ) : (
                <span className="text-2xs text-faint" title="No documented endpoint for accepting">accept in client</span>
              )}
            </div>
          ))}
          {!data?.requests.length && <div className="px-5 py-3 text-sm text-muted">None.</div>}
        </Panel>
        <Note>Removing friends and accepting incoming requests have no documented local endpoint, so they’re left to the Riot Client.</Note>
      </div>
    </div>
  );
}

function Leaderboard({ connected }: { connected: boolean }) {
  const acts = useRpc<{ id: string; name: string }[]>('hub:acts', []);
  const [season, setSeason] = useState<string | undefined>();
  const [start, setStart] = useState(0);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const lb = useRpc<LeaderboardView>('hub:leaderboard', [season, start, search], connected);
  if (!connected) return <ErrorNote>Needs tokens: start the Riot Client or sign in.</ErrorNote>;
  const v = lb.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="label">Act</span>
          <select value={season ?? v?.seasonId ?? ''} onChange={(e) => { setSeason(e.target.value); setStart(0); }} className="field min-w-[200px]">
            {(acts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
        <span className="pb-1.5 text-sm text-muted">Region {v?.region?.toUpperCase() ?? '–'}{v?.total ? ` · ${v.total.toLocaleString()} ranked players` : ''}</span>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q.trim());
            setStart(0);
          }}
        >
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a player" className="field w-44" />
          <Btn type="submit">Search</Btn>
          {search && <Btn tone="ghost" onClick={() => (setQ(''), setSearch(''))}>Clear</Btn>}
        </form>
        <div className="ml-auto flex gap-2">
          <Btn disabled={start === 0} onClick={() => setStart(Math.max(0, start - 50))}>Prev</Btn>
          <Btn onClick={() => setStart(start + 50)}>Next</Btn>
        </div>
      </div>
      {v?.status === 'error' && <ErrorNote>{v.error}</ErrorNote>}
      {lb.error && <ErrorNote>{lb.error}</ErrorNote>}
      <Panel>
        {!v && <Skeleton className="m-4 h-64" />}
        {v?.players.map((p) => (
          <div key={p.rank} className="grid grid-cols-[48px_36px_minmax(0,1fr)_120px_76px_64px] items-center gap-3 border-b border-line px-5 py-2 last:border-b-0">
            <span className="num font-display text-md font-bold text-muted">#{p.rank}</span>
            {p.cardIcon ? <Img src={p.cardIcon} alt="" className="h-8 w-8 rounded-sm" /> : <div className="h-8 w-8 rounded-sm bg-white/5" />}
            {p.anonymized ? <span className="truncate text-sm italic text-faint">{p.name}</span> : <PlayerName name={p.name} tag={p.tag} className="truncate text-sm" />}
            {p.rankInfo ? <RankBadge rank={p.rankInfo} /> : <span className="text-xs text-muted">Tier {p.tier}</span>}
            <span className="num text-right text-sm">{p.rr} RR</span>
            <span className="num text-right text-sm text-muted">{p.wins} W</span>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function Browser({ kind }: { kind: 'agents' | 'maps' | 'weapons' }) {
  const { data } = useRpc<any>('browse:get', []);
  const [sel, setSel] = useState<string | null>(null);
  const list: any[] = useMemo(() => [...(data?.[kind] ?? [])].sort((a, b) => String(a.name).localeCompare(String(b.name))), [data, kind]);
  const item = list.find((x) => x.id === sel) ?? list[0];
  if (!data) return <Skeleton className="h-64" />;
  return (
    <div className="grid grid-cols-[clamp(200px,20vw,260px)_minmax(0,1fr)] gap-4 xl:gap-5">
      <Panel className="max-h-[560px] overflow-y-auto py-1">
        {list.map((x) => (
          <button key={x.id} onClick={() => setSel(x.id)} className={cx('flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors duration-120', item?.id === x.id ? 'bg-white/[0.05] text-ink' : 'text-muted hover:text-ink')}>
            {x.icon && <Img src={img(x.icon)} alt="" className={cx('object-contain', kind === 'weapons' ? 'h-5 w-12' : 'h-7 w-7 rounded-sm')} />}
            <span className="truncate">{x.name}</span>
            {x.role && <span className="ml-auto text-2xs text-faint">{x.role}</span>}
          </button>
        ))}
      </Panel>
      {item && (
        <Panel className="overflow-hidden">
          {kind === 'agents' && (
            <div className="relative p-6">
              {item.portrait && <Img src={img(item.portrait)} alt="" className="absolute -right-10 top-0 h-[420px] opacity-40" />}
              <div className="relative max-w-[520px]">
                <div className="label">{item.role}</div>
                <h2 className="font-display text-2xl font-bold uppercase tracking-wide">{item.name}</h2>
                <p className="mt-2 text-sm text-muted">{plainText(item.description)}</p>
                <div className="mt-5 flex flex-col gap-3">
                  {item.abilities.filter((a: any) => a.name).map((a: any) => (
                    <div key={a.slot} className="flex gap-3">
                      {a.icon ? <Img src={img(a.icon)} alt="" className="h-9 w-9 shrink-0" /> : <div className="h-9 w-9 shrink-0" />}
                      <div>
                        <div className="text-sm font-medium">{a.name} <span className="ml-1 text-2xs text-faint">{SLOT_KEY[a.slot] ?? a.slot}</span></div>
                        <div className="text-xs text-muted">{plainText(a.description)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {kind === 'maps' && (
            <div>
              {item.splash && <Img src={img(item.splash)} alt="" className="h-[320px] w-full object-cover" />}
              <div className="p-6">
                <h2 className="font-display text-2xl font-bold uppercase tracking-wide">{item.name}</h2>
                <div className="text-sm text-muted">{item.sites}{item.coordinates ? ` · ${item.coordinates}` : ''}</div>
                {item.icon && <Img src={img(item.icon)} alt="Minimap" className="mt-4 h-64 w-64 object-contain" />}
              </div>
            </div>
          )}
          {kind === 'weapons' && (
            <div className="p-6">
              <div className="label">{item.category}</div>
              <h2 className="font-display text-2xl font-bold uppercase tracking-wide">{item.name}</h2>
              {item.icon && <Img src={img(item.icon)} alt="" className="my-4 h-24 object-contain" />}
              {item.stats ? (
                <>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-3 text-sm">
                    {[...(item.cost != null ? [['Cost', item.cost]] : []), ['Fire rate', item.stats.fireRate], ['Magazine', item.stats.magazine], ['Reload', `${item.stats.reload}s`]].map(([k, v]) => (
                      <div key={k as string} className="rounded-sm border border-line px-3 py-2">
                        <div className="label">{k}</div>
                        <div className="num mt-1">{v}</div>
                      </div>
                    ))}
                  </div>
                  <table className="mt-4 w-full text-sm">
                    <thead><tr>{['Range', 'Head', 'Body', 'Leg'].map((h) => <th key={h} className="label py-1.5 text-left">{h}</th>)}</tr></thead>
                    <tbody>{item.stats.damage.map((d: any) => <tr key={d.range} className="border-t border-line"><td className="py-1.5">{d.range}</td><td className="num">{Math.round(d.head)}</td><td className="num">{Math.round(d.body)}</td><td className="num">{Math.round(d.leg)}</td></tr>)}</tbody>
                  </table>
                </>
              ) : (
                <p className="text-sm text-muted">No stats (melee).</p>
              )}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

export function HubScreen({ connected, riotClient, initialTab, onProfile }: { connected: boolean; riotClient: boolean; initialTab?: Tab; onProfile: (q: string) => void }) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'friends');
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-7 xl:px-8">
      <PageHeader label="Hub" title="Hub" />
      <div className="mb-5">
        <TabBar
          tabs={[['friends', 'Friends'], ['leaderboard', 'Leaderboard'], ['agents', 'Agents'], ['maps', 'Maps'], ['weapons', 'Weapons']]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === 'friends' && <Friends riotClient={riotClient} onProfile={onProfile} />}
      {tab === 'leaderboard' && <Leaderboard connected={connected} />}
      {(tab === 'agents' || tab === 'maps' || tab === 'weapons') && <Browser kind={tab} />}
    </div>
  );
}
