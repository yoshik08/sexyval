// Plain data types for the Part 2-4 screens. No tokens ever appear here.
import type { RankInfo } from './types';

// ---------- Catalog / collection ----------

export interface CatalogLevel {
  id: string;
  name: string;
  item?: string; // levelItem e.g. "EEquippableSkinLevelItem::Animation"
  icon?: string;
  video?: string;
}

export interface CatalogChroma {
  id: string;
  name: string;
  icon?: string;
  render?: string;
  swatch?: string;
  video?: string;
}

/** How a skin is obtained when it is a contract reward rather than a store item. */
export interface SkinSource {
  kind: 'battlepass' | 'event' | 'agent';
  /** Contract display name, e.g. "Dimension: Act 2" or "Gekko Gear". */
  name: string;
  /** Reward position inside the contract (1-based). */
  level: number;
}

export interface CatalogSkin {
  id: string;
  name: string;
  weaponId: string;
  tierId?: string;
  themeId?: string;
  icon?: string;
  wallpaper?: string;
  order: number;
  firstSeen: number;
  levels: CatalogLevel[];
  chromas: CatalogChroma[];
  source?: SkinSource;
}

/**
 * What the UI shows instead of "price unknown".
 * exact   - seen in the live store (daily / night market / bundle); VP is the list price.
 * reward  - not sold; it is a contract reward, `label` says which.
 * typical - the standard price for this tier and weapon kind, shown as an estimate.
 */
export interface PriceQuote {
  kind: 'exact' | 'reward' | 'typical';
  vp?: number;
  /** Full text for a reward, e.g. "Battle Pass · Season 2026 Act III". */
  label?: string;
  /** Which contract type a reward comes from. */
  source?: SkinSource['kind'];
  seenAt?: number;
}

/** Skin id -> quote. Every catalog skin has an entry. */
export type PriceMap = Record<string, PriceQuote>;

export type ExtraKind = 'buddy' | 'spray' | 'card' | 'title';

export interface CatalogExtra {
  kind: ExtraKind;
  id: string;
  name: string;
  icon?: string;
  /** Animated version (sprays: animationGif). */
  anim?: string;
  wide?: string;
  large?: string;
  text?: string;
  themeId?: string;
  /** IDs an entitlement may reference (item uuid + level uuids). */
  ownIds: string[];
  /** For buddies: the level id used when equipping. */
  levelId?: string;
}

export interface CatalogWeapon {
  id: string;
  name: string;
  category: string;
  icon?: string;
  defaultSkinId?: string;
  /** Standard skin ids (needed to unequip a skin in Loadout). */
  defaultSkin?: { id: string; levelId: string; chromaId: string; icon?: string };
}

export interface CatalogTier {
  id: string;
  name: string;
  color?: string;
  icon?: string;
  rank: number;
}

export interface Catalog {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  fetchedAt?: number;
  /** Game version the catalog was built for (valorant-api.com /version). */
  version?: string;
  /** Cache layout version; a mismatch forces a rebuild so new fields appear after an update. */
  schema?: number;
  skins: CatalogSkin[];
  weapons: CatalogWeapon[];
  tiers: CatalogTier[];
  themes: Record<string, string>;
  buddies: CatalogExtra[];
  sprays: CatalogExtra[];
  cards: CatalogExtra[];
  titles: CatalogExtra[];
}

export interface OwnedState {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'signed-out';
  fetchedAt?: number;
  levels: string[];
  chromas: string[];
  buddies: string[];
  sprays: string[];
  cards: string[];
  titles: string[];
  agents: string[];
  /** Buddy level id -> entitlement InstanceIDs (needed to equip). */
  buddyInstances: Record<string, string[]>;
  /** Per type: which response shape was seen, or the error. Debug aid. */
  shapes: Record<string, string>;
  error?: string;
}

export type OwnedFilter = 'all' | 'owned' | 'not-owned';
export type SkinSort = 'owned' | 'tier' | 'name' | 'newest';

export interface SkinFilter {
  owned: OwnedFilter;
  weaponId?: string;
  tierId?: string;
  themeId?: string;
  search?: string;
  sort: SkinSort;
}

// ---------- Accounts / sign-in ----------

export interface AccountInfo {
  id: string;
  name?: string;
  tag?: string;
  puuid?: string;
  region?: string;
  status: 'ok' | 'expired' | 'pending' | 'error';
  active: boolean;
  lastOkAt?: number;
  error?: string;
}

// ---------- Progression ----------

export interface MissionView {
  id: string;
  title: string;
  type: string; // Daily | Weekly | ...
  xp: number;
  progress: number;
  target: number;
  complete: boolean;
  activation?: string;
  expiration?: string;
}

export interface ContractView {
  id: string;
  name: string;
  kind: string; // Season | Event | Agent
  relationId?: string;
  agentName?: string;
  agentIcon?: string;
  level: number;
  maxLevel: number;
  xpIntoLevel: number;
  xpForNext: number;
  nextReward?: { type: string; name: string; icon?: string };
  active: boolean;
  isCurrent: boolean;
}

export interface ProgressionView {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  accountLevel?: number;
  accountXp?: number;
  dailies: MissionView[];
  weeklies: MissionView[];
  queuedWeeklies: MissionView[];
  weeklyCheckpoint?: string;
  weeklyRefill?: string;
  battlepass?: ContractView;
  eventpass?: ContractView;
  agentContracts: ContractView[];
  activeSpecialContract?: string;
}

// ---------- Party ----------

export interface PartyMemberView {
  puuid: string;
  name?: string;
  tag?: string;
  cardIcon?: string;
  level?: number;
  rank?: RankInfo;
  isOwner: boolean;
  isReady: boolean;
  isMe: boolean;
  pings: { pod: string; ping: number }[];
}

export interface PartyView {
  status: 'idle' | 'loading' | 'ready' | 'none' | 'error';
  error?: string;
  partyId?: string;
  state?: string;
  queueId?: string;
  eligibleQueues: string[];
  accessibility?: 'OPEN' | 'CLOSED';
  inviteCode?: string;
  members: PartyMemberView[];
  requests: { id: string; by?: string; subjects: string[] }[];
  preferredPods: string[];
  isOwner: boolean;
  queueEntryTime?: string;
}

// ---------- Loadout ----------

export interface LoadoutGun {
  weaponId: string;
  skinId: string;
  skinLevelId: string;
  chromaId: string;
  charmId?: string;
  charmLevelId?: string;
  charmInstanceId?: string;
  attachments: unknown[];
}

export interface LoadoutView {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  version?: number;
  /** Which personalization API answered (v3 is current; v2 is the retired one). */
  api?: 'v3' | 'v2';
  guns: LoadoutGun[];
  /** Spray wheel in slot order. v3 stores these as `ActiveExpressions` of the spray type. */
  sprays: { slot: number; sprayId: string }[];
  cardId?: string;
  titleId?: string;
  levelBorderId?: string;
  accountLevel?: number;
  hideAccountLevel?: boolean;
  incognito?: boolean;
}

export interface LoadoutPreset {
  id: string;
  name: string;
  createdAt: number;
  loadout: LoadoutView;
}

// ---------- Profiles / history ----------

export interface ScoreboardRow {
  puuid: string;
  name?: string;
  tag?: string;
  teamId: string;
  agentId?: string;
  agentName?: string;
  agentIcon?: string;
  tier: number;
  rank?: RankInfo;
  kills: number;
  deaths: number;
  assists: number;
  acs: number;
  adr: number | null;
  hsPct: number | null;
  firstBloods: number | null;
  avgLoadout: number | null;
  avgSpent: number | null;
}

export interface MatchRow {
  matchId: string;
  startTime: number;
  queueId: string;
  queueTag: string;
  mapId?: string;
  mapName?: string;
  agentId?: string;
  agentName?: string;
  agentIcon?: string;
  result: 'W' | 'L' | 'D' | '-';
  score: string;
  kills: number;
  deaths: number;
  assists: number;
  acs: number;
  adr: number | null;
  hsPct: number | null;
  rrChange?: number;
  tierAfter?: number;
}

export interface ProfileView {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  puuid: string;
  name?: string;
  tag?: string;
  isMe: boolean;
  cardId?: string;
  cardWide?: string;
  title?: string;
  level?: number;
  rank?: RankInfo;
  rr?: number;
  peak?: RankInfo;
  leaderboardRank?: number;
  rrHistory: { t: number; tier: number; rr: number; delta: number; matchId: string }[];
  matches: MatchRow[];
  matchesLoading: boolean;
}

export interface MatchDetailView {
  matchId: string;
  mapName?: string;
  queueTag: string;
  startTime: number;
  lengthMs?: number;
  teams: { teamId: string; won: boolean; roundsWon: number }[];
  rows: ScoreboardRow[];
  rounds: { n: number; winner?: string; result?: string }[];
}

// ---------- Hub ----------

export interface FriendView {
  puuid: string;
  name: string;
  tag: string;
  online: boolean;
  state?: string;
  product?: string;
  status?: string; // decoded valorant presence summary
  partySize?: number;
  level?: number;
  rank?: RankInfo;
  note?: string;
  lastOnline?: number;
}

export interface FriendRequestView {
  puuid: string;
  name: string;
  tag: string;
  direction: 'in' | 'out';
}

export interface LeaderboardView {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  seasonId?: string;
  seasonName?: string;
  region?: string;
  total?: number;
  players: { rank: number; name: string; tag: string; rr: number; wins: number; tier: number; rankInfo?: RankInfo; anonymized: boolean; cardIcon?: string }[];
}

export interface Lineup {
  id: string;
  agentId?: string;
  mapId?: string;
  site?: string;
  title: string;
  notes?: string;
  links: string[];
  images: string[]; // svlocal:// urls
  createdAt: number;
}

export interface WishlistState {
  skinIds: string[];
  lastHits: { skinId: string; at: number }[];
}
