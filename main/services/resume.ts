import type { Settings } from '../../shared/types';
import type { ResumeFile, UiReport, UiResumeState } from '../../shared/update';
import { readJson, writeJson } from '../paths';
import { promises as fsp } from 'node:fs';
import { log } from '../log';

/**
 * The renderer pushes its current tab/scroll position (and the flags the safe-moment check needs)
 * here on every change (debounced). A silent update relaunch writes whatever we last heard to
 * disk, and the next start reads it once.
 */
export class ResumeStore {
  private ui: UiResumeState | null = null;
  private flags = { videoPlaying: false, unsavedLoadoutChanges: false };

  constructor(private readonly file: string) {}

  report(r: UiReport): void {
    this.ui = r.nav;
    this.flags = { videoPlaying: r.videoPlaying, unsavedLoadoutChanges: r.unsavedLoadoutChanges };
  }

  getFlags(): { videoPlaying: boolean; unsavedLoadoutChanges: boolean } {
    return this.flags;
  }

  async save(window: Settings['window'], hiddenInTray: boolean, version: string): Promise<void> {
    const data: ResumeFile = { version, window, hiddenInTray, ui: this.ui, savedAt: Date.now() };
    await writeJson(this.file, data);
  }

  /** One-shot: reads and deletes, so a normal subsequent start doesn't keep bouncing back to it. */
  async consume(): Promise<ResumeFile | null> {
    const data = await readJson<ResumeFile | null>(this.file, null);
    if (data) {
      await fsp.rm(this.file).catch(() => undefined);
      log.info(`resume: restoring state saved ${Math.round((Date.now() - data.savedAt) / 1000)}s ago`);
    }
    return data;
  }
}
