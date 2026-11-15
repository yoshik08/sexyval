// 2D replays from Riot's match details. Valorant's own .vrf replay files are an undocumented binary format,
// so SexyVal can list them but not decode them. Match details, though, record every player's position at
// every kill (and at the plant and defuse): enough to redraw each round on the minimap, with players
// moving between those snapshots. Pure: no I/O, no clocks.

/** A position on the minimap, 0..1 on both axes (already transformed from game units). */
export interface Pt {
  x: number;
  y: number;
}

export interface ReplayPlayer {
  puuid: string;
  teamId: string;
  name?: string;
  tag?: string;
  agentId?: string;
  kills: number;
  deaths: number;
  assists: number;
}

export interface ReplayKill {
  /** ms since the round started. */
  t: number;
  killer?: string;
  victim: string;
  assistants: string[];
  /** Weapon uuid (lowercase) or an ability slot ("Ability1", "Ultimate"…). */
  weapon?: string;
  damageType?: string;
  victimAt?: Pt;
  killerAt?: Pt;
  /** Everyone alive at that moment (victim and killer included when Riot sends them). */
  positions: Record<string, Pt & { view?: number }>;
  /** This kill avenged a teammate who died within TRADE_WINDOW ms. */
  trade?: boolean;
  /** The killer's nth kill this round (2+ = multi-kill). */
  streak: number;
}

export interface ReplayBombEvent {
  t: number;
  player?: string;
  at?: Pt;
  site?: string;
  positions: Record<string, Pt & { view?: number }>;
}

export interface ReplayRound {
  n: number;
  winningTeam?: string;
  /** "Eliminated", "Bomb detonated", "Bomb defused", "Round timer expired", "Surrendered". */
  result?: string;
  kills: ReplayKill[];
  plant?: ReplayBombEvent;
  defuse?: ReplayBombEvent;
  /** Last event time + a short tail. */
  length: number;
  /** Attacking team this round (from the planter, or the half). */
  attackers?: string;
}

export interface ReplayData {
  matchId: string;
  mapId?: string;
  queueId?: string;
  startTime: number;
  players: ReplayPlayer[];
  teams: { teamId: string; won: boolean; roundsWon: number }[];
  rounds: ReplayRound[];
  /** False when the match carried no per-round positions (deathmatch, very old matches). */
  hasPositions: boolean;
}

export interface MapTransform {
  xm: number;
  ym: number;
  xa: number;
  ya: number;
}

/** A kill within this long after a teammate's death, on that teammate's killer, is a trade. */
export const TRADE_WINDOW = 5000;
const TAIL = 4000;

/** Game units -> minimap 0..1 (valorant-api.com's documented transform: the axes swap). */
export function toMinimap(loc: { x: number; y: number } | undefined, tf: MapTransform | undefined): Pt | undefined {
  if (!loc || !tf || !Number.isFinite(loc.x) || !Number.isFinite(loc.y)) return undefined;
  return { x: loc.y * tf.xm + tf.xa, y: loc.x * tf.ym + tf.ya };
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const lc = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : undefined);

function positionsOf(list: unknown, tf: MapTransform | undefined): Record<string, Pt & { view?: number }> {
  const out: Record<string, Pt & { view?: number }> = {};
  for (const p of Array.isArray(list) ? list : []) {
    const at = toMinimap(p?.location, tf);
    if (typeof p?.subject === 'string' && at) out[p.subject] = { ...at, view: typeof p.viewRadians === 'number' ? p.viewRadians : undefined };
  }
  return out;
}

function rawKill(k: any, tf: MapTransform | undefined): Omit<ReplayKill, 'streak'> | null {
  if (!k || typeof k.victim !== 'string') return null;
  const positions = positionsOf(k.playerLocations, tf);
  const victimAt = toMinimap(k.victimLocation, tf);
  if (victimAt) positions[k.victim] ??= victimAt;
  const killer = typeof k.killer === 'string' && k.killer ? k.killer : undefined;
  return {
    t: n(k.roundTime ?? k.timeSinceRoundStartMillis),
    killer,
    victim: k.victim,
    assistants: (Array.isArray(k.assistants) ? k.assistants : []).filter((a: unknown): a is string => typeof a === 'string'),
    weapon: lc(k.finishingDamage?.damageItem) || undefined,
    damageType: typeof k.finishingDamage?.damageType === 'string' ? k.finishingDamage.damageType : undefined,
    victimAt,
    killerAt: killer ? positions[killer] : undefined,
    positions,
  };
}

/**
 * Raw match-details JSON -> replay. Kills come from the top-level `kills` list when Riot sends one (it has a
 * `round` field), else from roundResults[].playerStats[].kills; never both, they're the same kills.
 */
export function buildReplay(raw: any, tf: MapTransform | undefined): ReplayData {
  const info = raw?.matchInfo ?? {};
  const playersRaw: any[] = Array.isArray(raw?.players) ? raw.players : [];
  const roundsRaw: any[] = Array.isArray(raw?.roundResults) ? raw.roundResults : [];
  const team = new Map<string, string>(playersRaw.filter((p) => typeof p?.subject === 'string').map((p) => [p.subject, String(p.teamId ?? '')]));
  const topKills: any[] = Array.isArray(raw?.kills) ? raw.kills : [];
  const byRound = new Map<number, any[]>();
  if (topKills.length) for (const k of topKills) byRound.set(n(k?.round), [...(byRound.get(n(k?.round)) ?? []), k]);
  else for (const r of roundsRaw) byRound.set(n(r?.roundNum), (Array.isArray(r?.playerStats) ? r.playerStats : []).flatMap((ps: any) => (Array.isArray(ps?.kills) ? ps.kills : [])));

  let hasPositions = false;
  const rounds: ReplayRound[] = roundsRaw.map((r) => {
    const num = n(r?.roundNum);
    const ks = (byRound.get(num) ?? []).map((k) => rawKill(k, tf)).filter((k): k is Omit<ReplayKill, 'streak'> => !!k).sort((a, b) => a.t - b.t);
    const streak = new Map<string, number>();
    const deaths: { t: number; victim: string; killer?: string }[] = [];
    const kills: ReplayKill[] = ks.map((k) => {
      if (Object.keys(k.positions).length) hasPositions = true;
      const s = k.killer ? (streak.get(k.killer) ?? 0) + 1 : 0;
      if (k.killer) streak.set(k.killer, s);
      // Trade: the victim recently killed someone on the killer's team.
      const trade = !!k.killer && deaths.some((d) => d.killer === k.victim && team.get(d.victim) === team.get(k.killer!) && d.victim !== k.killer && k.t - d.t <= TRADE_WINDOW);
      deaths.push({ t: k.t, victim: k.victim, killer: k.killer });
      return { ...k, streak: s, trade };
    });
    const bomb = (t: unknown, player: unknown, loc: unknown, site: unknown, locs: unknown): ReplayBombEvent | undefined => {
      const time = n(t);
      if (!time && !player) return undefined;
      return { t: time, player: typeof player === 'string' && player ? player : undefined, at: toMinimap(loc as any, tf), site: typeof site === 'string' && site ? site : undefined, positions: positionsOf(locs, tf) };
    };
    const plant = r?.bombPlanter || n(r?.plantRoundTime) ? bomb(r.plantRoundTime, r.bombPlanter, r.plantLocation, r.plantSite, r.plantPlayerLocations) : undefined;
    const defuse = r?.bombDefuser || n(r?.defuseRoundTime) ? bomb(r.defuseRoundTime, r.bombDefuser, r.defuseLocation, undefined, r.defusePlayerLocations) : undefined;
    const last = Math.max(0, ...kills.map((k) => k.t), plant?.t ?? 0, defuse?.t ?? 0);
    return {
      n: num,
      winningTeam: typeof r?.winningTeam === 'string' ? r.winningTeam : undefined,
      result: typeof r?.roundResult === 'string' ? r.roundResult : undefined,
      kills,
      plant,
      defuse,
      length: last + TAIL,
      attackers: plant?.player ? team.get(plant.player) : undefined,
    };
  });
  // Attackers for rounds without a plant: same as the nearest planted round in the same half.
  const half = (i: number) => (i < 12 ? 0 : i < 24 ? 1 : 2 + (i % 2));
  for (const r of rounds) {
    if (r.attackers) continue;
    const ref = rounds.find((x) => x.attackers && half(x.n) === half(r.n));
    if (ref) r.attackers = ref.attackers;
  }

  const players: ReplayPlayer[] = playersRaw
    .filter((p) => typeof p?.subject === 'string')
    .map((p) => ({
      puuid: p.subject,
      teamId: String(p.teamId ?? ''),
      name: typeof p.gameName === 'string' && p.gameName ? p.gameName : undefined,
      tag: typeof p.tagLine === 'string' && p.tagLine ? p.tagLine : undefined,
      agentId: lc(p.characterId),
      kills: n(p.stats?.kills),
      deaths: n(p.stats?.deaths),
      assists: n(p.stats?.assists),
    }));
  return {
    matchId: String(info.matchId ?? ''),
    mapId: typeof info.mapId === 'string' ? info.mapId : undefined,
    queueId: info.queueID ?? info.queueId ?? undefined,
    startTime: n(info.gameStartMillis),
    players,
    teams: (Array.isArray(raw?.teams) ? raw.teams : []).map((t: any) => ({ teamId: String(t.teamId), won: !!t.won, roundsWon: n(t.roundsWon) })),
    rounds,
    hasPositions,
  };
}

// ---------------- playback ----------------

export interface Snapshot {
  t: number;
  positions: Record<string, Pt & { view?: number }>;
}

/** Every moment in a round where Riot recorded positions, in time order. */
export function snapshots(r: ReplayRound): Snapshot[] {
  const out: Snapshot[] = r.kills.map((k) => ({ t: k.t, positions: k.positions }));
  if (r.plant && Object.keys(r.plant.positions).length) out.push({ t: r.plant.t, positions: r.plant.positions });
  if (r.defuse && Object.keys(r.defuse.positions).length) out.push({ t: r.defuse.t, positions: r.defuse.positions });
  return out.sort((a, b) => a.t - b.t);
}

export interface PlayerFrame extends Pt {
  alive: boolean;
  /** No snapshot before or after `t` to move from/to: this is the nearest known spot. */
  estimated: boolean;
  view?: number;
}

/**
 * Where each player is at time t: linear between the two recorded positions around t, held at the
 * nearest one outside them, and fixed where they died once dead.
 */
export function frameAt(r: ReplayRound, snaps: Snapshot[], puuids: string[], t: number): Record<string, PlayerFrame> {
  const out: Record<string, PlayerFrame> = {};
  for (const p of puuids) {
    const death = r.kills.find((k) => k.victim === p);
    if (death && t >= death.t) {
      const at = death.victimAt ?? death.positions[p];
      if (at) out[p] = { ...at, alive: false, estimated: false };
      continue;
    }
    let before: Snapshot | undefined;
    let after: Snapshot | undefined;
    for (const s of snaps) {
      if (!s.positions[p]) continue;
      if (s.t <= t) before = s;
      else {
        after = s;
        break;
      }
    }
    if (death && death.t > t && (!after || death.t < after.t)) {
      const at = death.victimAt ?? death.positions[p];
      if (at) after = { t: death.t, positions: { [p]: at } };
    }
    const a = before?.positions[p];
    const b = after?.positions[p];
    if (a && b && after!.t > before!.t) {
      const k = (t - before!.t) / (after!.t - before!.t);
      out[p] = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, view: b.view ?? a.view, alive: true, estimated: false };
    } else if (a || b) {
      const c = (a ?? b)!;
      out[p] = { x: c.x, y: c.y, view: c.view, alive: true, estimated: !a || !b };
    }
  }
  return out;
}

// ---------------- events (skip to…) ----------------

export type EventKind = 'kill' | 'death' | 'assist' | 'trade' | 'multikill' | 'ace' | 'plant' | 'defuse' | 'clutch';

export interface ReplayEvent {
  round: number;
  t: number;
  kind: EventKind;
  /** The player the event is about (killer, victim, assister, planter…). */
  player?: string;
  label: string;
}

/**
 * Jump points. With `focus`, only that player's kills / deaths / assists / trades / multi-kills; without it,
 * the round-shaping moments (multi-kills, aces, clutches, plants, defuses) plus every kill.
 */
export function replayEvents(d: ReplayData, focus?: string, nameOf: (p?: string) => string = (p) => p?.slice(0, 6) ?? '?'): ReplayEvent[] {
  const team = new Map(d.players.map((p) => [p.puuid, p.teamId]));
  const out: ReplayEvent[] = [];
  for (const r of d.rounds) {
    const perKiller = new Map<string, number>();
    for (const k of r.kills) if (k.killer) perKiller.set(k.killer, (perKiller.get(k.killer) ?? 0) + 1);
    for (const k of r.kills) {
      const mine = !focus || k.killer === focus;
      if (k.killer && mine) {
        out.push({ round: r.n, t: k.t, kind: 'kill', player: k.killer, label: `${nameOf(k.killer)} killed ${nameOf(k.victim)}` });
        if (k.trade) out.push({ round: r.n, t: k.t, kind: 'trade', player: k.killer, label: `${nameOf(k.killer)} traded ${nameOf(k.victim)}` });
        const total = perKiller.get(k.killer) ?? 0;
        if (k.streak >= 3 && k.streak === total) out.push({ round: r.n, t: k.t, kind: k.streak >= 5 ? 'ace' : 'multikill', player: k.killer, label: `${nameOf(k.killer)} ${k.streak >= 5 ? 'ace' : `${k.streak}K`}` });
      }
      if (focus && k.victim === focus) out.push({ round: r.n, t: k.t, kind: 'death', player: focus, label: `${nameOf(focus)} died to ${nameOf(k.killer)}` });
      if (focus && k.assistants.includes(focus)) out.push({ round: r.n, t: k.t, kind: 'assist', player: focus, label: `${nameOf(focus)} assisted on ${nameOf(k.victim)}` });
    }
    if (r.plant && (!focus || r.plant.player === focus)) out.push({ round: r.n, t: r.plant.t, kind: 'plant', player: r.plant.player, label: `Plant${r.plant.site ? ` on ${r.plant.site}` : ''}` });
    if (r.defuse && (!focus || r.defuse.player === focus)) out.push({ round: r.n, t: r.defuse.t, kind: 'defuse', player: r.defuse.player, label: 'Defuse' });
    // Clutch: the round winner's last player alive won against 2+.
    const clutch = clutchOf(r, team);
    if (clutch && (!focus || clutch.player === focus)) out.push({ round: r.n, t: clutch.t, kind: 'clutch', player: clutch.player, label: `${nameOf(clutch.player)} 1v${clutch.against}` });
  }
  return out.sort((a, b) => a.round - b.round || a.t - b.t);
}

/** The 1vX moment of a round, if the winning team's last survivor started it against 2 or more. */
export function clutchOf(r: ReplayRound, team: Map<string, string>): { player: string; t: number; against: number } | undefined {
  if (!r.winningTeam) return undefined;
  const all = [...team.keys()];
  const alive = new Set(all);
  for (const k of r.kills) {
    alive.delete(k.victim);
    const mine = [...alive].filter((p) => team.get(p) === r.winningTeam);
    const theirs = [...alive].filter((p) => team.get(p) !== r.winningTeam);
    if (mine.length === 1 && theirs.length >= 2) return { player: mine[0], t: k.t, against: theirs.length };
  }
  return undefined;
}
