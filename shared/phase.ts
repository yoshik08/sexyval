import type { Phase } from './types';
import { parsePartyCore } from './party';

/** Queue and agent select tick this often, whatever the user's poll setting is. */
export const FAST_MS = 1000;
/** Retry delay while Valorant (or the Riot Client) is missing. */
export const WAIT_MS = 3000;

/** The JSON each phase probe answered with this tick; null means 404 / no match / not checked. */
export interface PhaseResponses {
  pregameMatch: any | null;
  coreMatch: any | null;
  party: any | null;
}

/** Agent select beats in game beats queuing; no match and no matchmaking party means menus. */
export function phaseFrom(r: PhaseResponses): Phase {
  if (r.pregameMatch) return 'pregame';
  if (r.coreMatch) return 'ingame';
  if (r.party && parsePartyCore(r.party).matchmaking) return 'queue';
  return 'idle';
}

export interface CadenceInput {
  phase: Phase;
  /** The user's poll setting (already clamped by settings). */
  pollMs: number;
  valorantRunning: boolean;
  /** Current 429/5xx backoff; 0 when the last tick succeeded. */
  backoffMs: number;
}

/**
 * Delay before the next tick. Backoff always wins, so a rate limit is never hammered by the fast
 * cadence. Queue and agent select run on their own 1 s cadence, outside the poll setting's clamp.
 */
export function nextDelay(c: CadenceInput): number {
  if (c.backoffMs > 0) return c.backoffMs;
  if (!c.valorantRunning) return Math.max(c.pollMs, WAIT_MS);
  if (c.phase === 'queue' || c.phase === 'pregame') return FAST_MS;
  return c.pollMs;
}

const PHASE_URI = /ares-(?:parties|pregame|core-game)/;

/**
 * Riot Client WebSocket frame -> the event uri when it concerns party, pregame or core-game.
 * Frames look like `[8, "OnJsonApiEvent", { data, eventType, uri }]`; anything else is ignored.
 */
export function phaseEventUri(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(msg) || msg[0] !== 8) return null;
  const uri = (msg[2] as any)?.uri;
  return typeof uri === 'string' && PHASE_URI.test(uri) ? uri : null;
}

/** Text for the connection chip and tray. */
export function phaseLabel(phase: Phase, valorantRunning: boolean): string {
  if (!valorantRunning) return 'Valorant closed';
  return { idle: 'In menus', queue: 'In queue', pregame: 'Agent select', ingame: 'In game' }[phase];
}
