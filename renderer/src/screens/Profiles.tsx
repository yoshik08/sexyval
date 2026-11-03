import { useEffect, useMemo, useState } from 'react';
import type { MatchDetailView, ProfileView } from '../../../shared/features';
import { analyzeMatches, filterMatches, type HistoryFilter } from '../../../shared/stats';
import { queueName } from '../../../shared/queues';
import { cx } from '../lib/format';
import { Img, Panel, RankBadge, Skeleton } from '../components/ui';
import { act, Btn, ErrorNote, PageHeader, TabBar } from '../components/kit';
import { DeltaBars, HBars, LineChart } from '../components/charts';

const when = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function Scoreboard({ matchId, onClose, onOpenProfile }: { matchId: string; onClose: () => void; onOpenProfile: (puuid: string) => void }) {
  const [d, setD] = useState<MatchDetailView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void act<MatchDetailView>('profile:match', matchId).then((r) => (r.ok ? setD(r.data) : setErr(r.error)));
  }, [matchId]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-8" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="drawer-in max-h-full w-full max-w-[1100px] overflow-auto rounded-sm border border-line2 bg-surface" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <div className="label">Match · {d?.queueTag}</div>
            <div className="font-display text-lg font-semibold uppercase tracking-wide">
              {d?.mapName ?? '…'} {d && <span className="num ml-2 text-muted">{d.teams.map((t) => t.roundsWon).join(' – ')}</span>}
            </div>
          </div>
          <Btn onClick={onClose}>Close</Btn>
        </div>
        {err && <div className="p-5"><ErrorNote>{err}</ErrorNote></div>}
        {!d && !err && <Skeleton className="m-5 h-64" />}
        {d && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                {['Player', 'Rank', 'K', 'D', 'A', 'ACS', 'ADR', 'HS%', 'FB', 'Avg loadout'].map((h, i) => (
                  <th key={h} className={cx('label px-3 py-2 font-semibold', i > 1 && 'text-right')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r, i) => {
                const teamStart = i === 0 || d.rows[i - 1].teamId !== r.teamId;
                const won = d.teams.find((t) => t.teamId === r.teamId)?.won;
                return (
                  <tr key={r.puuid} className={cx('border-b border-line', teamStart && i > 0 && 'border-t-2 border-t-line2')}>
                    <td className="px-3 py-1.5">
                      <button className="flex items-center gap-2 text-left hover:text-accent" onClick={() => onOpenProfile(r.puuid)}>
                        <span className={cx('h-6 w-[3px] rounded-full', won ? 'bg-win' : 'bg-loss')} />
                        {r.agentIcon && <Img src={r.agentIcon} alt="" className="h-7 w-7 rounded-sm" />}
                        <span>
                          {r.name ?? '—'}
                          <span className="text-faint">#{r.tag}</span>
                        </span>
                      </button>
                    </td>
                    <td className="px-3"><RankBadge rank={r.rank} compact /></td>
                    <td className="num px-3 text-right">{r.kills}</td>
                    <td className="num px-3 text-right">{r.deaths}</td>
                    <td className="num px-3 text-right">{r.assists}</td>
                    <td className="num px-3 text-right">{r.acs}</td>
                    <td className="num px-3 text-right">{r.adr ?? '–'}</td>
                    <td className="num px-3 text-right">{r.hsPct != null ? `${r.hsPct}%` : '–'}</td>
                    <td className="num px-3 text-right">{r.firstBloods ?? '–'}</td>
                    <td className="num px-3 text-right text-muted">{r.avgLoadout ?? '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {d && <p className="px-5 py-3 text-xs text-faint">ADR, HS%, first bloods and economy come from per-round data; “–” means the match had none.</p>}
      </div>
    </div>
  );
}

export function ProfilesScreen({ connected, myPuuid, initialQuery, historyQueue }: { connected: boolean; myPuuid?: string; initialQuery?: string; historyQueue: string }) {
  const [query, setQuery] = useState(initialQuery ?? '');
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'history' | 'stats'>('history');
  const [filter, setFilter] = useState<HistoryFilter>({});
  const [openMatch, setOpenMatch] = useState<string | null>(null);

  const load = async (q: string) => {
    if (!q) return;
    setLoading(true);
    setErr(null);
    const r = await act<ProfileView>('profile:get', q, historyQueue);
    setLoading(false);
    if (r.ok) {
      setProfile(r.data);
      setFilter({});
    } else setErr(r.error);
  };
  useEffect(() => {
    if (connected && myPuuid && !profile && !initialQuery) void load(myPuuid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, myPuuid]);
  useEffect(() => {
    if (initialQuery) void load(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  const rows = useMemo(() => filterMatches(profile?.matches ?? [], filter), [profile, filter]);
  const stats = useMemo(() => analyzeMatches(rows), [rows]);
  const agents = useMemo(() => [...new Map((profile?.matches ?? []).filter((m) => m.agentId).map((m) => [m.agentId!, m.agentName ?? '?'])).entries()], [profile]);
  const maps = useMemo(() => [...new Map((profile?.matches ?? []).filter((m) => m.mapId).map((m) => [m.mapId!, m.mapName ?? '?'])).entries()], [profile]);
  const queues = useMemo(() => [...new Set((profile?.matches ?? []).map((m) => m.queueId).filter(Boolean))], [profile]);

  if (!connected) return <div className="px-6 py-7 xl:px-8"><PageHeader label="Profiles" title="Profiles & history" /><ErrorNote>Needs tokens: start the Riot Client or sign in.</ErrorNote></div>;

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-7 xl:px-8">
      <PageHeader
        label="Profiles"
        title="Profiles & history"
        right={
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void load(query.trim());
            }}
          >
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name#TAG" className="field w-44 xl:w-56" />
            <Btn type="submit" disabled={loading}>Look up</Btn>
            {myPuuid && <Btn onClick={() => void load(myPuuid)}>Me</Btn>}
          </form>
        }
      />
      {err && <div className="mb-4"><ErrorNote>{err}</ErrorNote></div>}
      {loading && !profile && <Skeleton className="h-64" />}
      {profile && (
        <div className={cx('flex flex-col gap-5 transition-opacity duration-180', loading && 'opacity-60')}>
          <Panel className="relative overflow-hidden">
            {profile.cardWide && <Img src={profile.cardWide} alt="" className="absolute inset-0 h-full w-full object-cover opacity-30" />}
            <div className="absolute inset-0 bg-gradient-to-r from-surface via-surface/80 to-transparent" />
            <div className="relative flex flex-wrap items-end justify-between gap-x-6 gap-y-4 p-6">
              <div>
                <div className="label">{profile.title ?? 'No title'}</div>
                <h2 className="mt-1 font-display text-stat font-bold uppercase tracking-wide">
                  {profile.name ?? 'Unknown'}
                  <span className="text-faint">#{profile.tag ?? '?'}</span>
                </h2>
                <div className="mt-1 text-sm text-muted">Level {profile.level ?? '–'}{profile.leaderboardRank ? ` · Leaderboard #${profile.leaderboardRank}` : ''}</div>
              </div>
              <div className="flex gap-8">
                <div>
                  <div className="label">Current</div>
                  <div className="mt-1 flex items-center gap-2">
                    <RankBadge rank={profile.rank} />
                    <span className="num text-sm text-muted">{profile.rr ?? 0} RR</span>
                  </div>
                </div>
                <div>
                  <div className="label">Peak</div>
                  <div className="mt-1"><RankBadge rank={profile.peak} /></div>
                </div>
              </div>
            </div>
          </Panel>

          <div className="grid grid-cols-2 gap-5">
            <Panel className="p-5">
              <div className="label mb-2">Rank rating over time</div>
              <LineChart
                title="Rank rating"
                points={profile.rrHistory.map((h) => ({ x: h.t, y: h.tier * 100 + h.rr, label: `${when(h.t)} · tier ${h.tier}` }))}
                format={(v) => `${Math.floor(v / 100)}·${Math.round(v % 100)}`}
              />
              <p className="mt-1 text-2xs text-faint">Y axis: tier · RR (e.g. 15·40 = tier 15, 40 RR).</p>
            </Panel>
            <Panel className="p-5">
              <div className="label mb-2">RR per match</div>
              <DeltaBars title="RR changes" values={profile.rrHistory.map((h) => ({ v: h.delta, label: when(h.t) }))} />
            </Panel>
          </div>

          <TabBar tabs={[['history', `Match history · ${profile.matches.length}`], ['stats', 'Analysis']]} value={tab} onChange={setTab} />

          <div className="flex flex-wrap items-end gap-3">
            {[
              ['Queue', 'queue', queues.map((q) => [q, queueName(q)])],
              ['Agent', 'agentId', agents],
              ['Map', 'mapId', maps],
              ['Result', 'result', [['W', 'Win'], ['L', 'Loss'], ['D', 'Draw']]],
            ].map(([label, key, opts]) => (
              <label key={key as string} className="flex flex-col gap-1">
                <span className="label">{label as string}</span>
                <select
                  value={(filter as any)[key as string] ?? ''}
                  onChange={(e) => setFilter({ ...filter, [key as string]: e.target.value || undefined })}
                  className="field min-w-[130px]"
                >
                  <option value="">All</option>
                  {(opts as [string, string][]).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
            ))}
            <label className="flex flex-col gap-1">
              <span className="label">From</span>
              <input type="date" onChange={(e) => setFilter({ ...filter, from: e.target.value ? Date.parse(e.target.value) : undefined })} className="field" />
            </label>
            <span className="ml-auto pb-1.5 text-xs text-muted">{rows.length} matches</span>
          </div>

          {tab === 'history' ? (
            <Panel>
              {rows.map((m) => (
                <button
                  key={m.matchId}
                  onClick={() => setOpenMatch(m.matchId)}
                  className="grid w-full grid-cols-[6px_36px_minmax(0,1fr)_84px_72px_64px_64px_52px] items-center gap-3 border-b border-line px-5 py-2.5 text-left transition-colors duration-120 last:border-b-0 hover:bg-white/[0.03]"
                >
                  <span className={cx('h-8 w-1.5 rounded-[1px]', m.result === 'W' ? 'bg-win' : m.result === 'L' ? 'bg-loss' : 'bg-faint')} />
                  <Img src={m.agentIcon} alt="" className="h-9 w-9 rounded-sm bg-white/5" />
                  <div className="min-w-0">
                    <div className="truncate font-display text-md font-semibold uppercase tracking-wide">{m.mapName ?? 'Unknown'}</div>
                    <div className="truncate text-xs text-muted">{m.agentName} · {m.queueTag} · {when(m.startTime)}</div>
                  </div>
                  <span className="num text-right text-sm">{m.kills}/{m.deaths}/{m.assists}</span>
                  <span className="num text-right text-sm text-muted">{m.acs} ACS</span>
                  <span className="num text-right text-sm text-muted">{m.hsPct != null ? `${m.hsPct}% HS` : '–'}</span>
                  <span className={cx('num text-right text-sm', m.rrChange == null ? 'text-faint' : m.rrChange >= 0 ? 'text-win' : 'text-loss')}>
                    {m.rrChange == null ? '–' : `${m.rrChange > 0 ? '+' : ''}${m.rrChange} RR`}
                  </span>
                  <span className={cx('num text-right font-display text-md font-semibold', m.result === 'W' ? 'text-win' : m.result === 'L' ? 'text-loss' : 'text-muted')}>{m.score}</span>
                </button>
              ))}
              {!rows.length && <div className="px-5 py-6 text-sm text-muted">No matches for this filter.</div>}
            </Panel>
          ) : (
            <div className="grid grid-cols-2 gap-5">
              <Panel className="p-5">
                <div className="label mb-3">Win rate by agent</div>
                <HBars rows={stats.byAgent.slice(0, 8).map((g) => ({ key: g.key, label: g.name, value: g.winRate, sub: `${g.games} game${g.games === 1 ? '' : 's'} · ${g.kd} K/D`, icon: g.icon ? <Img src={g.icon} alt="" className="h-5 w-5 rounded-sm" /> : undefined }))} />
              </Panel>
              <Panel className="p-5">
                <div className="label mb-3">Win rate by map</div>
                <HBars rows={stats.byMap.slice(0, 8).map((g) => ({ key: g.key, label: g.name, value: g.winRate, sub: `${g.games} game${g.games === 1 ? '' : 's'} · ${g.acs} ACS` }))} />
              </Panel>
              <Panel className="p-5">
                <div className="label mb-2">K/D trend</div>
                <LineChart title="K/D" baseline={1} points={stats.trend.map((t) => ({ x: t.t, y: t.kd, label: `${when(t.t)} · ${t.result}` }))} format={(v) => v.toFixed(2)} />
              </Panel>
              <Panel className="p-5">
                <div className="label mb-2">ACS trend</div>
                <LineChart title="ACS" points={stats.trend.map((t) => ({ x: t.t, y: t.acs, label: `${when(t.t)} · ${t.result}` }))} format={(v) => String(Math.round(v))} />
              </Panel>
            </div>
          )}
        </div>
      )}
      {openMatch && (
        <Scoreboard
          matchId={openMatch}
          onClose={() => setOpenMatch(null)}
          onOpenProfile={(p) => {
            setOpenMatch(null);
            setQuery('');
            void load(p);
          }}
        />
      )}
    </div>
  );
}
