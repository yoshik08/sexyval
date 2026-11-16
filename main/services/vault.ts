import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { promises as fs } from 'node:fs';
import { checkEnvelope, ID_FILE, keepSnapshots, MATCH_FILE, MAX_PAYLOAD_BYTES, missingOnly, VAULT_FILES, VAULT_HEADER, VAULT_MAGIC, VAULT_SCHEMA, type VaultCheck, type VaultEnvelope, type VaultFile, type VaultPayload } from '../../shared/vault';
import type { VaultStatus } from '../../shared/features';
import { log } from '../log';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const CURRENT = 'sexyval.sxyval';
const DEBOUNCE_MS = 2 * 60_000;
const MIN_INTERVAL_MS = 10 * 60_000;
const REMIND_EVERY = 30 * 24 * 60 * 60_000;

/** %LOCALAPPDATA%\SexyVal\Vault: outside the install folder and the roaming data folder; no admin rights. */
export function defaultVaultDir(): string {
  if (process.env.SEXYVAL_VAULT_DIR) return process.env.SEXYVAL_VAULT_DIR;
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SexyVal', 'Vault');
}

export function encodeVault(env: VaultEnvelope): Buffer {
  return Buffer.concat([Buffer.from(VAULT_HEADER, 'utf8'), zlib.gzipSync(Buffer.from(JSON.stringify(env), 'utf8'))]);
}

/** File bytes → validated payload. Also accepts the 1.6 JSON backup (schema 0, migrated). */
export function decodeVault(buf: Buffer): VaultCheck {
  try {
    if (buf.subarray(0, VAULT_HEADER.length).toString('utf8') === VAULT_HEADER) {
      const json = zlib.gunzipSync(buf.subarray(VAULT_HEADER.length), { maxOutputLength: MAX_PAYLOAD_BYTES + 1024 * 1024 }).toString('utf8');
      return checkEnvelope(JSON.parse(json), sha256);
    }
    if (buf.length > MAX_PAYLOAD_BYTES) return { ok: false, error: 'File is too large' };
    const legacy = JSON.parse(buf.toString('utf8'));
    if (legacy?.app !== 'SexyVal' || typeof legacy.files !== 'object') return { ok: false, error: 'Not a SexyVal vault or backup file' };
    const payloadText = JSON.stringify(legacy);
    return checkEnvelope({ magic: VAULT_MAGIC, schema: 0, createdAt: Number(legacy.exportedAt) || 0, appVersion: String(legacy.version ?? '?'), reason: 'export', sha256: sha256(payloadText), payloadText }, sha256);
  } catch (e) {
    return { ok: false, error: `Unreadable file: ${(e as Error).message}` };
  }
}

interface State {
  lastSnapshotAt?: number;
  lastError?: string;
  reminders: boolean;
  lastReminderAt: number;
  recoveredAt?: number;
  recoveredFiles?: number;
}

/**
 * The vault keeps a validated copy of SexyVal's own data so a broken file, a reinstall or a bad import
 * can't take it with it. It is a backup, not the live database: services keep their own files.
 */
export class VaultService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private state: State = { reminders: true, lastReminderAt: 0 };

  constructor(
    private readonly dataDir: (...p: string[]) => string,
    private readonly appVersion: string,
    readonly root: string = defaultVaultDir(),
  ) {}

  private p(...x: string[]) {
    return path.join(this.root, ...x);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.p('history'), { recursive: true });
    await fs.mkdir(this.p('matches'), { recursive: true });
    try {
      this.state = { ...this.state, ...JSON.parse(await fs.readFile(this.p('vault-state.json'), 'utf8')) };
    } catch {
      // First run: the first reminder comes a few days in, not on day one.
      this.state.lastReminderAt = Date.now() - REMIND_EVERY + 3 * 24 * 60 * 60_000;
    }
    // Leftovers of an interrupted write: never valid, never read.
    for (const f of await fs.readdir(this.root).catch(() => [])) if (f.endsWith('.tmp')) await fs.rm(this.p(f), { force: true });
  }

  private async saveState(): Promise<void> {
    await fs.writeFile(this.p('vault-state.json'), JSON.stringify(this.state)).catch(() => undefined);
  }

  private async readFile(file: string): Promise<VaultCheck> {
    try {
      return decodeVault(await fs.readFile(file));
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async historyFiles(): Promise<string[]> {
    return (await fs.readdir(this.p('history')).catch(() => [] as string[])).filter((f) => f.endsWith('.sxyval')).sort().reverse();
  }

  /** The newest valid snapshot: the current file, else the newest valid history entry. */
  async best(): Promise<{ file: string; check: Extract<VaultCheck, { ok: true }> } | null> {
    for (const f of [this.p(CURRENT), ...(await this.historyFiles()).map((h) => this.p('history', h))]) {
      const c = await this.readFile(f);
      if (c.ok) return { file: f, check: c };
    }
    return null;
  }

  // ---------- collecting ----------

  private async collect(includeMatches: boolean): Promise<VaultPayload> {
    const files: VaultPayload['files'] = {};
    for (const f of VAULT_FILES) {
      try {
        files[f] = JSON.parse(await fs.readFile(this.dataDir(f), 'utf8'));
      } catch {
        // missing or mid-write: the previous snapshot still has it
      }
    }
    const mmrUpdates: Record<string, unknown> = {};
    for (const f of await fs.readdir(this.dataDir('mmr-updates')).catch(() => [] as string[])) {
      if (!ID_FILE.test(f)) continue;
      try {
        mmrUpdates[f] = JSON.parse(await fs.readFile(this.dataDir('mmr-updates', f), 'utf8'));
      } catch {
        // skip a file being written
      }
    }
    const matchNames = (await fs.readdir(this.dataDir('matches')).catch(() => [] as string[])).filter((f) => MATCH_FILE.test(f));
    const payload: VaultPayload = { files, mmrUpdates, matchCount: matchNames.length };
    if (includeMatches) {
      payload.matches = {};
      const mirror = new Set(await fs.readdir(this.p('matches')).catch(() => [] as string[]));
      for (const f of new Set([...matchNames, ...[...mirror].filter((x) => MATCH_FILE.test(x))])) {
        const src = matchNames.includes(f) ? this.dataDir('matches', f) : this.p('matches', f);
        try {
          payload.matches[f] = JSON.parse(await fs.readFile(src, 'utf8'));
        } catch {
          // skip
        }
      }
      payload.matchCount = Object.keys(payload.matches).length;
    }
    // Settings: never the HenrikDev key or machine-specific values.
    const s = files['settings.json'] as Record<string, unknown> | undefined;
    if (s) for (const k of ['henrikKey', 'window', 'stretchDevice', 'overlayDisplay']) delete s[k];
    return payload;
  }

  private envelope(payload: VaultPayload, reason: VaultEnvelope['reason']): VaultEnvelope {
    const payloadText = JSON.stringify(payload);
    return { magic: VAULT_MAGIC, schema: VAULT_SCHEMA, createdAt: Date.now(), appVersion: this.appVersion, reason, sha256: sha256(payloadText), payloadText };
  }

  /** Match files never change once cached: copy the new ones only. */
  private async mirrorMatches(): Promise<number> {
    const have = new Set(await fs.readdir(this.p('matches')).catch(() => [] as string[]));
    let n = 0;
    for (const f of await fs.readdir(this.dataDir('matches')).catch(() => [] as string[])) {
      if (!MATCH_FILE.test(f) || have.has(f)) continue;
      await fs.copyFile(this.dataDir('matches', f), this.p('matches', f)).catch(() => undefined);
      n++;
    }
    return n;
  }

  // ---------- snapshots ----------

  /**
   * Atomic: write a temp file, read it back and verify the checksum, move the old current into history,
   * then rename. A crash at any step leaves the previous valid snapshot in place.
   */
  snapshot(reason: VaultEnvelope['reason'] = 'auto'): Promise<void> {
    this.running ??= (async () => {
      try {
        const env = this.envelope(await this.collect(false), reason);
        const tmp = this.p(`${CURRENT}.${process.pid}.tmp`);
        await fs.writeFile(tmp, encodeVault(env));
        const verify = await this.readFile(tmp);
        if (!verify.ok) throw new Error(`verification failed: ${verify.error}`);
        const cur = await this.readFile(this.p(CURRENT));
        if (cur.ok) await fs.copyFile(this.p(CURRENT), this.p('history', `sexyval-${new Date(cur.envelope.createdAt).toISOString().replace(/[:.]/g, '-')}.sxyval`));
        else await fs.rename(this.p(CURRENT), this.p(`${CURRENT}.corrupt-${Date.now()}`)).catch(() => undefined);
        await fs.rename(tmp, this.p(CURRENT));
        await this.prune();
        const mirrored = await this.mirrorMatches();
        this.state.lastSnapshotAt = env.createdAt;
        this.state.lastError = undefined;
        log.info(`vault: snapshot (${reason}), ${Math.round(env.payloadText.length / 1024)} KB, ${mirrored} new matches mirrored`);
      } catch (e) {
        this.state.lastError = (e as Error).message;
        log.warn('vault snapshot failed', e);
      } finally {
        await this.saveState();
      }
    })().finally(() => (this.running = null));
    return this.running;
  }

  private async prune(): Promise<void> {
    const files = await this.historyFiles();
    const times = new Map<number, string>();
    for (const f of files) {
      const m = /^sexyval-(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z\.sxyval$/.exec(f);
      if (m) times.set(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]), f);
    }
    const keep = keepSnapshots([...times.keys()]);
    for (const [t, f] of times) if (!keep.has(t)) await fs.rm(this.p('history', f), { force: true });
  }

  /** A covered file was written: snapshot after a quiet spell, at most every 10 minutes. */
  markDirty(): void {
    if (this.timer) return;
    const since = Date.now() - (this.state.lastSnapshotAt ?? 0);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.snapshot('auto');
    }, Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - since));
    this.timer.unref?.();
  }

  /** Called for every JSON write in the data folder (paths.ts). */
  covers(file: string): boolean {
    const base = path.basename(file);
    const dir = path.basename(path.dirname(file));
    return (VAULT_FILES as readonly string[]).includes(base) || dir === 'mmr-updates' || dir === 'matches';
  }

  // ---------- recovery ----------

  /**
   * Startup (before settings and services load): after a reinstall or a lost file, bring back what is
   * missing from the newest valid snapshot. Existing files are never touched: newer data wins.
   */
  async recoverMissing(): Promise<{ restored: string[]; from?: string }> {
    const best = await this.best();
    if (!best) return { restored: [] };
    if (best.file !== this.p(CURRENT)) {
      log.warn('vault: current snapshot invalid, using a history copy');
      await fs.rename(this.p(CURRENT), this.p(`${CURRENT}.corrupt-${Date.now()}`)).catch(() => undefined);
      await fs.copyFile(best.file, this.p(CURRENT));
    }
    const p = best.check.payload;
    const restored: string[] = [];
    const exists = async (f: string) => fs.stat(f).then(() => true, () => false);
    for (const f of Object.keys(p.files) as VaultFile[]) {
      if (await exists(this.dataDir(f))) continue;
      await fs.mkdir(path.dirname(this.dataDir(f)), { recursive: true });
      await fs.writeFile(this.dataDir(f), JSON.stringify(p.files[f]));
      restored.push(f);
    }
    await fs.mkdir(this.dataDir('mmr-updates'), { recursive: true });
    const haveMmr = new Set(await fs.readdir(this.dataDir('mmr-updates')).catch(() => [] as string[]));
    for (const f of missingOnly(Object.keys(p.mmrUpdates), haveMmr)) {
      await fs.writeFile(this.dataDir('mmr-updates', f), JSON.stringify(p.mmrUpdates[f]));
      restored.push(`mmr-updates/${f}`);
    }
    await fs.mkdir(this.dataDir('matches'), { recursive: true });
    const haveMatches = new Set(await fs.readdir(this.dataDir('matches')).catch(() => [] as string[]));
    let m = 0;
    for (const f of missingOnly((await fs.readdir(this.p('matches')).catch(() => [] as string[])).filter((x) => MATCH_FILE.test(x)), haveMatches)) {
      await fs.copyFile(this.p('matches', f), this.dataDir('matches', f)).catch(() => undefined);
      m++;
    }
    if (m) restored.push(`${m} cached matches`);
    if (restored.length) {
      this.state.recoveredAt = Date.now();
      this.state.recoveredFiles = restored.length;
      await this.saveState();
      log.info(`vault: restored ${restored.length} missing item(s) from ${path.basename(best.file)}`);
    }
    return { restored, from: best.file };
  }

  /** Overwrite the current data with a snapshot or an imported file (after a safety snapshot). Caller relaunches. */
  async restore(check: Extract<VaultCheck, { ok: true }>): Promise<number> {
    await this.snapshot('before-restore');
    const p = check.payload;
    let n = 0;
    for (const f of Object.keys(p.files) as VaultFile[]) {
      let v = p.files[f];
      // The vault never carries secrets or machine values: keep this PC's (HenrikDev key, window, displays).
      if (f === 'settings.json' && v && typeof v === 'object') {
        const here = await fs.readFile(this.dataDir(f), 'utf8').then((t) => JSON.parse(t), () => ({}));
        v = { ...(v as object), ...Object.fromEntries(['henrikKey', 'window', 'stretchDevice', 'overlayDisplay'].filter((k) => k in here).map((k) => [k, here[k]])) };
      }
      await fs.writeFile(this.dataDir(f), JSON.stringify(v));
      n++;
    }
    await fs.mkdir(this.dataDir('mmr-updates'), { recursive: true });
    for (const [f, v] of Object.entries(p.mmrUpdates)) {
      await fs.writeFile(this.dataDir('mmr-updates', f), JSON.stringify(v));
      n++;
    }
    if (p.matches) {
      await fs.mkdir(this.dataDir('matches'), { recursive: true });
      const have = new Set(await fs.readdir(this.dataDir('matches')).catch(() => [] as string[]));
      for (const [f, v] of Object.entries(p.matches)) if (!have.has(f)) await fs.writeFile(this.dataDir('matches', f), JSON.stringify(v));
    }
    return n;
  }

  async restoreVersion(name: string): Promise<number> {
    const file = name === CURRENT ? this.p(CURRENT) : this.p('history', path.basename(name));
    const c = await this.readFile(file);
    if (!c.ok) throw new Error(c.error);
    return this.restore(c);
  }

  async importFile(file: string): Promise<{ count: number; createdAt: number }> {
    const c = await this.readFile(file);
    if (!c.ok) throw new Error(c.error);
    return { count: await this.restore(c), createdAt: c.envelope.createdAt };
  }

  /** Portable copy (optionally with every cached match). Holds no logins: it restores data, not a session. */
  async exportTo(file: string, includeMatches: boolean): Promise<number> {
    const env = this.envelope(await this.collect(includeMatches), 'export');
    const buf = encodeVault(env);
    await fs.writeFile(file, buf);
    const v = await this.readFile(file);
    if (!v.ok) throw new Error(`Export didn’t verify: ${v.error}`);
    return buf.length;
  }

  // ---------- status / reminder ----------

  async status(): Promise<VaultStatus> {
    const cur = await this.readFile(this.p(CURRENT));
    const st = await fs.stat(this.p(CURRENT)).catch(() => null);
    const versions: VaultStatus['versions'] = [];
    if (cur.ok && st) versions.push({ name: CURRENT, createdAt: cur.envelope.createdAt, size: st.size, ok: true, reason: cur.envelope.reason, appVersion: cur.envelope.appVersion });
    for (const h of await this.historyFiles()) {
      const c = await this.readFile(this.p('history', h));
      const s = await fs.stat(this.p('history', h)).catch(() => null);
      versions.push({ name: h, createdAt: c.ok ? c.envelope.createdAt : (s?.mtimeMs ?? 0), size: s?.size ?? 0, ok: c.ok, reason: c.ok ? c.envelope.reason : undefined, appVersion: c.ok ? c.envelope.appVersion : undefined, error: c.ok ? undefined : c.error });
    }
    const mirrored = (await fs.readdir(this.p('matches')).catch(() => [] as string[])).length;
    const health: VaultStatus['health'] = cur.ok ? 'ok' : !st ? (versions.some((v) => v.ok) ? 'recovered' : 'none') : versions.some((v) => v.ok) ? 'recovered' : 'corrupt';
    return {
      location: this.root,
      health,
      error: cur.ok ? this.state.lastError : st ? cur.error : this.state.lastError,
      lastSnapshotAt: cur.ok ? cur.envelope.createdAt : this.state.lastSnapshotAt,
      size: st?.size,
      matchesMirrored: mirrored,
      matchCount: cur.ok ? cur.payload.matchCount : undefined,
      versions,
      reminders: this.state.reminders,
      recoveredAt: this.state.recoveredAt,
      recoveredFiles: this.state.recoveredFiles,
    };
  }

  /** Cheap, synchronous view for the health panel (no file reads). */
  quickHealth(): { lastSnapshotAt?: number; error?: string } {
    return { lastSnapshotAt: this.state.lastSnapshotAt, error: this.state.lastError };
  }

  reminderDue(): boolean {
    return this.state.reminders && !!this.state.lastSnapshotAt && Date.now() - this.state.lastReminderAt > REMIND_EVERY;
  }

  async reminderSeen(disable: boolean): Promise<void> {
    this.state.lastReminderAt = Date.now();
    if (disable) this.state.reminders = false;
    await this.saveState();
  }

  async setReminders(on: boolean): Promise<void> {
    this.state.reminders = on;
    await this.saveState();
  }
}
