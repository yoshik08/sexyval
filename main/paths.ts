import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export function dataDir(...p: string[]): string {
  return path.join(app.getPath('userData'), ...p);
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

let tmpSeq = 0;
const queues = new Map<string, Promise<void>>();

/**
 * Atomic-ish write: temp file then rename. Writes to the same file run one after another (Windows
 * refuses two renames onto one file at once), and each gets its own temp name.
 */
export function writeJson(file: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data);
  const run = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
  };
  const next = (queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(run);
  queues.set(file, next);
  void next.finally(() => {
    if (queues.get(file) === next) queues.delete(file);
  }).catch(() => undefined);
  return next;
}
