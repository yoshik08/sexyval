import { promises as fs, constants as fsc } from 'node:fs';
import path from 'node:path';
import type { BoostStatus, Settings } from '../../shared/types';
import { BoostEngine, COMPETITIVE_PRESET, DEFAULT_VALORANT_EXE, HAGS_KEY, parseRegQuery, PRESET_SECTION, TWEAKS, type Cmd, type CmdResult, type Journal, type TweakId } from '../../shared/boost';
import { readIniKeys, setIniKeys } from '../../shared/stretch';
import { valorantIniFiles } from './stretch';
import type { GameWatcher } from './system';
import { readJson, writeJson } from '../paths';
import { log } from '../log';

const PRESET_BACKUP = 'GameUserSettings.sexyval-preset-backup.ini';

/** Valorant's install folder from the Riot Client's product settings, else the default path. */
export async function detectValorantExe(): Promise<string> {
  const f = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Riot Games', 'Metadata', 'valorant.live', 'valorant.live.product_settings.yaml');
  const text = await fs.readFile(f, 'utf8').catch(() => '');
  const m = /product_install_full_path:\s*"?([^"\r\n]+)"?/.exec(text);
  return m ? path.join(m[1].replace(/\//g, '\\'), 'ShooterGame', 'Binaries', 'Win64', 'VALORANT-Win64-Shipping.exe') : DEFAULT_VALORANT_EXE;
}

export interface BoostDepsMain {
  run: (cmds: Cmd[]) => Promise<CmdResult[]>;
  journalFile: string;
  settings: () => Settings;
  game: GameWatcher;
  setQuiet: (on: boolean) => void;
  elevatedReady: () => Promise<boolean>;
  configDir: string;
  onStatus: (s: BoostStatus) => void;
  dryRun: boolean;
}

/**
 * Settings → Boost. Persistent tweaks follow their switches; session tweaks are applied when Valorant
 * starts and reverted when it exits. On start, session tweaks left over from a crash are reverted.
 */
export class BoostService {
  readonly engine: BoostEngine;
  private errors: Partial<Record<TweakId, string>> = {};
  private valorantExe = DEFAULT_VALORANT_EXE;
  private busy: Promise<void> = Promise.resolve();
  private hags: BoostStatus['hags'] = 'unknown';
  private presetMsg?: string;

  constructor(private readonly d: BoostDepsMain) {
    this.engine = new BoostEngine({
      run: d.run,
      loadJournal: () => readJson<Journal>(d.journalFile, { v: 1, applied: {} }),
      saveJournal: (j) => writeJson(d.journalFile, j),
      valorantExe: () => this.valorantExe,
      setQuiet: d.setQuiet,
    });
  }

  /** On for this tweak: master switch on, and the tweak's own switch (default when never set). */
  wanted(id: TweakId, s = this.d.settings()): boolean {
    if (!s.boostEnabled) return false;
    return s.boostTweaks[id] ?? TWEAKS.find((t) => t.id === id)!.defaultOn;
  }

  /** Serialises every change so a toggle storm can't interleave reg writes. */
  private queue(fn: () => Promise<void>): Promise<void> {
    this.busy = this.busy.then(fn, fn).catch((e) => log.warn('boost', e));
    return this.busy;
  }

  async init(): Promise<void> {
    this.valorantExe = await detectValorantExe();
    await this.engine.load();
    await this.queue(async () => {
      // Crash path: session tweaks still in the journal with no game running are reverted now.
      if (!this.d.game.running) await this.engine.revertAll('session');
      await this.sync();
    });
    this.d.game.on(() => void this.queue(() => this.sync()));
    await this.emit();
  }

  onSettings(): void {
    void this.queue(() => this.sync()).then(() => this.emit());
  }

  /** Make the applied set match the wanted set (session tweaks only while the game runs). */
  private async sync(): Promise<void> {
    for (const t of TWEAKS) {
      const want = this.wanted(t.id) && (t.scope === 'persistent' || this.d.game.running);
      try {
        if (want && !this.engine.isApplied(t.id)) await this.engine.apply(t.id);
        else if (!want && this.engine.isApplied(t.id)) await this.engine.revert(t.id);
        delete this.errors[t.id];
      } catch (e) {
        this.errors[t.id] = (e as Error).message;
        log.warn(`boost ${t.id}`, e);
      }
    }
    await this.emit();
  }

  private async readHags(): Promise<void> {
    // Reading HKLM needs no admin: ask reg directly, not through the elevated task.
    const r = (await this.d.run([{ exe: 'reg.exe', args: ['query', HAGS_KEY, '/v', 'HwSchMode'], admin: false }]))[0];
    const v = r?.code === 0 ? parseRegQuery(r.out, 'HwSchMode')?.data : undefined;
    this.hags = v === '2' ? 'on' : v === '1' ? 'off' : 'unknown';
  }

  async emit(): Promise<BoostStatus> {
    await this.readHags().catch(() => undefined);
    const files = await valorantIniFiles(this.d.configDir);
    const hasBackup = (await Promise.all(files.map((f) => fs.access(path.join(path.dirname(f), PRESET_BACKUP)).then(() => true, () => false)))).some(Boolean);
    const s: BoostStatus = {
      enabled: this.d.settings().boostEnabled,
      gameRunning: this.d.game.running,
      tweaks: TWEAKS.map((t) => ({ id: t.id, label: t.label, scope: t.scope, admin: t.admin, on: this.d.settings().boostTweaks[t.id] ?? t.defaultOn, applied: this.engine.isApplied(t.id), note: t.note, error: this.errors[t.id] })),
      hags: this.hags,
      elevatedReady: await this.d.elevatedReady().catch(() => false),
      preset: { canApply: !this.d.game.running && files.length > 0, hasBackup, message: this.presetMsg },
      dryRun: this.d.dryRun,
    };
    this.d.onStatus(s);
    return s;
  }

  // ---------------- Valorant preset (game closed only) ----------------

  async applyPreset(): Promise<BoostStatus> {
    if (this.d.game.running) throw new Error('Close Valorant first');
    const files = await valorantIniFiles(this.d.configDir);
    if (!files.length) throw new Error('Valorant’s settings file wasn’t found');
    for (const f of files) {
      const ro = await isReadOnly(f);
      if (ro) await fs.chmod(f, 0o666);
      await fs.copyFile(f, path.join(path.dirname(f), PRESET_BACKUP), fsc.COPYFILE_EXCL).catch(() => undefined);
      await fs.writeFile(f, setIniKeys(await fs.readFile(f, 'utf8'), PRESET_SECTION, COMPETITIVE_PRESET));
      if (ro) await fs.chmod(f, 0o444);
    }
    this.presetMsg = undefined;
    return this.emit();
  }

  /** Puts back only the [ScalabilityGroups] values from the backup, so a stretch edit made since survives. */
  async restorePreset(): Promise<BoostStatus> {
    if (this.d.game.running) throw new Error('Close Valorant first');
    for (const f of await valorantIniFiles(this.d.configDir)) {
      const backup = path.join(path.dirname(f), PRESET_BACKUP);
      const old = await fs.readFile(backup, 'utf8').catch(() => null);
      if (old == null) continue;
      const ro = await isReadOnly(f);
      if (ro) await fs.chmod(f, 0o666);
      await fs.writeFile(f, setIniKeys(await fs.readFile(f, 'utf8'), PRESET_SECTION, readIniKeys(old, PRESET_SECTION)));
      if (ro) await fs.chmod(f, 0o444);
      await fs.rm(backup);
    }
    return this.emit();
  }

  /** Quit: session tweaks back. Uninstall: everything back. */
  async shutdown(opts: { all?: boolean } = {}): Promise<string[]> {
    let errors: string[] = [];
    await this.queue(async () => {
      errors = await this.engine.revertAll(opts.all ? undefined : 'session');
    });
    return errors;
  }
}

async function isReadOnly(f: string): Promise<boolean> {
  try {
    await fs.access(f, fsc.W_OK);
    return false;
  } catch {
    return true;
  }
}

export type { Journal };
