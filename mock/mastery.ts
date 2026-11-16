// Mock Agent Mastery ("Bloomline") routes. SYNTHETIC values in the shape of `pd/bloomline/v0` as the live
// service returned it on 2026-11-16. NumberModules (stat slots) were not in that live answer (no stats
// equipped), so their shape still follows the community docs (techchrism/valorant-api-docs #71).
//
// MOCK_MASTERY (or setMockMastery in tests): '' normal · empty (no agents) · error (503) · invalid (wrong
// shape) · slow (2.5 s delay) · notfound (404).
import { AGENTS, ME, uuid } from './data';

export type MockMasteryMode = '' | 'empty' | 'error' | 'invalid' | 'slow' | 'notfound';
let mode: MockMasteryMode = (process.env.MOCK_MASTERY as MockMasteryMode) || '';
/** Extra delay per subject (tests: a slow answer for one account while another becomes active). */
const delays = new Map<string, number>();

export function setMockMastery(m: MockMasteryMode, delayFor?: Record<string, number>): void {
  mode = m;
  delays.clear();
  for (const [k, v] of Object.entries(delayFor ?? {})) delays.set(k, v);
}

const [JETT, SAGE, OMEN, SOVA, KILLJOY, RAZE, VIPER] = AGENTS;

interface Preset {
  agent: string;
  short?: number;
  prev?: number;
  long: number;
  points?: number;
  equipped?: boolean;
}

/** Your account: a spread of states the UI must handle. */
const MINE: Preset[] = [
  { agent: JETT, short: 7, prev: 10, long: 23, points: 80_450, equipped: true }, // mid-track, last Act maxed
  { agent: SAGE, short: 12, prev: 10, long: 31, points: 250_000, equipped: true }, // overlevelled, every tier
  { agent: OMEN, prev: 6, long: 9 }, // new Act, not played yet (zero fields omitted, like Riot)
  { agent: SOVA, short: 3, long: 3, points: 25_000 },
  { agent: KILLJOY, short: 1, long: 1, points: 4_000 },
  { agent: RAZE, short: 4, prev: 2, long: 14, points: 999 }, // points that don't fit the level table
  { agent: VIPER, short: 2, prev: 10, long: 12, points: 13_225 },
];
/** Any other account (account-switch checks): different numbers so a mix-up is visible. */
const OTHER: Preset[] = [
  { agent: AGENTS[9], short: 5, long: 5, points: 45_000 },
  { agent: JETT, short: 1, long: 1, points: 2_500 },
];

function bonsai(p: Preset, subject: string, withStats: boolean): Record<string, unknown> {
  const flourish: Record<string, unknown> = { FlourishID: uuid(`flourish-${p.agent}`), LongLevel: p.long, PointsVersion: 5 };
  if (p.short) flourish.ShortLevel = p.short;
  if (p.prev) flourish.PreviousShortLevel = p.prev;
  if (p.points) flourish.Points = p.points;
  return {
    BonsaiID: p.agent,
    ...(p.equipped ? { HypeID: uuid(`hype-${p.agent}`), BackgroundID: uuid(`bg-${p.agent}`), BorderID: uuid(`border-${p.agent}`) } : {}),
    Flourish: flourish,
    TrackProgressList: [{ TrackID: uuid(`track-${p.agent}`), TrackLevel: p.long }],
    ...(withStats
      ? {
          NumberModules: [
            { ModuleID: uuid('slot-1'), NumberID: uuid('stat-kills'), Value: Math.round(p.long * 41.5 + (subject === ME ? 7 : 3)) },
            { ModuleID: uuid('slot-2'), NumberID: uuid('stat-assists'), Value: p.long * 12 },
            { ModuleID: uuid('slot-3'), NumberID: '00000000-0000-0000-0000-000000000000', Value: 0 },
          ],
        }
      : {}),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Returns [status, body] for a bloomline path, or null when the path isn't one. */
export async function masteryRoute(p: string): Promise<[number, unknown] | null> {
  let m: RegExpExecArray | null;
  if (p === '/pd/bloomline/v0/config/valid-queues') {
    return [200, { ProcessedQueues: ['competitive', 'unrated', 'swiftplay', 'spikerush', 'hurm', 'premier'], PerformanceScoreQueues: ['competitive', 'unrated', 'premier'] }];
  }
  if (!(m = /^\/pd\/bloomline\/v0\/players\/([^/]+)(?:\/bonsai\/([^/]+))?$/.exec(p))) return null;
  const subject = decodeURIComponent(m[1]).toLowerCase();
  const agent = m[2] ? decodeURIComponent(m[2]).toLowerCase() : undefined;
  const wait = (mode === 'slow' ? 2500 : 0) + (delays.get(subject) ?? 0);
  if (wait) await sleep(wait);
  if (mode === 'error') return [503, { httpStatus: 503, errorCode: 'SERVICE_UNAVAILABLE', message: 'mock outage' }];
  if (mode === 'notfound') return [404, { httpStatus: 404, errorCode: 'RESOURCE_NOT_FOUND', message: 'not found' }];
  if (mode === 'invalid') return [200, { Subject: subject, Bonsais: 'not-a-list' }];
  const presets = mode === 'empty' ? [] : subject === ME ? MINE : OTHER;
  // Like the live service (seen 2026-11-16): a record for every agent, unplayed ones with an empty
  // Flourish, and the per-agent route wrapped the same way as the full list.
  const unplayed = (a: string) => ({ BonsaiID: a, Flourish: {}, TrackProgressList: [{ TrackID: uuid(`track-${a}`) }] });
  if (agent) {
    const pr = presets.find((x) => x.agent === agent);
    return [200, { Subject: subject, Bonsais: [pr ? bonsai(pr, subject, true) : unplayed(agent)], LongGroupVersion: 3 }];
  }
  if (mode === 'empty') return [200, { Subject: subject }];
  const rest = AGENTS.filter((a) => !presets.some((x) => x.agent === a)).map(unplayed);
  // One malformed record: the app must drop it and keep the rest.
  return [200, { Subject: subject, Bonsais: [...presets.map((x) => bonsai(x, subject, false)), ...rest, { BonsaiID: 'garbage', Flourish: { LongLevel: -1 } }], LongGroupVersion: 3 }];
}
