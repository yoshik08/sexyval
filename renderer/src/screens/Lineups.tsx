import { useEffect, useMemo, useState } from 'react';
import type { LibraryLineup, LineupLibraryView, Lineup } from '../../../shared/features';
import { ago, cx } from '../lib/format';
import { img } from '../lib/media';
import { saveSettings, useSettings } from '../lib/store';
import { ArrowClockwise, ArrowSquareOut, MapPin, Play, Star, X } from '../lib/icons';
import { Img, Panel, Segmented, Select, Skeleton } from '../components/ui';
import { act, Btn, ErrorNote, Note, PageHeader, useRpc } from '../components/kit';
import { VideoPlayer } from '../components/VideoPlayer';

type Tab = 'library' | 'mine';

const FAV_KEY = 'sexyval.lineups.favorites';
function readFavs(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}
function useFavs() {
  const [favs, setFavs] = useState(readFavs);
  const toggle = (key: string) =>
    setFavs((f) => {
      const n = new Set(f);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      try {
        localStorage.setItem(FAV_KEY, JSON.stringify([...n]));
      } catch {
        // storage blocked: favourites last this session
      }
      return n;
    });
  return { favs, toggle };
}
type Side = 'all' | 'attack' | 'defense';

const prettyAbility = (k?: string) =>
  ({ reconbolt: 'Recon Bolt', shockbolt: 'Shock Bolt', snakebite: 'Snake Bite', poisoncloud: 'Poison Cloud', toxicscreen: 'Toxic Screen', incendiary: 'Incendiary', nanoswarm: 'Nanoswarm', alarmbot: 'Alarmbot', turret: 'Turret', skysmoke: 'Sky Smoke', stimbeacon: 'Stim Beacon', orbitalstrike: 'Orbital Strike', molly: 'Molly' })[k ?? ''] ??
  (k ? k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()) : 'Ability');
const DIFF_TONE: Record<string, string> = { easy: 'text-win', medium: 'text-warn', hard: 'text-loss' };

function LineupSheet({ l, agentName, onClose }: { l: LibraryLineup; agentName: string; onClose: () => void }) {
  const settings = useSettings();
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-8" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sheet-in w-full max-w-[980px] overflow-hidden rounded-[24px] bg-[#0c0c0e] ring-1 ring-white/10" onClick={(e) => e.stopPropagation()}>
        <div className="relative aspect-video bg-black">
          {l.video ? (
            <VideoPlayer src={l.video} poster={l.thumbnail} alt={l.title} autoPlay sound={settings?.soundOn ?? false} onSoundChange={(on) => void saveSettings({ soundOn: on })} className="absolute inset-0" />
          ) : l.thumbnail ? (
            <Img src={img(l.thumbnail)} alt={l.title} className="absolute inset-0 h-full w-full object-cover" />
          ) : null}
        </div>
        <div className="flex items-start gap-6 p-6">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-muted">
              {agentName} · {prettyAbility(l.ability)}
              {l.side ? ` · ${l.side === 'attack' ? 'Attack' : 'Defense'}` : ''}
              {l.difficulty && <span className={cx('ml-1 capitalize', DIFF_TONE[l.difficulty])}> · {l.difficulty}</span>}
            </div>
            <h2 className="t-head mt-1 text-xl text-ink">{l.title}</h2>
            {l.description && <p className="text-pretty mt-2 text-sm leading-relaxed text-ink/80">{l.description}</p>}
          </div>
          <Btn onClick={onClose}>
            <X size={14} weight="bold" /> Close
          </Btn>
        </div>
      </div>
    </div>
  );
}

/** Blitz's top-down layout with one numbered dot per lineup; hovering a card lights its dot. */
function LineupMap({ v, list, hover, onPick }: { v: LineupLibraryView; list: LibraryLineup[]; hover: string | null; onPick: (l: LibraryLineup) => void }) {
  const layout = v.mapArt?.layout;
  if (!layout) return null;
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-white/[0.03]">
      <Img src={img(layout)} alt="" className="absolute inset-0 h-full w-full object-contain opacity-80" />
      {list.map((l, i) =>
        l.x != null && l.y != null ? (
          <button
            key={l.id}
            type="button"
            title={l.title}
            onClick={() => onPick(l)}
            className={cx(
              'num absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[11px] font-semibold shadow-[0_2px_8px_rgba(0,0,0,0.6)] transition-transform duration-150',
              l.side === 'defense' ? 'bg-[#5ab0ff] text-black' : 'bg-[#ff6b6b] text-black',
              hover === l.id ? 'z-10 scale-[1.35] ring-2 ring-white' : 'hover:scale-125',
            )}
            style={{ left: `${l.x}%`, top: `${l.y}%` }}
          >
            {i + 1}
          </button>
        ) : null,
      )}
    </div>
  );
}

function Library() {
  const browse = useRpc<any>('browse:get', []);
  const agents: any[] = useMemo(() => [...(browse.data?.agents ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [browse.data]);
  const maps: any[] = useMemo(() => [...(browse.data?.maps ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [browse.data]);
  const [agent, setAgent] = useState<string>('');
  const [map, setMap] = useState<string>('');
  const [side, setSide] = useState<Side>('all');
  const [ability, setAbility] = useState('');
  const [v, setV] = useState<LineupLibraryView | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<LibraryLineup | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const { favs, toggle } = useFavs();
  const [onlyFavs, setOnlyFavs] = useState(false);
  const favKey = (l: LibraryLineup) => `${v?.agent}/${v?.map}/${l.id}`;
  useEffect(() => {
    if (!agent && agents.length) setAgent((agents.find((a) => a.name === 'Sova') ?? agents[0]).name);
    if (!map && maps.length) setMap((maps.find((m) => m.name === 'Ascent') ?? maps[0]).name);
  }, [agents, maps, agent, map]);
  const load = async (force = false) => {
    if (!agent || !map) return;
    setLoading(true);
    const r = await act<LineupLibraryView>('lineups:library', agent, map, force);
    setLoading(false);
    setV(r.ok ? r.data : { status: 'error', error: r.error, agent, map, lineups: [], source: '' });
  };
  useEffect(() => {
    setAbility('');
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, map]);
  const abilities = useMemo(() => [...new Set((v?.lineups ?? []).map((l) => l.ability).filter(Boolean) as string[])], [v]);
  const shown = (v?.lineups ?? [])
    .filter((l) => (side === 'all' || l.side === side) && (!ability || l.ability === ability) && (!onlyFavs || favs.has(`${v?.agent}/${v?.map}/${l.id}`)))
    .sort((a, b) => Number(favs.has(`${v?.agent}/${v?.map}/${b.id}`)) - Number(favs.has(`${v?.agent}/${v?.map}/${a.id}`)));
  const agentRow = agents.find((a) => a.name === agent);
  if (!browse.data) return <Skeleton className="h-64" />;
  return (
    <div className="flex flex-col gap-5">
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="listbox" aria-label="Agent">
        {agents.map((a) => (
          <button
            key={a.id}
            role="option"
            aria-selected={a.name === agent}
            title={a.name}
            onClick={() => setAgent(a.name)}
            className={cx('press flex w-[60px] shrink-0 flex-col items-center gap-1 rounded-2xl px-1 py-1.5 text-[11px] font-medium leading-tight', a.name === agent ? 'bg-white/[0.14] text-ink' : 'text-muted hover:bg-white/[0.06] hover:text-ink')}
          >
            <Img src={img(a.icon)} alt="" className={cx('h-10 w-10 rounded-xl', a.name !== agent && 'opacity-70')} />
            <span className="w-full truncate text-center">{a.name}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <Select value={map} onChange={setMap} options={maps.map((m) => ({ value: m.name, label: m.name }))} />
        <Segmented<Side> size="sm" value={side} onChange={setSide} options={[['all', 'Both sides'], ['attack', 'Attack'], ['defense', 'Defense']]} />
        {abilities.length > 1 && <Select value={ability} onChange={setAbility} options={[{ value: '', label: 'All abilities' }, ...abilities.map((a) => ({ value: a, label: prettyAbility(a) }))]} />}
        <button type="button" aria-pressed={onlyFavs} onClick={() => setOnlyFavs((x) => !x)} className={cx('press inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-medium', onlyFavs ? 'bg-white text-black' : 'bg-white/[0.08] text-muted hover:text-ink')}>
          <Star size={13} weight={onlyFavs ? 'fill' : 'bold'} /> Favourites
        </button>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted">
          {v?.fetchedAt && <span>{v.stale ? 'Offline copy · ' : ''}updated {ago(v.fetchedAt)}</span>}
          <Btn tone="ghost" size="sm" onClick={() => void load(true)} disabled={loading}>
            <ArrowClockwise size={14} weight="bold" /> Refresh
          </Btn>
        </div>
      </div>
      {v?.status === 'error' && <ErrorNote>{v.error}</ErrorNote>}
      {loading && !v && <Skeleton className="h-72" />}
      {v?.status === 'ready' && (
        <div className={cx('grid gap-5 transition-opacity duration-150', loading && 'opacity-60', v.mapArt?.layout && shown.length ? 'grid-cols-[clamp(260px,30vw,400px)_minmax(0,1fr)]' : 'grid-cols-1')}>
          {v.mapArt?.layout && shown.length > 0 && (
            <div className="sticky top-4 self-start">
              <LineupMap v={v} list={shown} hover={hover} onPick={setOpen} />
              <div className="mt-2 flex items-center gap-3 text-2xs text-faint">
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#ff6b6b]" /> Attack</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#5ab0ff]" /> Defense</span>
                <span className="ml-auto inline-flex items-center gap-1"><MapPin size={11} /> where it lands</span>
              </div>
            </div>
          )}
          <div>
            {shown.length ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                {shown.map((l, i) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setOpen(l)}
                    onMouseEnter={() => setHover(l.id)}
                    onMouseLeave={() => setHover(null)}
                    className="group flex flex-col overflow-hidden rounded-[18px] bg-surface text-left ring-1 ring-inset ring-white/[0.07] transition-shadow duration-200 hover:ring-white/[0.18]"
                  >
                    <div className="relative aspect-video bg-black">
                      {l.thumbnail && <Img src={img(l.thumbnail)} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />}
                      <span className="num absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-[11px] font-semibold text-ink">{i + 1}</span>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-pressed={favs.has(favKey(l))}
                        title={favs.has(favKey(l)) ? 'Remove from favourites' : 'Add to favourites'}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(favKey(l));
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.stopPropagation();
                            toggle(favKey(l));
                          }
                        }}
                        className={cx('absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/70', favs.has(favKey(l)) ? 'text-warn' : 'text-ink/70 hover:text-ink')}
                      >
                        <Star size={14} weight={favs.has(favKey(l)) ? 'fill' : 'bold'} />
                      </span>
                      {l.video && (
                        <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/90 text-black">
                            <Play size={18} weight="fill" />
                          </span>
                        </span>
                      )}
                    </div>
                    <div className="flex flex-1 flex-col gap-1 p-3.5">
                      <div className="line-clamp-2 text-sm font-medium leading-snug text-ink">{l.title}</div>
                      <div className="mt-auto pt-1 text-xs text-muted">
                        {prettyAbility(l.ability)}
                        {l.side ? ` · ${l.side === 'attack' ? 'Attack' : 'Defense'}` : ''}
                        {l.difficulty && <span className={cx('capitalize', DIFF_TONE[l.difficulty])}> · {l.difficulty}</span>}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <Note>
                {v.lineups.length ? 'No lineups for this side or ability.' : `Blitz has no ${agent} lineups for ${map} yet. Lineups exist mostly for agents with throwable or bouncing utility (Sova, Viper, Brimstone, Killjoy, KAY/O, Fade, Gekko…).`}
              </Note>
            )}
          </div>
        </div>
      )}
      {v?.source && (
        <p className="text-xs text-faint">
          Lineups and clips by{' '}
          <button className="inline-flex items-center gap-1 text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => void act('open:url', v.source)}>
            Blitz.gg <ArrowSquareOut size={11} weight="bold" />
          </button>
          , fetched when you open an agent and map and kept for a day.
        </p>
      )}
      {open && <LineupSheet l={open} agentName={agentRow?.name ?? agent} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Your own lineups (screenshots + links), stored locally. Moved here from Hub. */
function MyLineups() {
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
        {!shown.length && <Note>No saved lineups yet. Add your own with screenshots and links.</Note>}
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

export function LineupsScreen({ initialTab }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'library');
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  return (
    <div className="mx-auto max-w-[1280px] px-6 py-7 xl:px-8">
      <PageHeader title="Lineups" right={<Segmented<Tab> value={tab} onChange={setTab} options={[['library', 'Library'], ['mine', 'My lineups']]} />} />
      {tab === 'library' ? <Library /> : <MyLineups />}
    </div>
  );
}
