import { useState } from 'react';
import type { ContractView, MissionView, ProgressionView } from '../../../shared/features';
import { cx } from '../lib/format';
import { img } from '../lib/media';
import { Panel, Skeleton } from '../components/ui';
import { act, Bar, Btn, ErrorNote, PageHeader, useRpc } from '../components/kit';
import { Img } from '../components/ui';

const fmt = (n: number) => n.toLocaleString('en-US');
const date = (s?: string) => (s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '–');

function Mission({ m }: { m: MissionView }) {
  return (
    <div className="flex items-center gap-4 border-b border-line px-5 py-3 last:border-b-0">
      <span className={cx('h-2 w-2 shrink-0 rotate-45', m.complete ? 'bg-win' : 'bg-white/20')} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{m.title}</div>
        <div className="mt-1.5 w-full max-w-[360px]">
          <Bar value={m.progress} max={m.target || 1} tone={m.complete ? 'bg-win' : 'bg-accent'} />
        </div>
      </div>
      <div className="num w-20 shrink-0 text-right text-sm text-muted xl:w-24">
        {fmt(Math.min(m.progress, m.target))}/{fmt(m.target)}
      </div>
      <div className="num w-24 shrink-0 text-right text-sm">{fmt(m.xp)} XP</div>
    </div>
  );
}

function ContractCard({ c, title, onActivate }: { c?: ContractView; title: string; onActivate?: () => void }) {
  if (!c) return null;
  return (
    <Panel className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="label">{title}</div>
          <div className="mt-1 font-display text-lg font-semibold uppercase tracking-wide [overflow-wrap:anywhere]">{c.name}</div>
        </div>
        <div className="num text-right font-display text-2xl font-bold leading-none">
          {c.level}
          <span className="text-md text-faint">/{c.maxLevel}</span>
        </div>
      </div>
      <div className="mt-4">
        <Bar value={c.xpIntoLevel} max={c.xpForNext || 1} />
        <div className="mt-1.5 flex justify-between text-xs text-muted">
          <span>Tier {c.level + 1 > c.maxLevel ? c.maxLevel : c.level + 1}</span>
          <span className="num">{c.xpForNext ? `${fmt(Math.max(0, c.xpForNext - c.xpIntoLevel))} XP to next` : 'Complete'}</span>
        </div>
      </div>
      {c.nextReward && (
        <div className="mt-4 flex items-center gap-3 rounded-sm border border-line bg-black/20 p-2.5">
          {c.nextReward.icon ? <Img src={img(c.nextReward.icon)} alt="" className="h-10 w-10 object-contain" /> : <div className="h-10 w-10 rounded-sm bg-white/5" />}
          <div className="min-w-0">
            <div className="label">Next reward</div>
            <div className="truncate text-sm">{c.nextReward.name}</div>
          </div>
        </div>
      )}
      {onActivate && <Btn className="mt-3" onClick={onActivate}>Set active</Btn>}
    </Panel>
  );
}

export function ProgressScreen({ connected }: { connected: boolean }) {
  const { data: p, error, loading, reload, setData } = useRpc<ProgressionView>('progress:get', [], connected);
  const [future, setFuture] = useState<{ date: string; list: MissionView[] | null }>({ date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), list: null });
  const [msg, setMsg] = useState<string | null>(null);

  const activate = async (id: string) => {
    const r = await act<ProgressionView>('progress:activate', id);
    if (r.ok) setData(r.data);
    else setMsg(r.error);
  };
  const preview = async () => {
    const r = await act<MissionView[]>('progress:future', Date.parse(future.date));
    if (r.ok) setFuture({ ...future, list: r.data });
  };

  if (!connected) return <div className="px-6 py-7 xl:px-8"><PageHeader label="Progression" title="Missions & passes" /><ErrorNote>Needs tokens: start the Riot Client or sign in (Settings › Accounts). Valorant can stay closed.</ErrorNote></div>;

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-7 xl:px-8">
      <PageHeader
        label="Progression"
        title="Missions & passes"
        right={
          <div className="flex items-center gap-4">
            {p?.accountLevel && (
              <div className="text-right">
                <div className="label">Account level</div>
                <div className="num font-display text-xl font-bold">
                  {p.accountLevel} <span className="text-sm text-muted">· {fmt(p.accountXp ?? 0)} XP into level</span>
                </div>
              </div>
            )}
            <Btn onClick={() => void reload()} disabled={loading}>Refresh</Btn>
          </div>
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {msg && <div className="mb-3"><ErrorNote>{msg}</ErrorNote></div>}
      {!p && loading && <Skeleton className="h-64" />}
      {p && (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-5">
            <ContractCard c={p.battlepass} title="Battle pass" />
            {p.eventpass ? <ContractCard c={p.eventpass} title="Event pass" /> : <Panel className="p-5 text-sm text-muted">No event pass active.</Panel>}
          </div>

          <Panel>
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <span className="label">Daily checkpoints</span>
            </div>
            {p.dailies.length ? p.dailies.map((m) => <Mission key={m.id} m={m} />) : <div className="px-5 py-4 text-sm text-muted">No daily mission data in the contracts response.</div>}
          </Panel>

          <Panel>
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <span className="label">This week</span>
              <span className="text-xs text-muted">Refills {date(p.weeklyRefill)}</span>
            </div>
            {p.weeklies.length ? p.weeklies.map((m) => <Mission key={m.id} m={m} />) : <div className="px-5 py-4 text-sm text-muted">No weekly missions active.</div>}
          </Panel>

          <div className="grid grid-cols-2 gap-5">
            <Panel>
              <div className="border-b border-line px-5 py-3 label">Queued weeklies (unlock later)</div>
              {p.queuedWeeklies.length ? (
                p.queuedWeeklies.map((m) => (
                  <div key={m.id} className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5 text-sm last:border-b-0">
                    <span className="min-w-0 truncate">{m.title}</span>
                    <span className="num shrink-0 text-xs text-muted">{date(m.activation)} · {fmt(m.xp)} XP</span>
                  </div>
                ))
              ) : (
                <div className="px-5 py-4 text-sm text-muted">Nothing queued.</div>
              )}
            </Panel>
            <Panel>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-5 py-2">
                <span className="label">Future weeklies</span>
                <div className="flex items-center gap-2">
                  <input type="date" value={future.date} onChange={(e) => setFuture({ date: e.target.value, list: null })} className="field" />
                  <Btn onClick={() => void preview()}>Preview</Btn>
                </div>
              </div>
              {future.list ? (
                future.list.length ? (
                  future.list.map((m) => (
                    <div key={m.id} className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5 text-sm last:border-b-0">
                      <span className="min-w-0 truncate">{m.title}</span>
                      <span className="num shrink-0 text-xs text-muted">{fmt(m.target)} · {fmt(m.xp)} XP</span>
                    </div>
                  ))
                ) : (
                  <div className="px-5 py-4 text-sm text-muted">No weeklies scheduled for that date in the public catalog.</div>
                )
              ) : (
                <div className="px-5 py-4 text-sm text-faint">Pick a date to see which weeklies are scheduled (from valorant-api.com).</div>
              )}
            </Panel>
          </div>

          <Panel>
            <div className="border-b border-line px-5 py-3 label">Agent contracts</div>
            <div className="grid grid-cols-2 gap-px bg-line">
              {p.agentContracts.map((c) => (
                <div key={c.id} className="flex items-center gap-3 bg-surface px-5 py-3">
                  {c.agentIcon ? <Img src={c.agentIcon} alt="" className="h-10 w-10 rounded-sm bg-white/5" /> : <div className="h-10 w-10 rounded-sm bg-white/5" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-display text-md font-semibold uppercase tracking-wide">{c.agentName ?? c.name}</span>
                      {c.active && <span className="rounded-sm bg-accent/15 px-1.5 font-display text-2xs font-bold uppercase tracking-label text-accent">Active</span>}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="flex-1"><Bar value={c.level} max={c.maxLevel || 1} tone={c.active ? 'bg-accent' : 'bg-def'} /></div>
                      <span className="num text-xs text-muted">{c.level}/{c.maxLevel}</span>
                    </div>
                  </div>
                  {!c.active && <Btn onClick={() => void activate(c.id)}>Activate</Btn>}
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
