// Synthetic trimmed match details for the team model (tests only).
import type { TrimmedDetails } from '../shared/last5';

export interface Mate {
  id: string;
  tier: number;
  /** Same party as the viewer. */
  premade?: boolean;
  acs?: number;
}

export interface MatchSpec {
  id: string;
  me: string;
  myTier: number;
  myAcs?: number;
  mates: Mate[];
  /** Enemy tiers (or players). */
  enemies: (number | Mate)[];
  win: boolean;
  /** Absolute round margin (default 4). */
  margin?: number;
  /** false = details cached before partyId existed (no party data at all). */
  partyData?: boolean;
  startTime?: number;
}

/** Five on each side by default; `mates` are your 4 teammates. ACS defaults to 200 (score = acs · rounds). */
export function matchDetails(s: MatchSpec): TrimmedDetails {
  const margin = s.margin ?? 4;
  const won = 13;
  const lost = 13 - margin;
  const rounds = won + lost;
  const party = s.partyData === false ? undefined : `party-${s.id}`;
  const line = (id: string, team: string, tier: number, acs: number, partyId: string | undefined) => ({
    subject: id,
    teamId: team,
    score: Math.round(acs * rounds),
    roundsPlayed: rounds,
    kills: Math.round(acs / 12),
    deaths: 15,
    assists: 4,
    tier,
    partyId,
    adr: Math.round(acs * 0.65),
    hsPct: 22,
    firstBloods: acs > 240 ? 3 : 1,
    characterId: 'agent',
  });
  const enemies = s.enemies.map((e, i) => (typeof e === 'number' ? { id: `${s.id}-e${i}`, tier: e } : e));
  return {
    matchId: s.id,
    mapId: 'map',
    startTime: s.startTime ?? 0,
    players: [
      line(s.me, 'Blue', s.myTier, s.myAcs ?? 200, party),
      ...s.mates.map((m, i) => line(m.id, 'Blue', m.tier, m.acs ?? 200, s.partyData === false ? undefined : m.premade ? party : `solo-${s.id}-${i}`)),
      ...enemies.map((e, i) => line(e.id, 'Red', e.tier, e.acs ?? 200, s.partyData === false ? undefined : `enemy-${s.id}-${i}`)),
    ],
    teams: [
      { teamId: 'Blue', won: s.win, roundsWon: s.win ? won : lost },
      { teamId: 'Red', won: !s.win, roundsWon: s.win ? lost : won },
    ],
    roundResults: [],
  };
}

/** Teammates for a lobby at `tier`: the listed premades first, then randoms up to 4. */
export function mates(tier: number, premades: Mate[] = [], matchId = 'm'): Mate[] {
  return [...premades.map((p) => ({ ...p, premade: true })), ...Array.from({ length: 4 - premades.length }, (_, i) => ({ id: `${matchId}-r${i}`, tier }))];
}
