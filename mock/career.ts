// Deterministic match careers for mock players: history, competitive updates and match details all come
// from the same list, so RR sign, round score, lobby ranks and party size agree with each other.
import { MAPS, ME, rng, SQUAD, SQUAD_EXTRA, uuid } from './data';
import { fiveStackPenaltyRisk } from '../shared/team';

export type Persona = 'above' | 'at' | 'below' | 'excluded' | 'normal';

/** Fixed mock players (they sit in the mock live match so every persona can be opened from Live). */
export const PERSONA = {
  at: uuid('persona-at'),
  below: uuid('persona-below'),
  excluded: uuid('persona-excluded'),
  /** Marked private on a third-party tracker (mock flag only). Riot's own endpoints answer as usual. */
  trackerPrivate: uuid('persona-tracker-private'),
} as const;

/** Mock-only flag: these players set their tracker.gg profile private. SexyVal never reads this or any tracker. */
export const TRACKER_PRIVATE = new Set<string>([PERSONA.trackerPrivate]);

export interface CareerMatch {
  id: string;
  start: number;
  queue: 'competitive' | 'unrated' | 'deathmatch' | 'swiftplay';
  actId: string;
  map: string;
  win: boolean;
  draw: boolean;
  myRounds: number;
  theirRounds: number;
  /** Competitive only. */
  rrEarned: number;
  perfBonus: number;
  tierBefore: number;
  tierAfter: number;
  rrBefore: number;
  rrAfter: number;
  afk: number;
  partySize: number;
  lobbyTier: number;
  acs: number;
}

interface Shape {
  win: number;
  loss: number;
  margin: number;
  lobby: number;
  winProb: number;
  tier: number;
}

const SHAPES: Record<Persona, Shape> = {
  // Wins pay a lot more than losses cost and lobbies sit about two divisions higher.
  above: { win: 23, loss: -11, margin: 0.35, lobby: 2.2, winProb: 0.58, tier: 14 },
  at: { win: 18, loss: -18, margin: 0.3, lobby: 0, winProb: 0.5, tier: 15 },
  below: { win: 12, loss: -23, margin: 0.3, lobby: -2.2, winProb: 0.44, tier: 13 },
  excluded: { win: 18, loss: -17, margin: 0.3, lobby: 0, winProb: 0.5, tier: 12 },
  normal: { win: 19, loss: -17, margin: 0.4, lobby: 0, winProb: 0.52, tier: 11 },
};

export function personaOf(puuid: string, mePersona: Persona): Persona {
  if (puuid === ME) return mePersona;
  if (puuid === PERSONA.at) return 'at';
  if (puuid === PERSONA.below) return 'below';
  if (puuid === PERSONA.excluded) return 'excluded';
  return 'normal';
}

/** How many matches a player has: enough for the lifetime list to page past 20 (45+ for the personas). */
function countFor(puuid: string, persona: Persona): number {
  if (puuid === ME || SQUAD_IDS.has(puuid)) return 52;
  if (persona !== 'normal' || TRACKER_PRIVATE.has(puuid)) return 48;
  return 26;
}

/**
 * Newest first. The newest ~60% of matches belong to the current act (`acts[1]`), the rest to the act
 * before it (`acts[0]`) and sit 60+ days back, before the current act began.
 * With the mock squad on (MOCK_SQUAD, default on) your newest 25 competitive matches get premades and
 * every squad member's career shares those matches (same MatchID, result, score and map).
 */
export function career(puuid: string, acts: [string, string], bootAt: number, mePersona: Persona, mode: SquadMode = squadMode()): CareerMatch[] {
  if (mode !== 'off') {
    const w = squadWorld(acts, bootAt, mePersona, mode);
    if (puuid === ME) return w.me;
    const m = w.members.get(puuid);
    if (m) return m;
  }
  return baseCareer(puuid, acts, bootAt, mePersona);
}

/** The 1.3 career generator (unchanged; MOCK_SQUAD=off is exactly this for everyone). */
function baseCareer(puuid: string, acts: [string, string], bootAt: number, mePersona: Persona, as?: Persona, shape?: Shape): CareerMatch[] {
  const persona = as ?? personaOf(puuid, mePersona);
  const s = shape ?? SHAPES[persona];
  const r = rng(`career:${puuid}:${persona}`);
  const n = countFor(puuid, persona);
  const inCurrent = Math.round(n * 0.6);
  // Build oldest -> newest so RR can be carried forward, then reverse.
  const out: CareerMatch[] = [];
  let tier = s.tier - (persona === 'above' ? 1 : persona === 'below' ? -1 : 0);
  let rr = 30 + Math.floor(r() * 40);
  for (let k = n - 1; k >= 0; k--) {
    const current = k < inCurrent;
    const start = bootAt - (k + 1) * 47 * 60_000 - (current ? 0 : 60 * 86400_000);
    const roll = r();
    const queue: CareerMatch['queue'] = persona !== 'normal' ? (roll < 0.86 ? 'competitive' : 'unrated') : roll < 0.68 ? 'competitive' : roll < 0.84 ? 'unrated' : roll < 0.93 ? 'deathmatch' : 'swiftplay';
    const win = r() < s.winProb;
    const draw = queue === 'competitive' && r() < 0.02;
    const loserRounds = Math.floor(r() * 11);
    const myRounds = draw ? 12 : win ? 13 : loserRounds;
    const theirRounds = draw ? 12 : win ? loserRounds : 13;
    const acs = Math.round(150 + r() * 160 + (persona === 'above' ? 25 : persona === 'below' ? -15 : 0));
    let afk = 0;
    let partySize = r() < 0.65 ? 1 : 2 + Math.floor(r() * 2);
    let placement = false;
    if (persona === 'excluded' && current) {
      const x = r();
      if (x < 0.25) afk = -3;
      else if (x < 0.5) partySize = 5;
      else if (x < 0.62) placement = true;
    }
    if (k === inCurrent - 1 && persona !== 'excluded') placement = false;
    const rd = myRounds - theirRounds;
    const perfBonus = queue === 'competitive' && win && acs > 290 && persona === 'above' ? 2 + Math.floor(r() * 2) : 0;
    let earned = 0;
    if (queue === 'competitive' && !draw) earned = Math.round((win ? s.win : s.loss) + s.margin * rd + (r() - 0.5) * 3) + perfBonus;
    if (afk) earned = Math.min(earned, 0) + afk;
    const tierBefore = placement ? 0 : tier;
    const rrBefore = rr;
    if (queue === 'competitive') {
      rr += earned;
      while (rr >= 100 && tier < 24) {
        tier++;
        rr -= 100;
      }
      while (rr < 0 && tier > 3) {
        tier--;
        rr += 100;
      }
      rr = Math.max(0, rr);
    }
    const lobbyTier = Math.max(3, Math.min(25, Math.round(tier + s.lobby + (r() - 0.5) * 1.4)));
    out.push({
      id: uuid(`${puuid}-career-${k}`),
      start,
      queue,
      actId: current ? acts[1] : acts[0],
      map: MAPS[Math.floor(r() * MAPS.length)],
      win: win && !draw,
      draw,
      myRounds,
      theirRounds,
      rrEarned: earned,
      perfBonus,
      tierBefore,
      tierAfter: tier,
      rrBefore,
      rrAfter: rr,
      afk,
      partySize,
      lobbyTier,
      acs,
    });
  }
  return out.reverse();
}

/** Riot's competitiveupdates Matches[] entry. */
export function updateJson(m: CareerMatch) {
  return {
    MatchID: m.id,
    MapID: m.map,
    SeasonID: m.actId,
    MatchStartTime: m.start,
    TierAfterUpdate: m.tierAfter,
    TierBeforeUpdate: m.tierBefore,
    RankedRatingAfterUpdate: m.rrAfter,
    RankedRatingBeforeUpdate: m.rrBefore,
    RankedRatingEarned: m.rrEarned,
    RankedRatingPerformanceBonus: m.perfBonus,
    CompetitiveMovement: 'MOVEMENT_UNKNOWN',
    AFKPenalty: m.afk,
  };
}

// ---------- Mock squad (1.4) ----------
//
// MOCK_SQUAD: on (default) | off (1.3: all solo randoms) | solo (no premades this act) | penalty (on +
// the live party reports SkillDisparityRRPenalty 0.25) | many (12 premades) | five (only 5-stacks).

export type SquadMode = 'on' | 'off' | 'solo' | 'penalty' | 'many' | 'five';
export function squadMode(): SquadMode {
  const v = process.env.MOCK_SQUAD;
  return v === 'off' || v === 'solo' || v === 'penalty' || v === 'many' || v === 'five' ? v : 'on';
}

export { SQUAD, SQUAD_EXTRA };
type Role = keyof typeof SQUAD;
const SQUAD_IDS = new Set<string>([...Object.values(SQUAD), ...SQUAD_EXTRA]);

/** Who each squad member is: persona (their own RR shape and MMR vs rank), rank vs yours at mid-window, ACS z. */
const MEMBERS: Record<Role, { persona: Persona; tierOffset: number; z: number }> = {
  drain: { persona: 'below', tierOffset: -2, z: -0.7 }, // ~2 divisions below you, MMR below their rank
  carry: { persona: 'above', tierOffset: 2, z: 0.8 }, // above you (5-stacks with both sit outside the rank window)
  neutral: { persona: 'at', tierOffset: 0, z: 0 },
  rare: { persona: 'at', tierOffset: 1, z: 0 }, // 2 games only
  five: { persona: 'at', tierOffset: 0, z: 0.1 }, // fills 5-stacks
};
const memberOf = (p: string) => (Object.keys(SQUAD) as Role[]).find((r) => SQUAD[r] === p);
function profile(p: string): { persona: Persona; tierOffset: number; z: number } {
  const r = memberOf(p);
  if (r) return MEMBERS[r];
  const i = SQUAD_EXTRA.indexOf(p);
  return { persona: 'at', tierOffset: (i % 3) - 1, z: ((i % 5) - 2) * 0.2 };
}

/**
 * The tier / RR chain for a squad member, oldest -> newest. Through your window their own games (not the
 * shared ones) are won or lost to keep them near `target(k)` (your rank + their offset), so "2 divisions
 * below you" holds from the first match of the window to the last and every 5-stack sits where the plan says.
 */
function trackChain(list: CareerMatch[], shape: Shape, who: string, target: (k: number) => number | undefined, shared: Set<string>): void {
  const oldest = list[list.length - 1];
  if (!oldest) return;
  let tier = oldest.tierBefore >= 3 ? oldest.tierBefore : oldest.tierAfter;
  let rr = oldest.rrBefore;
  for (let k = list.length - 1; k >= 0; k--) {
    const m = list[k];
    const t = target(k);
    if (t != null && m.queue === 'competitive' && !shared.has(m.id)) {
      const win = tier + rr / 100 < t;
      const loser = Math.min(m.myRounds, m.theirRounds, 11);
      Object.assign(m, { win, draw: false, myRounds: win ? 13 : loser, theirRounds: win ? loser : 13, afk: 0, perfBonus: 0 });
      m.rrEarned = rrFor(shape, m, who, false, 0);
    }
    m.tierBefore = m.tierBefore === 0 ? 0 : tier;
    m.rrBefore = rr;
    if (m.queue === 'competitive') {
      rr += m.rrEarned;
      while (rr >= 100 && tier < 24) {
        tier++;
        rr -= 100;
      }
      while (rr < 0 && tier > 3) {
        tier--;
        rr += 100;
      }
      rr = Math.max(0, rr);
    }
    m.tierAfter = tier;
    m.rrAfter = rr;
  }
}

interface PlanEntry {
  premades: string[];
  /** Forced result in squad games (so the design holds); undefined = keep the generated one. */
  result?: 'W' | 'L';
  /** A 5-stack outside the community-reported rank window: everyone gets RR × 0.75. */
  outside?: boolean;
}

const guest = (j: number) => uuid(`squad-guest-${j}`);

/** Your newest 25 competitive matches this act, newest first: ~32% solo, 28% duo, 16% trio, 24% 5-stack. */
function plan(mode: SquadMode): PlanEntry[] {
  const { drain: d, carry: c, neutral: n, rare: r, five: f } = SQUAD;
  if (mode === 'solo') return Array.from({ length: 25 }, () => ({ premades: [] }));
  if (mode === 'five') return Array.from({ length: 25 }, (_, j) => ({ premades: [d, c, n, f], result: j % 2 ? 'L' : 'W', outside: true }));
  if (mode === 'many') {
    const all = [d, c, n, r, f, ...SQUAD_EXTRA];
    return Array.from({ length: 25 }, (_, j) => (j % 8 === 0 ? { premades: [] } : { premades: [all[j % 12], ...(j % 3 === 0 ? [all[(j + 5) % 12]] : [])] }));
  }
  const W = 'W' as const;
  const L = 'L' as const;
  return [
    { premades: [], result: W },
    { premades: [d], result: L },
    { premades: [d, c, n, f], result: W, outside: true },
    { premades: [c], result: W },
    { premades: [], result: L },
    { premades: [d, n], result: L },
    { premades: [n], result: W },
    { premades: [d, c, n, r], result: L, outside: true },
    { premades: [], result: W },
    { premades: [d], result: W },
    { premades: [c, n], result: W },
    { premades: [], result: W },
    { premades: [d, c, n, f], result: W, outside: true },
    { premades: [c], result: W },
    { premades: [], result: L },
    { premades: [d, c], result: L },
    { premades: [c], result: W },
    { premades: [c, n, f, guest(17)], result: W }, // no drain: inside the window
    { premades: [], result: W },
    { premades: [d], result: L },
    { premades: [d, r], result: W },
    { premades: [], result: L },
    { premades: [d, c, n, f], result: L, outside: true },
    { premades: [d, n, f, guest(23)], result: L }, // no carry: inside the window
    { premades: [], result: W },
  ];
}

export interface SquadWorld {
  me: CareerMatch[];
  members: Map<string, CareerMatch[]>;
  /** Shared match -> your premades (plan order) and whether it was an outside-the-window 5-stack. */
  info: Map<string, { premades: string[]; outside: boolean }>;
  /** Shared match -> premade -> ACS. */
  acs: Map<string, Map<string, number>>;
  /** A premade's tier in a shared match (their own competitive update), else undefined. */
  tierOf(puuid: string, matchId: string): number | undefined;
  /** A player's "true MMR" in the mock: tier plus their persona's lobby offset. */
  mmrOf(puuid: string, tier: number): number;
}

/** Re-runs the tier / RR chain oldest -> newest after results or RR changed (same rules as baseCareer). */
function rechain(list: CareerMatch[]): void {
  const oldest = list[list.length - 1];
  if (!oldest) return;
  let tier = oldest.tierBefore >= 3 ? oldest.tierBefore : oldest.tierAfter;
  let rr = oldest.rrBefore;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    m.tierBefore = m.tierBefore === 0 ? 0 : tier;
    m.rrBefore = rr;
    if (m.queue === 'competitive') {
      rr += m.rrEarned;
      while (rr >= 100 && tier < 24) {
        tier++;
        rr -= 100;
      }
      while (rr < 0 && tier > 3) {
        tier--;
        rr += 100;
      }
      rr = Math.max(0, rr);
    }
    m.tierAfter = tier;
    m.rrAfter = rr;
  }
}

/** One match's RR from a persona's shape (fresh noise per match id), × 0.75 outside the rank window. */
function rrFor(shape: Shape, m: Pick<CareerMatch, 'id' | 'win' | 'myRounds' | 'theirRounds'>, who: string, outside: boolean, perfBonus: number): number {
  const r = rng(`squad-rr:${who}:${m.id}`);
  const base = Math.round((m.win ? shape.win : shape.loss) + shape.margin * (m.myRounds - m.theirRounds) + (r() - 0.5) * 3) + perfBonus;
  return outside ? Math.round(base * 0.75) : base;
}

const worlds = new Map<string, SquadWorld>();

export function squadWorld(acts: [string, string], bootAt: number, mePersona: Persona, mode: SquadMode): SquadWorld {
  const key = `${acts.join()}:${bootAt}:${mePersona}:${mode}`;
  const hit = worlds.get(key);
  if (hit) return hit;
  const entries0 = plan(mode);
  // "Outside the rank window" is decided from the ranks the 5-stack actually had (community-reported rule,
  // shared/team.ts), which depend on the RR that the rule changes: rebuild until the flags are stable.
  let outside = entries0.map((e) => !!e.outside);
  let w = buildWorld(acts, bootAt, mePersona, mode, entries0, outside);
  for (let it = 0; it < 4; it++) {
    const next = w.window.map(({ m }, j) => {
      const e = entries0[j];
      if (!e || e.premades.length !== 4) return false;
      return fiveStackPenaltyRisk([m.tierBefore, ...e.premades.map((p) => w.world.tierOf(p, m.id) ?? m.tierBefore)]);
    });
    if (next.every((x, j) => x === outside[j])) break;
    outside = next;
    w = buildWorld(acts, bootAt, mePersona, mode, entries0, outside);
  }
  worlds.set(key, w.world);
  return w.world;
}

function buildWorld(acts: [string, string], bootAt: number, mePersona: Persona, mode: SquadMode, entries0: PlanEntry[], outside: boolean[]): { world: SquadWorld; window: { m: CareerMatch; k: number }[] } {
  // Own match ids per squad mode: details cached by a 1.3 mock run (or another mode) never leak in.
  const me = baseCareer(ME, acts, bootAt, mePersona).map((m, k) => ({ ...m, id: uuid(`${ME}-squad-${mode}-${k}`) }));
  const window = me.map((m, k) => ({ m, k })).filter(({ m }) => m.queue === 'competitive' && m.actId === acts[1]).slice(0, 25);
  const entries = entries0.slice(0, window.length);
  const info = new Map<string, { premades: string[]; outside: boolean }>();
  const meShape = SHAPES[mePersona];
  window.forEach(({ m }, j) => {
    const e = entries[j];
    m.partySize = e.premades.length + 1;
    if (!e.result) return; // solo / many: keep the generated result
    const win = e.result === 'W';
    const loser = m.draw ? 9 : Math.min(m.myRounds, m.theirRounds);
    m.draw = false;
    m.win = win;
    m.myRounds = win ? 13 : loser;
    m.theirRounds = win ? loser : 13;
    m.perfBonus = win ? m.perfBonus : 0;
    m.rrEarned = rrFor(meShape, m, ME, !!outside[j], m.perfBonus);
  });
  window.forEach(({ m }, j) => {
    if (entries[j].premades.length) info.set(m.id, { premades: entries[j].premades, outside: !!outside[j] });
  });
  rechain(me);

  // Members: their own career on the same timeline (52 matches, same slots), with your shared matches spliced in.
  const members = new Map<string, CareerMatch[]>();
  const acs = new Map<string, Map<string, number>>();
  const ids = [...new Set(entries.flatMap((e) => e.premades))].filter((p) => SQUAD_IDS.has(p));
  const lastK = window.length ? window[window.length - 1].k : -1;
  for (const p of ids) {
    const prof = profile(p);
    const shape = SHAPES[prof.persona];
    const list = baseCareer(p, acts, bootAt, mePersona, prof.persona).map((m) => ({ ...m }));
    // Start them at their offset from you, a little before your window begins.
    const startDelta = (me[Math.min(me.length - 1, lastK + 4)]?.tierBefore || me[me.length - 1].tierAfter) + prof.tierOffset - (list[list.length - 1].tierBefore || list[list.length - 1].tierAfter);
    for (const m of list) {
      if (m.tierBefore >= 3) m.tierBefore = Math.max(3, Math.min(24, m.tierBefore + startDelta));
      m.tierAfter = Math.max(3, Math.min(24, m.tierAfter + startDelta));
      m.lobbyTier = Math.max(3, Math.min(25, m.lobbyTier + startDelta));
    }
    const shared = new Set<string>();
    window.forEach(({ m, k }, j) => {
      if (!entries[j].premades.includes(p) || !list[k]) return;
      list[k] = { ...m, rrEarned: rrFor(shape, m, p, !!outside[j], 0), perfBonus: 0, afk: 0, tierBefore: list[k].tierBefore || 1, acs: 0 };
      shared.add(m.id);
    });
    // Their own games aim a little above the offset: shared losses at their persona's loss size pull them down.
    const aim = prof.tierOffset + (shape.loss < -shape.win ? 0.9 : 0.3);
    trackChain(list, shape, p, (k) => (k <= lastK + 4 && me[k] ? me[k].tierBefore + me[k].rrBefore / 100 + aim : undefined), shared);
    members.set(p, list);
  }
  // Premade ACS in shared matches: drawn around the lobby mean from each member's z.
  window.forEach(({ m }, j) => {
    const row = new Map<string, number>();
    for (const p of entries[j].premades) {
      const r = rng(`squad-acs:${p}:${m.id}`);
      row.set(p, Math.round(225 + profile(p).z * 55 + (r() - 0.5) * 30));
    }
    if (row.size) acs.set(m.id, row);
  });
  for (const [p, list] of members) for (const m of list) if (acs.get(m.id)?.has(p)) m.acs = acs.get(m.id)!.get(p)!;
  const byId = new Map<string, Map<string, CareerMatch>>([...members].map(([p, l]) => [p, new Map(l.map((m) => [m.id, m]))]));
  const world: SquadWorld = {
    me,
    members,
    info,
    acs,
    tierOf: (p, id) => byId.get(p)?.get(id)?.tierBefore,
    mmrOf: (p, tier) => tier + SHAPES[p === ME ? mePersona : SQUAD_IDS.has(p) ? profile(p).persona : 'normal'].lobby,
  };
  return { world, window };
}
