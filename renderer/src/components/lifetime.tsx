import { useEffect, useMemo, useState } from 'react';
import type { LifetimeGroupView, LifetimeView, MatchRow, MmrChip as Chip } from '../../../shared/features';
import { tierName } from '../../../shared/mmr';
import { cx, kd } from '../lib/format';
import { Gauge } from '../lib/icons';
import { openPlayer } from '../lib/store';
import { act, Btn, ErrorNote } from './kit';
import { Img, Panel, Skeleton } from './ui';
import { LineChart } from './charts';

const when = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** "Estimated MMR · Plat 2" chip; loads on mount, opens the MMR tab for this player. */
export function MmrChip({ puuid, className }: { puuid: string; className?: string }) {
  const [chip, setChip] = useState<Chip | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setChip(null);
    setFailed(false);
    void act<Chip>('mmr:chip', puuid).then((r) => live && (r.ok ? setChip(r.data) : setFailed(true)));
    return () => {
      live = false;
    };
  }, [puuid]);
  if (failed) return null;
  return (
    <button
      type="button"
      data-no-toggle
      onClick={(e) => {
        e.stopPropagation();
        openPlayer('mmr', puuid);
      }}
      title="Our own estimate from RR changes and lobby ranks. Riot doesn’t show real MMR."
      className={cx('press inline-flex h-7 items-center gap-1.5 rounded-full bg-white/[0.08] pl-1.5 pr-2.5 text-xs font-medium text-ink hover:bg-white/[0.14]', className)}
    >
      {chip?.est?.icon ? <Img src={chip.est.icon} alt="" className="h-5 w-5" /> : <Gauge size={14} className="ml-1 text-muted" />}
      {chip ? (chip.usable ? `Estimated MMR · ${chip.est?.name ?? '–'}` : 'Estimated MMR · –') : <Skeleton className="h-3 w-24" />}
    </button>
  );
}

/** One line of a match list (Profiles history and the lifetime list share it). */
export function MatchLine({ m, onOpen }: { m: MatchRow; onOpen?: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpen?.(m.matchId)}
      className="grid w-full grid-cols-[6px_36px_minmax(0,1fr)_84px_72px_64px_64px_52px] items-center gap-3 border-b border-line px-5 py-2.5 text-left transition-colors duration-120 last:border-b-0 hover:bg-white/[0.03]"
    >
      <span className={cx('h-8 w-1.5 rounded-[1px]', m.result === 'W' ? 'bg-win' : m.result === 'L' ? 'bg-loss' : 'bg-faint')} />
      <Img src={m.agentIcon} alt="" className="h-9 w-9 rounded-sm bg-white/5" />
      <div className="min-w-0">
        <div className="truncate font-display text-md font-semibold uppercase tracking-wide">{m.mapName ?? 'Unknown'}</div>
        <div className="truncate text-xs text-muted">
          {m.agentName} · {m.queueTag} · {when(m.startTime)}
          {m.tierAfter ? ` · ${tierName(m.tierAfter)} after` : ''}
        </div>
      </div>
      <span className="num text-right text-sm">
        {m.kills}/{m.deaths}/{m.assists}
      </span>
      <span className="num text-right text-sm text-muted">{m.acs} ACS</span>
      <span className="num text-right text-sm text-muted">{m.hsPct != null ? `${m.hsPct}% HS` : '–'}</span>
      <span className={cx('num text-right text-sm', m.rrChange == null ? 'text-faint' : m.rrChange >= 0 ? 'text-win' : 'text-loss')}>{m.rrChange == null ? '–' : `${m.rrChange > 0 ? '+' : ''}${m.rrChange} RR`}</span>
      <span className={cx('num text-right font-display text-md font-semibold', m.result === 'W' ? 'text-win' : m.result === 'L' ? 'text-loss' : 'text-muted')}>{m.score}</span>
    </button>
  );
}

function useLifetime(puuid: string) {
  const [view, setView] = useState<LifetimeView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async (count: number) => {
    setLoading(true);
    setErr(null);
    const r = await act<LifetimeView>('lifetime:get', puuid, count);
    setLoading(false);
    // A failed refresh keeps the last good result on screen.
    if (r.ok) setView(r.data);
    else setErr(r.error);
  };
  useEffect(() => {
    setView(null);
    void load(20);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puuid]);
  return { view, err, loading, more: () => view && load(view.loaded + 20) };
}

/** Compact lifetime line for a Live row (fetched when the row opens, never for the whole roster). */
export function LifetimeLine({ puuid }: { puuid: string }) {
  const { view, err } = useLifetime(puuid);
  if (err && !view) return <div className="text-xs text-faint">Lifetime unavailable: {err}</div>;
  if (!view) return <Skeleton className="h-4 w-full max-w-[260px]" />;
  const t = view.totals;
  const parts = [`${view.totalMatches} matches`, view.competitive.winRate != null ? `${view.competitive.winRate}% WR` : null, `${kd(t.kd)} K/D`, `${t.acs} ACS`, t.adr != null ? `${t.adr} ADR` : null].filter(Boolean);
  return (
    <div className="text-xs text-muted" title={`Lifetime: competitive record from every act; K/D, ACS and ADR from the ${view.loaded} most recent matches.`}>
      <span className="text-faint">Lifetime </span>
      <span className="num text-ink/90">{parts.join(' · ')}</span>
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: React.ReactNode; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-faint">{k}</div>
      <div className="t-num mt-1 truncate text-[22px] leading-none text-ink">{v}</div>
      {sub && <div className="mt-1 text-2xs text-faint">{sub}</div>}
    </div>
  );
}

function GroupTable({ title, rows, icon }: { title: string; rows: LifetimeGroupView[]; icon?: boolean }) {
  return (
    <Panel className="p-5">
      <div className="mb-3 text-xs text-faint">{title}</div>
      {rows.length ? (
        <div className="flex flex-col">
          <div className="grid grid-cols-[minmax(0,1fr)_52px_52px_52px_52px] gap-2 pb-1.5 text-2xs text-faint">
            <span />
            <span className="text-right">Games</span>
            <span className="text-right">Win</span>
            <span className="text-right">K/D</span>
            <span className="text-right">ACS</span>
          </div>
          {rows.slice(0, 8).map((g) => (
            <div key={g.key} className="grid grid-cols-[minmax(0,1fr)_52px_52px_52px_52px] items-center gap-2 border-t border-line py-1.5 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                {icon && <Img src={g.icon} alt="" className="h-6 w-6 shrink-0 rounded-md bg-white/5" />}
                <span className="truncate">{g.name}</span>
              </span>
              <span className="num text-right text-muted">{g.games}</span>
              <span className="num text-right">{g.winRate != null ? `${g.winRate}%` : '–'}</span>
              <span className="num text-right text-muted">{kd(g.kd)}</span>
              <span className="num text-right text-muted">{g.acs}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-muted">No matches loaded.</div>
      )}
    </Panel>
  );
}

/** Full lifetime profile body (Profiles, opened from Live, MMR or a scoreboard by PUUID). */
export function LifetimeSection({ puuid, onOpenMatch }: { puuid: string; onOpenMatch?: (id: string) => void }) {
  const { view, err, loading, more } = useLifetime(puuid);
  const points = useMemo(() => (view?.timeline ?? []).map((p) => ({ x: p.t, y: p.tier + Math.min(99, p.rr) / 100, label: `${new Date(p.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · ${p.delta > 0 ? '+' : ''}${p.delta} RR` })), [view]);
  if (!view) {
    return (
      <div className="flex flex-col gap-5">
        {err ? <ErrorNote>{err}</ErrorNote> : null}
        {!err && (
          <>
            <Skeleton className="h-[96px] rounded-[20px]" />
            <div className="grid grid-cols-2 gap-5">
              <Skeleton className="h-[240px] rounded-[20px]" />
              <Skeleton className="h-[240px] rounded-[20px]" />
            </div>
          </>
        )}
      </div>
    );
  }
  const t = view.totals;
  const f10 = view.currentAct.last10;
  const f20 = view.currentAct.last20;
  return (
    <div data-lifetime className="flex flex-col gap-5">
      {err && <ErrorNote>{err}</ErrorNote>}
      <Panel className="p-5">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="t-head text-md">Lifetime</h2>
          <span className="text-xs text-faint">
            Competitive record from every act · K/D, ACS, ADR and HS% from the {view.loaded} most recent of {view.totalMatches} matches
          </span>
        </div>
        <div className="grid grid-cols-8 gap-4">
          <Stat k="Matches" v={view.totalMatches} sub={`${view.competitive.matches} competitive`} />
          <Stat k="Win rate" v={view.competitive.winRate != null ? `${view.competitive.winRate}%` : '–'} sub={`${view.competitive.wins}W ${view.competitive.losses}L`} />
          <Stat k="K/D" v={kd(t.kd)} />
          <Stat k="ACS" v={t.acs || '–'} />
          <Stat k="ADR" v={t.adr ?? '–'} />
          <Stat k="HS%" v={t.hsPct != null ? `${t.hsPct}%` : '–'} />
          <Stat k="First bloods" v={t.firstBloods} />
          <Stat k="This act" v={f10.winRate != null ? `${f10.winRate}%` : '–'} sub={f20.n ? `last 10 · ${f20.winRate ?? '–'}% last 20` : 'no matches yet'} />
        </div>
        {(view.best.agent || view.best.map) && (
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted">
            {view.best.agent && <span className="rounded-full bg-white/[0.06] px-3 py-1">Best agent <span className="text-ink">{view.best.agent.name}</span> · {view.best.agent.winRate}%</span>}
            {view.best.worstAgent && <span className="rounded-full bg-white/[0.06] px-3 py-1">Worst agent <span className="text-ink">{view.best.worstAgent.name}</span> · {view.best.worstAgent.winRate}%</span>}
            {view.best.map && <span className="rounded-full bg-white/[0.06] px-3 py-1">Best map <span className="text-ink">{view.best.map.name}</span> · {view.best.map.winRate}%</span>}
            {view.best.worstMap && <span className="rounded-full bg-white/[0.06] px-3 py-1">Worst map <span className="text-ink">{view.best.worstMap.name}</span> · {view.best.worstMap.winRate}%</span>}
          </div>
        )}
      </Panel>
      <div className="grid grid-cols-2 gap-5">
        <GroupTable title="Agents" rows={view.byAgent} icon />
        <GroupTable title="Maps" rows={view.byMap} />
      </div>
      <Panel className="p-5">
        <div className="mb-2 text-xs text-faint">Rank across acts · one point per competitive match</div>
        <LineChart title="Rank across acts" height={180} points={points} format={(v) => tierName(v, true)} marks={view.actStarts.map((a) => ({ index: a.index, label: a.name }))} />
      </Panel>
      <Panel>
        {view.matches.length ? view.matches.map((m) => <MatchLine key={m.matchId} m={m} onOpen={onOpenMatch} />) : <div className="px-5 py-6 text-sm text-muted">No competitive matches found.</div>}
        {view.hasMore && (
          <div className="flex items-center justify-center gap-3 border-t border-line px-5 py-3">
            <Btn size="sm" onClick={() => void more()} disabled={loading}>
              {loading ? 'Loading…' : 'Load 20 more'}
            </Btn>
            <span className="text-xs text-faint">
              {view.loaded} of {view.totalMatches}
            </span>
          </div>
        )}
      </Panel>
      <p className="text-xs text-faint">From Riot’s own match data for a player in your game.</p>
    </div>
  );
}
