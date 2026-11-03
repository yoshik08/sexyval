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

/** Atomic-ish write: temp file then rename. */
export async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}
