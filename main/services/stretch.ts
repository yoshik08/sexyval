import { promises as fs, constants as fsc } from 'node:fs';
import path from 'node:path';
import type { Settings, StretchStatus } from '../../shared/types';
import { pickMode, resLabel, sameMode, stretchIni, stretchStep, watchdogState, type Mode, type StretchAction, type StretchState } from '../../shared/stretch';
import type { GameWatcher, HelperClient } from './system';
import { log } from '../log';

const BACKUP = 'GameUserSettings.sexyval-backup.ini';

/** Every GameUserSettings.ini Valorant keeps: per account (WindowsClient, or Windows on some builds) and machine-wide. */
export async function valorantIniFiles(configDir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(configDir);
  } catch {
    return out;
  }
  const dirs = ['', ...entries.filter((e) => /^[0-9a-f-]{36}-[a-z0-9]+$/i.test(e))];
  for (const d of dirs) {
    for (const sub of ['WindowsClient', 'Windows']) {
      const f = path.join(configDir, d, sub, 'GameUserSettings.ini');
      try {
        await fs.access(f, fsc.F_OK);
        out.push(f);
      } catch {
        // not there
      }
    }
  }
  return out;
}

async function setReadOnly(file: string, ro: boolean): Promise<void> {
  // On Windows, chmod without the write bit sets the read-only attribute (and with it clears it).
  await fs.chmod(file, ro ? 0o444 : 0o666);
}

/**
 * Stretched resolution, fully automatic: Valorant's ini (only while the game is closed; backed up once,
 * then read-only so the game can't revert it), and the desktop mode while Valorant runs (DMDFO_STRETCH
 * through helper/stretch.exe), restored when it exits, on disable, and by a watchdog if SexyVal dies.
 */
export class StretchService {
  private state: StretchState = { phase: 'off', iniPending: false };
  private native?: Mode;
  private focusTimer: NodeJS.Timeout | null = null;
  private watchdogStarted = false;
  private monitors: StretchStatus['monitors'] = [];
  status: StretchStatus = { line: 'Native', phase: 'off', monitors: [], dryRun: false };

  constructor(
    private readonly d: {
      helper: HelperClient;
      game: GameWatcher;
      settings: () => Settings;
      configDir: string;
      stateFile: string;
      onStatus: (s: StretchStatus) => void;
    },
  ) {
    this.status.dryRun = d.helper.dryRun;
  }

  private emit(line?: string, error?: string): void {
    const s = this.d.settings();
    const target = this.target();
    this.status = {
      line: line ?? (this.state.phase === 'stretched' && target ? `Stretched to ${resLabel(target)} @ ${target.hz} Hz` : 'Native'),
      error,
      phase: this.state.phase,
      monitors: this.monitors,
      dryRun: this.d.helper.dryRun,
    };
    if (!s.stretchEnabled && !error) this.status.line = 'Native';
    this.d.onStatus(this.status);
  }

  private device(): string {
    const want = this.d.settings().stretchDevice;
    return (want && this.monitors.find((m) => m.device === want)?.device) ?? this.monitors.find((m) => m.primary)?.device ?? this.monitors[0]?.device ?? '\\\\.\\DISPLAY1';
  }

  private target(): Mode | null {
    const m = this.monitors.find((x) => x.device === this.device());
    return m ? pickMode(m.modes, this.d.settings().stretchRes) : null;
  }

  async refreshMonitors(): Promise<StretchStatus['monitors']> {
    try {
      const r = await this.d.helper.call<{ ok: boolean; monitors: StretchStatus['monitors'] }>(['list']);
      if (r.ok) this.monitors = r.monitors;
    } catch (e) {
      log.warn('stretch: listing monitors failed', e);
    }
    return this.monitors;
  }

  async init(): Promise<void> {
    await this.refreshMonitors();
    // Crash safety: the desktop still in the stretch mode and no game -> back to native.
    const st = await fs.readFile(this.d.stateFile, 'utf8').catch(() => '');
    const saved = Object.fromEntries(st.split(/\r?\n/).filter((l) => l.includes('=')).map((l) => l.split('=').map((x) => x.trim()) as [string, string]));
    if (saved.stretched === '1') this.native = { w: Number(saved.w), h: Number(saved.h), hz: Number(saved.hz), fixedOutput: Number(saved.fixed) };
    if (this.d.settings().stretchEnabled) this.state = { phase: 'idle', iniPending: false };
    await this.dispatch({ type: 'startupCheck', desktopStretched: saved.stretched === '1', gameRunning: this.d.game.running });
    this.d.game.on((running) => void this.dispatch({ type: running ? 'gameStart' : 'gameExit' }));
    this.emit();
  }

  async onSettings(s: Settings, prev: Settings): Promise<void> {
    if (s.stretchEnabled !== prev.stretchEnabled) {
      await this.dispatch(s.stretchEnabled ? { type: 'enable', gameRunning: this.d.game.running } : { type: 'disable' });
    } else if (s.stretchEnabled && (s.stretchRes.w !== prev.stretchRes.w || s.stretchRes.h !== prev.stretchRes.h || s.stretchDevice !== prev.stretchDevice)) {
      if (s.stretchDevice !== prev.stretchDevice && this.state.phase === 'stretched') await this.restoreNative(prev.stretchDevice);
      await this.dispatch({ type: 'settingsChanged', gameRunning: this.d.game.running });
    }
    this.syncFocusWatch();
    this.emit();
  }

  private async dispatch(e: Parameters<typeof stretchStep>[1]): Promise<void> {
    const { state, actions } = stretchStep(this.state, e, { nativeOnAltTab: this.d.settings().stretchNativeOnAltTab });
    this.state = state;
    let error: string | undefined;
    for (const a of actions) {
      try {
        await this.run(a);
      } catch (err) {
        error = (err as Error).message;
        log.warn(`stretch ${a} failed`, err);
      }
    }
    this.syncFocusWatch();
    this.emit(undefined, error);
  }

  private async run(a: StretchAction): Promise<void> {
    switch (a) {
      case 'saveNative': {
        await this.refreshMonitors();
        const m = this.monitors.find((x) => x.device === this.device());
        if (m && !sameMode(m.current, this.target())) this.native = { ...m.current, fixedOutput: 0 };
        return;
      }
      case 'applyStretch':
        return this.applyStretch();
      case 'restoreNative':
        return this.restoreNative();
      case 'writeIni':
        return this.writeIni();
      case 'restoreIni':
        return this.restoreIni();
      case 'startWatchdog':
        if (!this.watchdogStarted) {
          this.watchdogStarted = true;
          this.d.helper.watchdog(this.d.stateFile);
        }
        return;
    }
  }

  private async applyStretch(): Promise<void> {
    const t = this.target();
    const res = this.d.settings().stretchRes;
    if (!t) throw new Error(`${resLabel(res)} isn't available on this monitor`);
    const r = await this.d.helper.call<{ ok: boolean; stretched?: boolean; readback?: Mode; error?: string; dryRun?: boolean }>(['apply', this.device(), String(t.w), String(t.h), String(t.hz)]);
    if (!r.ok) throw new Error(r.error ?? `Couldn't switch to ${resLabel(t)}`);
    await fs.writeFile(this.d.stateFile, watchdogState(true, this.device(), this.native)).catch(() => undefined);
    // The driver kept black bars (it ignored DMDFO_STRETCH). Vendor scaling APIs aren't implemented yet.
    if (!r.dryRun && r.stretched === false) throw new Error('The graphics driver kept black bars: set its scaling to Full-screen');
  }

  private async restoreNative(device: string | null = this.device()): Promise<void> {
    const n = this.native;
    if (!n) return;
    const r = await this.d.helper.call<{ ok: boolean; error?: string }>(['restore', device ?? this.device(), String(n.w), String(n.h), String(n.hz), String(n.fixedOutput ?? 0)]);
    await fs.writeFile(this.d.stateFile, watchdogState(false, '')).catch(() => undefined);
    if (!r.ok) throw new Error(r.error ?? 'Couldn’t restore the native resolution');
    this.native = undefined;
  }

  private async writeIni(): Promise<void> {
    if (this.d.game.running) {
      this.state = { ...this.state, iniPending: true };
      return;
    }
    const res = this.d.settings().stretchRes;
    for (const f of await valorantIniFiles(this.d.configDir)) {
      const backup = path.join(path.dirname(f), BACKUP);
      await setReadOnly(f, false).catch(() => undefined);
      const text = await fs.readFile(f, 'utf8');
      // Back up the original once; later edits never overwrite that first copy.
      await fs.copyFile(f, backup, fsc.COPYFILE_EXCL).catch(() => undefined);
      await fs.writeFile(f, stretchIni(text, res));
      await setReadOnly(f, true);
    }
  }

  private async restoreIni(): Promise<void> {
    for (const f of await valorantIniFiles(this.d.configDir)) {
      const backup = path.join(path.dirname(f), BACKUP);
      await setReadOnly(f, false).catch(() => undefined);
      try {
        await fs.copyFile(backup, f);
        await fs.rm(backup);
      } catch {
        // no backup: the file was never changed
      }
    }
  }

  /** "Native while alt-tabbed": poll which window has focus, only while stretched and switched on. */
  private syncFocusWatch(): void {
    const want = this.d.settings().stretchNativeOnAltTab && (this.state.phase === 'stretched' || this.state.phase === 'native-alt-tab');
    if (!want && this.focusTimer) {
      clearInterval(this.focusTimer);
      this.focusTimer = null;
    }
    if (want && !this.focusTimer) {
      this.focusTimer = setInterval(async () => {
        const r = await this.d.helper.call<{ process?: string }>(['foreground']).catch(() => null);
        if (!r?.process) return;
        const inGame = r.process.toLowerCase().startsWith('valorant');
        if (inGame && this.state.phase === 'native-alt-tab') await this.dispatch({ type: 'focusGained' });
        if (!inGame && this.state.phase === 'stretched') await this.dispatch({ type: 'focusLost' });
      }, 1000);
    }
  }

  /** Quit / uninstall: back to native, ini restored (uninstall), watchdog told there's nothing to do. */
  async shutdown(opts: { restoreIni?: boolean } = {}): Promise<void> {
    if (this.focusTimer) clearInterval(this.focusTimer);
    if (this.state.phase === 'stretched' || this.native) await this.restoreNative().catch((e) => log.warn('stretch: restore on quit failed', e));
    if (opts.restoreIni) await this.restoreIni().catch(() => undefined);
    await fs.writeFile(this.d.stateFile, watchdogState(false, '')).catch(() => undefined);
  }
}
