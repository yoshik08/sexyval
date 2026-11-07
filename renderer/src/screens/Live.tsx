import { useEffect, useLayoutEffect, useRef } from 'react';
import type { AppState, CoreGameView, LiveDensity, PlayerRow, PregameView, QueueView } from '../../../shared/types';
import { clock, cx, kd, useNow } from '../lib/format';
import { ArrowRight, Lock } from '../lib/icons';
import { lockIn, staggerIn } from '../lib/motion';
import { saveSettings, useSettings } from '../lib/store';
import { Btn } from '../components/kit';
import { Img, Last5Pips, Panel, SectionTitle, Segmented, SideBadge, Skeleton, tint } from '../components/ui';
import { ExpandPanel, isHidden, PartyBar, PartyChip, PlayerDetail, RankPair, rowHandlers, ScoreBadge, useDensity, useExpansion } from '../components/players';

export function LiveScreen({ state, onLoadout }: { state: AppState | null; onLoadout: () => void }) {
  if (!state) return <Waiting message="Starting…" />;
  const { conn, phase } = state;
  if (conn.status === 'waiting' || conn.status === 'connecting') return <Waiting message={conn.message} />;
  // Only Live needs the game process; every other tab works from tokens alone.
  if (!conn.valorant) return <Waiting message="Valorant is closed. Store, Collection, Loadout, Missions, Profiles and Hub still work." />;
  if (phase === 'pregame' && state.pregame) return <AgentSelect v={state.pregame} onLoadout={onLoadout} />;
  if (phase === 'ingame' && state.coregame) return <InGame v={state.coregame} />;
  return <Idle state={state} />;
}

/** Compact / Detailed (and Auto) for the player rows, remembered in settings. */
function DensityToggle() {
  const s = useSettings();
  return (
    <Segmented<LiveDensity>
      size="sm"
      value={s?.liveDensity ?? 'auto'}
      options={[
        ['auto', 'Auto'],
        ['compact', 'Compact'],
        ['detailed', 'Detailed'],
      ]}
      onChange={(v) => void saveSettings({ liveDensity: v })}
    />
  );
}

function QueueBanner({ q }: { q: QueueView }) {
  const now = useNow(1000);
  const secs = q.enteredAt ? Math.max(0, (now - q.enteredAt) / 1000) : null;
  return (
    <Panel className="mb-6 flex items-center justify-between gap-6 px-6 py-5">
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="pulse-dot h-2.5 w-2.5 shrink-0 rounded-full bg-win" />
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="t-head text-lg text-ink">In queue · {q.queueName}</span>
            {q.rrPenalty != null && q.rrPenalty > 0 && (
                  <span data-rr-penalty className="rounded-full bg-loss/[0.14] px-2.5 py-1 text-2xs font-semibold text-loss" title="Riot’s RR penalty for this party (SkillDisparityRRPenalty): every player earns and loses this much less RR">
                    RR −{Math.round(q.rrPenalty * 100)}%
                  </span>
                )}
          </div>
          <div className="text-pretty mt-0.5 text-sm text-muted">Agent select opens here the moment a match is found.</div>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div data-queue-time className="t-num text-[40px] leading-none text-ink">{secs != null ? clock(secs) : '--'}</div>
        <div className="mt-1.5 text-xs text-muted">in queue</div>
      </div>
    </Panel>
  );
}

function Waiting({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 pb-10 text-center">
      <svg viewBox="0 0 120 120" className="h-32 w-32" aria-hidden>
        <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.1)" />
        <circle cx="60" cy="60" r="34" fill="none" stroke="rgba(255,255,255,0.08)" />
        <circle cx="60" cy="60" r="16" fill="none" stroke="rgba(255,255,255,0.07)" />
        <circle className="radar-ping" cx="60" cy="60" r="40" fill="none" stroke="rgba(255,255,255,0.55)" />
        <g className="radar-sweep">
          <path d="M60 60 L60 8 A52 52 0 0 1 104 34 Z" fill="url(#sweep)" />
        </g>
        <circle cx="60" cy="60" r="3" fill="#fff" />
        <defs>
          <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="rgba(255,255,255,0.28)" />
            <stop offset="1" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
        </defs>
      </svg>
      <h1 className="t-title mt-8 text-[30px]">Waiting for Valorant</h1>
      <p className="text-pretty mt-2.5 max-w-sm text-md text-muted">{message}</p>
      <p className="mt-1.5 text-sm text-faint">Checking every few seconds. Start the game and this page fills in by itself.</p>
    </div>
  );
}

// ---------------- Idle ----------------

function Idle({ state }: { state: AppState }) {
  const me = state.me;
  return (
    <div className="mx-auto max-w-[1180px] px-6 xl:px-10 pb-16 pt-6">
      <div className="mb-8 flex items-end justify-between gap-8">
        <h1 className="t-title text-page">
          {me?.name ?? <Skeleton className="h-9 w-48" />}
          {me?.tag && <span className="ml-2 text-faint">#{me.tag}</span>}
        </h1>
        <p className="max-w-xs text-right text-sm text-muted">{state.phase === 'queue' ? 'Searching for a match.' : 'You are in the menus. Agent select and live matches show up here on their own.'}</p>
      </div>
      {state.phase === 'queue' && state.queue && <QueueBanner q={state.queue} />}
      <div className="grid grid-cols-[minmax(0,1fr)_clamp(260px,26vw,340px)] items-start gap-5 xl:gap-6">
        <Panel>
          <div className="flex items-center justify-between px-6 pb-2 pt-5">
            <h2 className="t-head text-md">Last five matches</h2>
            {me?.last5.summary && (
              <span className="num text-sm text-muted">
                <span className="text-win">{me.last5.summary.wins}W</span> <span className="text-loss">{me.last5.summary.losses}L</span> · K/D <span className="text-ink">{kd(me.last5.summary.kd)}</span> · ACS <span className="text-ink">{me.last5.summary.acs}</span>
              </span>
            )}
          </div>
          <div className="px-3 pb-3">
            {me && me.last5.matches.length
              ? me.last5.matches.map((m) => (
                  <div key={m.matchId} className="grid grid-cols-[6px_40px_minmax(0,1fr)_76px_64px_52px] items-center gap-3 xl:gap-3.5 rounded-2xl px-3 py-2.5 hover:bg-white/[0.04]">
                    <span className={cx('h-8 w-1.5 rounded-full', m.result === 'W' ? 'bg-win' : m.result === 'L' ? 'bg-loss' : 'bg-faint')} />
                    <Img src={m.agent?.icon} alt={m.agent?.name ?? ''} className="h-10 w-10 rounded-xl bg-white/5" />
                    <div className="min-w-0">
                      <div className="truncate text-md font-semibold">{m.map ?? 'Unknown'}</div>
                      <div className="truncate text-xs text-muted">
                        {m.agent?.name ?? '—'} · {m.queueTag}
                      </div>
                    </div>
                    <div className="num text-right text-sm">
                      {m.kills}/{m.deaths}/{m.assists}
                    </div>
                    <div className="num text-right text-sm text-muted">{m.acs} ACS</div>
                    <div className={cx('t-num text-right text-md', m.result === 'W' ? 'text-win' : m.result === 'L' ? 'text-loss' : 'text-muted')}>{m.score}</div>
                  </div>
                ))
              : Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-3">
                    {me?.last5.status === 'done' ? (
                      i === 0 ? <span className="text-sm text-muted">No recent matches.</span> : null
                    ) : (
                      <>
                        <Skeleton className="h-10 w-10 rounded-xl" />
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="ml-auto h-4 w-16" />
                      </>
                    )}
                  </div>
                ))}
          </div>
        </Panel>
        <Panel className="p-6">
          <h2 className="t-head text-md">Starting side</h2>
          <p className="text-pretty mt-2 text-sm text-muted">
            <span className="text-ink">Red attacks first, Blue defends first.</span> Agent select shows your side, and the overlay can show it over the game.
          </p>
          <p className="mt-3 text-xs text-faint">Checked on competitive matches; other spike queues are assumed to match.</p>
        </Panel>
      </div>
    </div>
  );
}

// ---------------- Agent select ----------------

function PhaseTimer({ endsAt }: { endsAt?: number }) {
  const now = useNow(250);
  if (!endsAt) return <span className="t-num text-[48px] leading-none text-faint">--</span>;
  const secs = Math.ceil(Math.max(0, endsAt - now) / 1000);
  return <span className={cx('t-num text-[56px] leading-none', secs <= 10 ? 'text-warn' : 'text-ink')}>{secs}</span>;
}

function AllyCard({ p, open, x }: { p: PlayerRow; open: boolean; x: ReturnType<typeof useExpansion> }) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef(p.selectionState);
  useEffect(() => {
    if (p.selectionState === 'locked' && prev.current !== 'locked') lockIn(ref.current);
    prev.current = p.selectionState;
  }, [p.selectionState]);
  const locked = p.selectionState === 'locked';
  const picking = p.selectionState === 'selected';
  const hidden = isHidden(p);
  return (
    <div
      ref={ref}
      data-row
      {...rowHandlers(p.puuid, open, x, !hidden)}
      className={cx(
        'relative flex flex-col overflow-hidden rounded-[26px] bg-surface ring-1 ring-inset transition-shadow duration-[420ms] ease-out',
        locked ? 'ring-def/45' : 'ring-white/[0.07]',
        p.isMe && 'shadow-[0_0_0_1px_rgba(255,255,255,0.28)]',
        !hidden && 'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-white/60',
      )}
    >
      <div className="relative h-[208px] overflow-hidden" style={{ background: locked ? `radial-gradient(ellipse 80% 70% at 50% 85%, ${tint('#5ad8c6', 0.22)}, transparent 70%)` : 'linear-gradient(to bottom, rgba(255,255,255,0.04), transparent)' }}>
        {p.agent?.portrait ? (
          <Img src={p.agent.portrait} alt={p.agent.name} className={cx('absolute left-1/2 top-2 h-[310px] max-w-none -translate-x-1/2 object-cover object-top transition-[filter,opacity] duration-[420ms]', !locked && 'opacity-60 saturate-50')} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <span className="text-sm text-faint">Choosing…</span>
          </div>
        )}
        <div data-portrait className="absolute inset-0" />
        <div data-flash className="pointer-events-none absolute inset-0 bg-def opacity-0 mix-blend-screen" />
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface to-transparent" />
        <span className={cx('absolute left-3.5 top-3.5 rounded-full px-2.5 py-1 text-xs font-semibold', locked ? 'bg-white text-black' : picking ? 'bg-white/15 text-ink' : 'bg-black/40 text-faint')}>{locked ? 'Locked' : picking ? 'Picking' : 'Waiting'}</span>
        {p.isMe && <span className="absolute right-3.5 top-3.5 rounded-full bg-white/15 px-2.5 py-1 text-xs font-semibold text-ink">You</span>}
        <PartyBar p={p} />
      </div>
      <div className="flex flex-1 flex-col gap-2.5 px-4 pb-4">
        <div className="min-w-0">
          <div className="t-head truncate text-[19px]">{p.agent?.name ?? '—'}</div>
          <div className="truncate text-sm text-muted" title={!hidden && p.name ? `${p.name}#${p.tag}` : undefined}>
            {hidden ? <span className="italic text-faint">Hidden</span> : p.name ? <>{p.name}<span className="text-faint">#{p.tag}</span></> : <Skeleton className="mt-1 h-3.5 w-24" />}
          </div>
          {hidden && p.accountLevel != null && <div className="text-xs text-faint">Level {p.accountLevel}</div>}
          {p.partyGroup && <div className="mt-1.5"><PartyChip p={p} /></div>}
        </div>
        <div className="mt-auto flex flex-col gap-2.5 border-t border-white/[0.07] pt-3">
          <div className="flex items-center justify-between gap-2">
            <RankPair p={p} open={open} />
            <ScoreBadge p={p} />
          </div>
          <Last5Pips last5={p.last5} size="sm" />
        </div>
        {!hidden && (
          <ExpandPanel open={open}>
            <PlayerDetail p={p} narrow open={open} />
          </ExpandPanel>
        )}
      </div>
    </div>
  );
}

function AgentSelect({ v, onLoadout }: { v: PregameView; onLoadout: () => void }) {
  const grid = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const s = useSettings();
  const density = useDensity(s?.liveDensity ?? 'auto', root, v.allies.length, false);
  const x = useExpansion(density);
  useLayoutEffect(() => staggerIn(grid.current), [v.matchId]);
  return (
    <div ref={root} className="flex min-h-full flex-col">
      <div className="relative h-[232px] shrink-0 overflow-hidden">
        <Img src={v.map?.splash} alt={v.map?.name ?? ''} className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/80 to-black/20" />
        <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black to-transparent" />
        <div className="relative flex h-full items-end justify-between px-6 xl:px-10 pb-7">
          <div className="min-w-0">
            <h1 className="t-display text-hero">{v.map?.name ?? 'Unknown map'}</h1>
            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <Chip strong>Agent select</Chip>
              <Chip>{v.modeName}</Chip>
              <Chip>{v.queueTag}</Chip>
              <Chip>Team {v.allyTeamId || '?'}</Chip>
            </div>
          </div>
          <div className="flex shrink-0 items-end gap-6 xl:gap-8">
            <div className="text-right">
              <PhaseTimer endsAt={v.phaseEndsAt} />
              <div className="mt-1.5 text-xs text-muted">seconds left</div>
            </div>
            <div className="flex flex-col items-end gap-2.5">
              <SideBadge side={v.side} large />
              <Btn size="sm" tone="ghost" onClick={onLoadout}>
                Loadout and skins <ArrowRight size={13} weight="bold" />
              </Btn>
            </div>
          </div>
        </div>
      </div>

      <div className="px-6 xl:px-10 pb-10 pt-7">
        <SectionTitle right={<DensityToggle />}>Your team</SectionTitle>
        <div ref={grid} className="grid grid-cols-5 items-start gap-3 xl:gap-4">
          {v.allies.map((p) => (
            <AllyCard key={p.puuid} p={p} open={!isHidden(p) && x.isOpen(p.puuid)} x={x} />
          ))}
        </div>

        <div className="mt-7 flex items-center justify-between rounded-[26px] bg-surface px-6 py-5 ring-1 ring-inset ring-white/[0.07]">
          <div>
            <div className="t-head text-md">Enemy team</div>
            <div className="mt-1 text-sm text-muted">Identities stay hidden until the match loads.</div>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex gap-2">
              {Array.from({ length: Math.max(v.enemySize, 1) }, (_, i) => (
                <div key={i} className={cx('flex h-11 w-9 items-center justify-center rounded-xl transition-colors duration-[320ms] ease-out', i < v.enemyLocked ? 'bg-atk/20 text-atk' : 'bg-white/[0.05] text-transparent')}>
                  <Lock size={15} weight="fill" />
                </div>
              ))}
            </div>
            <div className="t-num w-[96px] text-right text-[26px]">
              {v.enemyLocked}/{v.enemySize}
              <span className="ml-1.5 text-xs font-normal text-muted">locked</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Chip({ children, strong }: { children: React.ReactNode; strong?: boolean }) {
  return <span className={cx('rounded-full px-3 py-1 text-xs font-semibold', strong ? 'bg-white text-black' : 'bg-white/[0.12] text-ink')}>{children}</span>;
}

// ---------------- In game ----------------

const COLS = 'ig-cols';

/** Compact line: agent, name#tag, current + peak rank, SV Score, last-5 pips. Everything else is in tooltips or the expanded panel. */
function PlayerLine({ p, open, x, enemy }: { p: PlayerRow; open: boolean; x: ReturnType<typeof useExpansion>; enemy?: boolean }) {
  const hidden = isHidden(p);
  return (
    <div
      data-row
      {...rowHandlers(p.puuid, open, x, !hidden)}
      className={cx('relative mx-2 rounded-2xl px-2.5 py-2 outline-none transition-colors duration-160', p.isMe && 'bg-white/[0.05]', !hidden && 'cursor-pointer hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/50', open && !p.isMe && 'bg-white/[0.03]')}
    >
      <PartyBar p={p} />
      <div className={COLS}>
        <div className="flex min-w-0 items-center gap-3">
          <Img src={p.agent?.icon} alt={p.agent?.name ?? ''} className="h-9 w-9 shrink-0 rounded-xl bg-white/5" fallback={<div className="h-9 w-9 shrink-0 rounded-xl bg-white/5" />} />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
              <span className="min-w-0 truncate" title={!hidden && p.name ? `${p.name}#${p.tag}` : undefined}>
                {hidden ? (
                  <span className="italic text-faint">Hidden</span>
                ) : p.name ? (
                  <>
                    {p.name}
                    <span className="text-faint">#{p.tag}</span>
                  </>
                ) : (
                  <Skeleton className="h-3.5 w-28" />
                )}
              </span>
              {p.isMe && <span className="shrink-0 rounded-full bg-white/15 px-2 py-0.5 text-2xs font-semibold text-ink">You</span>}
              <PartyChip p={p} enemy={enemy} />
            </div>
            <div className="truncate text-xs text-muted">
              {p.agent?.name ?? '—'}
              {p.accountLevel != null && <span className="text-faint"> · Lv {p.accountLevel}</span>}
            </div>
          </div>
        </div>
        <RankPair p={p} open={open} />
        <ScoreBadge p={p} className="justify-self-end" />
        <Last5Pips last5={p.last5} />
      </div>
      {!hidden && (
        <ExpandPanel open={open}>
          <PlayerDetail p={p} open={open} />
        </ExpandPanel>
      )}
    </div>
  );
}

function TeamColumn({ title, rows, tone, density }: { title: string; rows: PlayerRow[]; tone: 'ally' | 'enemy'; density: 'compact' | 'detailed' }) {
  const x = useExpansion(density);
  return (
    <Panel className="ig-team overflow-visible">
      <div className="flex items-center gap-2.5 px-5 pb-2 pt-5">
        <span className={cx('h-2.5 w-2.5 rounded-full', tone === 'ally' ? 'bg-def' : 'bg-atk')} />
        <h2 className="t-head text-md">{title}</h2>
      </div>
      <div className={cx(COLS, 'mx-2 px-2.5 py-1.5 text-xs text-faint')}>
        <span>Player</span>
        <span title="Current rank · peak">Rank</span>
        <span className="text-right">SV</span>
        <span>Last 5</span>
      </div>
      <div className="pb-2">{rows.length ? rows.map((p) => <PlayerLine key={p.puuid} p={p} open={!isHidden(p) && x.isOpen(p.puuid)} x={x} enemy={tone === 'enemy'} />) : <div className="px-5 py-6 text-sm text-muted">No players reported.</div>}</div>
    </Panel>
  );
}

function InGame({ v }: { v: CoreGameView }) {
  const wrap = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const s = useSettings();
  const density = useDensity(s?.liveDensity ?? 'auto', root, v.myTeam.length + v.enemyTeam.length, true);
  useLayoutEffect(() => staggerIn(wrap.current), [v.matchId]);
  return (
    <div ref={root} className="flex min-h-full flex-col">
      <div className="relative h-[120px] shrink-0 overflow-hidden">
        <Img src={v.map?.splash} alt="" className="absolute inset-0 h-full w-full object-cover opacity-60" />
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/85 to-black/30" />
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black to-transparent" />
        <div className="relative flex h-full items-end justify-between px-6 xl:px-10 pb-5">
          <h1 className="t-display text-hero-sm">{v.map?.name ?? 'Unknown map'}</h1>
          <div className="flex items-center gap-2">
            <Chip strong>In game</Chip>
            <Chip>{v.modeName}</Chip>
            <Chip>{v.queueTag}</Chip>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 px-6 pt-5 xl:px-8">
        <p className="text-xs text-faint">Click a player for ranks, SV Score, their last five, lifetime stats and estimated MMR. Hidden players are not looked up.</p>
        <DensityToggle />
      </div>
      <div ref={wrap} className="grid grid-cols-2 items-start gap-4 px-6 py-5 xl:gap-5 xl:px-8">
        <TeamColumn title="Your team" rows={v.myTeam} tone="ally" density={density} />
        <TeamColumn title="Enemy team" rows={v.enemyTeam} tone="enemy" density={density} />
      </div>
      <p className="px-6 xl:px-10 pb-8 text-xs text-faint">SV Score is SexyVal’s own 0–1000 rating from the last five matches (ACS, K/D, ADR, HS%, first bloods, wins). It is not Tracker Score.</p>
    </div>
  );
}
