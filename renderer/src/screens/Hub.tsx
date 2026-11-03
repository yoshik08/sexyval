import { useEffect, useMemo, useState } from 'react';
import type { FriendRequestView, FriendView, LeaderboardView, Lineup } from '../../../shared/features';
import { ago, cx } from '../lib/format';
import { img } from '../lib/media';
import { Img, Panel, RankBadge, Skeleton } from '../components/ui';
import { act, Btn, ErrorNote, Note, PageHeader, TabBar, useRpc } from '../components/kit';
import { useInterval } from '../lib/store';

type Tab = 'friends' | 'leaderboard' | 'agents' | 'maps' | 'weapons' | 'lineups';

/** Game text carries style tags like <whitebold>Wingman</> or <debuffred>; show the words only. */
const plainText = (s: unknown) => String(s ?? '').replace(/<\/?[a-z]*>/gi, '');
/** Ability slots as the keys players know. */
const SLOT_KEY: Record<string, string> = { Ability1: 'Q', Ability2: 'E', Grenade: 'C', Ultimate: 'X', Passive: 'Passive' };

function Friends({ riotClient, onProfile }: { riotClient: boolean; onProfile: (q: string) => void }) {
  const { data, setData, error, reload } = useRpc<{ friends: FriendView[]; requests: FriendRequestView[] }>('hub:friends', [], riotClient);
  const [nt, setNt] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useInterval(() => riotClient && void reload(), 15000, [riotClient, reload]);
  if (!riotClient) return <Note>Friends and presence come from the Riot Client’s local chat API. Start the Riot Client to see them (a web sign-in can’t reach chat).</Note>;
  const online = data?.friends.filter((f) => f.online) ?? [];
  const offline = data?.friends.filter((f) => !f.online) ?? [];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_clamp(280px,26vw,340px)] gap-4 xl:gap-5">
      <Panel>
        <div className="border-b border-line px-5 py-3 label">Online · {online.length}</div>
        {error && <div className="p-4"><ErrorNote>{error}</ErrorNote></div>}
        {!data && !error && <Skeleton className="m-4 h-40" />}
        {[...online, ...offline].map((f) => (
          <div key={f.puuid} className={cx('flex items-center gap-3 border-b border-line px-5 py-2.5 last:border-b-0', !f.online && 'opacity-55')}>
            <span className={cx('h-2 w-2 rounded-full', f.online ? (f.state === 'away' ? 'bg-warn' : 'bg-win') : 'bg-faint')} />
            <button className="min-w-0 flex-1 text-left" onClick={() => onProfile(`${f.name}#${f.tag}`)}>
              <div className="truncate text-sm">
                {f.name}
                <span className="text-faint">#{f.tag}</span>
                {f.note && <span className="ml-2 text-xs text-faint">“{f.note}”</span>}
              </div>
              <div className="text-xs text-muted">{f.online ? (f.status ?? 'Online') + (f.partySize && f.partySize > 1 ? ` · party of ${f.partySize}` : '') : f.lastOnline ? `Last online ${ago(f.lastOnline)}` : 'Offline'}</div>
            </button>
            {f.rank && <RankBadge rank={f.rank} compact />}
            {f.level && <span className="num w-12 text-right text-xs text-muted">Lv {f.level}</span>}
          </div>
        ))}
      </Panel>
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
              <span className="min-w-0 flex-1 truncate">{r.name}<span className="text-faint">#{r.tag}</span></span>
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
  const lb = useRpc<LeaderboardView>('hub:leaderboard', [season, start], connected);
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
            <span className={cx('truncate text-sm', p.anonymized && 'italic text-faint')}>{p.name}{p.tag && <span className="text-faint">#{p.tag}</span>}</span>
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
                    {[['Cost', item.cost ?? '–'], ['Fire rate', item.stats.fireRate], ['Magazine', item.stats.magazine], ['Reload', `${item.stats.reload}s`]].map(([k, v]) => (
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

function Lineups() {
  const { data: list, setData } = useRpc<Lineup[]>('hub:lineups', []);
  const browse = useRpc<any>('browse:get', []);
  const [draft, setDraft] = useState<Partial<Lineup>>({ title: '', links: [], images: [] });
  const [link, setLink] = useState('');
  const [filter, setFilter] = useState<{ agentId?: string; mapId?: string }>({});
  const agents: any[] = useMemo(() => [...(browse.data?.agents ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [browse.data]);
  const maps: any[] = useMemo(() => [...(browse.data?.maps ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [browse.data]);
  const shown = (list ?? []).filter((l) => (!filter.agentId || l.agentId === filter.agentId) && (!filter.mapId || l.mapId === filter.mapId));
  const save = async () => {
    const r = await act<Lineup[]>('hub:saveLineup', { ...draft, title: draft.title || 'Untitled lineup' });
    if (r.ok) {
      setData(r.data);
      setDraft({ title: '', links: [], images: [] });
    }
  };
  const sel = 'field';
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_clamp(290px,28vw,360px)] gap-4 xl:gap-5">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <select className={sel} value={filter.agentId ?? ''} onChange={(e) => setFilter({ ...filter, agentId: e.target.value || undefined })}>
            <option value="">All agents</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select className={sel} value={filter.mapId ?? ''} onChange={(e) => setFilter({ ...filter, mapId: e.target.value || undefined })}>
            <option value="">All maps</option>
            {maps.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        {shown.map((l) => (
          <Panel key={l.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-display text-md font-semibold uppercase tracking-wide">{l.title}</div>
                <div className="text-xs text-muted">
                  {agents.find((a) => a.id === l.agentId)?.name ?? 'Any agent'} · {maps.find((m) => m.id === l.mapId)?.name ?? 'Any map'}{l.site ? ` · ${l.site} site` : ''}
                </div>
              </div>
              <Btn tone="danger" onClick={async () => { const r = await act<Lineup[]>('hub:deleteLineup', l.id); if (r.ok) setData(r.data); }}>Delete</Btn>
            </div>
            {l.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-ink/85">{l.notes}</p>}
            {l.images.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {l.images.map((src) => <Img key={src} src={src} alt="" className="h-28 rounded-sm object-cover" />)}
              </div>
            )}
            {l.links.length > 0 && (
              <ul className="mt-2 text-xs text-muted">
                {l.links.map((u) => <li key={u} className="select-text truncate">{u}</li>)}
              </ul>
            )}
          </Panel>
        ))}
        {!shown.length && <Note>No lineups yet. Riot doesn’t provide any; add your own with screenshots and links.</Note>}
      </div>
      <Panel className="flex flex-col gap-3 p-5">
        <div className="label">New lineup</div>
        <input value={draft.title ?? ''} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Title (e.g. A main molly from spawn)" className={cx(sel, 'w-full')} />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
          <select className={sel} value={draft.agentId ?? ''} onChange={(e) => setDraft({ ...draft, agentId: e.target.value || undefined })}>
            <option value="">Agent</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select className={sel} value={draft.mapId ?? ''} onChange={(e) => setDraft({ ...draft, mapId: e.target.value || undefined })}>
            <option value="">Map</option>
            {maps.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select className={sel} value={draft.site ?? ''} onChange={(e) => setDraft({ ...draft, site: e.target.value || undefined })}>
            <option value="">Site</option>
            {['A', 'B', 'C', 'Mid'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <textarea value={draft.notes ?? ''} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={4} placeholder="Notes" className="field-area" />
        <div className="flex gap-2">
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" className={cx(sel, 'min-w-0 flex-1')} />
          <Btn disabled={!/^https?:\/\//.test(link)} onClick={() => { setDraft({ ...draft, links: [...(draft.links ?? []), link] }); setLink(''); }}>Add link</Btn>
        </div>
        <Btn onClick={async () => { const r = await act<string | null>('hub:pickImage'); if (r.ok && r.data) setDraft({ ...draft, images: [...(draft.images ?? []), r.data] }); }}>Add image…</Btn>
        <div className="flex flex-wrap gap-2">
          {(draft.images ?? []).map((s) => <Img key={s} src={s} alt="" className="h-16 rounded-sm" />)}
          {(draft.links ?? []).map((u) => <span key={u} className="truncate text-2xs text-muted">{u}</span>)}
        </div>
        <Btn tone="primary" onClick={() => void save()}>Save lineup</Btn>
      </Panel>
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
          tabs={[['friends', 'Friends'], ['leaderboard', 'Leaderboard'], ['agents', 'Agents'], ['maps', 'Maps'], ['weapons', 'Weapons'], ['lineups', 'Lineups']]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === 'friends' && <Friends riotClient={riotClient} onProfile={onProfile} />}
      {tab === 'leaderboard' && <Leaderboard connected={connected} />}
      {(tab === 'agents' || tab === 'maps' || tab === 'weapons') && <Browser kind={tab} />}
      {tab === 'lineups' && <Lineups />}
    </div>
  );
}
