// Agent Mastery (Riot, patch 13.06, 2026-09-22): data contracts, validation and the pure view logic.
// main/services/mastery.ts does the I/O.
//
// Provenance, strictest first. Every value the UI shows carries one of these, and they are never mixed
// into a single number:
//   riot        Riot's own pd endpoint `bloomline/v0` ("Bloomline" is Riot's internal name for mastery).
//               Undocumented: field meanings come from community reverse-engineering
//               (techchrism/valorant-api-docs issue #71) and are validated here, not trusted.
//   entitlements  Your owned items (pd store entitlements), used for reward ownership.
//   catalog     valorant-api.com public content (agents, mastery player cards, old Agent Gear contracts).
//   wiki        VALORANT Wiki (wiki.playvalorant.com, community-edited): MP per level, reward track, prices.
//   snapshot    A copy SexyVal saved earlier, shown with the time it was taken.
//   sexyval     SexyVal analytics from your locally cached matches. Never presented as Riot mastery.

/** Agent Mastery went live with patch 13.06. Earlier play never counted (Riot: everyone started at zero). */
export const MASTERY_LAUNCH = Date.parse('2026-09-22T00:00:00Z');
/** File format of mastery/<puuid>.json. Bump with a migration in migrateMasteryFile. */
export const MASTERY_SCHEMA = 1;
/** Checked on 2026-11-16 against the VALORANT Wiki. */
export const WIKI_CHECKED = '2026-11-16';
export const WIKI_URL = 'https://wiki.playvalorant.com/en-us/Agent_Mastery';
export const GUIDE_URL = 'https://support.riotgames.com/en-us/valorant/gameplay/agent-mastery-guide';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const ZERO = '00000000-0000-0000-0000-000000000000';
/** Sanity bounds: anything beyond these is a broken response, not progress. */
const MAX_LEVEL = 10_000;
const MAX_POINTS = 2_000_000_000;

/** Riot sends dashed lowercase UUIDs in responses and 32-hex uppercase in request bodies. Both → dashed lowercase. */
export function normId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  const d = HEX32.test(s) ? `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}` : s;
  return UUID.test(d) && d !== ZERO ? d : undefined;
}

/**
 * Riot omits zero-valued fields, so a missing number on a present record is 0. A present value that isn't
 * a sane non-negative integer is a broken record (null), which the caller rejects.
 */
function count(v: unknown, max: number): number | null {
  if (v === undefined) return 0;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

// ---------------------------------------------------------------------------------------------------
// Riot response → normalized record

/** One agent's mastery as Riot returned it, normalized. */
export interface AgentMasteryRecord {
  agentId: string;
  /** Flourish.ShortLevel: Act Level this Act. */
  actLevel: number;
  /** Flourish.PreviousShortLevel: Act Level reached last Act (portrait upgrades are kept one extra Act). */
  previousActLevel: number;
  /** Flourish.LongLevel: Lifetime Level, never resets. */
  lifetimeLevel: number;
  /** Flourish.Points: Mastery Points. Read as this Act's total; see actProgress for the consistency check. */
  points: number;
  pointsVersion?: number;
  /** Agent ID slots as Riot names them. No public catalog maps these ids to items yet. Absent = nothing set. */
  slots: { hype?: string; background?: string; clip?: string; border?: string };
  /** Reward track progress (TrackProgressList). */
  tracks: { trackId: string; level: number }[];
}

/** Agent ID stat slots (NumberModules), only in the per-agent response. */
export interface StatSlot {
  slotId?: string;
  /** Which stat (NumberID). Undefined: empty slot. */
  statId?: string;
  value: number;
}

export type ParseResult<T> = { ok: true; value: T; dropped: number } | { ok: false; error: string };

function parseBonsai(b: any): AgentMasteryRecord | null {
  if (!b || typeof b !== 'object') return null;
  const agentId = normId(b.BonsaiID);
  if (!agentId) return null;
  const f = b.Flourish ?? {};
  if (typeof f !== 'object') return null;
  const actLevel = count(f.ShortLevel, MAX_LEVEL);
  const previousActLevel = count(f.PreviousShortLevel, MAX_LEVEL);
  const lifetimeLevel = count(f.LongLevel, MAX_LEVEL);
  const points = count(f.Points, MAX_POINTS);
  if (actLevel === null || previousActLevel === null || lifetimeLevel === null || points === null) return null;
  // Every Act Level also raises the Lifetime Level by one, so the Act Level can never exceed it.
  if (actLevel > lifetimeLevel) return null;
  const tracks = (Array.isArray(b.TrackProgressList) ? b.TrackProgressList : [])
    .map((t: any) => ({ trackId: normId(t?.TrackID), level: count(t?.TrackLevel, MAX_LEVEL) }))
    .filter((t: any): t is { trackId: string; level: number } => !!t.trackId && t.level !== null);
  const pv = count(f.PointsVersion, 1_000_000);
  return {
    agentId,
    actLevel,
    previousActLevel,
    lifetimeLevel,
    points,
    ...(pv ? { pointsVersion: pv } : {}),
    slots: dropUndefined({ hype: normId(b.HypeID), background: normId(b.BackgroundID), clip: normId(b.ClipID), border: normId(b.BorderID) }),
    tracks,
  };
}

function dropUndefined<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/**
 * `GET pd/bloomline/v0/players/{puuid}`. Rejects anything that isn't recognisably this account's mastery:
 * a different Subject (the account changed mid-request), no Bonsais array, or only broken records.
 * Individual broken records are dropped and counted.
 */
export function parseBloomlinePlayer(json: unknown, puuid: string): ParseResult<AgentMasteryRecord[]> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, error: 'Riot sent no mastery data' };
  const j = json as any;
  const subject = normId(j.Subject);
  if (subject && subject !== puuid.toLowerCase()) return { ok: false, error: 'Mastery answer was for a different account' };
  if (j.Bonsais === undefined && subject) return { ok: true, value: [], dropped: 0 }; // empty lists are omitted too
  if (!Array.isArray(j.Bonsais)) return { ok: false, error: 'Unrecognised mastery response from Riot' };
  const seen = new Map<string, AgentMasteryRecord>();
  let dropped = 0;
  for (const b of j.Bonsais) {
    const r = parseBonsai(b);
    if (!r || seen.has(r.agentId)) dropped++;
    else seen.set(r.agentId, r);
  }
  if (j.Bonsais.length && !seen.size) return { ok: false, error: 'Riot’s mastery data could not be read (every agent record was malformed)' };
  return { ok: true, value: [...seen.values()], dropped };
}

/** `GET pd/bloomline/v0/players/{puuid}/bonsai/{agentId}`: the same record plus NumberModules (stat slots). */
export function parseBloomlineBonsai(json: unknown, puuid: string, agentId: string): ParseResult<{ record?: AgentMasteryRecord; stats: StatSlot[] }> {
  const j = json as any;
  if (!j || typeof j !== 'object') return { ok: false, error: 'Riot sent no mastery data' };
  const subject = normId(j.Subject);
  if (subject && subject !== puuid.toLowerCase()) return { ok: false, error: 'Mastery answer was for a different account' };
  // The single-agent response has been seen both as a bare bonsai and wrapped in Bonsais.
  const raw = Array.isArray(j.Bonsais) ? j.Bonsais.find((b: any) => normId(b?.BonsaiID) === agentId) : j.BonsaiID ? j : undefined;
  if (Array.isArray(j.Bonsais) && j.Bonsais.length && !raw) return { ok: false, error: 'Mastery answer was for a different agent' };
  const record = raw ? (parseBonsai(raw) ?? undefined) : undefined;
  if (raw && !record) return { ok: false, error: 'Riot’s mastery record for this agent was malformed' };
  let dropped = 0;
  const stats: StatSlot[] = [];
  for (const m of Array.isArray(raw?.NumberModules) ? raw.NumberModules : []) {
    const value = typeof m?.Value === 'number' && Number.isFinite(m.Value) && m.Value >= 0 ? m.Value : null;
    if (value === null) {
      dropped++;
      continue;
    }
    stats.push(dropUndefined({ slotId: normId(m.ModuleID), statId: normId(m.NumberID), value }));
  }
  return { ok: true, value: { record, stats: stats.slice(0, 3) }, dropped };
}

/** `GET pd/bloomline/v0/config/valid-queues`. */
export function parseValidQueues(json: unknown): { processed: string[]; performance: string[] } | null {
  const j = json as any;
  if (!j || typeof j !== 'object' || !Array.isArray(j.ProcessedQueues)) return null;
  const ids = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && /^[a-z0-9_-]{1,40}$/i.test(x)) : []);
  return { processed: ids(j.ProcessedQueues), performance: ids(j.PerformanceScoreQueues) };
}

// ---------------------------------------------------------------------------------------------------
// Act Levels (community thresholds) and portrait treatment (official rules)

/**
 * MP needed for each Act Level, from the VALORANT Wiki (community; Riot hasn't published these). Index =
 * level. Above level 30 the wiki has no data, so progress past it is not shown.
 */
export const ACT_LEVEL_MP: readonly number[] = [0, 2000, 8500, 9300, 10500, 12000, 13800, 15800, 17900, 20100, 22500, 35000, 78000, 205000, 418000, ...Array<number>(16).fill(715000)];
/** Cumulative MP at the start of each level. */
export const ACT_LEVEL_TOTAL: readonly number[] = ACT_LEVEL_MP.reduce<number[]>((acc, mp, i) => (acc.push(i ? acc[i - 1] + mp : 0), acc), []);
/** Riot: 10 main Act Levels per Act; you can keep levelling past it. */
export const ACT_MAIN_LEVELS = 10;

export interface ActProgress {
  /** MP into the current level and the MP that level needs (community table). */
  into: number;
  need: number;
  nextLevel: number;
}

/**
 * Progress to the next Act Level: Riot's points against the community table. Returned only when the two
 * agree (the points fall inside the current level's band). When they don't, the reading of Points or the
 * table is wrong for this agent, and showing a bar would invent progress.
 */
export function actProgress(level: number, points: number): { ok: true; progress: ActProgress } | { ok: false; reason: 'beyond-table' | 'mismatch' } {
  if (level + 1 >= ACT_LEVEL_TOTAL.length) return { ok: false, reason: 'beyond-table' };
  const start = ACT_LEVEL_TOTAL[level];
  const end = ACT_LEVEL_TOTAL[level + 1];
  if (points < start || points >= end) return { ok: false, reason: 'mismatch' };
  return { ok: true, progress: { into: points - start, need: end - start, nextLevel: level + 1 } };
}

/**
 * Portrait accents: Riot unlocks them at Act Levels 4, 7 and 10 (the wiki adds the level indicator at 1),
 * and keeps what you earned for one more Act, so the better of this Act and last Act counts.
 * 0 none · 1 level indicator · 2 indicator upgrade · 3 background upgrade · 4 animated background.
 */
export function portraitTier(actLevel: number, previousActLevel: number): 0 | 1 | 2 | 3 | 4 {
  const l = Math.max(actLevel, previousActLevel);
  return l >= 10 ? 4 : l >= 7 ? 3 : l >= 4 ? 2 : l >= 1 ? 1 : 0;
}
export const PORTRAIT_STEPS = [
  { level: 1, name: 'Level indicator' },
  { level: 4, name: 'Indicator upgrade' },
  { level: 7, name: 'Background upgrade' },
  { level: 10, name: 'Animated background' },
] as const;

// ---------------------------------------------------------------------------------------------------
// Reward track (wiki) and Agent ID stats (Riot's list, wiki unlock levels)

export type RewardCategory = 'spray' | 'title' | 'card' | 'stat' | 'quote' | 'frame' | 'background' | 'skin' | 'buddy' | 'pose';
export interface TrackReward {
  level: number;
  category: RewardCategory;
  name: string;
  /** Kingdom Credits (wiki). */
  kc: number;
  stat?: StatKey;
}

/** Per-agent reward track, identical in layout for every agent (VALORANT Wiki, checked WIKI_CHECKED). */
export const REWARD_TRACK: readonly TrackReward[] = [
  { level: 5, category: 'spray', name: 'Spray', kc: 4000 },
  { level: 5, category: 'title', name: 'Player title', kc: 2500 },
  { level: 5, category: 'card', name: 'Player card', kc: 4500 },
  { level: 5, category: 'stat', name: 'KD stat', kc: 2500, stat: 'kd' },
  { level: 5, category: 'quote', name: 'Quote', kc: 5000 },
  { level: 10, category: 'stat', name: 'MVPs stat', kc: 2500, stat: 'mvps' },
  { level: 10, category: 'frame', name: 'Level II frame', kc: 2500 },
  { level: 10, category: 'stat', name: 'Headshots stat', kc: 2500, stat: 'headshots' },
  { level: 10, category: 'background', name: 'Agent Role background', kc: 6000 },
  { level: 10, category: 'card', name: 'Player card', kc: 4500 },
  { level: 15, category: 'skin', name: 'Sidearm skin', kc: 8000 },
  { level: 15, category: 'quote', name: 'Quote', kc: 5000 },
  { level: 15, category: 'spray', name: 'Spray', kc: 4000 },
  { level: 15, category: 'stat', name: 'First Bloods stat', kc: 2500, stat: 'firstBloods' },
  { level: 20, category: 'buddy', name: 'Gun buddy', kc: 5500 },
  { level: 20, category: 'stat', name: 'Win Rate stat', kc: 2500, stat: 'winRate' },
  { level: 20, category: 'title', name: 'Player title', kc: 2500 },
  { level: 20, category: 'background', name: 'VALORANT background', kc: 6000 },
  { level: 20, category: 'frame', name: 'Level III frame', kc: 5000 },
  { level: 25, category: 'spray', name: 'Spray', kc: 4000 },
  { level: 25, category: 'stat', name: 'Clutches stat', kc: 2500, stat: 'clutches' },
  { level: 25, category: 'background', name: 'Agent Lore background', kc: 6000 },
  { level: 25, category: 'pose', name: 'Mastery I pose', kc: 7500 },
  { level: 30, category: 'title', name: 'Player title', kc: 2500 },
  { level: 30, category: 'quote', name: 'Quote', kc: 5000 },
  { level: 30, category: 'stat', name: 'Aces stat', kc: 2500, stat: 'aces' },
  { level: 30, category: 'card', name: 'Mastery player card (animated)', kc: 7500 },
  { level: 30, category: 'frame', name: 'Level IV frame', kc: 7500 },
];
export const TRACK_LEVELS = [...new Set(REWARD_TRACK.map((r) => r.level))];

export type StatKey = 'assists' | 'actLevel10s' | 'hoursPlayed' | 'gamesWon' | 'damage' | 'kills' | 'kd' | 'mvps' | 'winRate' | 'aces' | 'clutches' | 'firstBloods' | 'headshots';
export interface StatDef {
  key: StatKey;
  name: string;
  /** Riot: available without unlocking. */
  default: boolean;
  /** Lifetime Level that makes it purchasable (wiki), for unlockable stats. */
  unlockLevel?: number;
}
/** Riot's support guide lists which stats are default and which unlock from the track. */
export const STAT_DEFS: readonly StatDef[] = [
  { key: 'assists', name: 'Assists', default: true },
  { key: 'actLevel10s', name: 'Act Level 10s', default: true },
  { key: 'hoursPlayed', name: 'Hours played', default: true },
  { key: 'gamesWon', name: 'Games won', default: true },
  { key: 'damage', name: 'Damage', default: true },
  { key: 'kills', name: 'Kills', default: true },
  ...REWARD_TRACK.filter((r) => r.stat).map((r) => ({ key: r.stat!, name: r.name.replace(/ stat$/, ''), default: false, unlockLevel: r.level })),
];

/**
 * NumberID → stat. Deliberately empty: no public source maps these ids, and guessing would put the wrong
 * label on Riot's numbers. Add an entry only once it's been confirmed against the game.
 */
export const KNOWN_STAT_IDS: Readonly<Record<string, StatKey>> = {};

// ---------------------------------------------------------------------------------------------------
// Snapshot file (mastery/<puuid>.json)

export interface ActRef {
  id: string;
  label: string;
  start: number;
  end: number;
}

export interface MasterySnapshot {
  /** When Riot answered. */
  at: number;
  /** The Act that was current when it answered (from the public content catalog), if known. */
  act?: { id: string; label: string };
  agents: AgentMasteryRecord[];
}

/** Last Act Level SexyVal saw for each agent in an Act it was running in. Only real observations. */
export interface ActHistory {
  id: string;
  label: string;
  lastSeenAt: number;
  levels: Record<string, number>;
}

export interface MasteryFile {
  schema: number;
  puuid: string;
  current?: MasterySnapshot;
  acts: ActHistory[];
  /** Agent ID stat slots per agent, with when Riot sent them. */
  stats: Record<string, { at: number; slots: StatSlot[] }>;
  queues?: { at: number; processed: string[]; performance: string[] };
}

export const emptyMasteryFile = (puuid: string): MasteryFile => ({ schema: MASTERY_SCHEMA, puuid, acts: [], stats: {} });

/**
 * Stored file → current schema. Returns null for a file this version can't use (other account, newer
 * schema, wrong shape); the caller sets it aside instead of overwriting it.
 */
export function migrateMasteryFile(raw: unknown, puuid: string): MasteryFile | null {
  const r = raw as any;
  if (!r || typeof r !== 'object' || typeof r.schema !== 'number') return null;
  if (r.schema > MASTERY_SCHEMA || r.puuid !== puuid) return null;
  // (No older schema exists yet. A v2 adds `if (r.schema === 1) r = {...r, schema: 2, ...}` here.)
  const agents = Array.isArray(r.current?.agents) ? r.current.agents.filter((a: any) => normId(a?.agentId)) : null;
  return {
    schema: MASTERY_SCHEMA,
    puuid,
    current: agents && Number.isFinite(r.current.at) ? { at: r.current.at, act: r.current.act, agents } : undefined,
    acts: Array.isArray(r.acts) ? r.acts.filter((a: any) => a && typeof a.id === 'string' && a.levels && typeof a.levels === 'object').slice(-24) : [],
    stats: r.stats && typeof r.stats === 'object' ? r.stats : {},
    queues: r.queues && Array.isArray(r.queues.processed) ? r.queues : undefined,
  };
}

/** Pure: records a fresh answer from Riot into the file (history keeps the last value seen per Act). */
export function recordSnapshot(file: MasteryFile, snap: MasterySnapshot): MasteryFile {
  const acts = [...file.acts];
  if (snap.act) {
    let h = acts.find((a) => a.id === snap.act!.id);
    if (!h) {
      h = { id: snap.act.id, label: snap.act.label, lastSeenAt: 0, levels: {} };
      acts.push(h);
    }
    const next = { ...h, label: snap.act.label, lastSeenAt: snap.at, levels: { ...h.levels } };
    for (const a of snap.agents) if (a.actLevel > 0) next.levels[a.agentId] = a.actLevel;
    acts[acts.indexOf(h)] = next;
  }
  return { ...file, current: snap, acts: acts.slice(-24) };
}

// ---------------------------------------------------------------------------------------------------
// Views (what the renderer gets)

export interface AgentMeta {
  id: string;
  name: string;
  role?: string;
  roleIcon?: string;
  icon?: string;
  portrait?: string;
  background?: string;
  colors?: string[];
}

/** progress: Riot has a record · none: Riot answered and has no record for this agent (never played since 13.06) · unknown: no data at all. */
export type AgentMasteryState = 'progress' | 'none' | 'unknown';

export interface AgentMasteryView extends AgentMeta {
  state: AgentMasteryState;
  /** Null when the snapshot is from an earlier Act (the Act Level reset since) or there's no data. */
  actLevel: number | null;
  /** Riot's PreviousShortLevel; for a stale snapshot, the level seen in that Act. */
  previousActLevel: number | null;
  lifetimeLevel: number | null;
  /** Riot's MP; null with actLevel. */
  points: number | null;
  progress: ActProgress | null;
  progressNote?: 'beyond-table' | 'mismatch';
  portraitTier: 0 | 1 | 2 | 3 | 4;
  /** Track milestones (5, 10, …) the Lifetime Level has reached. */
  milestones: number;
  slots: AgentMasteryRecord['slots'];
}

export interface MasteryView {
  puuid: string;
  /** live: Riot answered this session · snapshot: an earlier save · none: nothing yet. */
  source: 'live' | 'snapshot' | 'none';
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  /** Last successful answer from Riot. */
  syncedAt?: number;
  act?: ActRef;
  /** The snapshot was taken in an earlier Act: Act values aren't current any more (Lifetime still is). */
  actChanged?: { from: string };
  agents: AgentMasteryView[];
  /** Records Riot sent that failed validation (Debug aid). */
  dropped?: number;
  queues?: { processed: string[]; performance: string[] };
}

export type SortKey = 'act' | 'lifetime' | 'name';

/** Pure: the grid view for one account. Every playable agent appears, with or without data. */
export function buildMasteryView(o: {
  puuid: string;
  file: MasteryFile | null;
  agents: AgentMeta[];
  act?: ActRef | null;
  live: boolean;
  status: MasteryView['status'];
  error?: string;
  dropped?: number;
}): MasteryView {
  const snap = o.file?.current;
  const byId = new Map((snap?.agents ?? []).map((a) => [a.agentId, a]));
  // The Act changed since the snapshot: Riot reset every Act Level, so the saved ones are history now.
  const actChanged = !!(snap && o.act && snap.act && snap.act.id !== o.act.id);
  const agents = o.agents.map((m): AgentMasteryView => {
    const raw = byId.get(m.id);
    // Riot sends a record for every agent; one never played since 13.06 has an empty Flourish (all zero).
    const r = raw && (raw.points || raw.lifetimeLevel || raw.actLevel || raw.previousActLevel || Object.keys(raw.slots).length) ? raw : undefined;
    if (!snap) return { ...m, state: 'unknown', actLevel: null, previousActLevel: null, lifetimeLevel: null, points: null, progress: null, portraitTier: 0, milestones: 0, slots: {} };
    if (!r) {
      // Riot answered without this agent: no mastery on it yet. That is real zero progress, but only for
      // this Act if the snapshot is current.
      return { ...m, state: 'none', actLevel: actChanged ? null : 0, previousActLevel: actChanged ? null : 0, lifetimeLevel: 0, points: actChanged ? null : 0, progress: null, portraitTier: 0, milestones: 0, slots: {} };
    }
    const prog = actChanged ? null : actProgress(r.actLevel, r.points);
    return {
      ...m,
      state: 'progress',
      actLevel: actChanged ? null : r.actLevel,
      // After an Act change the snapshot's own Act Level becomes "last Act"; its previous level is two Acts old.
      previousActLevel: actChanged ? r.actLevel : r.previousActLevel,
      lifetimeLevel: r.lifetimeLevel,
      points: actChanged ? null : r.points,
      progress: prog && prog.ok ? prog.progress : null,
      progressNote: prog && !prog.ok ? prog.reason : undefined,
      portraitTier: actChanged ? portraitTier(0, r.actLevel) : portraitTier(r.actLevel, r.previousActLevel),
      milestones: TRACK_LEVELS.filter((l) => r.lifetimeLevel >= l).length,
      slots: r.slots,
    };
  });
  return {
    puuid: o.puuid,
    source: !snap ? 'none' : o.live ? 'live' : 'snapshot',
    status: o.status,
    error: o.error,
    syncedAt: snap?.at,
    act: o.act ?? undefined,
    actChanged: actChanged ? { from: snap!.act!.label } : undefined,
    agents,
    dropped: o.dropped,
    queues: o.file?.queues ? { processed: o.file.queues.processed, performance: o.file.queues.performance } : undefined,
  };
}

/** Pure: grid order. Agents without data sort after agents with data under the level sorts. */
export function sortAgents(list: AgentMasteryView[], key: SortKey): AgentMasteryView[] {
  const lv = (v: number | null) => (v === null ? -1 : v);
  const byName = (a: AgentMasteryView, b: AgentMasteryView) => a.name.localeCompare(b.name);
  return [...list].sort((a, b) => {
    if (key === 'name') return byName(a, b);
    if (key === 'act') return lv(b.actLevel) - lv(a.actLevel) || (b.points ?? -1) - (a.points ?? -1) || lv(b.lifetimeLevel) - lv(a.lifetimeLevel) || byName(a, b);
    return lv(b.lifetimeLevel) - lv(a.lifetimeLevel) || lv(b.actLevel) - lv(a.actLevel) || byName(a, b);
  });
}

// ---------------------------------------------------------------------------------------------------
// Rewards and ownership

/**
 * equipped / owned: from Riot (entitlements or the Agent ID slots) · available: the Lifetime Level unlocked
 * it and you don't own it · locked: Lifetime Level too low · unknown: unlocked, but no source can say
 * whether you bought it.
 */
export type RewardState = 'equipped' | 'owned' | 'available' | 'locked' | 'unknown';

export interface CosmeticRef {
  type: 'spray' | 'card' | 'title' | 'buddy' | 'skin';
  id: string;
  name: string;
  icon?: string;
  /** Bigger art for the reward tile: the card's tall art, the spray's full icon. */
  art?: string;
  /** A title's text. */
  text?: string;
}

export interface RewardRow extends TrackReward {
  state: RewardState;
  /** When the exact item is known: the mastery card, and the Agent Gear items slotted in by matchGearToTrack. */
  item?: CosmeticRef;
}

/** Owned item ids by type, from entitlements. Null: ownership couldn't be read. */
export interface OwnedIds {
  sprays: Set<string>;
  cards: Set<string>;
  titles: Set<string>;
  buddies: Set<string>;
  skins: Set<string>;
}

function ownsRef(owned: OwnedIds, r: CosmeticRef): boolean {
  const set = { spray: owned.sprays, card: owned.cards, title: owned.titles, buddy: owned.buddies, skin: owned.skins }[r.type];
  return set.has(r.id);
}

const GEAR_SLOT: Partial<Record<RewardCategory, CosmeticRef['type']>> = { spray: 'spray', card: 'card', title: 'title', buddy: 'buddy', skin: 'skin' };

/**
 * Pure: track index → Agent Gear item. The wiki's per-agent tables show the mastery track reuses the old
 * Agent Gear items (Neon: sprays at 5/15/25, cards at 5/10, titles at 5/20, buddy at 20, sidearm at 15)
 * in contract order. A category is matched only when the counts agree exactly; otherwise its slots stay
 * generic rather than risk naming the wrong item.
 */
export function matchGearToTrack(gear: CosmeticRef[]): Map<number, CosmeticRef> {
  const out = new Map<number, CosmeticRef>();
  for (const [cat, type] of Object.entries(GEAR_SLOT) as [RewardCategory, CosmeticRef['type']][]) {
    const items = gear.filter((g) => g.type === type);
    // The Lifetime 30 card is always the Bloomline mastery card (matched separately). The 30 title is the
    // third Agent Gear title for the launch agents (Sage: Warden/Enlightened/Dauntless), a new one otherwise.
    const all = REWARD_TRACK.map((r, i) => [r, i] as const).filter(([r]) => r.category === cat && !(cat === 'card' && r.level === 30));
    const slots = items.length === all.length ? all : cat === 'title' && items.length === all.length - 1 ? all.filter(([r]) => r.level !== 30) : null;
    slots?.forEach(([, i], n) => out.set(i, items[n]));
  }
  return out;
}

/** Pure: the reward track for one agent. `lifetime` null (no data) leaves every row's eligibility unknown. */
export function rewardRows(lifetime: number | null, masteryCard: CosmeticRef | undefined, owned: OwnedIds | null, statOwned: Set<StatKey>, gear: CosmeticRef[] = []): RewardRow[] {
  const matched = matchGearToTrack(gear);
  return REWARD_TRACK.map((r, i) => {
    const item = r.category === 'card' && r.level === 30 ? masteryCard : matched.get(i);
    let state: RewardState;
    if (item && owned && ownsRef(owned, item)) state = 'owned';
    else if (r.stat && statOwned.has(r.stat)) state = 'equipped';
    else if (lifetime === null) state = 'unknown';
    else if (lifetime < r.level) state = 'locked';
    else if (item && owned) state = 'available';
    else state = 'unknown';
    return { ...r, item, state };
  });
}

/** Pure: items from the agent's old Agent Gear contract (carried into the mastery track) with real ownership. */
export function gearCosmetics(levels: { rewardType?: string; rewardId?: string }[], resolve: (type: string, id: string) => { name: string; icon?: string; art?: string; text?: string }, owned: OwnedIds | null): (CosmeticRef & { owned: boolean | null })[] {
  const TYPE: Record<string, CosmeticRef['type']> = { Spray: 'spray', PlayerCard: 'card', Title: 'title', EquippableCharmLevel: 'buddy', EquippableSkinLevel: 'skin' };
  const out: (CosmeticRef & { owned: boolean | null })[] = [];
  for (const l of levels) {
    const type = TYPE[String(l.rewardType)];
    const id = normId(l.rewardId);
    if (!type || !id) continue;
    const ref: CosmeticRef = { type, id, ...resolve(String(l.rewardType), id) };
    out.push({ ...ref, owned: owned ? ownsRef(owned, ref) : null });
  }
  return out;
}

/**
 * Pure: valorant-api.com files each agent's mastery player card under PlayerCards/Bloomline/Bloomline_<dev>_…,
 * where <dev> is the agent's developer name. developerName → card id.
 */
export function masteryCardsByDeveloperName(cards: { uuid?: string; assetPath?: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of cards) {
    const m = /\/Bloomline\/Bloomline_([A-Za-z0-9]+)_\d+\//.exec(String(c.assetPath ?? ''));
    const id = normId(c.uuid);
    if (m && id && !out[m[1].toLowerCase()]) out[m[1].toLowerCase()] = id;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Statistics

export interface StatSlotView {
  slotId?: string;
  statId?: string;
  /** Named only through KNOWN_STAT_IDS. */
  stat?: StatDef;
  value: number;
}

/** Pure: which stats are usable on the Agent ID at this Lifetime Level (Riot's list, wiki levels). */
export function statAvailability(lifetime: number | null): { def: StatDef; state: 'default' | 'eligible' | 'locked' | 'unknown' }[] {
  return STAT_DEFS.map((def) => ({ def, state: def.default ? 'default' : lifetime === null ? 'unknown' : lifetime >= (def.unlockLevel ?? 0) ? 'eligible' : 'locked' }));
}

export function statSlotViews(slots: StatSlot[]): StatSlotView[] {
  return slots.map((s) => {
    const key = s.statId ? KNOWN_STAT_IDS[s.statId] : undefined;
    return { ...s, stat: key ? STAT_DEFS.find((d) => d.key === key) : undefined };
  });
}

/** Modes Riot's guide says earn MP. Riot's valid-queues list replaces this when it answers. */
export const MASTERY_QUEUES: readonly string[] = ['competitive', 'unrated', 'swiftplay', 'spikerush', 'hurm', 'premier'];

/** Minimal match row for analytics (a subset of the warehouse row). */
export interface AnalyticsRow {
  t: number;
  queue: string;
  agent?: string;
  result: 'W' | 'L' | 'D' | '-';
  k: number;
  d: number;
  a: number;
  hs: number | null;
  fk: number | null;
  lengthMs?: number;
  adr: number | null;
  rounds: number;
}

export interface AgentAnalytics {
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
  hours: number;
  kd: number | null;
  winRate: number | null;
  /** Average of per-match headshot % where known. */
  hsPct: number | null;
  firstBloods: number | null;
  damage: number | null;
  from?: number;
  to?: number;
}

/**
 * SexyVal analytics for one agent from cached matches since `since` (mastery launch or the Act start).
 * Covers only matches SexyVal has seen, so it is a lower bound and never Riot's mastery stats.
 */
export function agentAnalytics(rows: AnalyticsRow[], agentId: string, since: number, until = Infinity, queues: readonly string[] = MASTERY_QUEUES): AgentAnalytics {
  const q = new Set(queues);
  const mine = rows.filter((r) => r.agent === agentId && r.t >= since && r.t < until && q.has(r.queue));
  const sum = (f: (r: AnalyticsRow) => number) => mine.reduce((a, r) => a + f(r), 0);
  const wins = mine.filter((r) => r.result === 'W').length;
  const decided = mine.filter((r) => r.result === 'W' || r.result === 'L').length;
  const kills = sum((r) => r.k);
  const deaths = sum((r) => r.d);
  const hs = mine.filter((r) => r.hs !== null);
  const fk = mine.filter((r) => r.fk !== null);
  const dmg = mine.filter((r) => r.adr !== null && r.rounds > 0);
  return {
    matches: mine.length,
    wins,
    kills,
    deaths,
    assists: sum((r) => r.a),
    hours: sum((r) => r.lengthMs ?? 0) / 3_600_000,
    kd: mine.length ? (deaths ? kills / deaths : kills) : null,
    winRate: decided ? wins / decided : null,
    hsPct: hs.length ? hs.reduce((a, r) => a + (r.hs ?? 0), 0) / hs.length : null,
    firstBloods: fk.length ? fk.reduce((a, r) => a + (r.fk ?? 0), 0) : null,
    damage: dmg.length ? Math.round(dmg.reduce((a, r) => a + (r.adr ?? 0) * r.rounds, 0)) : null,
    from: mine.length ? Math.min(...mine.map((r) => r.t)) : undefined,
    to: mine.length ? Math.max(...mine.map((r) => r.t)) : undefined,
  };
}

// ---------------------------------------------------------------------------------------------------
// Agent detail (one rpc call)

export interface AgentMasteryDetail {
  puuid: string;
  agent: AgentMasteryView;
  act?: ActRef;
  actChanged?: { from: string };
  syncedAt?: number;
  source: MasteryView['source'];
  /** Act Levels SexyVal saw in earlier Acts, newest first. */
  history: { id: string; label: string; level: number; lastSeenAt: number }[];
  rewards: RewardRow[];
  /** Items carried over from the agent's Agent Gear contract and its mastery card, with real ownership. */
  cosmetics: (CosmeticRef & { owned: boolean | null; origin: 'gear' | 'mastery' })[];
  ownershipAt?: number;
  stats: { slots: StatSlotView[]; at?: number; error?: string; availability: ReturnType<typeof statAvailability> };
  analytics: { sinceLaunch: AgentAnalytics; thisAct: AgentAnalytics | null; matchesCached: number; queues: string[] };
}
