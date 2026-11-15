import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReplayListItem, ReplayView } from '../../../shared/features';
import { frameAt, replayEvents, snapshots, type EventKind, type ReplayEvent, type ReplayKill } from '../../../shared/replay';
import { cx, fmtBytes } from '../lib/format';
import { img } from '../lib/media';
import { ArrowClockwise, CaretLeft, CaretRight, FilmStrip, FolderOpen, Info, Pause, Play, SkipBack, SkipForward, Skull, X } from '../lib/icons';
import { Img, Panel, Segmented, Select, Skeleton } from '../components/ui';
import { act, Btn, ErrorNote, Note, PageHeader, useRpc } from '../components/kit';
import { PlayerName } from '../components/PlayerName';

const ALLY = '#3ddc97';
const ENEMY = '#ff5c5c';
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

type Filter = 'all' | 'kill' | 'death' | 'assist' | 'trade' | 'multi' | 'clutch' | 'bomb';
const FILTERS: { value: Filter; label: string; kinds: EventKind[]; needsFocus?: boolean }[] = [
  { value: 'all', label: 'All events', kinds: ['kill', 'death', 'assist', 'trade', 'multikill', 'ace', 'clutch', 'plant', 'defuse'] },
  { value: 'kill', label: 'Kills', kinds: ['kill'] },
  { value: 'death', label: 'Deaths', kinds: ['death'], needsFocus: true },
  { value: 'assist', label: 'Assists', kinds: ['assist'], needsFocus: true },
  { value: 'trade', label: 'Trades', kinds: ['trade'] },
  { value: 'multi', label: 'Multi-kills & aces', kinds: ['multikill', 'ace'] },
  { value: 'clutch', label: 'Clutches', kinds: ['clutch'] },
  { value: 'bomb', label: 'Plants & defuses', kinds: ['plant', 'defuse'] },
];

const RESULT_SHORT: Record<string, string> = { Eliminated: 'Elim', 'Bomb detonated': 'Spike', 'Bomb defused': 'Defuse', 'Round timer expired': 'Time', Surrendered: 'FF' };

// ---------------- list ----------------

function ReplayList({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, error, loading, reload } = useRpc<{ items: ReplayListItem[]; folder: string; folderFound: boolean }>('replays:list', []);
  const files = data?.items.filter((i) => i.file) ?? [];
  const rest = data?.items.filter((i) => !i.file) ?? [];
  const Row = ({ m }: { m: ReplayListItem }) => (
    <button type="button" onClick={() => onOpen(m.matchId)} className="group flex w-full items-center gap-4 border-b border-line px-5 py-3 text-left last:border-b-0 hover:bg-white/[0.03]">
      <div className="relative h-12 w-24 shrink-0 overflow-hidden rounded-xl bg-white/[0.05]">
        {m.mapImage && <Img src={m.mapImage} alt="" className="h-full w-full object-cover opacity-80" />}
        {m.agentIcon && <Img src={m.agentIcon} alt="" className="absolute bottom-1 right-1 h-7 w-7 rounded-lg ring-2 ring-black" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          {m.mapName ?? 'Match'}
          {m.file && <span className="rounded-full bg-white/[0.1] px-2 py-0.5 text-2xs font-semibold text-ink/80">Replay file · {fmtBytes(m.file.size)}</span>}
        </div>
        <div className="text-xs text-muted">
          {[m.queueTag, m.startTime ? when(m.startTime) : undefined, m.kda].filter(Boolean).join(' · ') || m.matchId.slice(0, 8)}
        </div>
      </div>
      {m.score && <span className={cx('num text-md font-semibold', m.result === 'W' ? 'text-win' : m.result === 'L' ? 'text-loss' : 'text-muted')}>{m.score}</span>}
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-ink transition-colors group-hover:bg-white group-hover:text-black">
        <Play size={14} weight="fill" />
      </span>
    </button>
  );
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3 rounded-2xl bg-white/[0.05] px-4 py-3 text-sm text-muted">
        <Info size={18} className="mt-0.5 shrink-0" />
        <div className="flex-1">
          Valorant’s own replay files (.vrf) use Riot’s private format and only play inside the game. SexyVal redraws any match on the minimap instead, from Riot’s match data: where every player stood at each kill, plant and defuse.
        </div>
        <div className="flex shrink-0 gap-2">
          <Btn size="sm" tone="ghost" onClick={() => void act('replays:reveal')} title={data?.folder}>
            <FolderOpen size={14} /> Replays folder
          </Btn>
          <Btn size="sm" tone="ghost" onClick={() => void reload()} disabled={loading}>
            <ArrowClockwise size={14} weight="bold" />
          </Btn>
        </div>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data && !error && <Skeleton className="h-64" />}
      {data && (
        <>
          <Panel>
            <div className="border-b border-line px-5 py-3 label">Saved on this PC · {files.length}</div>
            {files.map((m) => (
              <Row key={m.matchId} m={m} />
            ))}
            {!files.length && <div className="px-5 py-4 text-sm text-muted">{data.folderFound ? 'No replay files yet. Download one from a match in Valorant’s Career tab.' : 'Valorant hasn’t saved any replays on this PC.'}</div>}
          </Panel>
          {rest.length > 0 && (
            <Panel>
              <div className="border-b border-line px-5 py-3 label">Recent matches · {rest.length}</div>
              {rest.map((m) => (
                <Row key={m.matchId} m={m} />
              ))}
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

// ---------------- viewer ----------------

function useAbilityIcon(v: ReplayView) {
  return useMemo(() => {
    const lower = new Map(Object.entries(v.abilities).map(([k, a]) => [k.toLowerCase(), a]));
    return (k: ReplayKill) => {
      if (!k.weapon) return undefined;
      const w = v.weapons[k.weapon];
      if (w) return w;
      const agent = v.players.find((p) => p.puuid === k.killer)?.agentId;
      return agent ? lower.get(`${agent}:${k.weapon}`) : undefined;
    };
  }, [v]);
}

function nearestCallout(v: ReplayView, x?: number, y?: number) {
  if (x == null || y == null || !v.callouts.length) return undefined;
  let best = v.callouts[0];
  let d = Infinity;
  for (const c of v.callouts) {
    const dd = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (dd < d) {
      d = dd;
      best = c;
    }
  }
  return best.name;
}

function Viewer({ id, onBack }: { id: string; onBack: () => void }) {
  const [v, setV] = useState<ReplayView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<'0.5' | '1' | '2' | '4'>('2');
  const [focus, setFocus] = useState<string | undefined>();
  const [filter, setFilter] = useState<Filter>('all');
  const [heat, setHeat] = useState(false);
  const tRef = useRef(0);
  tRef.current = t;

  useEffect(() => {
    let live = true;
    void act<ReplayView>('replays:get', id).then((r) => {
      if (!live) return;
      if (r.ok) {
        setV(r.data);
        setFocus(r.data.players.some((p) => p.puuid === r.data.me) ? r.data.me : undefined);
      } else setErr(r.error);
    });
    return () => {
      live = false;
    };
  }, [id]);

  const r = v?.rounds[round];
  const snaps = useMemo(() => (r ? snapshots(r) : []), [r]);
  const puuids = useMemo(() => v?.players.map((p) => p.puuid) ?? [], [v]);
  const frame = useMemo(() => (r ? frameAt(r, snaps, puuids, t) : {}), [r, snaps, puuids, t]);
  const byId = useMemo(() => new Map((v?.players ?? []).map((p) => [p.puuid, p])), [v]);
  const myTeam = (v && byId.get(v.me ?? '')?.teamId) ?? v?.teams[0]?.teamId;
  const colorOf = useCallback((p?: string) => (p && byId.get(p)?.teamId === myTeam ? ALLY : ENEMY), [byId, myTeam]);
  const nameOf = useCallback((p?: string) => (p ? (byId.get(p)?.name ?? byId.get(p)?.agentName ?? 'Player') : 'the world'), [byId]);
  const iconFor = useAbilityIcon(v ?? ({ abilities: {}, weapons: {}, players: [] } as unknown as ReplayView));

  const allEvents = useMemo(() => (v ? replayEvents(v, focus, nameOf) : []), [v, focus, nameOf]);
  const fdef = FILTERS.find((f) => f.value === filter)!;
  const events = allEvents.filter((e) => fdef.kinds.includes(e.kind));
  const roundEvents = (v ? replayEvents(v, undefined, nameOf) : []).filter((e) => e.round === r?.n && (e.kind === 'kill' || e.kind === 'plant' || e.kind === 'defuse'));

  // Playback clock.
  useEffect(() => {
    if (!playing || !r || !v) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) * Number(speed);
      last = now;
      const next = tRef.current + dt;
      if (next >= r.length) {
        if (round < v.rounds.length - 1) {
          setRound(round + 1);
          setT(0);
        } else {
          setT(r.length);
          setPlaying(false);
        }
        return;
      }
      setT(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, r, v, round, speed]);

  const jump = (e: ReplayEvent, lead = 1500) => {
    const ri = v!.rounds.findIndex((x) => x.n === e.round);
    if (ri >= 0) setRound(ri);
    setT(Math.max(0, e.t - lead));
    setPlaying(true);
  };
  const cur = { round: r?.n ?? 0, t };
  const nextEv = events.find((e) => e.round > cur.round || (e.round === cur.round && e.t > cur.t + 1600));
  const prevEv = [...events].reverse().find((e) => e.round < cur.round || (e.round === cur.round && e.t < cur.t - 200));

  // Keyboard: space play/pause, arrows step events, [ ] rounds.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return;
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowRight' && nextEv) jump(nextEv);
      else if (e.key === 'ArrowLeft' && prevEv) jump(prevEv);
      else if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  if (err) return <div className="flex flex-col gap-4"><Btn tone="ghost" className="self-start" onClick={onBack}><CaretLeft size={14} weight="bold" /> Replays</Btn><ErrorNote>{err}</ErrorNote></div>;
  if (!v || !r) return <Skeleton className="h-[560px]" />;

  const teams = [myTeam, v.teams.find((x) => x.teamId !== myTeam)?.teamId].filter(Boolean) as string[];
  const recentKills = r.kills.filter((k) => k.t <= t && t - k.t < 7000).slice(-5);
  const flashes = r.kills.filter((k) => k.t <= t && t - k.t < 1400);
  const planted = r.plant && t >= r.plant.t ? r.plant : undefined;
  const defused = r.defuse && t >= r.defuse.t;
  const alive = (team: string) => v.players.filter((p) => p.teamId === team && frame[p.puuid]?.alive !== false && !r.kills.some((k) => k.victim === p.puuid && k.t <= t)).length;
  const scoreAt = (team: string) => v.rounds.slice(0, round).filter((x) => x.winningTeam === team).length;

  const Roster = ({ team }: { team: string }) => (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between px-1">
        <span className="text-xs font-semibold" style={{ color: colorOf(v.players.find((p) => p.teamId === team)?.puuid) }}>
          {team === myTeam ? (v.me && byId.has(v.me) ? 'Your team' : team) : 'Enemy team'}
        </span>
        <span className="num text-xs text-muted">{alive(team)} alive</span>
      </div>
      {v.players
        .filter((p) => p.teamId === team)
        .sort((a, b) => b.kills - a.kills)
        .map((p) => {
          const dead = r.kills.some((k) => k.victim === p.puuid && k.t <= t);
          const kr = r.kills.filter((k) => k.killer === p.puuid && k.t <= t).length;
          const on = focus === p.puuid;
          return (
            <div
              key={p.puuid}
              role="button"
              tabIndex={0}
              onClick={() => setFocus(on ? undefined : p.puuid)}
              onKeyDown={(e) => (e.key === 'Enter' ? setFocus(on ? undefined : p.puuid) : undefined)}
              title={on ? 'Stop highlighting' : 'Highlight this player'}
              className={cx('press flex items-center gap-2.5 rounded-2xl px-2 py-1.5 transition-colors', on ? 'bg-white/[0.12] ring-1 ring-white/25' : 'hover:bg-white/[0.06]', dead && 'opacity-45')}
            >
              <span className="relative shrink-0">
                <Img src={p.agentIcon} alt={p.agentName ?? ''} className="h-9 w-9 rounded-xl" style={{ boxShadow: `0 0 0 2px ${colorOf(p.puuid)}` }} />
                {dead && <Skull size={14} weight="fill" className="absolute -bottom-1 -right-1 rounded-full bg-black p-px text-ink" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink">
                  <PlayerName name={p.name} tag={p.tag} fallback={p.agentName ?? 'Player'} tagClassName="text-faint text-xs" />
                </div>
                <div className="num text-2xs text-muted">
                  {p.kills}/{p.deaths}/{p.assists}
                  {kr > 0 && <span className="ml-1.5 text-ink">· {kr}K this round</span>}
                </div>
              </div>
            </div>
          );
        })}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Top bar */}
      <div className="flex items-center gap-3">
        <Btn tone="ghost" size="sm" onClick={onBack}>
          <CaretLeft size={14} weight="bold" /> Replays
        </Btn>
        <div className="min-w-0 flex-1">
          <div className="t-head truncate text-xl text-ink">{v.mapName ?? 'Match'}</div>
          <div className="text-xs text-muted">{[v.queueTag, v.startTime ? when(v.startTime) : undefined].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="num flex items-center gap-3 text-2xl font-semibold">
          <span style={{ color: ALLY }}>{scoreAt(teams[0])}</span>
          <span className="text-faint">:</span>
          <span style={{ color: ENEMY }}>{scoreAt(teams[1] ?? '')}</span>
        </div>
        {v.hasFile && (
          <Btn size="sm" tone="ghost" onClick={() => void act('replays:reveal', v.matchId)} title="The .vrf file plays inside Valorant">
            <FolderOpen size={14} /> Show file
          </Btn>
        )}
      </div>

      {/* Round strip */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {v.rounds.map((x, i) => {
          const won = x.winningTeam === myTeam;
          return (
            <button
              key={x.n}
              type="button"
              onClick={() => {
                setRound(i);
                setT(0);
              }}
              title={`Round ${x.n + 1} · ${won ? 'won' : 'lost'}${x.result ? ` · ${x.result}` : ''}`}
              className={cx('press flex h-11 w-9 shrink-0 flex-col items-center justify-center rounded-xl text-2xs font-semibold', i === round ? 'bg-white text-black' : 'bg-white/[0.05] text-muted hover:bg-white/[0.1]')}
            >
              <span className="num">{x.n + 1}</span>
              <span className="h-1 w-4 rounded-full" style={{ background: x.winningTeam ? (won ? ALLY : ENEMY) : 'transparent' }} />
              {(x.n + 1 === 12 || x.n + 1 === 24) && <span className="sr-only">half</span>}
            </button>
          );
        })}
      </div>

      {!v.hasPositions && <Note>Riot sent no positions for this match (deathmatch and some modes don’t record them), so the map stays empty. The killfeed and events still work.</Note>}

      <div className="grid grid-cols-[clamp(190px,18vw,240px)_minmax(0,1fr)_clamp(190px,18vw,240px)] items-start gap-4">
        <Roster team={teams[0]} />
        {/* Minimap */}
        <div className="relative mx-auto aspect-square w-full max-w-[min(640px,calc(100vh-330px))] overflow-hidden rounded-[24px] bg-[#0a0a0b] ring-1 ring-white/[0.07]">
          {v.minimap && <Img src={v.minimap} alt="" className="absolute inset-0 h-full w-full object-contain opacity-90" />}
          <svg viewBox="0 0 1000 1000" className="absolute inset-0 h-full w-full">
            {heat &&
              v.rounds.flatMap((rr) =>
                rr.kills.flatMap((k, i) => {
                  const dots: JSX.Element[] = [];
                  // Following someone: their kills (where they stood) and deaths. Otherwise every death in the match.
                  if (focus) {
                    if (k.killer === focus && k.killerAt) dots.push(<circle key={`k${rr.n}-${i}`} cx={k.killerAt.x * 1000} cy={k.killerAt.y * 1000} r={14} fill={ALLY} opacity={0.35} />);
                    if (k.victim === focus && k.victimAt) dots.push(<circle key={`d${rr.n}-${i}`} cx={k.victimAt.x * 1000} cy={k.victimAt.y * 1000} r={14} fill={ENEMY} opacity={0.45} />);
                  } else if (k.victimAt) dots.push(<circle key={`a${rr.n}-${i}`} cx={k.victimAt.x * 1000} cy={k.victimAt.y * 1000} r={11} fill={colorOf(k.victim)} opacity={0.3} />);
                  return dots;
                }),
              )}
            {flashes.map((k, i) =>
              k.killerAt && k.victimAt ? (
                <line key={i} x1={k.killerAt.x * 1000} y1={k.killerAt.y * 1000} x2={k.victimAt.x * 1000} y2={k.victimAt.y * 1000} stroke={colorOf(k.killer)} strokeWidth={3} strokeDasharray="10 7" opacity={1 - (t - k.t) / 1400} />
              ) : null,
            )}
            {planted?.at && (
              <g transform={`translate(${planted.at.x * 1000} ${planted.at.y * 1000})`}>
                <circle r={defused ? 10 : 16} fill={defused ? '#5ab0ff' : '#ffb84d'} opacity={0.25} className={defused ? undefined : 'animate-pulse'} />
                <rect x={-6} y={-6} width={12} height={12} rx={2} fill={defused ? '#5ab0ff' : '#ffb84d'} transform="rotate(45)" />
              </g>
            )}
            {v.players.map((p) => {
              const f = frame[p.puuid];
              if (!f) return null;
              const c = colorOf(p.puuid);
              const dim = focus && focus !== p.puuid;
              const x = f.x * 1000;
              const y = f.y * 1000;
              if (!f.alive)
                return (
                  <g key={p.puuid} transform={`translate(${x} ${y})`} opacity={dim ? 0.3 : 0.75}>
                    <path d="M-12 -12 L12 12 M12 -12 L-12 12" stroke={c} strokeWidth={5} strokeLinecap="round" />
                  </g>
                );
              return (
                <g key={p.puuid} transform={`translate(${x} ${y})`} opacity={dim ? 0.35 : f.estimated ? 0.7 : 1}>
                  {f.view != null && (
                    <path d="M0 0 L62 -24 A66 66 0 0 1 62 24 Z" fill={c} opacity={0.25} transform={`rotate(${(-f.view * 180) / Math.PI - 90})`} />
                  )}
                  {focus === p.puuid && <circle r={38} fill="none" stroke="#fff" strokeWidth={4} />}
                  <circle r={30} fill="#000" stroke={c} strokeWidth={5} />
                  <clipPath id={`c-${p.puuid}`}>
                    <circle r={25} />
                  </clipPath>
                  {p.agentIcon && <image href={img(p.agentIcon)} x={-25} y={-25} width={50} height={50} clipPath={`url(#c-${p.puuid})`} />}
                </g>
              );
            })}
          </svg>
          {/* Killfeed */}
          <div className="pointer-events-none absolute right-3 top-3 flex w-[min(300px,52%)] flex-col items-end gap-1">
            {recentKills.map((k, i) => {
              const killer = byId.get(k.killer ?? '');
              const victim = byId.get(k.victim);
              const w = iconFor(k);
              return (
                <div key={`${k.t}-${i}`} className="toast-in flex items-center gap-1.5 rounded-lg bg-black/75 px-2 py-1 text-[11px] text-ink backdrop-blur-sm" style={{ boxShadow: `inset 3px 0 0 ${colorOf(k.killer)}` }}>
                  {killer?.agentIcon && <Img src={killer.agentIcon} alt="" className="h-5 w-5 rounded" />}
                  <span className="max-w-[70px] truncate font-medium" style={{ color: colorOf(k.killer) }}>{nameOf(k.killer)}</span>
                  {w?.icon ? <Img src={w.icon} alt={w.name} title={w.name} className="h-3.5 max-w-[46px] object-contain opacity-90" /> : <span className="text-faint">›</span>}
                  {k.trade && <span className="rounded bg-white/15 px-1 text-[9px] font-bold uppercase">trade</span>}
                  <span className="max-w-[70px] truncate font-medium" style={{ color: colorOf(k.victim) }}>{nameOf(k.victim)}</span>
                  {victim?.agentIcon && <Img src={victim.agentIcon} alt="" className="h-5 w-5 rounded opacity-70 grayscale" />}
                </div>
              );
            })}
          </div>
          <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-black/70 px-2.5 py-1 text-xs text-ink backdrop-blur-sm">
            Round {r.n + 1} · <span className="num">{clock(t)}</span>
            {planted && <span className="ml-1.5 text-[#ffb84d]">· {defused ? 'Defused' : `Planted${planted.site ? ` ${planted.site}` : ''}`}</span>}
          </div>
        </div>
        <Roster team={teams[1] ?? ''} />
      </div>

      {/* Transport */}
      <Panel className="flex flex-col gap-3 px-5 py-4">
        <div className="relative h-8">
          <input
            type="range"
            min={0}
            max={r.length}
            step={50}
            value={Math.min(t, r.length)}
            onChange={(e) => setT(Number(e.target.value))}
            aria-label="Round time"
            className="absolute inset-x-0 top-1/2 w-full -translate-y-1/2 accent-white"
          />
          {roundEvents.map((e, i) => (
            <button
              key={i}
              type="button"
              title={`${clock(e.t)} · ${e.label}`}
              onClick={() => jump(e, 800)}
              className="absolute top-0 h-2.5 w-[3px] -translate-x-1/2 rounded-full"
              style={{ left: `${(e.t / r.length) * 100}%`, background: e.kind === 'plant' ? '#ffb84d' : e.kind === 'defuse' ? '#5ab0ff' : colorOf(e.player) }}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Btn size="sm" tone="ghost" title="Previous round" disabled={round === 0} onClick={() => (setRound(round - 1), setT(0))}>
            <SkipBack size={14} weight="fill" />
          </Btn>
          <button type="button" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'} className="press flex h-10 w-10 items-center justify-center rounded-full bg-white text-black">
            {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
          </button>
          <Btn size="sm" tone="ghost" title="Next round" disabled={round >= v.rounds.length - 1} onClick={() => (setRound(round + 1), setT(0))}>
            <SkipForward size={14} weight="fill" />
          </Btn>
          <span className="num ml-1 w-[88px] text-sm text-muted">
            {clock(t)} / {clock(r.length)}
          </span>
          <button
            type="button"
            aria-pressed={heat}
            onClick={() => setHeat((h) => !h)}
            title={focus ? 'Every spot where the player you follow got a kill (green) or died (red), all rounds' : 'Where everyone died this match, coloured by team'}
            className={cx('press h-8 rounded-full px-3 text-sm font-medium', heat ? 'bg-white text-black' : 'bg-white/[0.08] text-ink hover:bg-white/[0.14]')}
          >
            Heatmap
          </button>
          <Segmented<'0.5' | '1' | '2' | '4'> size="sm" value={speed} onChange={setSpeed} options={[['0.5', '0.5×'], ['1', '1×'], ['2', '2×'], ['4', '4×']]} />
          <div className="ml-auto flex items-center gap-2">
            <Select<Filter> value={filter} onChange={setFilter} align="right" options={FILTERS.map((f) => ({ value: f.value, label: f.label, hint: f.needsFocus && !focus ? 'pick a player' : String(allEvents.filter((e) => f.kinds.includes(e.kind)).length) }))} />
            <Btn size="sm" disabled={!prevEv} onClick={() => prevEv && jump(prevEv)} title={prevEv?.label}>
              <CaretLeft size={13} weight="bold" /> Prev
            </Btn>
            <Btn size="sm" disabled={!nextEv} onClick={() => nextEv && jump(nextEv)} title={nextEv?.label}>
              Next <CaretRight size={13} weight="bold" />
            </Btn>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {focus ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.08] px-2.5 py-1 text-ink">
              Following {nameOf(focus)}
              <button type="button" aria-label="Stop following" onClick={() => setFocus(undefined)} className="text-faint hover:text-ink">
                <X size={11} weight="bold" />
              </button>
            </span>
          ) : (
            <span>Click a player to follow them: events then skip through their kills, deaths and assists.</span>
          )}
          <span className="ml-auto text-faint">Space play/pause · ← → events · positions are exact at kills, plants and defuses, straight-line in between</span>
        </div>
      </Panel>

      {/* This round's events */}
      <Panel>
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="label">Round {r.n + 1} · {r.result ? (RESULT_SHORT[r.result] ?? r.result) : '—'}</span>
          <span className="text-xs" style={{ color: r.winningTeam === myTeam ? ALLY : ENEMY }}>{r.winningTeam === myTeam ? 'Won' : 'Lost'}</span>
        </div>
        <div className="divide-y divide-white/[0.05]">
          {[...r.kills.map((k) => ({ t: k.t, k })), ...(r.plant ? [{ t: r.plant.t, plant: true as const }] : []), ...(r.defuse ? [{ t: r.defuse.t, defuse: true as const }] : [])]
            .sort((a, b) => a.t - b.t)
            .map((e, i) => {
              const past = e.t <= t;
              if ('k' in e && e.k) {
                const k = e.k;
                const w = iconFor(k);
                const where = nearestCallout(v, k.victimAt?.x, k.victimAt?.y);
                return (
                  <button key={i} type="button" onClick={() => jump({ round: r.n, t: k.t, kind: 'kill', label: '' }, 1200)} className={cx('flex w-full items-center gap-3 px-5 py-2 text-left text-sm hover:bg-white/[0.03]', !past && 'opacity-50')}>
                    <span className="num w-10 text-xs text-faint">{clock(k.t)}</span>
                    <span className="font-medium" style={{ color: colorOf(k.killer) }}>{nameOf(k.killer)}</span>
                    {w?.icon ? <Img src={w.icon} alt={w.name} className="h-4 max-w-[52px] object-contain opacity-80" /> : <span className="text-faint">killed</span>}
                    <span className="font-medium" style={{ color: colorOf(k.victim) }}>{nameOf(k.victim)}</span>
                    {k.trade && <span className="rounded-full bg-white/[0.1] px-1.5 text-2xs font-semibold text-ink">Trade</span>}
                    {k.streak >= 3 && <span className="rounded-full bg-warn/[0.16] px-1.5 text-2xs font-semibold text-warn">{k.streak >= 5 ? 'ACE' : `${k.streak}K`}</span>}
                    {k.assistants.length > 0 && <span className="text-xs text-faint">+ {k.assistants.map(nameOf).join(', ')}</span>}
                    {where && <span className="ml-auto text-xs text-faint">{where}</span>}
                  </button>
                );
              }
              const b = 'plant' in e ? r.plant! : r.defuse!;
              return (
                <button key={i} type="button" onClick={() => jump({ round: r.n, t: b.t, kind: 'plant', label: '' }, 1200)} className={cx('flex w-full items-center gap-3 px-5 py-2 text-left text-sm hover:bg-white/[0.03]', !past && 'opacity-50')}>
                  <span className="num w-10 text-xs text-faint">{clock(b.t)}</span>
                  <span className={'plant' in e ? 'text-[#ffb84d]' : 'text-[#5ab0ff]'}>{'plant' in e ? `Spike planted${r.plant?.site ? ` on ${r.plant.site}` : ''}` : 'Spike defused'}</span>
                  <span className="text-muted">by {nameOf(b.player)}</span>
                </button>
              );
            })}
          {!r.kills.length && !r.plant && <div className="px-5 py-3 text-sm text-muted">Nothing recorded this round.</div>}
        </div>
      </Panel>
    </div>
  );
}

export function ReplaysScreen({ connected }: { connected: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="mx-auto max-w-[1400px] px-6 py-7 xl:px-8">
      {!open && <PageHeader title="Replays" right={<FilmStrip size={22} className="text-faint" />} />}
      {!connected && !open ? <ErrorNote>Needs tokens: start the Riot Client or sign in. Replays are rebuilt from Riot’s match data.</ErrorNote> : open ? <Viewer key={open} id={open} onBack={() => setOpen(null)} /> : <ReplayList onOpen={setOpen} />}
    </div>
  );
}
