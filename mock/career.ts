// Deterministic match careers for mock players: history, competitive updates and match details all come
// from the same list, so RR sign, round score, lobby ranks and party size agree with each other.
import { MAPS, ME, rng, uuid } from './data';

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
  if (puuid === ME) return 52;
  if (persona !== 'normal' || TRACKER_PRIVATE.has(puuid)) return 48;
  return 26;
}

/**
 * Newest first. The newest ~60% of matches belong to the current act (`acts[1]`), the rest to the act
 * before it (`acts[0]`) and sit 60+ days back, before the current act began.
 */
export function career(puuid: string, acts: [string, string], bootAt: number, mePersona: Persona): CareerMatch[] {
  const persona = personaOf(puuid, mePersona);
  const s = SHAPES[persona];
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
