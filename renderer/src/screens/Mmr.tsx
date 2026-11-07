import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MmrTeamView, MmrView } from '../../../shared/features';
import { climbSentence, tierName, type Confidence } from '../../../shared/mmr';
import type { TeamSummary } from '../../../shared/team';
import type { PlayerRow, RankInfo } from '../../../shared/types';
import { cx } from '../lib/format';
import { ArrowClockwise, ArrowDown, ArrowUp, Minus } from '../lib/icons';
import { api } from '../lib/api';
import { saveSettings, useSettings } from '../lib/store';
import { Img, Panel, Segmented, Skeleton } from '../components/ui';
import { act, Btn, ErrorNote, PageHeader } from '../components/kit';
import { MultiLineChart, SERIES, STACK_RAMP } from '../components/charts';
import { SquadList, STACK_LABEL, StackIcon, StackTiles } from '../components/squad';

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

const STACK_INDEX: Record<string, number> = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 3 };

function Graph({ v, team }: { v: MmrView; team?: boolean }) {
  const rows = [...v.matches].reverse().filter((m) => m.excluded !== 'other act');
  const rank = rows.map((m) => (m.tierAfter >= 3 ? m.tierAfter + Math.min(99, m.rrAfter) / 100 : undefined));
  const lobby = rows.map((m) => m.lobbyAvg);
  const est = rows.map((m) => m.estAfter);
  const ticks = Array.from({ length: 25 }, (_, i) => i + 3);
  return (
    <MultiLineChart
      title={team ? 'Rank, lobby average, team-adjusted signal and estimated MMR' : 'Rank, lobby average and estimated MMR'}
      height={team ? 250 : 230}
      series={[
        { key: 'rank', label: 'Your rank', color: SERIES[0], values: rank },
        { key: 'lobby', label: 'Lobby average', color: SERIES[1], values: lobby, dashed: true },
        { key: 'est', label: team ? 'Estimated MMR (team-adjusted)' : 'Estimated MMR', color: SERIES[2], values: est },
        ...(team ? [{ key: 'team', label: 'Team-adjusted signal', color: SERIES[3], values: rows.map((m) => m.teamAfter), dashed: true }] : []),
      ]}
      markers={
        team
          ? {
              series: 'rank',
              colors: rows.map((m) => (typeof m.stack === 'number' ? STACK_RAMP[STACK_INDEX[String(m.stack)]] : undefined)),
              legend: [1, 2, 3, 5].map((n, i) => ({ label: STACK_LABEL[String(n)], color: STACK_RAMP[i] })),
            }
          : undefined
      }
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
            {team && m.stack != null && (
              <div className="mt-0.5 max-w-[260px] text-muted">
                {STACK_LABEL[String(m.stack)]}
                {m.premadeNames?.length ? ` with ${m.premadeNames.join(', ')}` : ''}
              </div>
            )}
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
      {f.rrFactor != null && (
        <span className="rounded-2xl bg-loss/[0.1] px-4 py-3 text-sm text-ink">
          With your current party: <span className="num font-semibold text-loss">RR ×{f.rrFactor.toFixed(2)}</span> <span className="text-faint">(already in these numbers)</span>
        </span>
      )}
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

/** Team view's table: the stack (premade names on hover) and both teams' average rank replace the lobby column. */
function TeamMatchTable({ v }: { v: MmrView }) {
  const cols = 'grid-cols-[64px_minmax(0,1fr)_minmax(0,0.75fr)_84px_52px_52px_150px_minmax(0,1.2fr)]';
  return (
    <Panel>
      <div className={cx('grid gap-3 border-b border-line px-5 py-2.5 text-xs text-faint', cols)}>
        <span>Date</span>
        <span>Map</span>
        <span>Agent</span>
        <span>Result</span>
        <span className="text-right">RR</span>
        <span>Stack</span>
        <span>Team vs enemy</span>
        <span>Why</span>
      </div>
      {v.matches.map((m) => (
        <div key={m.matchId} data-match-row className={cx('grid items-center gap-3 border-b border-line px-5 py-2 text-sm last:border-b-0', cols, m.excluded && 'opacity-45')}>
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
          <span className="flex items-center gap-1.5 text-muted" title={m.stack === 'unknown' || m.stack == null ? 'No party data for this match' : m.premadeNames?.length ? `With ${m.premadeNames.join(', ')}` : 'Solo'}>
            <StackIcon stack={m.stack} className={m.stack === 'unknown' ? 'text-faint' : 'text-muted'} />
            <span className="num">{typeof m.stack === 'number' ? m.stack : '?'}</span>
          </span>
          <span className="num truncate text-xs text-muted" title={m.teamAvgTier != null && m.enemyAvgTier != null ? `Your team ${tierName(m.teamAvgTier)} · enemy ${tierName(m.enemyAvgTier)}` : undefined}>
            {m.teamAvgTier != null ? tierName(m.teamAvgTier, true) : '–'} <span className="text-faint">vs</span> {m.enemyAvgTier != null ? tierName(m.enemyAvgTier, true) : '–'}
          </span>
          <span className="truncate text-xs text-muted" title={m.tag}>
            {m.tag}
          </span>
        </div>
      ))}
    </Panel>
  );
}

/** Headline card. `badge` and `children` are the team view's additions; the solo view passes neither. */
function Headline({ v, badge, children }: { v: MmrView; badge?: string; children?: ReactNode }) {
  const e = v.estimate;
  return (
    <Panel className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <RankIcon rank={e.usable ? v.est : undefined} size={76} />
          <div>
            {!v.isMe && (
              <div className="text-sm text-muted">
                {v.name ?? 'Player'}
                {v.tag ? <span className="text-faint">#{v.tag}</span> : null}
              </div>
            )}
            <div className="t-title mt-0.5 text-[34px] leading-none text-ink">{e.usable ? `Estimated MMR · ${tierName(e.estTier)}` : 'No estimate yet'}</div>
            {badge && e.usable > 0 && <div className="mt-2 text-sm text-muted">{badge}</div>}
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-2xl bg-white/[0.05] px-4 py-3">
          <RankIcon rank={v.mine} size={36} />
          <div>
            <div className="text-xs text-faint">{v.isMe ? 'Your rank' : 'Rank'}</div>
            <div className="text-sm font-medium text-ink">
              {v.mine ? tierName(e.myTier) : 'Unrated'}
              {v.mine && <span className="num text-muted"> · {e.myRR} RR</span>}
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
      {children}
      <p className="text-pretty mt-4 max-w-2xl text-md text-muted">{climbSentence(e)}</p>
    </Panel>
  );
}

/** The 1.3 screen: unchanged. */
function SoloBody({ view, loading }: { view: MmrView; loading: boolean }) {
  const e = view.estimate;
  return (
    <div data-mmr className={cx('flex flex-col gap-5 transition-opacity duration-180', loading && 'opacity-60')}>
      <Headline v={view} />
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
  );
}

const stackedGames = (t?: TeamSummary) => (t ? t.stacks.filter((s) => typeof s.stack === 'number' && s.stack >= 2).reduce((a, s) => a + s.games, 0) : 0);
const TEAM_FOOTER = 'Estimate from your RR, lobby ranks and who you queued with. Riot doesn’t show real MMR. Teammate impact over 25 matches is a rough signal, not a verdict.';

function TeamBody({ tv, loading }: { tv: MmrTeamView; loading: boolean }) {
  const view = tv.team;
  const e = view.estimate;
  const t = e.team!;
  const fade = cx('flex flex-col gap-6 transition-opacity duration-180', loading && 'opacity-60');
  if (!stackedGames(t)) {
    return (
      <div data-mmr data-mmr-team className={fade}>
        <StackTiles team={t} livePenalty={tv.livePenalty} />
        <Panel className="p-6">
          <div className="t-head text-lg text-ink">You’ve only played solo this act</div>
          <p className="text-pretty mt-1 max-w-2xl text-sm text-muted">With no premades there is nothing to adjust for: your lobbies already reflect you, and the Solo view has your estimate. Queue with friends and this view shows how they move your lobbies and your RR.</p>
        </Panel>
        <p className="text-xs text-faint">{TEAM_FOOTER}</p>
      </div>
    );
  }
  if (e.usable < 5) {
    // Mostly 5-stacks: their RR penalty can only be measured against solo, duo and trio games.
    const fives = view.matches.filter((m) => m.excluded === '5-stack').length;
    return (
      <div data-mmr data-mmr-team className={fade}>
        <StackTiles team={t} livePenalty={tv.livePenalty} />
        <Panel className="p-6">
          <div className="t-head text-lg text-ink">Not enough matches yet</div>
          <p className="text-pretty mt-1 max-w-2xl text-sm text-muted">
            {fives >= 3
              ? `${fives} of your recent matches were 5-stacks. Their RR penalty can only be measured against solo, duo and trio games, so play a few outside a 5-stack to get a team estimate.`
              : 'Play a few more competitive matches this act to get a team estimate.'}
          </p>
        </Panel>
        <SquadList rows={tv.squad} randoms={t.randoms} settled={tv.lookups.done >= tv.lookups.total} youTier={e.myTier} />
        <p className="text-xs text-faint">{TEAM_FOOTER}</p>
      </div>
    );
  }
  const solo = t.lobbyAvgSolo;
  const stacked = t.lobbyAvgStacked;
  const lobbyGap = solo != null && stacked != null && Math.abs(solo - stacked) >= 0.5;
  return (
    <div data-mmr data-mmr-team className={fade}>
      <Headline v={view} badge="Team-adjusted: lobbies corrected for who you queued with">
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <span className="num" title="How much each signal counts in the estimate: the RR split against your rank, and the team-adjusted lobby signal (inverse-variance weights, scaled in by how many games were stacked).">
            Split {Math.round(t.wSplitUsed * 100)}% · Team lobbies {Math.round(t.wTeamUsed * 100)}%
          </span>
          {t.teamSignal != null && (
            <span className="text-faint">
              Team-adjusted lobby signal ~{tierName(t.teamSignal)}
              {t.teamSignalSe != null ? ` (±${t.teamSignalSe} div.)` : ''}
            </span>
          )}
        </div>
        {lobbyGap && (
          <p data-lobby-gap className="text-pretty mt-3 flex items-center gap-2 text-sm text-ink">
            {tv.stackedLobby && <Img src={tv.stackedLobby.icon} alt="" className="h-6 w-6 shrink-0" />}
            <span>
              Your stacked lobbies average {tierName(stacked!)}, your solo lobbies {tierName(solo!)}. Your party pulls your lobbies {stacked! < solo! ? 'down' : 'up'}.
            </span>
          </p>
        )}
      </Headline>
      <StackTiles team={t} livePenalty={tv.livePenalty} />
      <SquadList rows={tv.squad} randoms={t.randoms} settled={tv.lookups.done >= tv.lookups.total} youTier={e.myTier} />
      <Panel className="p-5">
        <div className="mb-1 text-xs text-faint">This act, one point per competitive match; dots show who you queued with</div>
        <Graph v={view} team />
      </Panel>
      <Forecast v={view} />
      {view.matches.length > 0 && <TeamMatchTable v={view} />}
      <p className="text-xs text-faint">{TEAM_FOOTER}</p>
    </div>
  );
}

type Shown = { kind: 'me'; tv: MmrTeamView } | { kind: 'other'; view: MmrView };

export function MmrScreen({ connected, myPuuid, initialQuery, players }: { connected: boolean; myPuuid?: string; initialQuery?: string; players: PlayerRow[] }) {
  const settings = useSettings();
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState<Shown | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const target = useRef<string | null>(null);

  const load = async (q: string, force = false) => {
    if (!q) return;
    target.current = q;
    setLoading(true);
    setErr(null);
    // Your own account: one call carries both views (solo and team-adjusted) on the same matches.
    if (q === myPuuid) {
      const r = await act<MmrTeamView>('mmr:team', q, force);
      if (target.current !== q) return;
      setLoading(false);
      if (r.ok) setShown({ kind: 'me', tv: r.data });
      else setErr(r.error); // errors keep the last good result on screen
      return;
    }
    const r = await act<MmrView>('mmr:get', q, force);
    if (target.current !== q) return;
    setLoading(false);
    // Errors keep the last good result on screen.
    if (r.ok) setShown({ kind: 'other', view: r.data });
    else setErr(r.error);
  };
  useEffect(() => {
    if (initialQuery) void load(initialQuery);
    else if (connected && myPuuid && !shown) void load(myPuuid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, myPuuid, initialQuery]);
  // Premade lookups land after the first answer; each one pushes a fuller team view.
  useEffect(() => api.on<MmrTeamView>('mmr-team', (v) => target.current === v.puuid && setShown({ kind: 'me', tv: v })), []);

  if (!connected) return <div className="px-6 py-7 xl:px-8"><PageHeader title="Estimated MMR" /><ErrorNote>Needs tokens: start the Riot Client or sign in.</ErrorNote></div>;

  const pref = settings?.mmrView ?? 'auto';
  const tv = shown?.kind === 'me' ? shown.tv : undefined;
  const mode: 'solo' | 'team' = !tv ? 'solo' : pref === 'auto' ? (stackedGames(tv.team.estimate.team) ? 'team' : 'solo') : pref;
  const soloView = shown?.kind === 'other' ? shown.view : tv?.solo;
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
      {tv && (
        <div className="-mt-2 mb-5 flex items-center gap-3">
          <Segmented
            value={mode}
            options={[
              ['solo', 'Solo view'],
              ['team', 'Team view'],
            ]}
            onChange={(v) => void saveSettings({ mmrView: v })}
          />
          {mode === 'team' && (
            <Btn tone="ghost" size="sm" disabled={loading} onClick={() => myPuuid && void load(myPuuid, true)}>
              <ArrowClockwise size={14} className={loading ? 'animate-spin' : undefined} /> Refresh
            </Btn>
          )}
        </div>
      )}
      {picks.length > 0 && (
        <div className="-mt-2 mb-5 flex flex-wrap items-center gap-2">
          <span className="text-xs text-faint">In your match</span>
          {picks.map((p) => (
            <button key={p.puuid} onClick={() => void load(p.puuid)} className={cx('press rounded-full px-3 py-1 text-xs font-medium', soloView?.puuid === p.puuid ? 'bg-white text-black' : 'bg-white/[0.08] text-ink hover:bg-white/[0.14]')}>
              {p.name}
              <span className={soloView?.puuid === p.puuid ? 'text-black/50' : 'text-faint'}>#{p.tag}</span>
            </button>
          ))}
        </div>
      )}
      {err && (
        <div className="mb-4">
          <ErrorNote>{err}</ErrorNote>
        </div>
      )}
      {!shown && loading && (
        <div className="flex flex-col gap-5">
          <Skeleton className="h-[188px] rounded-[20px]" />
          <div className="grid grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[150px] rounded-[20px]" />
            ))}
          </div>
          <Skeleton className="h-[280px] rounded-[20px]" />
        </div>
      )}
      {tv && mode === 'team' && tv.team.estimate.team && <TeamBody tv={tv} loading={loading} />}
      {soloView && (mode === 'solo' || !tv) && <SoloBody view={soloView} loading={loading} />}
    </div>
  );
}
