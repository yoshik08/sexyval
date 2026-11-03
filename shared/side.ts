/**
 * Starting side, hardcoded: the Red team attacks first, Blue defends first.
 *
 * Checked 15/15 on competitive matches (Nov 2026). Other spike queues are assumed to work the same way
 * and are marked unverified. There is no self-check: if Riot ever changes which colour starts on
 * attack, this is silently wrong.
 */

export type StartSide = 'ATK' | 'DEF';

/** Queues that play spike plant/defuse. Decided by queue, not by "Bomb" in the mode path (Swiftplay's isn't). */
export const SPIKE_QUEUES = ['competitive', 'unrated', 'premier', 'swiftplay', 'spikerush'] as const;
const VERIFIED_QUEUES = new Set(['competitive']);
/** Modes that never have a starting side, even if a queue id says otherwise. */
const NON_SPIKE_MODE = /Deathmatch|HURM|GunGame|OneForAll|SnowballFight|NewPlayerExperience|ShootingRange/i;

export const UNVERIFIED_NOTE = 'assumed from competitive, unverified';

/** Red = ATK, Blue = DEF. Null for non-spike modes, blank/custom queues and unknown team ids. */
export function getStartSide(teamId: string | null | undefined, queueID: string | null | undefined, modeId: string | null | undefined): StartSide | null {
  const queue = String(queueID ?? '').trim().toLowerCase();
  if (!(SPIKE_QUEUES as readonly string[]).includes(queue)) return null;
  if (NON_SPIKE_MODE.test(String(modeId ?? ''))) return null;
  const team = String(teamId ?? '').trim().toLowerCase();
  if (team === 'red') return 'ATK';
  if (team === 'blue') return 'DEF';
  return null;
}

/** Only competitive has been checked against real matches. */
export function isStartSideVerified(queueID: string | null | undefined): boolean {
  return VERIFIED_QUEUES.has(String(queueID ?? '').trim().toLowerCase());
}
