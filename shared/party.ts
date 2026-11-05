// Party fields both the Party screen and the live loop need. One parser, so the loop's
// "are we queuing?" check and the Party screen can never disagree.

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
  };
}
