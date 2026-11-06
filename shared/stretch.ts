// Stretched resolution: Valorant's ini edit, display-mode choice, and the start/exit/crash state machine.
// Pure; the files and the display calls live in main/services/stretch.ts and helper/stretch.exe.

export interface Res {
  w: number;
  h: number;
}

export interface Mode extends Res {
  hz: number;
  fixedOutput?: number;
}

export const PRESETS: Res[] = [
  { w: 1440, h: 1080 },
  { w: 1280, h: 960 },
  { w: 1280, h: 1024 },
  { w: 1080, h: 1080 },
];

export const resLabel = (r: Res) => `${r.w}×${r.h}`;

/** Unreal's FullscreenMode: 1 = Windowed Fullscreen (keeps the overlay working). */
export const WINDOWED_FULLSCREEN = 1;
export const SECTION = '[/Script/ShooterGame.ShooterGameUserSettings]';

/**
 * Keys checked on a real install (Nov 2026, Config\<puuid>-<region>\WindowsClient\GameUserSettings.ini):
 * all of these exist in [/Script/ShooterGame.ShooterGameUserSettings].
 */
export function stretchKeys(r: Res): Record<string, string> {
  return {
    ResolutionSizeX: String(r.w),
    ResolutionSizeY: String(r.h),
    LastUserConfirmedResolutionSizeX: String(r.w),
    LastUserConfirmedResolutionSizeY: String(r.h),
    DesiredScreenWidth: String(r.w),
    DesiredScreenHeight: String(r.h),
    LastUserConfirmedDesiredScreenWidth: String(r.w),
    LastUserConfirmedDesiredScreenHeight: String(r.h),
    bShouldLetterbox: 'False',
    bLastConfirmedShouldLetterbox: 'False',
    FullscreenMode: String(WINDOWED_FULLSCREEN),
    LastConfirmedFullscreenMode: String(WINDOWED_FULLSCREEN),
    PreferredFullscreenMode: String(WINDOWED_FULLSCREEN),
  };
}

/**
 * Sets keys inside one [section] of an ini, keeping every other line, its order and the file's line
 * endings. Missing keys are appended to the end of the section; a missing section is added at the end.
 */
export function setIniKeys(text: string, section: string, keys: Record<string, string>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  const trailing = lines.length > 0 && lines[lines.length - 1] === '';
  if (trailing) lines.pop();
  const todo = new Map(Object.entries(keys));
  let start = lines.findIndex((l) => l.trim().toLowerCase() === section.toLowerCase());
  if (start < 0) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(section);
    start = lines.length - 1;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.*\]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  for (let i = start + 1; i < end; i++) {
    const m = /^(\s*)([^=;#\s][^=]*?)\s*=/.exec(lines[i]);
    if (m && todo.has(m[2])) {
      lines[i] = `${m[1]}${m[2]}=${todo.get(m[2])}`;
      todo.delete(m[2]);
    }
  }
  // Insert before the blank lines that separate this section from the next one.
  let at = end;
  while (at > start + 1 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, ...[...todo.entries()].map(([k, v]) => `${k}=${v}`));
  return lines.join(eol) + (trailing || !text.length ? eol : '');
}

export function readIniKeys(text: string, section: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      inside = line.trim().toLowerCase() === section.toLowerCase();
      continue;
    }
    const m = inside ? /^\s*([^=;#\s][^=]*?)\s*=(.*)$/.exec(line) : null;
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function stretchIni(text: string, r: Res): string {
  return setIniKeys(text, SECTION, stretchKeys(r));
}

/** The stretch mode for a resolution: the monitor's highest refresh rate at that size (never 240 -> 60). */
export function pickMode(modes: Mode[], r: Res): Mode | null {
  const same = modes.filter((m) => m.w === r.w && m.h === r.h);
  if (!same.length) return null;
  return same.reduce((a, b) => (b.hz > a.hz ? b : a));
}

export const sameMode = (a?: Mode | null, b?: Mode | null) => !!a && !!b && a.w === b.w && a.h === b.h && a.hz === b.hz;

// ---------------- state machine ----------------

export type StretchPhase = 'off' | 'idle' | 'stretched' | 'native-alt-tab';

export interface StretchState {
  phase: StretchPhase;
  /** The ini edit waits for Valorant to close. */
  iniPending: boolean;
  /** Native mode saved when stretching started. */
  native?: Mode;
}

export type StretchEvent =
  | { type: 'enable'; gameRunning: boolean }
  | { type: 'disable' }
  | { type: 'gameStart' }
  | { type: 'gameExit' }
  | { type: 'focusLost' }
  | { type: 'focusGained' }
  /** SexyVal started and found the desktop still in the stretch mode with no game running (it crashed). */
  | { type: 'startupCheck'; desktopStretched: boolean; gameRunning: boolean }
  | { type: 'settingsChanged'; gameRunning: boolean };

export type StretchAction = 'saveNative' | 'applyStretch' | 'restoreNative' | 'writeIni' | 'restoreIni' | 'startWatchdog';

export function stretchStep(s: StretchState, e: StretchEvent, opts: { nativeOnAltTab: boolean }): { state: StretchState; actions: StretchAction[] } {
  const out = (state: StretchState, actions: StretchAction[] = []) => ({ state, actions });
  switch (e.type) {
    case 'enable':
      if (s.phase !== 'off') return out(s);
      // Valorant running: the ini waits for it to close, the display part applies at once.
      return e.gameRunning ? out({ phase: 'stretched', iniPending: true }, ['saveNative', 'applyStretch', 'startWatchdog']) : out({ phase: 'idle', iniPending: false }, ['writeIni']);
    case 'settingsChanged':
      if (s.phase === 'off') return out(s);
      if (e.gameRunning) return out({ ...s, iniPending: true }, s.phase === 'stretched' ? ['applyStretch'] : []);
      return out({ ...s, iniPending: false }, ['writeIni']);
    case 'disable': {
      const actions: StretchAction[] = [];
      if (s.phase === 'stretched' || s.phase === 'native-alt-tab') actions.push('restoreNative');
      if (s.phase !== 'off') actions.push('restoreIni');
      return out({ phase: 'off', iniPending: false }, actions);
    }
    case 'gameStart':
      if (s.phase !== 'idle') return out(s);
      return out({ ...s, phase: 'stretched' }, ['saveNative', 'applyStretch', 'startWatchdog']);
    case 'gameExit': {
      if (s.phase === 'off' || s.phase === 'idle') return out(s);
      const actions: StretchAction[] = s.phase === 'stretched' ? ['restoreNative'] : [];
      if (s.iniPending) actions.push('writeIni');
      return out({ phase: 'idle', iniPending: false, native: undefined }, actions);
    }
    case 'focusLost':
      return s.phase === 'stretched' && opts.nativeOnAltTab ? out({ ...s, phase: 'native-alt-tab' }, ['restoreNative']) : out(s);
    case 'focusGained':
      return s.phase === 'native-alt-tab' ? out({ ...s, phase: 'stretched' }, ['applyStretch']) : out(s);
    case 'startupCheck':
      if (e.desktopStretched && !e.gameRunning) return out({ ...s, phase: s.phase === 'off' ? 'off' : 'idle' }, ['restoreNative']);
      if (s.phase === 'idle' && e.gameRunning) return out({ ...s, phase: 'stretched' }, ['saveNative', 'applyStretch', 'startWatchdog']);
      return out(s);
  }
}

/** Watchdog state file (key=value lines, read by helper/stretch.exe). */
export function watchdogState(stretched: boolean, device: string, native?: Mode): string {
  if (!stretched || !native) return 'stretched=0\r\n';
  return [`stretched=1`, `device=${device}`, `w=${native.w}`, `h=${native.h}`, `hz=${native.hz}`, `fixed=${native.fixedOutput ?? 0}`].join('\r\n') + '\r\n';
}
