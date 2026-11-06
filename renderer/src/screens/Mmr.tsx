import { useEffect, useRef, useState } from 'react';
import type { MmrView } from '../../../shared/features';
import { climbSentence, tierName, type Confidence } from '../../../shared/mmr';
import type { PlayerRow, RankInfo } from '../../../shared/types';
import { cx } from '../lib/format';
import { ArrowDown, ArrowUp, Minus } from '../lib/icons';
import { Img, Panel, Skeleton } from '../components/ui';
import { act, Btn, ErrorNote, PageHeader } from '../components/kit';
import { MultiLineChart, SERIES } from '../components/charts';

const when = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;

function RankIcon({ rank, size = 40 }: { rank?: RankInfo; size?: number }) {
  const box = { width: size, height: size };
  if (!rank) return <span style={box} className="inline-block shrink-0 rounded-full border border-dashed border-white/15" />;
  return <Img src={rank.icon} alt={rank.name} style={box} className="shrink-0" fallback={<span style={box} className="inline-block shrink-0" />} />;
}

function GapBadge({ gap, label }: { gap: number; label: string }) {
  const up = gap >= 0.5;
  const down = gap <= -0.5;
  const n = Math.round(Math.abs(gap));
  const text = up || down ? `about ${n || 1} division${n === 1 || n === 0 ? '' : 's'} ${up ? 'above' : 'below'}` : 'at your rank';
  const Icon = up ? ArrowUp : down ? ArrowDown : Minus;
  return (
    <span title={label} className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold', up ? 'bg-win/[0.14] text-win' : down ? 'bg-loss/[0.14] text-loss' : 'bg-white/[0.08] text-muted')}>
      <Icon size={13} weight="bold" />
      {text}
    </span>
  );
}

function ConfidenceChip({ c, n }: { c: Confidence; n: number }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-white/[0.08] px-3 py-1 text-sm text-muted">
      <span className="flex gap-0.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className={cx('h-2.5 w-1 rounded-full', i < (c === 'High' ? 3 : c === 'Medium' ? 2 : 1) ? 'bg-ink' : 'bg-white/20')} />
        ))}
      </span>
      <span className="text-ink">{c} confidence</span> · based on {n} match{n === 1 ? '' : 'es'}
    </span>
  );
}

function SplitBars({ v }: { v: MmrView }) {
  const e = v.estimate;
  const max = Math.max(1, e.Gw, e.Gl, 30);
  const bar = (label: string, value: number, raw: number, tone: string) => (
    <div className="grid grid-cols-[92px_minmax(0,1fr)_56px] items-center gap-3" title={`${label}: ${value} RR after cleaning · ${raw} RR raw average`}>
      <span className="text-sm text-muted">{label}</span>
      <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className={cx('h-full rounded-full transition-[width] duration-[420ms] ease-out', tone)} style={{ width: `${Math.max(3, (value / max) * 100)}%` }} />
      </div>
      <span className="num text-right text-sm text-ink">{value ? `${value}` : '–'}</span>
    </div>
  );
  return (
    <div className="flex flex-col gap-2.5">
      {bar('Avg win', e.Gw, e.GwRaw, 'bg-win')}
      {bar('Avg loss', e.Gl, e.GlRaw, 'bg-loss')}
    </div>
  );
}

function Signals({ v }: { v: MmrView }) {
  const e = v.estimate;
  return (
    <div className="grid grid-cols-3 gap-5">
      <Panel className="p-5">
        <div className="text-xs text-faint">RR split</div>
        <p className="mt-1 text-sm text-muted">{e.method === 'regression' ? 'Cleaned of round margin and performance.' : 'Raw averages (not enough matches to clean them yet).'}</p>
        <div className="mt-4">
          <SplitBars v={v} />
        </div>
      </Panel>
      <Panel className="p-5">
        <div className="text-xs text-faint">Lobby average</div>
        <div className="mt-3 flex items-center gap-3">
          <RankIcon rank={v.lobby} size={44} />
          <p className="text-pretty text-sm text-muted">
            {e.lobbyAvg != null ? (
              <>
                {v.isMe ? 'Your lobbies' : 'Their lobbies'} average <span className="text-ink">{tierName(e.lobbyAvg)}</span> vs {v.isMe ? 'your' : 'their'} <span className="text-ink">{e.myTier >= 3 ? tierName(e.myTier) : 'rank'}</span>.
              </>
            ) : (
              'No ranked players in these matches yet.'
            )}
          </p>
        </div>
      </Panel>
      <Panel className="p-5">
        <div className="text-xs text-faint">Win rate</div>
        <div className="mt-2 flex items-baseline gap-6">
          <div>
            <div className="t-num text-[28px] leading-none text-ink">{e.winRate10 != null ? `${e.winRate10}%` : '–'}</div>
            <div className="mt-1 text-xs text-muted">last 10</div>
          </div>
          <div>
            <div className="t-num text-[28px] leading-none text-ink">{e.winRate20 != null ? `${e.winRate20}%` : '–'}</div>
            <div className="mt-1 text-xs text-muted">last 20</div>
          </div>
        </div>
        <p className="mt-3 text-xs text-faint">About 50% means you’re where you belong.</p>
      </Panel>
    </div>
  );
}

function Graph({ v }: { v: MmrView }) {
  const rows = [...v.matches].reverse().filter((m) => m.excluded !== 'other act');
  const rank = rows.map((m) => (m.tierAfter >= 3 ? m.tierAfter + Math.min(99, m.rrAfter) / 100 : undefined));
  const lobby = rows.map((m) => m.lobbyAvg);
  const est = rows.map((m) => m.estAfter);
  const ticks = Array.from({ length: 25 }, (_, i) => i + 3);
  return (
    <MultiLineChart
      title="Rank, lobby average and estimated MMR"
      height={230}
      series={[
        { key: 'rank', label: 'Your rank', color: SERIES[0], values: rank },
        { key: 'lobby', label: 'Lobby average', color: SERIES[1], values: lobby, dashed: true },
        { key: 'est', label: 'Estimated MMR', color: SERIES[2], values: est },
      ]}
      yTicks={ticks}
      format={(t) => tierName(t, true)}
      tip={(i) => {
        const m = rows[i];
        return (
          <div>
            <div className="text-ink">
              {m.mapName ?? 'Unknown map'} · <span className={m.result === 'W' ? 'text-win' : m.result === 'L' ? 'text-loss' : 'text-muted'}>{m.result === 'W' ? 'Win' : m.result === 'L' ? 'Loss' : 'Draw'}</span> {m.score ?? ''}
            </div>
            <div className="text-muted">
              {when(m.startTime)} · {signed(m.rrEarned)} RR{m.lobbyAvg != null ? ` · lobby ${tierName(m.lobbyAvg)}` : ''}
            </div>
          </div>
        );
      }}
    />
  );
}

function Forecast({ v }: { v: MmrView }) {
  const f = v.estimate.forecast;
  return (
    <div className="flex flex-wrap gap-3">
      {f.winsToNext != null && v.mine && (
        <span className="rounded-2xl bg-white/[0.06] px-4 py-3 text-sm text-ink">
          About <span className="t-num">{f.winsToNext}</span> win{f.winsToNext === 1 ? '' : 's'} to {f.nextTier ? tierName(f.nextTier) : 'the next division'}{' '}
          <span className="text-faint">
            ({tierName(v.estimate.myTier)} → {f.nextTier ? tierName(f.nextTier) : '…'})
          </span>
        </span>
      )}
      {f.lossCost != null && (
        <span className="rounded-2xl bg-white/[0.06] px-4 py-3 text-sm text-ink">
          A loss costs about <span className="num text-loss">−{f.lossCost} RR</span>
        </span>
      )}
      {f.skipPossible && <span className="rounded-2xl bg-win/[0.12] px-4 py-3 text-sm font-semibold text-win">Division skip possible</span>}
    </div>
  );
}

function MatchTable({ v }: { v: MmrView }) {
  return (
    <Panel>
      <div className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,0.8fr)_84px_64px_92px_minmax(0,1.2fr)] gap-3 border-b border-line px-5 py-2.5 text-xs text-faint">
        <span>Date</span>
        <span>Map</span>
        <span>Agent</span>
        <span>Result</span>
        <span className="text-right">RR</span>
        <span>Lobby</span>
        <span>Why</span>
      </div>
      {v.matches.map((m) => (
        <div key={m.matchId} className={cx('grid grid-cols-[72px_minmax(0,1fr)_minmax(0,0.8fr)_84px_64px_92px_minmax(0,1.2fr)] items-center gap-3 border-b border-line px-5 py-2 text-sm last:border-b-0', m.excluded && 'opacity-45')}>
          <span className="num text-muted">{when(m.startTime)}</span>
          <span className="truncate">{m.mapName ?? '–'}</span>
          <span className="flex min-w-0 items-center gap-2">
            {m.agentIcon && <Img src={m.agentIcon} alt="" className="h-6 w-6 shrink-0 rounded-md bg-white/5" />}
            <span className="truncate text-muted">{m.agentName ?? '–'}</span>
          </span>
          <span className={cx('num', m.result === 'W' ? 'text-win' : m.result === 'L' ? 'text-loss' : 'text-muted')}>
            {m.result === 'W' ? 'Win' : m.result === 'L' ? 'Loss' : 'Draw'} {m.score ?? ''}
          </span>
          <span className={cx('num text-right', m.rrEarned > 0 ? 'text-win' : m.rrEarned < 0 ? 'text-loss' : 'text-muted')}>{signed(m.rrEarned)}</span>
          <span className="flex items-center gap-1.5 text-muted">
            {m.lobbyRank && <Img src={m.lobbyRank.icon} alt="" className="h-5 w-5 shrink-0" />}
            <span className="truncate">{m.lobbyAvg != null ? tierName(m.lobbyAvg, true) : '–'}</span>
          </span>
          <span className="truncate text-xs text-muted" title={m.tag}>
            {m.tag}
          </span>
        </div>
      ))}
    </Panel>
  );
}

export function MmrScreen({ connected, myPuuid, initialQuery, players }: { connected: boolean; myPuuid?: string; initialQuery?: string; players: PlayerRow[] }) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<MmrView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const target = useRef<string | null>(null);

  const load = async (q: string, force = false) => {
    if (!q) return;
    target.current = q;
    setLoading(true);
    setErr(null);
    const r = await act<MmrView>('mmr:get', q, force);
    if (target.current !== q) return;
    setLoading(false);
    // Errors keep the last good result on screen.
    if (r.ok) setView(r.data);
    else setErr(r.error);
  };
  useEffect(() => {
    if (initialQuery) void load(initialQuery);
    else if (connected && myPuuid && !view) void load(myPuuid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, myPuuid, initialQuery]);

  if (!connected) return <div className="px-6 py-7 xl:px-8"><PageHeader title="Estimated MMR" /><ErrorNote>Needs tokens: start the Riot Client or sign in.</ErrorNote></div>;

  const e = view?.estimate;
  const picks = players.filter((p) => !p.isMe && !(p.incognito && !p.isMe) && p.name);
  return (
    <div className="mx-auto max-w-[1180px] px-6 pb-16 pt-7 xl:px-8">
      <PageHeader
        title="Estimated MMR"
        right={
          <form
            className="flex gap-2"
            onSubmit={(ev) => {
              ev.preventDefault();
              void load(query.trim());
            }}
          >
            <input value={query} onChange={(ev) => setQuery(ev.target.value)} placeholder="Name#TAG" className="field w-44 xl:w-56" />
            <Btn type="submit" disabled={loading}>
              Look up
            </Btn>
            {myPuuid && <Btn onClick={() => void load(myPuuid)}>Me</Btn>}
          </form>
        }
      />
      {picks.length > 0 && (
        <div className="-mt-2 mb-5 flex flex-wrap items-center gap-2">
          <span className="text-xs text-faint">In your match</span>
          {picks.map((p) => (
            <button key={p.puuid} onClick={() => void load(p.puuid)} className={cx('press rounded-full px-3 py-1 text-xs font-medium', view?.puuid === p.puuid ? 'bg-white text-black' : 'bg-white/[0.08] text-ink hover:bg-white/[0.14]')}>
              {p.name}
              <span className={view?.puuid === p.puuid ? 'text-black/50' : 'text-faint'}>#{p.tag}</span>
            </button>
          ))}
        </div>
      )}
      {err && (
        <div className="mb-4">
          <ErrorNote>{err}</ErrorNote>
        </div>
      )}
      {!view && loading && (
        <div className="flex flex-col gap-5">
          <Skeleton className="h-[188px] rounded-[20px]" />
          <div className="grid grid-cols-3 gap-5">
            <Skeleton className="h-[150px] rounded-[20px]" />
            <Skeleton className="h-[150px] rounded-[20px]" />
            <Skeleton className="h-[150px] rounded-[20px]" />
          </div>
          <Skeleton className="h-[280px] rounded-[20px]" />
        </div>
      )}
      {view && e && (
        <div data-mmr className={cx('flex flex-col gap-5 transition-opacity duration-180', loading && 'opacity-60')}>
          <Panel className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-6">
              <div className="flex items-center gap-4">
                <RankIcon rank={e.usable ? view.est : undefined} size={76} />
                <div>
                  {!view.isMe && (
                    <div className="text-sm text-muted">
                      {view.name ?? 'Player'}
                      {view.tag ? <span className="text-faint">#{view.tag}</span> : null}
                    </div>
                  )}
                  <div className="t-title mt-0.5 text-[34px] leading-none text-ink">{e.usable ? `Estimated MMR · ${tierName(e.estTier)}` : 'No estimate yet'}</div>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-2xl bg-white/[0.05] px-4 py-3">
                <RankIcon rank={view.mine} size={36} />
                <div>
                  <div className="text-xs text-faint">{view.isMe ? 'Your rank' : 'Rank'}</div>
                  <div className="text-sm font-medium text-ink">
                    {view.mine ? tierName(e.myTier) : 'Unrated'}
                    {view.mine && <span className="num text-muted"> · {e.myRR} RR</span>}
                  </div>
                </div>
              </div>
            </div>
            {e.usable > 0 && (
              <div className="mt-5 flex flex-wrap items-center gap-2.5">
                <GapBadge gap={e.gapDivisions} label={e.label} />
                <ConfidenceChip c={e.confidence} n={e.usable} />
              </div>
            )}
            <p className="text-pretty mt-4 max-w-2xl text-md text-muted">{climbSentence(e)}</p>
          </Panel>

          {e.usable > 0 && (
            <>
              <Signals v={view} />
              <Panel className="p-5">
                <div className="mb-1 text-xs text-faint">This act, one point per competitive match</div>
                <Graph v={view} />
              </Panel>
              <Forecast v={view} />
            </>
          )}
          {view.matches.length > 0 && <MatchTable v={view} />}
          <p className="text-xs text-faint">Estimate from your RR changes and lobby ranks. Riot doesn’t show real MMR.</p>
        </div>
      )}
    </div>
  );
}
