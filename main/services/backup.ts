import { promises as fs } from 'node:fs';
import { app } from 'electron';
import type { Settings } from '../../shared/types';

/** What a backup carries: your own data files. Riot sessions, caches and secrets never leave the PC. */
export const BACKUP_FILES = ['wishlist.json', 'lineups.json', 'spending.json', 'friend-watch.json', 'loadout-presets.json', 'shop-history.json', 'bundles.json', 'prices.json'] as const;
/** Settings that are never exported or imported (secrets, window placement, machine-specific). */
const SKIP_SETTINGS = new Set(['henrikKey', 'window', 'stretchDevice', 'overlayDisplay', 'settingsVersion']);

export interface BackupFile {
  app: 'SexyVal';
  version: string;
  exportedAt: number;
  settings: Partial<Settings>;
  files: Record<string, unknown>;
}

export async function makeBackup(dataDir: (f: string) => string, settings: Settings): Promise<BackupFile> {
  const files: Record<string, unknown> = {};
  for (const f of BACKUP_FILES) {
    try {
      files[f] = JSON.parse(await fs.readFile(dataDir(f), 'utf8'));
    } catch {
      // not created yet
    }
  }
  const s = Object.fromEntries(Object.entries(settings).filter(([k]) => !SKIP_SETTINGS.has(k))) as Partial<Settings>;
  return { app: 'SexyVal', version: app.getVersion(), exportedAt: Date.now(), settings: s, files };
}

/** Validates and writes a backup's files; returns the settings patch to apply (caller relaunches). */
export async function restoreBackup(dataDir: (f: string) => string, raw: string): Promise<{ settings: Partial<Settings>; restored: string[] }> {
  let b: BackupFile;
  try {
    b = JSON.parse(raw);
  } catch {
    throw new Error('That file isn’t a SexyVal backup');
  }
  if (b?.app !== 'SexyVal' || typeof b.files !== 'object' || !b.files) throw new Error('That file isn’t a SexyVal backup');
  const restored: string[] = [];
  for (const f of BACKUP_FILES) {
    if (!(f in b.files)) continue;
    await fs.writeFile(dataDir(f), JSON.stringify(b.files[f]));
    restored.push(f);
  }
  const settings = Object.fromEntries(Object.entries(b.settings ?? {}).filter(([k]) => !SKIP_SETTINGS.has(k))) as Partial<Settings>;
  return { settings, restored };
}
