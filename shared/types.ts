// Plain data shared between main and renderer. No tokens ever appear here.

export type ConnStatus = 'waiting' | 'connecting' | 'connected' | 'error';

export interface Connection {
  status: ConnStatus;
  message: string;
  /** Riot Client local API reachable and signed in. */
  riotClient?: 'up' | 'down';
  /** Valorant process present in external-sessions. Only Live needs it. */
  valorant?: boolean;
  tokenSource?: 'riot-client' | 'signin' | 'none';
  account?: string;
  regionSource?: string;
  region?: string;
  shard?: string;
  version?: string;
  versionSource?: string;
  puuid?: string;
  mock: boolean;
  lastPollAt?: number;
  backoffMs?: number;
  /** Riot Client local WebSocket (instant phase changes). Polling continues either way. */
  events?: 'connected' | 'connecting' | 'off';
}

/** queue = your party is matchmaking (party State MATCHMAKING). */
export type Phase = 'idle' | 'queue' | 'pregame' | 'ingame';

export interface QueueView {
  queueId: string;
  queueTag: string;
  queueName: string;
  /** When matchmaking started (party QueueEntryTime), ms. */
  enteredAt?: number;
  /** Party RR penalty (SkillDisparityRRPenalty, 0–1). */
  rrPenalty?: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  icon?: string;
  portrait?: string;
  role?: string;
}

export interface MapInfo {
  id: string;
  name: string;
  splash?: string;
  listIcon?: string;
}

export interface RankInfo {
  tier: number;
  name: string;
  icon?: string;
  color?: string;
}

export type MatchResult = 'W' | 'L' | 'D' | '-';

export interface MatchSummary {
  matchId: string;
  startTime: number;
  result: MatchResult;
  agent?: AgentInfo;
  kills: number;
  deaths: number;
  assists: number;
  acs: number;
  map?: string;
  queueTag: string;
  score: string;
}

export interface PlayerSummary {
  count: number;
  wins: number;
  losses: number;
  kd: number;
  acs: number;
}

export interface Last5State {
  status: 'idle' | 'loading' | 'done' | 'error' | 'skipped';
  matches: MatchSummary[];
  summary?: PlayerSummary;
  error?: string;
}

/** SexyVal's own score (shared/score.ts), 0-1000. Not Tracker Score. */
export interface SvScore {
  score: number;
  /** Matches with round data that went into it. */
  sample: number;
  parts: {
    acs: number;
    kd: number;
    adr: number;
    hsPct: number;
    fbPerRound: number;
    wins: number;
    losses: number;
  };
}

export interface RankWithRR {
  /** Undefined = no rank this act (Unrated). */
  rank?: RankInfo;
  rr: number;
}

export interface MmrState {
  status: 'loading' | 'done' | 'error';
  current?: RankWithRR;
  /** Highest tier across every act, and the act it was reached in. */
  peak?: { rank?: RankInfo; act?: string };
  error?: string;
}

export interface PlayerRow {
  puuid: string;
  name?: string;
  tag?: string;
  incognito: boolean;
  isMe: boolean;
  teamId: string;
  agent?: AgentInfo;
  selectionState?: string;
  rank?: RankInfo;
  accountLevel?: number;
  last5: Last5State;
  /** Undefined for hidden players (never computed); null when fewer than 3 matches have round data. */
  svScore?: SvScore | null;
  /** Current + peak rank from mmr/v1. Undefined for hidden players (never fetched). */
  mmr?: MmrState;
}

/** Starting side from the hardcoded rule (shared/side.ts). `side` is null when the mode has none. */
export interface SideInfo {
  side: 'ATK' | 'DEF' | null;
  /** True only for queues checked against real matches (competitive). */
  verified: boolean;
}

export interface PregameView {
  matchId: string;
  map?: MapInfo;
  mode: string;
  modeName: string;
  queueId: string;
  queueTag: string;
  phaseEndsAt?: number;
  allyTeamId: string;
  allies: PlayerRow[];
  enemySize: number;
  enemyLocked: number;
  side: SideInfo;
}

export interface CoreGameView {
  matchId: string;
  map?: MapInfo;
  mode: string;
  modeName: string;
  queueId: string;
  queueTag: string;
  myTeamId: string;
  myTeam: PlayerRow[];
  enemyTeam: PlayerRow[];
}

export interface AppState {
  conn: Connection;
  phase: Phase;
  queue?: QueueView;
  pregame?: PregameView;
  coregame?: CoreGameView;
  me?: PlayerRow;
  assetsReady: boolean;
  updatedAt: number;
}

export interface ShopItem {
  offerId: string;
  skinId?: string;
  levelId?: string;
  owned?: boolean;
  watched?: boolean;
  name: string;
  icon?: string;
  tier?: { name: string; icon?: string; color?: string };
  cost: number;
  baseCost?: number;
  discountPercent?: number;
}

export interface ShopView {
  status: 'idle' | 'loading' | 'done' | 'error';
  error?: string;
  daily: ShopItem[];
  dailyEndsAt?: number;
  night?: { items: ShopItem[]; endsAt?: number };
  bundles?: { id: string; name: string; icon?: string; endsAt?: number; items: ShopItem[]; total?: number; totalBase?: number }[];
  v2Status?: number;
  wallet: { vp: number; rad: number; kc: number } | null;
  fetchedAt?: number;
  source?: string;
}

export interface Settings {
  /** Bumped whenever a one-time settings migration runs; absent/stale on disk means "run the pending migrations". */
  settingsVersion: number;
  launchAtStartup: boolean;
  closeToTray: boolean;
  pollMs: number;
  historyQueue: string;
  notifications: boolean;
  cacheVideos: boolean;
  /** Largest the on-disk video cache may grow, in MB (least recently used files are dropped first). */
  videoCacheMaxMb: number;
  /** Short muted preview when you rest the pointer on a skin tile. */
  hoverPreviews: boolean;
  /** Skin videos in the detail view play with sound. */
  soundOn: boolean;
  appIcon: 'red' | 'teal' | 'gold' | 'mono';
  platformType: 'PC' | 'xbox' | 'playstation';
  window: { width: number; height: number; x?: number; y?: number; maximized?: boolean };
  /** Small always-on-top ATK/DEF pill shown only during agent select. */
  overlayEnabled: boolean;
  overlayPosition: OverlayPosition;
  overlayScale: OverlayScale;
  /** Electron display id; null = primary display. */
  overlayDisplay: number | null;
  /** Overlay pops up with "Match found" the moment the queue pops. */
  overlayMatchFound: boolean;
  /** HenrikDev API key (price source). The renderer only ever gets a masked copy; never logged. */
  henrikKey: string;
  /** Live player rows: auto = compact when narrow or 10 players in game. */
  liveDensity: LiveDensity;
  /** MMR tab: Solo or Team view; auto = Team when your window has stacked games. */
  mmrView: 'auto' | 'solo' | 'team';
  /** Silent background updates (installed build only; the portable build can't self-update). */
  autoUpdate: boolean;
  /** Stretched resolution while Valorant runs (Settings → Stretch). */
  stretchEnabled: boolean;
  stretchRes: { w: number; h: number };
  /** Display device name (\\.\DISPLAY1); null = primary. */
  stretchDevice: string | null;
  stretchNativeOnAltTab: boolean;
  /** Game boost (Settings → Boost): master switch and each tweak. */
  boostEnabled: boolean;
  boostTweaks: Record<string, boolean>;
}

export interface StretchStatus {
  line: string;
  error?: string;
  phase: 'off' | 'idle' | 'stretched' | 'native-alt-tab';
  monitors: { device: string; name: string; primary: boolean; current: { w: number; h: number; hz: number }; modes: { w: number; h: number; hz: number }[] }[];
  dryRun: boolean;
}

export interface BoostStatus {
  enabled: boolean;
  gameRunning: boolean;
  tweaks: { id: string; label: string; scope: 'session' | 'persistent'; admin: boolean; on: boolean; applied: boolean; note?: string; error?: string }[];
  /** Hardware-accelerated GPU scheduling as Windows reports it now. */
  hags?: 'on' | 'off' | 'unknown';
  /** The elevated helper task exists (one UAC prompt to create it). */
  elevatedReady: boolean;
  preset: { canApply: boolean; hasBackup: boolean; message?: string };
  dryRun: boolean;
}

export type LiveDensity = 'auto' | 'compact' | 'detailed';

export type OverlayPosition = 'top-center' | 'top-left' | 'top-right';
export type OverlayScale = 'small' | 'medium';

export interface DebugDump {
  raw: Record<string, { at: number; data: unknown }>;
  unknownKeys: Record<string, string[]>;
  logs: string[];
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  availableVersion?: string;
  progressPercent?: number;
  error?: string;
  lastCheckedAt?: number;
  /** The portable build can't self-update; Settings shows a plain link instead. */
  portable: boolean;
  releasesUrl: string;
}

export interface Toast {
  id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

export type View = 'live' | 'shop' | 'collection' | 'progress' | 'party' | 'loadout' | 'profiles' | 'mmr' | 'hub' | 'settings';

export interface SexyValApi {
  getState(): Promise<AppState>;
  onState(cb: (s: AppState) => void): () => void;
  onToast(cb: (t: Toast) => void): () => void;
  onNav(cb: (v: string) => void): () => void;
  getShop(): Promise<ShopView>;
  refreshShop(): Promise<ShopView>;
  onShop(cb: (s: ShopView) => void): () => void;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  getDebug(): Promise<DebugDump>;
  isMock(): Promise<boolean>;
  mockSetPhase(phase: Phase | 'auto' | 'offline' | 'noval'): Promise<void>;
  /** Generic request to a main-process handler (see main/rpc.ts). */
  rpc<T = any>(method: string, ...args: unknown[]): Promise<T>;
  /** Generic main -> renderer event. */
  on<T = any>(event: string, cb: (v: T) => void): () => void;
}
