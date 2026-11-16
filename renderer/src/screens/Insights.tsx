import { useEffect, useState } from 'react';
import type { WarehouseGroup, WarehouseView } from '../../../shared/features';
import type { Insight } from '../../../shared/insights';
import { cx } from '../lib/format';
import { Panel, Segmented, Skeleton, showToast } from '../components/ui';
import { act, Btn, ErrorNote, Note } from '../components/kit';
import { LineChart } from '../components/charts';

const KIND: Record<Insight['kind'], { dot: string; label: string }> = {
  strength: { dot: 'bg-win', label: 'Strength' },
  weakness: { dot: 'bg-loss', label: 'Weakness' },
  'trend-up': { dot: 'bg-win', label: 'Improving' },
  'trend-down': { dot: 'bg-warn', label: 'Declining' },
  info: { dot: 'bg-def', label: 'Pattern' },
};
const day = (t?: number) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const pct = (w: number, n: number) => (n ? `${Math.round((w / n) * 100)}%` : '—');

function GroupTable({ title, rows, showRr }: { title: string; rows: WarehouseGroup[]; showRr: boolean }) {
  if (!rows.length) return null;
  return (
    <section>
      <h3 className="t-head mb-2 px-1 text-sm text-ink">{title}</h3>
      <Panel className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-2xs text-faint">
            <tr className="[&>th]:px-4 [&>th]:py-2 [&>th]:text-right [&>th:first-child]:text-left">
              <th>{title.replace(/s$/, '')}</th>
              <th>Games</th>
              <th>W–L</th>
              <th>Win</th>
              <th>K/D</th>
              <th>ACS</th>
              <th>ATK rounds</th>
              <th>DEF rounds</th>
              {showRr && <th>RR</th>}
            </tr>
          </thead>
          <tbody className="num divide-y divide-white/[0.05]">
            {rows.slice(0, 14).map((g) => (
              <tr key={g.key} className="[&>td]:px-4 [&>td]:py-2 [&>td]:text-right [&>td:first-child]:text-left">
                <td className="truncate text-ink">{g.label ?? g.key}</td>
                <td>{g.games}</td>
                <td className="text-muted">
                  {g.wins}–{g.losses}
                </td>
                <td className={cx(g.games < 8 && 'text-faint')}>{pct(g.wins, g.wins + g.losses)}</td>
                <td>{g.kd.toFixed(2)}</td>
                <td>{g.acs || '—'}</td>
                <td className="text-muted">{g.atk ? pct(g.atk[0], g.atk[1]) : '—'}</td>
                <td className="text-muted">{g.def ? pct(g.def[0], g.def[1]) : '—'}</td>
                {showRr && <td className={g.rr > 0 ? 'text-win' : g.rr < 0 ? 'text-loss' : 'text-muted'}>{g.rr > 0 ? `+${g.rr}` : g.rr}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </section>
  );
}

/**
 * Lifetime history (Feature 9) and Performance Intelligence (Feature 8) for the signed-in account, from
 * the local warehouse. Every number traces to stored matches; each insight states its method.
 */
export function HistoryInsights() {
  const [queue, setQueue] = useState<'competitive' | 'all'>('competitive');
  const [v, setV] = useState<WarehouseView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setV(null);
    setErr(null);
    void act<WarehouseView>('warehouse:get', queue).then((r) => (r.ok ? setV(r.data) : setErr(r.error)));
  }, [queue]);
  const exp = (f: 'csv' | 'json') => void act<string | null>('warehouse:export', f).then((r) => (r.ok ? r.data && showToast('History exported') : showToast(r.error, 'error')));
  return (
    <div className="mt-10 flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="t-title text-xl text-ink">Your history and insights</h2>
          <p className="mt-1 text-sm text-muted">From matches stored on this PC. Nothing here is Riot’s hidden MMR.</p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            size="sm"
            value={queue}
            options={[
              ['competitive', 'Competitive'],
              ['all', 'All queues'],
            ]}
            onChange={setQueue}
          />
          <Btn size="sm" tone="ghost" onClick={() => exp('csv')}>
            Export CSV
          </Btn>
          <Btn size="sm" tone="ghost" onClick={() => exp('json')}>
            JSON
          </Btn>
        </div>
      </div>
      {err && <ErrorNote>{err}</ErrorNote>}
      {!v && !err && <Skeleton className="h-64 rounded-[20px]" />}
      {v && (
        <>
          <p className="num -mt-3 text-xs text-faint">
            {v.matches.toLocaleString()} {queue === 'all' ? '' : 'competitive '}matches · {day(v.first)} – {day(v.last)}
            {v.gaps.missing > 0 && (
              <span className="text-warn">
                {' '}
                · {v.gaps.missing} ranked match{v.gaps.missing === 1 ? '' : 'es'} between {day(v.gaps.oldest)} and {day(v.gaps.newest)} have RR records but no stored details (shown as a gap, not filled in)
              </span>
            )}
          </p>

          <section>
            <h3 className="t-head mb-2 px-1 text-sm text-ink">Insights</h3>
            {v.insights.insights.length ? (
              <div className="grid grid-cols-2 gap-3">
                {v.insights.insights.map((i) => (
                  <Panel key={i.id} className="p-5">
                    <div className="flex items-center gap-2 text-2xs text-faint">
                      <span className={cx('h-2 w-2 rounded-full', KIND[i.kind].dot)} />
                      {KIND[i.kind].label} · {i.n.toLocaleString()} {i.unit} · {i.confidence} confidence
                    </div>
                    <div className="t-head mt-2 text-md text-ink">{i.title}</div>
                    <p className="mt-1 text-sm text-muted">{i.detail}</p>
                    <p className="mt-2 text-2xs text-faint">{i.method}</p>
                  </Panel>
                ))}
              </div>
            ) : (
              <Panel className="px-6 py-5 text-sm text-muted">No difference in your stored matches is big enough to call out yet. That is a result, not a missing feature.</Panel>
            )}
            {v.insights.notes.length > 0 && (
              <ul className="mt-2 list-disc pl-6 text-xs text-faint">
                {v.insights.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </section>

          {v.rank.length >= 2 && (
            <Panel className="p-5">
              <LineChart title="Rank over time" points={v.rank.map((h) => ({ x: h.t, y: h.tier * 100 + h.rr, label: `${day(h.t)} · ${h.delta >= 0 ? '+' : ''}${h.delta} RR` }))} format={(x) => `${Math.floor(x / 100)}·${Math.round(x % 100)}`} />
            </Panel>
          )}
          {v.months.length >= 2 && (
            <Panel className="p-5">
              <LineChart title="Win rate by month" baseline={50} points={v.months.map((m) => ({ x: Date.parse(`${m.key}-15`), y: m.wins + m.losses ? Math.round((m.wins / (m.wins + m.losses)) * 100) : 0, label: `${m.key} · ${m.games} games` }))} format={(x) => `${Math.round(x)}%`} />
            </Panel>
          )}
          <GroupTable title="Maps" rows={v.maps} showRr={queue === 'competitive'} />
          <GroupTable title="Agents" rows={v.agents} showRr={queue === 'competitive'} />
          <GroupTable title="Acts" rows={v.acts} showRr={queue === 'competitive'} />
          <Note>Rounds by side use Riot’s round results (Red attacks rounds 1–12). Opening duels count first deaths only for matches stored by SexyVal 1.7 or later. Win rates under 8 games are greyed out.</Note>
        </>
      )}
    </div>
  );
}
