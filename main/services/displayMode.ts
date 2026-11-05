import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseDisplayMode, type DisplayMode } from '../../shared/fullscreen';

export function defaultValorantConfigDir(): string {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'VALORANT', 'Saved', 'Config');
}

async function mtime(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Reads the display mode Valorant saved. Settings live per account in
 * `Config\<puuid>-<region>\WindowsClient\GameUserSettings.ini` (seen on a real install; some builds
 * use `Windows` instead), with a machine-wide copy in `Config\WindowsClient`. The newest of the
 * signed-in account's files and the machine copy wins; without an account, the newest of all.
 * Returns null when nothing can be found or read: then the app says nothing.
 */
export async function detectDisplayMode(configDir: string, puuid?: string | null): Promise<{ mode: DisplayMode; file: string } | null> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(configDir);
  } catch {
    return null;
  }
  const accounts = entries.filter((e) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i.test(e));
  const mine = puuid ? accounts.filter((e) => e.toLowerCase().startsWith(puuid.toLowerCase())) : [];
  const folders = mine.length ? mine : accounts;
  const files = [path.join(configDir, 'WindowsClient', 'GameUserSettings.ini'), ...folders.flatMap((f) => ['WindowsClient', 'Windows'].map((sub) => path.join(configDir, f, sub, 'GameUserSettings.ini')))];
  const dated = (await Promise.all(files.map(async (f) => ({ f, t: await mtime(f) })))).filter((x) => x.t >= 0).sort((a, b) => b.t - a.t);
  for (const { f } of dated) {
    try {
      const mode = parseDisplayMode(await fs.readFile(f, 'utf8'));
      if (mode) return { mode, file: f };
    } catch {
      // unreadable: try the next one
    }
  }
  return null;
}
