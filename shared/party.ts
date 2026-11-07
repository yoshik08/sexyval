// Party fields both the Party screen and the live loop need. One parser, so the loop's
// "are we queuing?" check and the Party screen can never disagree.
import { normalisePenalty } from './team';

export interface PartyCore {
  state?: string;
  queueId?: string;
  eligibleQueues: string[];
  accessibility?: 'OPEN' | 'CLOSED';
  inviteCode?: string;
  preferredPods: string[];
  /** Raw QueueEntryTime string as Riot sends it. */
  queueEntryTime?: string;
  /** QueueEntryTime in ms, only when it is a real time (Riot sends 0001-01-01 when not queuing). */
  queueEntryAt?: number;
  matchmaking: boolean;
  /** MatchmakingData.SkillDisparityRRPenalty as a 0–1 fraction (unverified scale: > 1 is read as a percentage). */
  rrPenalty?: number;
  /** The raw value, for Debug. */
  rrPenaltyRaw?: unknown;
}

/** Riot uses "0001-01-01T00:00:00Z" for "never"; anything before 2010 is treated as unset. */
export function parseQueueEntryTime(v: unknown): number | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > Date.UTC(2010, 0, 1) ? t : undefined;
}

export function parsePartyCore(j: any): PartyCore {
  const state = typeof j?.State === 'string' ? j.State : undefined;
  const queueEntryTime = typeof j?.QueueEntryTime === 'string' ? j.QueueEntryTime : undefined;
  return {
    state,
    queueId: typeof j?.MatchmakingData?.QueueID === 'string' ? j.MatchmakingData.QueueID : undefined,
    eligibleQueues: Array.isArray(j?.EligibleQueues) ? j.EligibleQueues : [],
    accessibility: j?.Accessibility === 'OPEN' || j?.Accessibility === 'CLOSED' ? j.Accessibility : undefined,
    inviteCode: j?.InviteCode || undefined,
    preferredPods: Array.isArray(j?.MatchmakingData?.PreferredGamePods) ? j.MatchmakingData.PreferredGamePods : [],
    queueEntryTime,
    queueEntryAt: parseQueueEntryTime(queueEntryTime),
    matchmaking: state === 'MATCHMAKING',
    rrPenalty: normalisePenalty(j?.MatchmakingData?.SkillDisparityRRPenalty),
    rrPenaltyRaw: j?.MatchmakingData?.SkillDisparityRRPenalty,
  };
}

/** Live party bracket on a player row: index is the party's letter on that team (0 = A). */
export interface PartyGroup {
  id: string;
  size: number;
  index: number;
}

/** Party id from a decoded Valorant chat presence: flat `partyId` (newer) or `partyPresenceData.partyId`. */
export function partyOfPresence(decoded: any): string | undefined {
  const id = decoded?.partyId ?? decoded?.partyPresenceData?.partyId;
  return typeof id === 'string' && id ? id : undefined;
}

/** Parties of 2+ players on the same team, lettered per team in row order. Keyed by puuid. */
export function groupParties(players: { puuid: string; teamId: string }[], partyOf: (puuid: string) => string | undefined): Map<string, PartyGroup> {
  const byKey = new Map<string, { id: string; teamId: string; members: string[] }>();
  for (const p of players) {
    const id = p.puuid ? partyOf(p.puuid) : undefined;
    if (!id) continue;
    const key = `${p.teamId}\u0000${id}`;
    const g = byKey.get(key) ?? { id, teamId: p.teamId, members: [] };
    g.members.push(p.puuid);
    byKey.set(key, g);
  }
  const out = new Map<string, PartyGroup>();
  const letters = new Map<string, number>();
  for (const g of byKey.values()) {
    if (g.members.length < 2) continue;
    const index = letters.get(g.teamId) ?? 0;
    letters.set(g.teamId, index + 1);
    for (const m of g.members) out.set(m, { id: g.id, size: g.members.length, index });
  }
  return out;
}

/** Enemy party sizes in a finished match, e.g. "2+3", "solo" (all solo), undefined without party data. */
export function enemyStacks(enemies: { partyId?: string }[]): string | undefined {
  if (!enemies.length || enemies.some((e) => !e.partyId)) return undefined;
  const n = new Map<string, number>();
  for (const e of enemies) n.set(e.partyId!, (n.get(e.partyId!) ?? 0) + 1);
  const sizes = [...n.values()].filter((s) => s >= 2).sort((a, b) => a - b);
  return sizes.length ? sizes.join('+') : 'solo';
}
