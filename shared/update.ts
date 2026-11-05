import type { Phase } from './types';

/** How long the window must sit unfocused (but visible) before it's a safe moment to relaunch. */
export const UNFOCUSED_SAFE_MS = 5 * 60_000;
/** `powerMonitor.getSystemIdleTime()` threshold, in seconds. */
export const IDLE_SAFE_SECONDS = 300;
/** How often the safe-moment watch re-checks once an update is downloaded and waiting. */
export const SAFE_MOMENT_POLL_MS = 20_000;

export interface SafeToInstallInput {
  phase: Phase;
  videoPlaying: boolean;
  unsavedLoadoutChanges: boolean;
  /** Hidden in the tray, as opposed to minimized/behind other windows (which still counts as "visible"). */
  windowHidden: boolean;
  /** 0 while focused. */
  unfocusedForMs: number;
  systemIdleSeconds: number;
}

/**
 * Riot activity and in-progress edits always block; past that, the window being tucked in the
 * tray is itself enough (nothing to interrupt), otherwise we need sustained inattention: either
 * the window idle at the OS level, or just unfocused long enough that a flash of "SexyVal closed"
 * in the taskbar/tray won't land mid-click.
 */
export function isSafeToInstall(i: SafeToInstallInput): boolean {
  if (i.phase !== 'idle') return false;
  if (i.videoPlaying || i.unsavedLoadoutChanges) return false;
  if (i.windowHidden) return true;
  return i.unfocusedForMs >= UNFOCUSED_SAFE_MS || i.systemIdleSeconds >= IDLE_SAFE_SECONDS;
}

export interface UiResumeState {
  view: string;
  sub?: string;
  scrollTop: number;
  profileQuery?: string;
}

/** Pushed from the renderer on every change (debounced); drives both the resume file and the safe-moment check. */
export interface UiReport {
  nav: UiResumeState;
  videoPlaying: boolean;
  unsavedLoadoutChanges: boolean;
}

export interface ResumeFile {
  /** `app.getVersion()` at write time, for a sanity check on read (not currently enforced, just logged on mismatch). */
  version: string;
  window: { width: number; height: number; x?: number; y?: number; maximized?: boolean };
  hiddenInTray: boolean;
  ui: UiResumeState | null;
  savedAt: number;
}
