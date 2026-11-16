// Discord Rich Presence content (pure). Built only from what SexyVal already shows you about your own
// game: the phase, your own map/agent/rank, your party size and when the phase started. Never other
// players, never anything hidden (enemy agents, names), never your Riot ID.
import type { AppState } from './types';

export interface PresencePrivacy {
  map: boolean;
  agent: boolean;
  rank: boolean;
  party: boolean;
  elapsed: boolean;
  mode: boolean;
}

export const DEFAULT_PRIVACY: PresencePrivacy = { map: true, agent: true, rank: false, party: true, elapsed: true, mode: true };

export interface Activity {
  details?: string;
  state?: string;
  timestamps?: { start: number };
  assets?: { large_image?: string; large_text?: string; small_image?: string; small_text?: string };
  party?: { size: [number, number] };
  instance?: boolean;
}

export interface PresenceInput {
  valorantRunning: boolean;
  state: Pick<AppState, 'phase' | 'queue' | 'pregame' | 'coregame' | 'me'>;
  /** When the current phase began (main tracks it), ms. */
  phaseSince?: number;
}

const PARTY_MAX = 5;
const httpsOnly = (u?: string) => (u && /^https:\/\//.test(u) ? u : undefined);

/** null = clear the activity (Valorant closed, or nothing reliable to show). */
export function buildActivity(input: PresenceInput, p: PresencePrivacy): Activity | null {
  if (!input.valorantRunning) return null;
  const s = input.state;
  const a: Activity = { instance: false };
  let mapName: string | undefined;
  let mapArt: string | undefined;
  let agent: { name: string; icon?: string } | undefined;
  let mode: string | undefined;
  let partySize: number | undefined;
  switch (s.phase) {
    case 'pregame': {
      const me = s.pregame?.allies.find((x) => x.isMe);
      mapName = s.pregame?.map?.name;
      mapArt = s.pregame?.map?.listIcon ?? s.pregame?.map?.splash;
      agent = me?.selectionState === 'locked' ? me.agent : undefined;
      mode = s.pregame?.modeName;
      a.state = 'Agent select';
      partySize = me?.partyGroup?.size;
      break;
    }
    case 'ingame': {
      const me = s.coregame?.myTeam.find((x) => x.isMe);
      mapName = s.coregame?.map?.name;
      mapArt = s.coregame?.map?.listIcon ?? s.coregame?.map?.splash;
      agent = me?.agent;
      mode = s.coregame?.modeName;
      a.state = 'In a match';
      partySize = me?.partyGroup?.size;
      break;
    }
    case 'queue':
      mode = s.queue?.queueName;
      a.state = 'In queue';
      break;
    default:
      a.state = 'In the menus';
  }
  if (p.mode && mode) a.details = p.map && mapName ? `${mode} · ${mapName}` : mode;
  else if (p.map && mapName) a.details = mapName;
  if (p.elapsed && input.phaseSince && (s.phase === 'ingame' || s.phase === 'queue' || s.phase === 'pregame')) a.timestamps = { start: Math.floor(input.phaseSince / 1000) };
  const assets: NonNullable<Activity['assets']> = {};
  if (p.map && mapName && httpsOnly(mapArt)) {
    assets.large_image = httpsOnly(mapArt);
    assets.large_text = mapName;
  }
  if (p.agent && agent) {
    if (httpsOnly(agent.icon)) assets.small_image = httpsOnly(agent.icon);
    assets.small_text = agent.name;
    a.state = `${a.state} · ${agent.name}`;
  }
  const rank = s.me?.rank;
  if (p.rank && rank && rank.tier > 2 && rank.name) {
    assets.small_text = assets.small_text ? `${assets.small_text} · ${rank.name}` : rank.name;
    if (!assets.small_image && httpsOnly(rank.icon)) assets.small_image = httpsOnly(rank.icon);
  }
  if (Object.keys(assets).length) a.assets = assets;
  if (p.party && partySize && partySize >= 2) a.party = { size: [Math.min(partySize, PARTY_MAX), PARTY_MAX] };
  return a;
}

/** Two activities show the same thing (so nothing is sent). */
export const sameActivity = (a: Activity | null, b: Activity | null) => JSON.stringify(a) === JSON.stringify(b);

/** Discord allows 5 activity updates per 20 s; SexyVal waits at least this long between them. */
export const MIN_UPDATE_MS = 15_000;

/** Reconnect delays while Discord is closed: 15 s, 30 s, 1 min, 2 min, 5 min, then it stops trying. */
export function discordBackoff(attempt: number): number | null {
  const steps = [15_000, 30_000, 60_000, 120_000, 300_000];
  return attempt < steps.length ? steps[attempt] : null;
}

export function validClientId(id: string): boolean {
  return /^\d{17,20}$/.test(id.trim());
}
