// Team view of the MMR tab (1.4): how you queue, and who you queue with. Every number here is SexyVal's
// own estimate from your matches; Riot doesn't expose MMR.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SquadRowView } from '../../../shared/features';
import { tierName } from '../../../shared/mmr';
import type { RandomsRow, StackRow, StackSize, TeamSummary, Verdict } from '../../../shared/team';
import { cx } from '../lib/format';
import { CaretDown, CircleNotch, EyeSlash, User, Users, UsersFour, UsersThree, WarningCircle } from '../lib/icons';
import { expandTo, flipCapture } from '../lib/motion';
import { Img, Panel } from './ui';

const signed = (n: number, digits = 0) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}`;
const pct = (x?: number) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const when = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export const STACK_LABEL: Record<string, string> = { '1': 'Solo', '2': 'Duo', '3': 'Trio', '4': '4-stack', '5': '5-stack', unknown: 'No party data' };

/** Stack size as an icon (one person … five). */
export function StackIcon({ stack, size = 15, className }: { stack?: StackSize; size?: number; className?: string }) {
  const I = stack === 1 ? User : stack === 2 ? Users : stack === 3 ? UsersThree : stack === 4 || stack === 5 ? UsersFour : WarningCircle;
  return <I size={size} weight={stack === 5 ? 'fill' : 'regular'} className={className} aria-hidden />;
}

// ---------- How you queue ----------

function StackTile({ s, best, five }: { s: StackRow; best: boolean; five?: number }) {
  const never = s.games === 0;
  return (
    <div className={cx('flex min-w-0 flex-col gap-3 rounded-[20px] p-5 transition-colors', best ? 'bg-white/[0.07] ring-1 ring-white/[0.14]' : 'bg-white/[0.035]')}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-ink">
          <StackIcon stack={s.stack} className="text-muted" />
          {STACK_LABEL[String(s.stack)]}
        </span>
        {best && !never && <span className="text-2xs font-medium text-muted">Best for you</span>}
      </div>
      {never ? (
        <div className="text-sm text-faint">Never this act</div>
      ) : (
        <>
          <div>
            <div className={cx('t-num text-[30px] leading-none', (s.rrPerGame ?? 0) > 0 ? 'text-win' : (s.rrPerGame ?? 0) < 0 ? 'text-loss' : 'text-ink')}>{signed(s.rrPerGame ?? 0, 1)}</div>
            <div className="mt-1 text-xs text-muted">RR per game</div>
          </div>
          <div className="num flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
            <span className="text-ink">
              {s.games} game{s.games === 1 ? '' : 's'}
            </span>
            <span>
              {s.wins}–{s.losses}
              {s.draws ? `–${s.draws}` : ''}
            </span>
            <span>{s.winRate != null ? `${Math.round(s.winRate)}% won` : ''}</span>
          </div>
          <div className="num text-xs text-faint">
            win {s.avgWinRR != null ? signed(s.avgWinRR) : '–'} · loss {s.avgLossRR != null ? signed(s.avgLossRR) : '–'}
          </div>
          {s.stack === 5 && five != null && (
            <span className={cx('self-start rounded-full px-2.5 py-0.5 text-2xs font-semibold', five < 0.85 ? 'bg-loss/[0.14] text-loss' : 'bg-white/[0.08] text-muted')}>
              {five < 0.85 ? `RR ×${five.toFixed(2)} seen` : 'No RR penalty seen'}
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** Solo / Duo / Trio / 5-stack: record and RR per game, the best one lightly lifted. */
export function StackTiles({ team, livePenalty }: { team: TeamSummary; livePenalty?: number }) {
  const shown = team.stacks.filter((s) => s.stack !== 'unknown' && (s.stack !== 4 || s.games > 0));
  const withGames = shown.filter((s) => s.games >= 2);
  const best = withGames.length > 1 ? withGames.reduce((a, b) => ((b.rrPerGame ?? -Infinity) > (a.rrPerGame ?? -Infinity) ? b : a)) : undefined;
  return (
    <section data-stacks>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="t-head text-lg text-ink">How you queue</h2>
        <span className="text-xs text-faint">Last {team.window} competitive matches this act</span>
      </div>
      <div className={cx('grid gap-3', shown.length > 4 ? 'grid-cols-5' : 'grid-cols-4')}>
        {shown.map((s) => (
          <StackTile key={String(s.stack)} s={s} best={s === best} five={team.stackPenalty.five} />
        ))}
      </div>
      {(livePenalty != null && livePenalty > 0) || team.noPartyData > 0 ? (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {livePenalty != null && livePenalty > 0 && (
            <span className="text-ink">
              Your current party: <span className="num font-semibold text-loss">RR −{Math.round(livePenalty * 100)}%</span> <span className="text-faint">(Riot’s number for this party)</span>
            </span>
          )}
          {team.noPartyData > 0 && (
            <span className="text-muted">
              {team.noPartyData} match{team.noPartyData === 1 ? '' : 'es'} without party data, left out of the party numbers
            </span>
          )}
        </div>
      ) : null}
    </section>
  );
}

// ---------- Squad ----------

const VERDICT: Record<Verdict, { label: string; tone: string }> = {
  'biggest drain': { label: 'Biggest drain', tone: 'bg-loss/[0.18] text-loss' },
  'costs you RR': { label: 'Costs you RR', tone: 'bg-loss/[0.09] text-loss/90' },
  neutral: { label: 'Neutral', tone: 'bg-white/[0.08] text-muted' },
  'helps you': { label: 'Helps you', tone: 'bg-win/[0.09] text-win/90' },
  'best partner': { label: 'Best partner', tone: 'bg-win/[0.18] text-win' },
  'not enough games': { label: 'Not enough games', tone: 'bg-white/[0.05] text-faint' },
};

function Avatar({ r }: { r: SquadRowView }) {
  const box = 'h-11 w-11 shrink-0 rounded-[12px]';
  if (r.hidden) return <span className={cx(box, 'flex items-center justify-center bg-white/[0.06] text-faint')}><EyeSlash size={18} /></span>;
  const initials = (r.name ?? '?').trim().slice(0, 2).toUpperCase();
  const fallback = <span className={cx(box, 'flex items-center justify-center bg-white/[0.08] text-sm font-semibold text-muted')}>{initials}</span>;
  return r.cardIcon ? <Img src={r.cardIcon} alt="" className={cx(box, 'object-cover')} fallback={fallback} /> : fallback;
}

/** −scale…+scale on a centred track; positive = good for you (green). Optional 80% interval as a thin range. */
function Diverging({ value, lo, hi, scale = 12 }: { value?: number; lo?: number; hi?: number; scale?: number }) {
  const pos = (v: number) => 50 + (Math.max(-scale, Math.min(scale, v)) / scale) * 50;
  if (value == null) return <div className="h-2 rounded-full bg-white/[0.05]" />;
  const a = pos(Math.min(0, value));
  const b = pos(Math.max(0, value));
  return (
    <div className="relative h-2 rounded-full bg-white/[0.06]">
      <span className="absolute inset-y-[-3px] left-1/2 w-px bg-white/25" />
      {lo != null && hi != null && <span className="absolute top-1/2 h-px -translate-y-1/2 bg-white/40" style={{ left: `${pos(lo)}%`, width: `${Math.max(0.5, pos(hi) - pos(lo))}%` }} />}
      <span className={cx('absolute inset-y-0 rounded-full', value >= 0 ? 'bg-win' : 'bg-loss')} style={{ left: `${a}%`, width: `${Math.max(1.5, b - a)}%` }} />
    </div>
  );
}

function Metric({ label, value, hint, children }: { label: string; value: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-muted">{label}</span>
        <span className="num shrink-0 text-sm text-ink">{value}</span>
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function mmrLine(r: SquadRowView, youTier: number): React.ReactNode {
  if (r.hidden) return <span className="text-faint">Hidden: SexyVal doesn’t look up players who hide their name. Your matches with them still count.</span>;
  if (r.status === 'loading')
    return (
      <span className="inline-flex items-center gap-1.5 text-faint">
        <CircleNotch size={12} className="animate-spin" /> Looking up their rank and MMR…
      </span>
    );
  if (r.status === 'unavailable') return <span className="text-faint">RR data unavailable for them; numbers use your RR in shared games.</span>;
  if (r.status === 'skipped')
    return <span className="text-faint">{r.games >= 2 ? 'Not looked up: SexyVal looks up the 6 players you queue with most.' : 'Not looked up (1 game together).'}</span>;
  const bits: React.ReactNode[] = [];
  if (r.theirTier) bits.push(<span key="r">Their rank {tierName(r.theirTier)}</span>);
  if (r.theirEstMmr != null) bits.push(<span key="m">their MMR ~{tierName(r.theirEstMmr)}{r.theirGapLabel ? ` (${r.theirGapLabel})` : ''}</span>);
  if (r.mmrGapVsYou != null && Math.abs(r.mmrGapVsYou) >= 0.5) {
    const n = Math.round(Math.abs(r.mmrGapVsYou));
    bits.push(<span key="g">{n} division{n === 1 ? '' : 's'} {r.mmrGapVsYou > 0 ? 'under' : 'over'} you</span>);
  }
  if (r.penaltyRisk) bits.push(<span key="p" className="text-loss/90">5-stack penalty risk</span>);
  if (!bits.length) bits.push(<span key="n">{youTier ? 'No rank data this act' : ''}</span>);
  return bits.flatMap((b, i) => (i ? [<span key={`s${i}`} className="text-faint/70"> · </span>, b] : [b]));
}

function SharedGames({ r }: { r: SquadRowView }) {
  const res = (x: string) => (x === 'W' ? 'text-win' : x === 'L' ? 'text-loss' : 'text-muted');
  const frag = (g: SquadRowView['shared'][number]) => {
    const bits = [];
    if (g.theirPlace === 1) bits.push('They top');
    else if (g.yourPlace === 1) bits.push('You top');
    if (g.bottomFrag === r.puuid) bits.push('They bottom');
    else if (g.yourPlace === 5) bits.push('You bottom');
    return bits.join(' · ') || '–';
  };
  return (
    <div className="mt-4 overflow-hidden rounded-2xl bg-white/[0.03]">
      <div className="grid grid-cols-[60px_minmax(0,1fr)_86px_64px_64px_96px_minmax(0,1.3fr)] gap-3 border-b border-line px-4 py-2 text-2xs text-faint">
        <span>Date</span>
        <span>Map</span>
        <span>Result</span>
        <span className="text-right">Your RR</span>
        <span className="text-right">Their RR</span>
        <span className="text-right">ACS them / you</span>
        <span title="Top and bottom ACS on your team">Frags</span>
      </div>
      {r.shared.map((g) => (
        <div key={g.matchId} className="grid grid-cols-[60px_minmax(0,1fr)_86px_64px_64px_96px_minmax(0,1.3fr)] items-center gap-3 border-b border-line px-4 py-1.5 text-xs last:border-b-0">
          <span className="num text-muted">{when(g.startTime)}</span>
          <span className="flex min-w-0 items-center gap-2">
            {g.agentIcon && <Img src={g.agentIcon} alt="" className="h-5 w-5 shrink-0 rounded-md bg-white/5" />}
            <span className="truncate text-ink">{g.mapName ?? '–'}</span>
          </span>
          <span className={cx('num', res(g.result))}>
            {g.result === 'W' ? 'Win' : g.result === 'L' ? 'Loss' : 'Draw'} {g.score ?? ''}
          </span>
          <span className={cx('num text-right', g.yourRR > 0 ? 'text-win' : g.yourRR < 0 ? 'text-loss' : 'text-muted')}>{signed(g.yourRR)}</span>
          <span className={cx('num text-right', (g.theirRR ?? 0) > 0 ? 'text-win' : (g.theirRR ?? 0) < 0 ? 'text-loss' : 'text-faint')}>{g.theirRR != null ? signed(g.theirRR) : '–'}</span>
          <span className="num text-right text-muted">
            <span className="text-ink">{g.theirAcs}</span> / {g.yourAcs}
          </span>
          <span className="truncate text-muted">{frag(g)}</span>
        </div>
      ))}
    </div>
  );
}

function SquadCard({ r, youTier }: { r: SquadRowView; youTier: number }) {
  const [open, setOpen] = useState(false);
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      if (outer.current) outer.current.style.height = '0px';
      return;
    }
    expandTo(outer.current, inner.current, open);
  }, [open]);
  const v = VERDICT[r.verdict];
  const name = r.hidden ? 'Hidden teammate' : (r.name ?? 'Teammate');
  const cost = r.rrCostEstimate;
  return (
    <div data-flip={r.puuid} data-squad-row className="border-b border-line px-5 py-4 last:border-b-0">
      <div className="flex items-start gap-4">
        <Avatar r={r} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="min-w-0 truncate text-md font-semibold text-ink" title={r.hidden ? undefined : `${name}${r.tag ? `#${r.tag}` : ''}`}>
              {name}
              {!r.hidden && r.tag && <span className="font-normal text-faint">#{r.tag}</span>}
            </span>
            {r.rank && <Img src={r.rank.icon} alt={r.rank.name} title={`Their rank: ${r.rank.name}`} className="h-6 w-6 shrink-0" />}
            {r.estRank && (
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted" title="Their estimated MMR (our own estimate)">
                <span className="text-faint">est.</span>
                <Img src={r.estRank.icon} alt={r.estRank.name} className="h-5 w-5" />
              </span>
            )}
            <span className={cx('ml-auto shrink-0 rounded-full px-2.5 py-1 text-2xs font-semibold', v.tone)}>{v.label}</span>
          </div>
          <div className="mt-1 text-sm text-muted">
            <span className="num text-ink">{r.games}</span> game{r.games === 1 ? '' : 's'} together
            {r.games ? (
              <span className="num">
                {' '}
                · {r.wins}–{r.losses}
                {r.draws ? `–${r.draws}` : ''}
              </span>
            ) : null}
            {cost != null && r.eligible && (
              <>
                {' '}
                · {cost < 0 ? 'cost you' : 'gained you'} about <span className={cx('num font-semibold', cost < 0 ? 'text-loss' : 'text-win')}>{signed(cost)} RR</span>
              </>
            )}
          </div>
          {!r.eligible && r.games >= 3 && r.without.games < 3 && <div className="mt-1 text-xs text-faint">In nearly every match with you: too few games without them to compare against.</div>}
          {r.eligible && (
            <div className="mt-4 grid grid-cols-3 gap-6">
              <Metric label="Adjusted impact" value={r.beta != null ? `${signed(r.beta, 1)} RR/game` : '–'} hint="Ridge regression over your window: your RR per game with them, other premades, 5-stacks and lobby difficulty held fixed (our own estimate).">
                <Diverging value={r.beta} />
              </Metric>
              <Metric label="With vs without" value={r.shrunkDelta != null ? `${signed(r.shrunkDelta, 1)} RR/game` : '–'} hint={`Your RR per game with them minus without them, shrunk for small samples (× n / (n + 5)). Thin line: 80% interval${r.interval ? ` (${signed(r.interval[0], 1)} to ${signed(r.interval[1], 1)})` : ''}.`}>
                <Diverging value={r.shrunkDelta} lo={r.interval?.[0]} hi={r.interval?.[1]} />
              </Metric>
              <Metric label="In your losses" value={r.them.meanZLosses != null ? `ACS z ${signed(r.them.meanZLosses, 2)}` : 'no losses'} hint="Their ACS against the whole lobby in the games you lost together (z-score: 0 = lobby average), and how often they had the lowest ACS on your team in those losses.">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Diverging value={r.them.meanZLosses != null ? r.them.meanZLosses * 8 : undefined} />
                  </div>
                  <span className="num shrink-0 text-2xs text-faint" title="Share of your shared losses where they had the lowest ACS on your team">bottom {pct(r.them.bottomFragLosses)}</span>
                </div>
              </Metric>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-1 text-xs text-muted">{mmrLine(r, youTier)}</div>
          {r.games > 0 && (
            <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="press mt-2 inline-flex items-center gap-1 rounded-full text-xs font-medium text-muted hover:text-ink">
              {open ? 'Hide' : 'Show'} {r.games} game{r.games === 1 ? '' : 's'}
              <CaretDown size={11} weight="bold" className={cx('transition-transform duration-200', open && 'rotate-180')} />
            </button>
          )}
          <div ref={outer} className="overflow-hidden" aria-hidden={!open}>
            <div ref={inner}>{r.shared.length > 0 && <SharedGames r={r} />}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RandomsLine({ r }: { r: RandomsRow }) {
  if (!r.appearances) return null;
  return (
    <div data-randoms className="flex items-start gap-4 bg-white/[0.02] px-5 py-4">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-white/[0.05] text-faint">
        <UsersThree size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-md font-semibold text-ink">Random teammates</div>
        <div className="mt-1 flex flex-wrap gap-x-1 text-sm text-muted">
          <span>
            <span className="num text-ink">{r.appearances}</span> across {r.games} games
          </span>
          {r.meanTier != null && (
            <span>
              · average {tierName(r.meanTier)}
              {r.yourTier >= 3 ? ` (you ${tierName(r.yourTier)})` : ''}
            </span>
          )}
          {r.meanZ != null && <span className="num">· ACS z {signed(r.meanZ, 2)}</span>}
          {r.bottomFragLosses != null && <span>· bottom frag {pct(r.bottomFragLosses)} of the time in losses</span>}
          {r.soloRRPerGame != null && (
            <span>
              · your solo queue <span className={cx('num', r.soloRRPerGame > 0 ? 'text-win' : r.soloRRPerGame < 0 ? 'text-loss' : '')}>{signed(r.soloRRPerGame, 1)} RR/game</span>
            </span>
          )}
        </div>
        <div className="mt-1 text-xs text-faint">Aggregate only. Randoms are never named.</div>
      </div>
    </div>
  );
}

/**
 * Everyone you queued with, most costly first. While premade lookups are still landing the order holds
 * and cards fill in place; once they are all in, the list re-sorts once (FLIP).
 */
export function SquadList({ rows, randoms, settled, youTier }: { rows: SquadRowView[]; randoms: RandomsRow; settled: boolean; youTier: number }) {
  const list = useRef<HTMLDivElement>(null);
  const [order, setOrder] = useState<string[]>(() => rows.map((r) => r.puuid));
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => {
    const next = rows.map((r) => r.puuid);
    setOrder((cur) => {
      if (!settled) return [...cur.filter((p) => next.includes(p)), ...next.filter((p) => !cur.includes(p))];
      if (cur.join() === next.join()) return cur;
      pending.current = flipCapture(list.current);
      return next;
    });
  }, [rows, settled]);
  useLayoutEffect(() => {
    pending.current?.();
    pending.current = null;
  }, [order]);
  const by = new Map(rows.map((r) => [r.puuid, r]));
  const shown = order.map((p) => by.get(p)).filter((r): r is SquadRowView => !!r);
  return (
    <section data-squad>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="t-head text-lg text-ink">Squad</h2>
        <span className="text-xs text-faint">{settled ? 'Ranked by estimated RR cost · 3+ games to be ranked' : 'Looking up your regulars…'}</span>
      </div>
      <Panel>
        <div ref={list}>
          {shown.map((r) => (
            <SquadCard key={r.puuid} r={r} youTier={youTier} />
          ))}
        </div>
        <RandomsLine r={randoms} />
      </Panel>
    </section>
  );
}
