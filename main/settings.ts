import { app } from 'electron';
import type { Settings } from '../shared/types';
import { dataDir, readJson, writeJson } from './paths';
import { CURRENT_SETTINGS_VERSION, loginItemOutOfSync, migrateStartupDefault } from '../shared/settingsMigration';

const DEFAULTS: Settings = {
  settingsVersion: CURRENT_SETTINGS_VERSION,
  launchAtStartup: true,
  closeToTray: true,
  pollMs: 5000,
  historyQueue: '',
  notifications: true,
  cacheVideos: false,
  videoCacheMaxMb: 2048,
  hoverPreviews: true,
  soundOn: true,
  appIcon: 'mono',
  platformType: 'PC',
  window: { width: 1280, height: 800 },
  overlayEnabled: true,
  overlayPosition: 'top-center',
  overlayScale: 'medium',
  overlayDisplay: null,
  overlayMatchFound: true,
  henrikKey: '',
  liveDensity: 'auto',
  autoUpdate: true,
};

/** Shown instead of the key: the renderer only learns that one is set (and its last 4 characters). */
export const KEY_MASK = '••••';

const ICONS = ['red', 'teal', 'gold', 'mono'] as const;
const PLATFORMS = ['PC', 'xbox', 'playstation'] as const;
const OVERLAY_POSITIONS = ['top-center', 'top-left', 'top-right'] as const;
const OVERLAY_SCALES = ['small', 'medium'] as const;
const DENSITIES = ['auto', 'compact', 'detailed'] as const;

let current: Settings = DEFAULTS;
let saveTimer: NodeJS.Timeout | null = null;
const listeners: ((s: Settings, prev: Settings) => void)[] = [];

const file = () => dataDir('settings.json');

export async function loadSettings(): Promise<Settings> {
  const s = await readJson<Partial<Settings>>(file(), {});
  const migration = migrateStartupDefault(s);
  current = { ...DEFAULTS, ...s, settingsVersion: migration.settingsVersion, launchAtStartup: migration.launchAtStartup, window: { ...DEFAULTS.window, ...(s.window ?? {}) } };
  if (app.isPackaged) {
    if (migration.shouldRegister) app.setLoginItemSettings({ openAtLogin: current.launchAtStartup, args: ['--hidden'] });
    else syncLoginItem();
  }
  if (migration.shouldRegister) void writeJson(file(), current);
  return current;
}

/** A moved install folder or an auto-update path change can leave Windows' login item disabled without telling us; resync it every start. */
function syncLoginItem(): void {
  const got = app.getLoginItemSettings({ args: ['--hidden'] });
  if (loginItemOutOfSync(got.openAtLogin, current.launchAtStartup)) {
    app.setLoginItemSettings({ openAtLogin: current.launchAtStartup, args: ['--hidden'] });
  }
}

export function getSettings(): Settings {
  return current;
}

/** What the renderer gets: the HenrikDev key is masked. */
export function publicSettings(s: Settings = current): Settings {
  return { ...s, henrikKey: s.henrikKey ? KEY_MASK + s.henrikKey.slice(-4) : '' };
}

export function onSettings(fn: (s: Settings, prev: Settings) => void): void {
  listeners.push(fn);
}

/** Validates every field: the renderer is not trusted to send sane values. */
export function updateSettings(patch: Partial<Settings>): Settings {
  const prev = current;
  const next: Settings = { ...current };
  if (typeof patch.launchAtStartup === 'boolean') next.launchAtStartup = patch.launchAtStartup;
  if (typeof patch.closeToTray === 'boolean') next.closeToTray = patch.closeToTray;
  if (typeof patch.notifications === 'boolean') next.notifications = patch.notifications;
  if (typeof patch.cacheVideos === 'boolean') next.cacheVideos = patch.cacheVideos;
  if (typeof patch.hoverPreviews === 'boolean') next.hoverPreviews = patch.hoverPreviews;
  if (typeof patch.soundOn === 'boolean') next.soundOn = patch.soundOn;
  if (typeof patch.videoCacheMaxMb === 'number' && Number.isFinite(patch.videoCacheMaxMb)) next.videoCacheMaxMb = Math.min(51200, Math.max(256, Math.round(patch.videoCacheMaxMb)));
  if (typeof patch.pollMs === 'number' && Number.isFinite(patch.pollMs)) next.pollMs = Math.min(30_000, Math.max(2000, Math.round(patch.pollMs)));
  if (typeof patch.historyQueue === 'string' && /^[a-z0-9_]{0,32}$/i.test(patch.historyQueue)) next.historyQueue = patch.historyQueue;
  if (ICONS.includes(patch.appIcon as any)) next.appIcon = patch.appIcon!;
  if (PLATFORMS.includes(patch.platformType as any)) next.platformType = patch.platformType!;
  if (patch.window && typeof patch.window === 'object') next.window = { ...current.window, ...patch.window };
  if (typeof patch.overlayEnabled === 'boolean') next.overlayEnabled = patch.overlayEnabled;
  if (OVERLAY_POSITIONS.includes(patch.overlayPosition as any)) next.overlayPosition = patch.overlayPosition!;
  if (OVERLAY_SCALES.includes(patch.overlayScale as any)) next.overlayScale = patch.overlayScale!;
  if (patch.overlayDisplay === null || (typeof patch.overlayDisplay === 'number' && Number.isSafeInteger(patch.overlayDisplay))) next.overlayDisplay = patch.overlayDisplay;
  if (typeof patch.overlayMatchFound === 'boolean') next.overlayMatchFound = patch.overlayMatchFound;
  if (DENSITIES.includes(patch.liveDensity as any)) next.liveDensity = patch.liveDensity!;
  if (typeof patch.autoUpdate === 'boolean') next.autoUpdate = patch.autoUpdate;
  // The masked value comes back unchanged from the form; only a real edit replaces the key.
  if (typeof patch.henrikKey === 'string' && patch.henrikKey.length <= 200 && !patch.henrikKey.startsWith(KEY_MASK)) next.henrikKey = patch.henrikKey.trim();
  if (next.launchAtStartup !== current.launchAtStartup && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: next.launchAtStartup, args: ['--hidden'] }); // started by Windows: begin in the tray
  }
  current = next;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void writeJson(file(), current), 300);
  for (const l of listeners) l(current, prev);
  return current;
}
