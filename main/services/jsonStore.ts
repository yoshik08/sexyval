import path from 'node:path';
import { promises as fs } from 'node:fs';
import { writeJson } from '../paths';
import { log } from '../log';

export interface JsonStoreOptions {
  /** Debounce for save() (ms). */
  debounceMs?: number;
  /** Write attempts before giving up for now (the in-memory copy is kept and retried later). */
  retries?: number;
  retryDelayMs?: number;
  /** After the retries ran out, try again this much later. */
  laterMs?: number;
}

/**
 * A versioned JSON file that must never lose data: atomic writes (temp + rename), retries on write
 * failure with the in-memory copy kept, and on load a file that doesn't parse or validate is renamed to
 * `<name>.corrupt-<timestamp>.json` instead of being dropped.
 */
export class JsonStore<T> {
  data: T;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> | null = null;
  private dirty = false;
  /** Set when the last write failed (Settings/Debug can show it). */
  lastError: string | null = null;

  constructor(
    readonly file: string,
    private readonly validate: (x: unknown) => x is T,
    private readonly empty: () => T,
    private readonly opts: JsonStoreOptions = {},
  ) {
    this.data = empty();
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch {
      this.data = this.empty(); // first run
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!this.validate(parsed)) throw new Error('unexpected shape');
      this.data = parsed;
    } catch (e) {
      const { dir, name } = path.parse(this.file);
      const backup = path.join(dir, `${name}.corrupt-${Date.now()}.json`);
      await fs.rename(this.file, backup).catch(() => fs.copyFile(this.file, backup).catch(() => undefined));
      log.warn(`${name}.json was unreadable (${(e as Error).message}); kept as ${path.basename(backup)} and started fresh`);
      this.data = this.empty();
    }
  }

  /** Debounced write of the current data. */
  save(): void {
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.opts.debounceMs ?? 300);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.writing) await this.writing.catch(() => undefined);
    if (!this.dirty) return;
    this.dirty = false;
    this.writing = this.write();
    await this.writing;
    this.writing = null;
  }

  private async write(): Promise<void> {
    const tries = this.opts.retries ?? 3;
    for (let i = 0; i < tries; i++) {
      try {
        await writeJson(this.file, this.data);
        this.lastError = null;
        return;
      } catch (e) {
        this.lastError = (e as Error).message;
        log.warn(`write ${path.basename(this.file)} failed (attempt ${i + 1}/${tries})`, e);
        await new Promise((r) => setTimeout(r, (this.opts.retryDelayMs ?? 500) * (i + 1)));
      }
    }
    // Keep the in-memory copy and try again later; nothing seen so far is lost.
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.opts.laterMs ?? 60_000);
  }
}
