import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ACT_LEVEL_TOTAL,
  ACT_MAIN_LEVELS,
  GUIDE_URL,
  PORTRAIT_STEPS,
  sortAgents,
  TRACK_LEVELS,
  WIKI_CHECKED,
  WIKI_URL,
  type AgentMasteryDetail,
  type AgentMasteryView,
  type MasteryView,
  type RewardCategory,
  type RewardRow,
  type RewardState,
  type SortKey,
} from '../../../shared/mastery';
import { queueName } from '../../../shared/queues';
import { api } from '../lib/api';
import { ago, cx, fmtNum, useNow } from '../lib/format';
import { img } from '../lib/media';
import { withViewTransition } from '../lib/motion';
import {
  ArrowClockwise,
  CaretLeft,
  ChartLine,
  Check,
  Cloud,
  Crosshair,
  Cube,
  Diamond,
  IdentificationCard,
  ImageSquare,
  LockSimple,
  PaintBrush,
  Question,
  Smiley,
  Tag,
  User,
  type IconProps,
} from '../lib/icons';
import { Btn, ErrorNote, Note, PageHeader } from '../components/kit';
import { Img, Panel, Segmented, Skeleton, tint } from '../components/ui';

const LAST_KEY = 'sv.mastery.lastPuuid';
const SORT_KEY = 'sv.mastery.sort';
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private window / blocked storage: only a convenience
    }
  },
};

/** Riot's list also names the console queues (console_competitive, …); SexyVal is PC only. */
const pcQueues = (q: string[] | undefined) => (q ?? []).filter((x) => !x.startsWith('console_'));

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method 'rpc': (Error: )?/, '');

/**
 * The mastery view for one account. Every response is checked against the account asked for, so a slow
 * answer for the previous account (after a switch) is dropped instead of shown.
 */
function useMastery(puuid: string | undefined) {
  const [view, setView] = useState<MasteryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useRef(puuid);
  current.current = puuid;
  useEffect(() => {
    setView(null);
    setError(null);
    if (!puuid) return;
    let live = true;
    api
      .rpc<MasteryView>('mastery:get', puuid)
      .then((v) => live && current.current === puuid && v.puuid === puuid && setView(v))
      .catch((e) => live && current.current === puuid && setError(errText(e)));
    const off = api.on<MasteryView>('mastery', (v) => {
      if (v.puuid === current.current) setView(v);
    });
    return () => {
      live = false;
      off();
    };
  }, [puuid]);
  const refresh = async () => {
    if (!puuid) return;
    setBusy(true);
    try {
      const v = await api.rpc<MasteryView>('mastery:refresh', puuid);
      if (current.current === puuid && v.puuid === puuid) setView(v);
    } catch (e) {
      if (current.current === puuid) setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return { view, error, busy, refresh };
}

// ---------------------------------------------------------------------------------------------------
// Small pieces

/** Where a value comes from. Shown next to every number that isn't plain Riot data. */
function Source({ kind, title }: { kind: 'riot' | 'wiki' | 'snapshot' | 'sexyval' | 'catalog'; title?: string }) {
  const label = { riot: 'Riot', wiki: 'Wiki', snapshot: 'Saved', sexyval: 'SexyVal', catalog: 'Catalog' }[kind];
  const tone = { riot: 'bg-white/[0.08] text-ink/80', wiki: 'bg-warn/[0.12] text-warn', snapshot: 'bg-white/[0.06] text-muted', sexyval: 'bg-def/[0.12] text-def', catalog: 'bg-white/[0.06] text-muted' }[kind];
  const t =
    title ??
    {
      riot: 'From Riot’s mastery data (undocumented endpoint, field meanings from community research)',
      wiki: `From the VALORANT Wiki (community-edited), checked ${WIKI_CHECKED}`,
      snapshot: 'A copy SexyVal saved earlier',
      sexyval: 'Calculated by SexyVal from your cached matches. Not Riot mastery data.',
      catalog: 'From the public content catalog (valorant-api.com)',
    }[kind];
  return (
    <span title={t} className={cx('inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-[10px] font-semibold', tone)}>
      {label}
    </span>
  );
}

/** Act Level badge with the portrait accent tier as rings (0 none … 4 animated background). */
function LevelBadge({ level, tier, size = 'md' }: { level: number | null; tier: number; size?: 'md' | 'lg' }) {
  const big = size === 'lg';
  return (
    <span
      className={cx(
        'relative inline-flex items-center justify-center rounded-full font-display font-bold num',
        big ? 'h-16 w-16 text-[26px]' : 'h-9 w-9 text-[15px]',
        tier >= 4 ? 'bg-white text-black' : tier >= 3 ? 'bg-white/[0.85] text-black' : tier >= 2 ? 'bg-black/60 text-ink ring-2 ring-white/80' : tier >= 1 ? 'bg-black/60 text-ink ring-1 ring-white/40' : 'bg-black/50 text-muted ring-1 ring-white/10',
        tier >= 4 && 'mastery-glow',
      )}
      style={{ fontStretch: '112%' }}
      title={tier ? `Portrait accent: ${PORTRAIT_STEPS[tier - 1].name}` : 'No portrait accent yet'}
    >
      {level === null ? '–' : level}
    </span>
  );
}

function ProgressLine({ a }: { a: AgentMasteryView }) {
  if (a.actLevel === null) return <div className="h-1 rounded-full bg-white/[0.08]" />;
  const pct = a.progress ? (a.progress.into / a.progress.need) * 100 : a.actLevel >= ACT_MAIN_LEVELS ? 100 : 0;
  return (
    <div className="h-1 overflow-hidden rounded-full bg-white/[0.12]" title={a.progress ? `${fmtNum(a.progress.into)} / ${fmtNum(a.progress.need)} MP to Act Level ${a.progress.nextLevel} (thresholds: VALORANT Wiki)` : undefined}>
      <div className={cx('h-full rounded-full', a.progress ? 'bg-white' : 'bg-white/30')} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

/** The brightest of the agent's gradient colours (valorant-api sends RRGGBBAA), as a light behind the art. */
function agentGlow(a: { colors?: string[] }, alpha: number): string {
  const lum = (h: string) => {
    const n = parseInt(h.slice(0, 6), 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  };
  const list = (a.colors ?? []).map(String).filter((h) => /^[0-9a-f]{6}/i.test(h));
  const best = list.sort((x, y) => lum(y) - lum(x))[0];
  return tint(best ? `#${best.slice(0, 6)}` : undefined, alpha);
}

// ---------------------------------------------------------------------------------------------------
// Grid

function AgentCard({ a, onOpen }: { a: AgentMasteryView; onOpen: () => void }) {
  const none = a.state !== 'progress';
  return (
    <button
      type="button"
      onClick={onOpen}
      data-agent={a.id}
      className="press group relative flex aspect-[3/4] flex-col overflow-hidden rounded-2xl bg-surface text-left ring-1 ring-white/[0.06] hover:ring-white/[0.16] [contain:layout_paint]"
    >
      <div aria-hidden className="absolute inset-0" style={{ background: `radial-gradient(120% 70% at 50% 100%, ${agentGlow(a, none ? 0.12 : 0.32)}, transparent 70%)` }} />
      {/* The 256 px head icon, not the 2048 px portrait: 30 full portraits would cost hundreds of MB decoded. */}
      {a.icon && (
        <Img
          src={img(a.icon)}
          alt=""
          className={cx('pointer-events-none absolute inset-x-0 top-[6%] mx-auto aspect-square w-[92%] object-contain transition-transform duration-320 ease-out group-hover:scale-[1.04]', none && 'opacity-40 grayscale')}
        />
      )}
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black via-black/70 to-transparent" />
      <div className="relative flex items-start justify-between p-3">
        <LevelBadge level={a.actLevel} tier={a.portraitTier} />
        {a.milestones > 0 && (
          <span className="rounded-full bg-black/55 px-2 py-0.5 text-2xs font-semibold text-ink/90" title={`${a.milestones} reward tier${a.milestones === 1 ? '' : 's'} unlocked by Lifetime Level`}>
            {a.milestones}/{TRACK_LEVELS.length}
          </span>
        )}
      </div>
      <div className="relative mt-auto p-3 pt-0">
        <div className="t-head truncate text-[17px] text-ink">{a.name}</div>
        <div className="mt-0.5 flex items-center justify-between gap-2 text-2xs text-muted">
          <span className="truncate">{a.role ?? ''}</span>
          <span className="num shrink-0">{a.state === 'unknown' ? 'No data' : a.state === 'none' ? 'Not played' : `Lifetime ${a.lifetimeLevel}`}</span>
        </div>
        <div className="mt-2">
          <ProgressLine a={a} />
        </div>
      </div>
    </button>
  );
}

function SyncLine({ v, busy }: { v: MasteryView; busy: boolean }) {
  const now = useNow(30_000);
  if (busy || v.status === 'loading') return <span className="text-xs text-muted">Syncing with Riot…</span>;
  if (!v.syncedAt) return <span className="text-xs text-muted">Never synced</span>;
  const when = ago(v.syncedAt, now);
  if (v.status === 'error') return <span className="text-xs text-warn" title={v.error}>Riot unreachable · saved {when}</span>;
  if (v.source === 'snapshot') return <span className="text-xs text-muted">Saved copy · {when}</span>;
  return <span className="text-xs text-muted">Synced {when}</span>;
}

// ---------------------------------------------------------------------------------------------------
// Detail

type Tab = 'overview' | 'act' | 'lifetime' | 'rewards' | 'agentid' | 'stats';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['act', 'Act'],
  ['lifetime', 'Lifetime'],
  ['rewards', 'Rewards'],
  ['agentid', 'Agent ID'],
  ['stats', 'Statistics'],
];

function useAgentDetail(puuid: string | undefined, agentId: string | null, syncedAt?: number) {
  const [d, setD] = useState<AgentMasteryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${puuid}:${agentId}`;
  const current = useRef(key);
  current.current = key;
  useEffect(() => {
    if (!puuid || !agentId) return;
    let live = true;
    setError(null);
    api
      .rpc<AgentMasteryDetail>('mastery:agent', puuid, agentId)
      .then((x) => live && current.current === key && x.puuid === puuid && x.agent.id === agentId && setD(x))
      .catch((e) => live && current.current === key && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [puuid, agentId, key, syncedAt]);
  // Drop the previous agent/account immediately so its numbers never show under a new name.
  const fresh = d && d.puuid === puuid && d.agent.id === agentId ? d : null;
  return { d: fresh, error };
}

function Stat({ label, value, sub, source }: { label: string; value: ReactNode; sub?: ReactNode; source?: Parameters<typeof Source>[0]['kind'] }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {label}
        {source && <Source kind={source} />}
      </div>
      <div className="t-title num mt-1 text-stat text-ink">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

/** Full on Overview; compact on the other tabs so their content starts above the fold. */
function Hero({ a, d, compact }: { a: AgentMasteryView; d: AgentMasteryDetail | null; compact?: boolean }) {
  return (
    <Panel className="relative overflow-hidden">
      <div aria-hidden className="absolute inset-0" style={{ background: `radial-gradient(90% 120% at 18% 100%, ${agentGlow(a, 0.38)}, transparent 65%)` }} />
      {a.background && <Img src={img(a.background)} alt="" className="pointer-events-none absolute -left-10 top-0 h-full opacity-[0.12]" />}
      <div className={cx('relative grid grid-cols-[minmax(200px,0.8fr)_minmax(0,1.2fr)] items-end', compact ? 'min-h-[176px]' : 'min-h-[300px]')}>
        <div className={cx('relative h-full', compact ? 'min-h-[176px]' : 'min-h-[300px]')}>
          {a.portrait && <Img src={img(a.portrait)} alt="" className={cx('absolute left-1/2 max-w-none -translate-x-1/2 object-contain', compact ? 'top-0 h-[420px] object-top' : 'bottom-0 h-[360px] object-bottom')} />}
        </div>
        <div className={cx('relative pl-2', compact ? 'p-5' : 'p-6 pb-7')}>
          {!compact && <div className="text-sm text-muted">{a.role}</div>}
          <h2 className={cx('t-title text-ink', compact ? 'text-page' : 'text-hero')}>{a.name}</h2>
          <div className={cx('grid grid-cols-3 gap-5', compact ? 'mt-3' : 'mt-6')}>
            <Stat label="Act Level" source="riot" value={a.actLevel ?? '–'} sub={d?.act?.label ?? (a.actLevel === null ? 'New Act since last sync' : undefined)} />
            <Stat label="Lifetime Level" source="riot" value={a.lifetimeLevel ?? '–'} sub="Never resets" />
            <Stat label="Mastery Points" source="riot" value={a.points === null ? '–' : fmtNum(a.points)} sub="This Act" />
          </div>
          {!compact && (
            <div className="mt-5 max-w-[520px]">
              <ActBar a={a} />
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

function ActBar({ a }: { a: AgentMasteryView }) {
  if (a.actLevel === null) return <div className="text-xs text-muted">Act Levels reset with the new Act. Sync to see this Act’s progress.</div>;
  return (
    <div>
      <ProgressLine a={a} />
      <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted">
        {a.progress ? (
          <>
            <span className="num">
              {fmtNum(a.progress.into)} / {fmtNum(a.progress.need)} MP to Act Level {a.progress.nextLevel}
            </span>
            <Source kind="wiki" title={`MP per level is from the VALORANT Wiki (community-edited, checked ${WIKI_CHECKED}); the points themselves are Riot’s`} />
          </>
        ) : a.progressNote === 'mismatch' ? (
          <span>Riot’s points don’t match the community level table for this agent, so no progress bar is shown.</span>
        ) : a.progressNote === 'beyond-table' ? (
          <span>Past the levels the community table covers.</span>
        ) : (
          <span>{a.state === 'none' ? 'No Mastery Points on this agent yet.' : ''}</span>
        )}
      </div>
    </div>
  );
}

function Overview({ a, d }: { a: AgentMasteryView; d: AgentMasteryDetail | null }) {
  const nextMilestone = TRACK_LEVELS.find((l) => (a.lifetimeLevel ?? 0) < l);
  const eligible = d?.rewards.filter((r) => r.state !== 'locked').length ?? 0;
  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <Panel className="p-5">
        <Stat label="Portrait" value={a.portraitTier ? PORTRAIT_STEPS[a.portraitTier - 1].name : 'Standard'} sub={a.previousActLevel ? `Best of this Act and last Act (Level ${a.previousActLevel})` : 'Upgrades at Act Levels 4, 7 and 10'} />
      </Panel>
      <Panel className="p-5">
        <Stat label="Next reward tier" value={nextMilestone ? `Lifetime ${nextMilestone}` : 'All tiers'} sub={nextMilestone && a.lifetimeLevel !== null ? `${nextMilestone - a.lifetimeLevel} Act Level${nextMilestone - a.lifetimeLevel === 1 ? '' : 's'} away` : undefined} />
      </Panel>
      <Panel className="p-5">
        <Stat label="Rewards unlocked" source="wiki" value={`${eligible}/${d?.rewards.length ?? 28}`} sub="Purchasable with Kingdom Credits" />
      </Panel>
      <Panel className="p-5">
        <Stat label="Matches cached" source="sexyval" value={d ? fmtNum(d.analytics.sinceLaunch.matches) : '–'} sub="On this agent since 13.06" />
      </Panel>
    </div>
  );
}

function ActTab({ a, d }: { a: AgentMasteryView; d: AgentMasteryDetail | null }) {
  const lvl = a.actLevel ?? 0;
  const steps = Array.from({ length: ACT_MAIN_LEVELS }, (_, i) => i + 1);
  const accent = new Map<number, string>(PORTRAIT_STEPS.map((s) => [s.level, s.name]));
  return (
    <div className="flex flex-col gap-4">
      <Panel className="p-6">
        <div className="flex items-baseline justify-between gap-4">
          <div className="t-head text-lg text-ink">{d?.act?.label ?? 'This Act'}</div>
          <span className="text-xs text-muted">Act Levels reset for every agent when a new Act starts</span>
        </div>
        <div className="mt-6 grid grid-cols-10 gap-1.5">
          {steps.map((s) => {
            const done = a.actLevel !== null && lvl >= s;
            const here = a.actLevel !== null && lvl + 1 === s;
            return (
              <div key={s} className="flex flex-col items-center gap-2">
                <div className={cx('h-2 w-full rounded-full', done ? 'bg-white' : here ? 'bg-white/30' : 'bg-white/[0.08]')} />
                <span className={cx('num text-2xs', done ? 'text-ink' : 'text-faint')}>{s}</span>
                {accent.has(s) && <span className={cx('text-center text-[10px] leading-tight', done ? 'text-ink/80' : 'text-faint')}>{accent.get(s)}</span>}
              </div>
            );
          })}
        </div>
        {lvl > ACT_MAIN_LEVELS && <div className="mt-4 text-sm text-muted">Overlevelled: Act Level {lvl}, {lvl - ACT_MAIN_LEVELS} past the main track.</div>}
        <div className="mt-6 max-w-[560px]">
          <ActBar a={a} />
        </div>
      </Panel>
      <div className="grid grid-cols-2 gap-4">
        <Panel className="p-5">
          <Stat label="Last Act" source="riot" value={a.previousActLevel === null ? '–' : a.previousActLevel} sub="Its portrait upgrades stay for this Act" />
        </Panel>
        <Panel className="p-5">
          <div className="flex items-center gap-1.5 text-xs text-muted">
            Earlier Acts <Source kind="snapshot" title="Only Acts SexyVal saw you play in: the last level it saw" />
          </div>
          {d?.history.length ? (
            <div className="mt-2 flex flex-col gap-1">
              {d.history.map((h) => (
                <div key={h.id} className="flex items-center justify-between text-sm">
                  <span className="truncate text-ink/90">{h.label}</span>
                  <span className="num text-muted">Level {h.level}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-2 text-sm text-muted">None recorded yet. SexyVal keeps the last level it sees in each Act from now on.</div>
          )}
        </Panel>
      </div>
      <Note>
        MP per level comes from the <a className="underline decoration-white/30 underline-offset-2 hover:text-ink" href={WIKI_URL} target="_blank" rel="noreferrer">VALORANT Wiki</a>: Riot hasn’t published it. Level 1 needs {fmtNum(ACT_LEVEL_TOTAL[1])} MP, Level 10 {fmtNum(ACT_LEVEL_TOTAL[10])} in total.
      </Note>
    </div>
  );
}

function LifetimeTab({ a }: { a: AgentMasteryView }) {
  const lv = a.lifetimeLevel ?? 0;
  const max = TRACK_LEVELS[TRACK_LEVELS.length - 1];
  return (
    <div className="flex flex-col gap-4">
      <Panel className="p-6">
        <div className="flex items-end justify-between gap-6">
          <Stat label="Lifetime Level" source="riot" value={a.lifetimeLevel ?? '–'} sub="Goes up with every Act Level and never resets" />
          <div className="text-right text-xs text-muted">{lv >= max ? 'Every reward tier unlocked' : `Reward tiers every 5 Lifetime Levels, up to ${max}`}</div>
        </div>
        <div className="relative mt-8 h-2 rounded-full bg-white/[0.08]">
          <div className="absolute inset-y-0 left-0 rounded-full bg-white transition-[width] duration-[420ms] ease-out" style={{ width: `${Math.min(100, (lv / max) * 100)}%` }} />
          {TRACK_LEVELS.map((l) => (
            <span key={l} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${(l / max) * 100}%` }}>
              <span className={cx('block h-4 w-4 rotate-45 rounded-[3px] ring-2 ring-black', lv >= l ? 'bg-white' : 'bg-[#2a2a2e]')} />
            </span>
          ))}
        </div>
        <div className="relative mt-3 h-4">
          {TRACK_LEVELS.map((l) => (
            <span key={l} className={cx('num absolute -translate-x-1/2 text-2xs', lv >= l ? 'text-ink' : 'text-faint')} style={{ left: `${(l / max) * 100}%` }}>
              {l}
            </span>
          ))}
        </div>
        {lv > max && <div className="mt-3 text-sm text-muted">Lifetime {lv}: past the last reward tier.</div>}
      </Panel>
      <Note>Riot started everyone at zero with patch 13.06 and doesn’t carry older playtime over. Player Support can’t change or erase Lifetime Mastery.</Note>
    </div>
  );
}

const CAT_ICON: Record<RewardCategory, (p: IconProps) => ReactNode> = {
  spray: (p) => <PaintBrush {...p} />,
  title: (p) => <Tag {...p} />,
  card: (p) => <IdentificationCard {...p} />,
  stat: (p) => <ChartLine {...p} />,
  quote: (p) => <Smiley {...p} />,
  frame: (p) => <Diamond {...p} />,
  background: (p) => <ImageSquare {...p} />,
  skin: (p) => <Crosshair {...p} />,
  buddy: (p) => <Cube {...p} />,
  pose: (p) => <User {...p} />,
};

function StateChip({ s }: { s: RewardState }) {
  const map: Record<RewardState, [string, string, string]> = {
    equipped: ['Equipped', 'bg-white text-black', 'On your Agent ID (from Riot)'],
    owned: ['Owned', 'bg-win/[0.16] text-win', 'In your entitlements (from Riot)'],
    available: ['Not owned', 'bg-white/[0.1] text-ink', 'Your Lifetime Level unlocked it and your entitlements show you don’t own it'],
    unknown: ['Unlocked', 'bg-white/[0.06] text-muted', 'Your Lifetime Level unlocked it. No Riot source says whether you bought it, so ownership is unknown.'],
    locked: ['Locked', 'bg-white/[0.04] text-faint', 'Needs a higher Lifetime Level'],
  };
  const [label, cls, t] = map[s];
  return (
    <span title={t} className={cx('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold', cls)}>
      {s === 'locked' && <LockSimple size={10} weight="bold" />}
      {(s === 'owned' || s === 'equipped') && <Check size={10} weight="bold" />}
      {label}
    </span>
  );
}

const CAT_LABEL: Record<RewardCategory, string> = {
  spray: 'Spray',
  title: 'Player title',
  card: 'Player card',
  stat: 'Agent ID stat',
  quote: 'Quote',
  frame: 'Frame',
  background: 'Background',
  skin: 'Sidearm skin',
  buddy: 'Gun buddy',
  pose: 'Pose',
};

/** Short label for a stat tile ("KD stat" → "KD", "First Bloods stat" → "First Bloods"). */
const statShort = (name: string) => name.replace(/ stat$/, '');
const ROMAN = ['', 'I', 'II', 'III', 'IV'];

/**
 * The picture half of a reward tile. Real art when the exact item is known (sprays, cards, buddy, sidearm,
 * mastery card). Everything else is a drawn preview built from what the item is, never a stand-in that
 * passes for the real art (the pose is a silhouette, backgrounds are the agent's own colours).
 */
function RewardArt({ r, a }: { r: RewardRow; a: AgentMasteryView }) {
  const glow = agentGlow(a, 0.34);
  const backdrop = <div aria-hidden className="absolute inset-0" style={{ background: `radial-gradient(85% 75% at 50% 60%, ${glow}, transparent 72%)` }} />;
  const it = r.item;
  if (it && r.category === 'card' && it.art)
    return <Img src={img(it.art)} alt="" className="absolute inset-0 h-full w-full object-cover object-top" />;
  if (it && it.icon && (r.category === 'spray' || r.category === 'buddy' || r.category === 'skin'))
    return (
      <>
        {backdrop}
        <Img src={img(it.art ?? it.icon)} alt="" className={cx('absolute inset-0 m-auto object-contain drop-shadow-[0_6px_18px_rgba(0,0,0,0.55)]', r.category === 'skin' ? 'h-[46%] w-[86%]' : 'h-[66%] w-[66%]')} />
      </>
    );
  switch (r.category) {
    case 'title':
      return (
        <>
          {backdrop}
          <div className="absolute inset-x-3 top-1/2 -translate-y-1/2 rounded-md bg-black/55 px-2 py-2 text-center ring-1 ring-white/[0.12] backdrop-blur-sm">
            <div className={cx('truncate text-sm font-semibold uppercase tracking-[0.14em]', it?.text ? 'text-ink' : 'text-faint')}>{it?.text ?? 'Title'}</div>
          </div>
        </>
      );
    case 'stat':
      return (
        <>
          {backdrop}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
            <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-muted">Stat</span>
            <span className="t-head max-w-[90%] truncate text-center text-xl text-ink">{statShort(r.name)}</span>
            <svg viewBox="0 0 64 18" className="mt-1 h-4 w-16 text-ink/60" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 15 L14 10 L24 12 L36 5 L46 8 L62 2" />
            </svg>
          </div>
        </>
      );
    case 'quote':
      return (
        <>
          {backdrop}
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-serif text-[72px] leading-[0.6] text-ink/85">“</span>
            <span className="mt-3 text-2xs font-semibold uppercase tracking-[0.16em] text-muted">Voice line</span>
          </div>
        </>
      );
    case 'frame': {
      const tier = ROMAN.indexOf(/Level (I+V?|IV)/.exec(r.name)?.[1] ?? '') || 2;
      return (
        <>
          {backdrop}
          <svg viewBox="0 0 100 100" className="absolute inset-0 m-auto h-[68%] w-[68%] text-ink" fill="none" stroke="currentColor">
            {Array.from({ length: tier }, (_, i) => (
              <rect key={i} x={50 - 28 - i * 5} y={50 - 28 - i * 5} width={56 + i * 10} height={56 + i * 10} rx={6 + i * 2} transform="rotate(45 50 50)" strokeWidth={i === 0 ? 2.4 : 1.2} opacity={1 - i * 0.22} />
            ))}
            <text x="50" y="56" textAnchor="middle" fill="currentColor" stroke="none" fontSize="17" fontWeight="700" letterSpacing="1">
              {ROMAN[tier]}
            </text>
          </svg>
        </>
      );
    }
    case 'background':
      return (
        <>
          <div aria-hidden className="absolute inset-0" style={{ background: `linear-gradient(160deg, ${agentGlow(a, 0.55)}, ${agentGlow(a, 0.08)} 70%)` }} />
          {a.background && <Img src={img(a.background)} alt="" className="absolute inset-y-0 left-1/2 h-full max-w-none -translate-x-1/2 opacity-30" />}
          {/Role/.test(r.name) && a.roleIcon && <Img src={img(a.roleIcon)} alt="" className="absolute inset-0 m-auto h-[34%] w-[34%] object-contain opacity-80" />}
          <span className="absolute inset-x-0 bottom-2 text-center text-2xs font-semibold uppercase tracking-[0.16em] text-ink/70">{r.name.replace(/ background$/, '')}</span>
        </>
      );
    case 'pose':
      return (
        <>
          {backdrop}
          {a.portrait && <Img src={img(a.portrait)} alt="" className="absolute inset-x-0 bottom-0 mx-auto h-[115%] max-w-none object-contain object-top opacity-25 [filter:brightness(0)_invert(1)]" />}
        </>
      );
    default:
      return (
        <>
          {backdrop}
          <span className="absolute inset-0 m-auto flex h-10 w-10 items-center justify-center text-muted">{CAT_ICON[r.category]({ size: 28 })}</span>
        </>
      );
  }
}

function RewardTile({ r, a }: { r: RewardRow; a: AgentMasteryView }) {
  const locked = r.state === 'locked';
  const have = r.state === 'owned' || r.state === 'equipped';
  return (
    <div className={cx('group flex min-w-0 flex-col overflow-hidden rounded-xl bg-white/[0.04] ring-1', have ? 'ring-win/40' : 'ring-white/[0.06]')}>
      <div className={cx('relative aspect-square overflow-hidden bg-black/40 transition-[filter,opacity] duration-200', locked && 'opacity-45 grayscale')}>
        <RewardArt r={r} a={a} />
      </div>
      <div className="relative flex flex-1 flex-col gap-1.5 p-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm text-ink/90" title={r.item?.name ?? r.name}>{r.item?.name ?? r.name}</div>
          <div className="num truncate text-2xs text-faint">
            {r.category === 'card' && r.level === 30 ? 'Mastery card' : CAT_LABEL[r.category]} · {fmtNum(r.kc)} KC
          </div>
        </div>
        <span className="self-start">
          <StateChip s={r.state} />
        </span>
      </div>
    </div>
  );
}

function RewardsTab({ a, d }: { a: AgentMasteryView; d: AgentMasteryDetail | null }) {
  if (!d) return <Skeleton className="h-72" />;
  const byLevel = TRACK_LEVELS.map((l) => [l, d.rewards.filter((r) => r.level === l)] as [number, RewardRow[]]);
  const lt = d.agent.lifetimeLevel;
  return (
    <div className="flex flex-col gap-4">
      {byLevel.map(([l, rows]) => (
        <Panel key={l} className="p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="t-head text-md text-ink">Lifetime {l}</span>
            {lt !== null && (lt >= l ? <span className="text-2xs text-win">Reached</span> : <span className="num text-2xs text-faint">{l - lt} to go</span>)}
          </div>
          <div className="grid grid-cols-5 gap-3">
            {rows.map((r, i) => (
              <RewardTile key={i} r={r} a={a} />
            ))}
          </div>
        </Panel>
      ))}
      {d.cosmetics.length > 0 && (
        <Panel className="p-5">
          <div className="mb-3 flex items-center gap-2">
            <span className="t-head text-md text-ink">More of this agent’s items</span>
            <span className="text-xs text-muted">Agent Gear items SexyVal couldn’t place on the track. Ownership from your entitlements.</span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2">
            {d.cosmetics.map((c) => (
              <div key={`${c.type}:${c.id}`} className="flex items-center gap-2.5 rounded-xl bg-white/[0.04] p-2">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/[0.06]">
                  {c.icon ? <Img src={img(c.icon)} alt="" className="h-10 w-10 object-contain" /> : CAT_ICON[c.type]({ size: 15 })}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-ink/90">{c.name}</div>
                  <div className="text-2xs text-faint">{{ spray: 'Spray', card: 'Player card', title: 'Title', buddy: 'Gun buddy', skin: 'Sidearm skin' }[c.type]}</div>
                </div>
                {c.owned === null ? <span className="text-2xs text-faint" title="Owned items aren’t loaded for this account">?</span> : c.owned ? <StateChip s="owned" /> : <span className="text-2xs text-faint">Not owned</span>}
              </div>
            ))}
          </div>
        </Panel>
      )}
      <Note>
        Reward layout and Kingdom Credits prices are from the <a className="underline decoration-white/30 underline-offset-2 hover:text-ink" href={WIKI_URL} target="_blank" rel="noreferrer">VALORANT Wiki</a> (checked {WIKI_CHECKED}). Sprays, cards, titles, the gun buddy and the sidearm skin are this agent’s Agent Gear items and Bloomline mastery card, placed in the wiki’s order, with ownership from your entitlements (most agents’ Lifetime 30 title is new and has no public mapping yet). Frames, backgrounds, the pose, quotes and stats are drawn previews: Riot publishes no item list for them, so their ownership shows as unknown. Lifetime Level unlocks a reward; you still buy it. SexyVal never buys or equips anything.
      </Note>
    </div>
  );
}

function SlotRow({ name, id, fallback }: { name: string; id?: string; fallback: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-b-0">
      <span className="text-sm text-ink/90">{name}</span>
      {id ? (
        <span className="flex items-center gap-2 text-xs text-muted" title={id}>
          Equipped · unidentified item <code className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-faint">{id.slice(0, 8)}</code>
        </span>
      ) : (
        <span className="text-xs text-muted">{fallback}</span>
      )}
    </div>
  );
}

function AgentIdTab({ a, d }: { a: AgentMasteryView; d: AgentMasteryDetail | null }) {
  const lt = a.lifetimeLevel ?? 0;
  const frame = lt >= 30 ? 4 : lt >= 20 ? 3 : lt >= 10 ? 2 : 1;
  const slots = d?.stats.slots ?? [];
  return (
    <div className="grid grid-cols-[minmax(240px,320px)_minmax(0,1fr)] gap-4">
      {/* Read-only preview: Riot's art for poses/backgrounds/frames isn't public, so this uses the agent's own art. */}
      <div className="relative aspect-[3/4.4] overflow-hidden rounded-[28px] bg-surface ring-1 ring-white/[0.1]">
        <div aria-hidden className="absolute inset-0" style={{ background: `linear-gradient(180deg, ${agentGlow(a, 0.5)}, #050506 75%)` }} />
        {a.background && <Img src={img(a.background)} alt="" className="absolute inset-0 h-full w-full object-cover opacity-[0.18]" />}
        {a.portrait && <Img src={img(a.portrait)} alt="" className="absolute bottom-[96px] left-1/2 h-[78%] max-w-none -translate-x-1/2 object-contain object-bottom" />}
        <div aria-hidden className={cx('pointer-events-none absolute inset-2 rounded-[22px]', frame >= 4 ? 'ring-2 ring-white' : frame >= 3 ? 'ring-2 ring-white/60' : frame >= 2 ? 'ring-1 ring-white/45' : 'ring-1 ring-white/15')} />
        <div className="absolute left-4 top-4">
          <LevelBadge level={a.lifetimeLevel} tier={Math.min(4, Math.floor(lt / 8))} />
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/85 to-transparent p-4 pt-10">
          <div className="t-head text-lg text-ink">{a.name}</div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {[0, 1, 2].map((i) => {
              const s = slots[i];
              return (
                <div key={i} className="rounded-xl bg-white/[0.07] px-2 py-1.5">
                  <div className="num truncate text-sm font-semibold text-ink">{s ? fmtNum(s.value) : '–'}</div>
                  <div className="truncate text-[10px] text-muted">{s?.stat?.name ?? (s?.statId ? 'Unidentified stat' : 'Empty')}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <Panel className="px-5 py-2">
          <SlotRow name="Background" id={a.slots.background} fallback="Standard (nothing set)" />
          <SlotRow name="Frame" id={a.slots.border} fallback="Level I (nothing set)" />
          <SlotRow name="Pose or quote (Riot slot “Hype”)" id={a.slots.hype} fallback="Default (nothing set)" />
          <SlotRow name="Pose or quote (Riot slot “Clip”)" id={a.slots.clip} fallback="Default (nothing set)" />
        </Panel>
        <Note>
          A read-only view of what Riot reports as equipped. Riot doesn’t publish names or art for Agent ID items, so equipped items show by id and the preview uses the agent’s standard art, with the frame tier your Lifetime Level allows (I–IV). Change your Agent ID in the game; SexyVal never sends changes.
        </Note>
        {d?.stats.error && <ErrorNote>Stat slots: {d.stats.error}</ErrorNote>}
      </div>
    </div>
  );
}

function StatsTab({ d }: { d: AgentMasteryDetail | null }) {
  if (!d) return <Skeleton className="h-72" />;
  const an = d.analytics;
  const row = (label: string, v: ReactNode) => (
    <div className="flex items-center justify-between border-b border-line py-2 text-sm last:border-b-0">
      <span className="text-muted">{label}</span>
      <span className="num text-ink">{v}</span>
    </div>
  );
  const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);
  const block = (title: string, x: typeof an.sinceLaunch | null) =>
    x && (
      <div>
        <div className="mb-1 text-xs text-muted">{title}</div>
        {row('Matches', fmtNum(x.matches))}
        {row('Games won', fmtNum(x.wins))}
        {row('Win rate', pct(x.winRate))}
        {row('Kills / deaths / assists', `${fmtNum(x.kills)} / ${fmtNum(x.deaths)} / ${fmtNum(x.assists)}`)}
        {row('K/D', x.kd === null ? '–' : x.kd.toFixed(2))}
        {row('Headshot %', x.hsPct === null ? '–' : `${Math.round(x.hsPct)}%`)}
        {row('First bloods', x.firstBloods === null ? '–' : fmtNum(x.firstBloods))}
        {row('Damage', x.damage === null ? '–' : fmtNum(x.damage))}
        {row('Hours played', x.hours.toFixed(1))}
      </div>
    );
  return (
    <div className="flex flex-col gap-4">
      <Panel className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <span className="t-head text-md text-ink">Agent ID stats</span>
          <Source kind="riot" />
          {d.stats.at && <span className="text-xs text-muted">· {ago(d.stats.at)}</span>}
        </div>
        {d.stats.slots.length ? (
          <div className="grid grid-cols-3 gap-3">
            {d.stats.slots.map((s, i) => (
              <div key={i} className="rounded-2xl bg-white/[0.05] p-4">
                <div className="t-title num text-stat text-ink">{fmtNum(s.value)}</div>
                <div className="mt-1 text-xs text-muted" title={s.statId}>
                  {s.stat?.name ?? (s.statId ? `Unidentified stat · ${s.statId.slice(0, 8)}` : 'Empty slot')}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted">{d.stats.error ? `Couldn’t load: ${d.stats.error}` : 'Riot sent no stat slots for this agent.'}</div>
        )}
        <div className="mt-4 flex flex-wrap gap-1.5">
          {d.stats.availability.map(({ def, state }) => (
            <span
              key={def.key}
              title={def.default ? 'Available to every player' : state === 'eligible' ? `Your Lifetime Level unlocks it (Lifetime ${def.unlockLevel}); it still has to be bought` : `Needs Lifetime ${def.unlockLevel} (VALORANT Wiki)`}
              className={cx('rounded-full px-2.5 py-1 text-2xs font-medium', state === 'default' ? 'bg-white/[0.08] text-ink/90' : state === 'eligible' ? 'bg-white/[0.08] text-ink/90 ring-1 ring-white/25' : 'bg-white/[0.03] text-faint')}
            >
              {state === 'locked' && <LockSimple size={9} weight="bold" className="mr-1 inline" />}
              {def.name}
              {!def.default && <span className="ml-1 text-faint">L{def.unlockLevel}</span>}
            </span>
          ))}
        </div>
      </Panel>
      <Panel className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <span className="t-head text-md text-ink">SexyVal analytics</span>
          <Source kind="sexyval" />
        </div>
        {an.sinceLaunch.matches ? (
          <div className="grid grid-cols-2 gap-6">
            {block('Since Agent Mastery launched (13.06)', an.sinceLaunch)}
            {block(d.act ? d.act.label : 'This Act', an.thisAct)}
          </div>
        ) : (
          <div className="text-sm text-muted">No cached matches on this agent since 13.06.</div>
        )}
        <div className="mt-3 text-xs text-faint">
          From the {fmtNum(an.matchesCached)} of your matches SexyVal has cached since 13.06, in modes that earn MP ({pcQueues(an.queues).map((q) => queueName(q)).join(', ')}). A lower bound, not Riot’s mastery stats, and never used to estimate Mastery Points.
        </div>
      </Panel>
    </div>
  );
}

function Detail({ puuid, a, syncedAt, onBack }: { puuid: string; a: AgentMasteryView; syncedAt?: number; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const { d, error } = useAgentDetail(puuid, a.id, syncedAt);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <Btn tone="ghost" onClick={onBack}>
          <CaretLeft size={14} weight="bold" /> All agents
        </Btn>
        <Segmented value={tab} options={TABS} onChange={setTab} size="sm" />
      </div>
      <Hero a={a} d={d} compact={tab !== 'overview'} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {a.state === 'unknown' && <Note>No mastery data for this account yet. It appears after the first successful sync with Riot.</Note>}
      {tab === 'overview' && <Overview a={a} d={d} />}
      {tab === 'act' && <ActTab a={a} d={d} />}
      {tab === 'lifetime' && <LifetimeTab a={a} />}
      {tab === 'rewards' && <RewardsTab a={a} d={d} />}
      {tab === 'agentid' && <AgentIdTab a={a} d={d} />}
      {tab === 'stats' && <StatsTab d={d} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------

export function MasteryScreen({ myPuuid }: { myPuuid?: string }) {
  // Without a live session, show the last account's saved copy (main only serves it if one was saved).
  const [lastPuuid] = useState(() => store.get(LAST_KEY) ?? undefined);
  const puuid = myPuuid ?? lastPuuid;
  useEffect(() => {
    if (myPuuid) store.set(LAST_KEY, myPuuid);
  }, [myPuuid]);
  const { view, error, busy, refresh } = useMastery(puuid);
  const [sort, setSort] = useState<SortKey>(() => (['act', 'lifetime', 'name'].includes(store.get(SORT_KEY) ?? '') ? (store.get(SORT_KEY) as SortKey) : 'lifetime'));
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setOpen(null), [puuid]);
  const agents = useMemo(() => (view ? sortAgents(view.agents, sort) : []), [view, sort]);
  const sel = open ? view?.agents.find((a) => a.id === open) : undefined;
  const go = (id: string | null) => withViewTransition(() => setOpen(id));
  const played = view?.agents.filter((a) => a.state === 'progress').length ?? 0;

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-7 xl:px-8">
      <PageHeader
        title="Agent Mastery"
        right={
          view && (
            <div className="flex items-center gap-3">
              <SyncLine v={view} busy={busy} />
              {!sel && <Segmented value={sort} options={[['act', 'Act'], ['lifetime', 'Lifetime'], ['name', 'Name']]} onChange={(s) => (setSort(s), store.set(SORT_KEY, s))} size="sm" />}
              {myPuuid && (
                <Btn size="sm" onClick={() => void refresh()} disabled={busy || view.status === 'loading'} title="Ask Riot again">
                  <ArrowClockwise size={14} weight="bold" />
                </Btn>
              )}
            </div>
          )
        }
      />
      {!puuid && <Note>Needs your account: start the Riot Client or sign in (Settings › Accounts). Valorant can stay closed.</Note>}
      {error && !view && <ErrorNote>{error === 'Not signed in' ? 'Start the Riot Client or sign in to load Agent Mastery.' : error}</ErrorNote>}
      {puuid && !view && !error && <Skeleton className="h-[420px]" />}
      {view && (
        <div className="flex flex-col gap-4">
          {!myPuuid && (
            <Note>
              <span className="inline-flex items-center gap-2">
                <Cloud size={15} /> Offline: the saved copy from {view.syncedAt ? new Date(view.syncedAt).toLocaleString() : 'earlier'}.
              </span>
            </Note>
          )}
          {view.actChanged && <Note>A new Act started since the last sync ({view.actChanged.from}). Riot reset every Act Level; Lifetime Levels carry over.</Note>}
          {view.status === 'error' && view.source !== 'none' && <ErrorNote>Riot didn’t answer ({view.error}). Showing the copy saved {view.syncedAt ? ago(view.syncedAt) : 'earlier'}.</ErrorNote>}
          {view.status === 'error' && view.source === 'none' && <ErrorNote>{view.error}</ErrorNote>}
          {sel ? (
            <Detail puuid={view.puuid} a={sel} syncedAt={view.syncedAt} onBack={() => go(null)} />
          ) : (
            <>
              {view.source !== 'none' && (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted">
                  {view.act && <span className="text-ink/90">{view.act.label}</span>}
                  {view.act && <span>Ends {new Date(view.act.end).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}
                  <span>
                    {played} of {view.agents.length} agents played
                  </span>
                  {pcQueues(view.queues?.processed).length ? <span title="Riot’s list of queues that earn Mastery Points">Earns MP in {pcQueues(view.queues?.processed).map((q) => queueName(q)).join(', ')}</span> : null}
                </div>
              )}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(158px,1fr))] gap-3">
                {agents.map((a) => (
                  <AgentCard key={a.id} a={a} onOpen={() => go(a.id)} />
                ))}
              </div>
              {!agents.length && <Note>Agent list isn’t loaded yet (valorant-api.com).</Note>}
              <div className="flex items-start gap-2 text-xs text-faint">
                <Question size={14} className="mt-px shrink-0" />
                <span>
                  Levels and Mastery Points come from Riot’s own mastery service. Riot doesn’t document it, so the field meanings follow community research and SexyVal checks every answer. How MP is earned:{' '}
                  <a className="underline decoration-white/20 underline-offset-2 hover:text-muted" href={GUIDE_URL} target="_blank" rel="noreferrer">
                    Riot’s guide
                  </a>
                  .
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
