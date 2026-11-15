import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliMessage, IDLE_INSTALL, isDaemonDown, isRegistrationMissing, parseScQuery, parseWarpStatus, WARP_DEFAULT_CLI, WARP_DOWNLOAD_URL, WARP_SERVICE, type WarpInstall, type WarpPhase, type WarpStatus } from '../../shared/warp';
import { log } from '../log';

export interface RunResult {
  code: number;
  out: string;
  /** The program itself couldn't be started (ENOENT and friends). */
  spawnError?: string;
}
export type Runner = (file: string, args: string[], timeoutMs?: number) => Promise<RunResult>;

const sys32 = (exe: string) => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe);

export const execRunner: Runner = (file, args, timeoutMs = 15_000) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`;
      if (!err) return resolve({ code: 0, out });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (typeof e.code === 'string') return resolve({ code: -1, out, spawnError: e.code === 'ENOENT' ? 'not found' : `${e.code}: ${e.message}` });
      if (e.killed) return resolve({ code: -1, out: out || `timed out after ${Math.round(timeoutMs / 1000)} s` });
      resolve({ code: typeof e.code === 'number' ? e.code : 1, out: out || e.message });
    });
  });

export interface WarpDeps {
  run?: Runner;
  exists?: (file: string) => Promise<boolean>;
  fetch?: typeof fetch;
  /** Checks the downloaded installer is signed by Cloudflare. Resolves to an error message, or null when it is. */
  verify?: (file: string) => Promise<VerifyResult>;
  /** Runs the installer and resolves with its exit code once it closes (null: opened, can't wait). */
  launch?: (file: string) => Promise<number | null>;
  tempDir?: () => string;
  sleep?: (ms: number) => Promise<void>;
  onStatus: (s: WarpStatus) => void;
}

const fileExists = (f: string) =>
  fs.access(f).then(
    () => true,
    () => false,
  );

export type VerifyResult = { ok: true } | { ok: false; message: string; /** The bytes are damaged (worth downloading again), not signed by someone else. */ corrupt: boolean };

const DOWNLOAD_ATTEMPTS = 3;

/** Authenticode check through PowerShell: Valid, and the signer is Cloudflare, Inc. */
async function verifySignature(file: string, run: Runner): Promise<VerifyResult> {
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$s = Get-AuthenticodeSignature -LiteralPath $env:SEXYVAL_WARP_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
  process.env.SEXYVAL_WARP_FILE = file;
  try {
    const r = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', script], 30_000);
    const [status = '', subject = ''] = r.out.trim().split('|');
    if (status === 'Valid') {
      if (/O="?Cloudflare, Inc\./.test(subject)) return { ok: true };
      return { ok: false, corrupt: false, message: `The installer is signed by someone other than Cloudflare (${subject}).` };
    }
    // HashMismatch / NotSigned / UnknownError on a file Cloudflare signs means damaged bytes.
    const corrupt = /^(HashMismatch|NotSigned|UnknownError)$/.test(status);
    return { ok: false, corrupt, message: `Windows couldn't verify the installer's signature (${status || r.out.trim() || 'no answer'}).` };
  } finally {
    delete process.env.SEXYVAL_WARP_FILE;
  }
}

/** msiexec shows Cloudflare's own installer UI and asks for admin itself; we wait for it to close. */
function launchInstaller(file: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const p = file.toLowerCase().endsWith('.msi') ? spawn(sys32('msiexec.exe'), ['/i', file], { stdio: 'ignore' }) : spawn(file, [], { stdio: 'ignore' });
    p.once('error', reject);
    p.once('exit', (code) => resolve(code));
  });
}

function fileNameFrom(disposition: string | null): string {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? '');
  const name = (m?.[1] ?? '').replace(/[^A-Za-z0-9._-]/g, '');
  return /\.(msi|exe)$/i.test(name) ? name : 'Cloudflare_WARP.msi';
}

/**
 * Cloudflare WARP on/off through the official client's warp-cli. Never builds a tunnel of its own and
 * never guesses: every phase shown comes from `warp-cli status`, and CLI errors are passed through.
 */
export class WarpService {
  private readonly run: Runner;
  private readonly exists: (f: string) => Promise<boolean>;
  private readonly sleep: (ms: number) => Promise<void>;
  private cli: string | null = null;
  private phase: WarpPhase = 'disconnected';
  private checked = false;
  private refreshError: string | undefined;
  private actionError: string | undefined;
  private busy = false;
  private install: WarpInstall = { ...IDLE_INSTALL };
  private inflight: Promise<WarpStatus> | null = null;

  constructor(private readonly deps: WarpDeps) {
    this.run = deps.run ?? execRunner;
    this.exists = deps.exists ?? fileExists;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get status(): WarpStatus | null {
    if (!this.checked) return null;
    return { phase: this.phase, error: this.refreshError ?? this.actionError, busy: this.busy, install: { ...this.install } };
  }

  private emit(): void {
    const s = this.status;
    if (s) this.deps.onStatus(s);
  }

  /** PATH first (where warp-cli), then the default install folder. */
  async locate(): Promise<string | null> {
    // Dev aid: SEXYVAL_WARP_CLI=<path> pins the CLI (a missing path shows the not-installed row).
    const pinned = process.env.SEXYVAL_WARP_CLI;
    if (pinned) return (await this.exists(pinned)) ? pinned : null;
    const w =await this.run(sys32('where.exe'), ['warp-cli'], 5000);
    if (w.code === 0) {
      for (const line of w.out.split(/\r?\n/).map((l) => l.trim())) {
        if (/warp-cli(\.exe)?$/i.test(line) && (await this.exists(line))) return line;
      }
    }
    return (await this.exists(WARP_DEFAULT_CLI)) ? WARP_DEFAULT_CLI : null;
  }

  /** Re-reads the real state. Concurrent calls share one check. */
  refresh(): Promise<WarpStatus> {
    this.inflight ??= this.doRefresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async doRefresh(): Promise<WarpStatus> {
    const cli = this.cli ?? (await this.locate());
    this.cli = cli;
    this.checked = true;
    this.refreshError = undefined;
    if (!cli) {
      this.phase = 'not-installed';
      this.emit();
      return this.status!;
    }
    const r = await this.run(cli, ['status']);
    if (r.spawnError) {
      // The exe went away (uninstalled) or can't start: look again next time.
      this.cli = null;
      if (!(await this.exists(cli))) {
        this.phase = 'not-installed';
      } else {
        this.phase = 'error';
        this.refreshError = `warp-cli couldn't be started: ${r.spawnError}`;
      }
      this.emit();
      return this.status!;
    }
    let phase = parseWarpStatus(r.out);
    if (phase === 'error' || r.code !== 0) {
      const svc = parseScQuery((await this.run(sys32('sc.exe'), ['query', WARP_SERVICE], 5000)).out);
      if (svc === false) phase = 'service-down';
    }
    this.phase = phase;
    if (phase === 'service-down') this.refreshError = cliMessage(r.out, "warp-svc isn't running.");
    else if (phase === 'error') this.refreshError = cliMessage(r.out, `warp-cli status exited with code ${r.code} and printed nothing.`);
    this.emit();
    return this.status!;
  }

  /** On = `warp-cli connect`, off = `warp-cli disconnect`; registers the device first if it never was. */
  async set(on: boolean): Promise<WarpStatus> {
    if (this.busy) return this.status ?? this.refresh();
    this.busy = true;
    this.actionError = undefined;
    this.emit();
    try {
      await this.doSet(on);
    } finally {
      this.busy = false;
      this.emit();
    }
    // Read after busy clears, so the rpc's answer never overwrites the final event with a stale one.
    return this.status!;
  }

  private async doSet(on: boolean): Promise<void> {
    const before = await this.refresh();
    if (!this.cli || before.phase === 'not-installed' || before.phase === 'service-down') return;
    if (on && before.phase === 'registration-missing') {
      if (!(await this.register())) return;
    }
    let r = await this.run(this.cli, [on ? 'connect' : 'disconnect']);
    if (on && r.code !== 0 && isRegistrationMissing(r.out) && (await this.register())) r = await this.run(this.cli, ['connect']);
    if (r.code !== 0 || r.spawnError || /^error/im.test(r.out)) {
      this.actionError = isDaemonDown(r.out) ? undefined : cliMessage(r.spawnError ?? r.out, `warp-cli ${on ? 'connect' : 'disconnect'} exited with code ${r.code}.`);
      log.warn(`warp-cli ${on ? 'connect' : 'disconnect'} failed`, r.out.trim());
      await this.refresh();
      return;
    }
    // Connect returns at once; the tunnel settles about a second later. Re-read until it does.
    const target: WarpPhase = on ? 'connected' : 'disconnected';
    let s = await this.refresh();
    for (let i = 0; i < 24 && s.phase !== target && (s.phase === 'connecting' || s.phase === (on ? 'disconnected' : 'connected')); i++) {
      await this.sleep(500);
      s = await this.refresh();
    }
    if (s.phase !== target && !s.error) this.actionError = on ? `WARP didn't finish connecting (status: ${s.phase}). Check the Cloudflare WARP app.` : `WARP didn't disconnect (status: ${s.phase}).`;
  }

  private async register(): Promise<boolean> {
    const r = await this.run(this.cli!, ['--accept-tos', 'registration', 'new'], 30_000);
    if (r.code === 0 && !/^error/im.test(r.out)) {
      log.info('warp-cli registration new: ok');
      return true;
    }
    this.actionError = `Registering this device with WARP failed: ${cliMessage(r.spawnError ?? r.out, `exit code ${r.code}`)}`;
    return false;
  }

  /**
   * Downloads the official installer from WARP_DOWNLOAD_URL (only), checks it is signed by
   * Cloudflare, opens it, and re-checks for the install once it closes.
   */
  async installWarp(): Promise<WarpStatus | null> {
    if (this.install.stage === 'downloading' || this.install.stage === 'installing') return this.status;
    let dir: string | null = null;
    const setInstall = (i: WarpInstall) => {
      this.install = i;
      this.emit();
    };
    setInstall({ stage: 'downloading', received: 0, total: 0 });
    try {
      dir = await fs.mkdtemp(path.join(this.deps.tempDir?.() ?? os.tmpdir(), 'sexyval-warp-'));
      const verify = this.deps.verify ?? ((f: string) => verifySignature(f, this.run));
      // A download that arrives damaged (bad bytes on disk, Windows reports HashMismatch) is fetched
      // again from scratch; a file signed by anyone but Cloudflare never is.
      let file = '';
      let size = 0;
      for (let attempt = 1; ; attempt++) {
        const got = await this.downloadOnce(dir, attempt, setInstall);
        file = got.file;
        size = got.size;
        const v = got.intact ? await verify(file) : { ok: false as const, corrupt: true, message: 'The download was damaged on its way to disk.' };
        if (v.ok) break;
        log.warn(`WARP installer check failed (attempt ${attempt})`, v.message);
        await fs.rm(file, { force: true }).catch(() => undefined);
        if (!v.corrupt) throw new Error(`${v.message} It was not opened.`);
        if (attempt >= DOWNLOAD_ATTEMPTS) throw new Error(`The installer kept arriving damaged (${attempt} tries; last: ${v.message}). It was not opened. Check your connection and try again.`);
      }

      setInstall({ stage: 'installing', received: size, total: size });
      log.info(`WARP installer opened: ${path.basename(file)}`);
      const code = await (this.deps.launch ?? launchInstaller)(file);
      this.cli = null;
      if (code === 1602) throw new Error('The WARP install was cancelled.');
      if (code != null && code !== 0 && code !== 3010 && code !== 1641) throw new Error(`The WARP installer closed with code ${code}.`);
      this.install = { ...IDLE_INSTALL };
      // The service can take a few seconds to come up after a fresh install.
      let s = await this.refresh();
      for (let i = 0; i < 10 && s.phase === 'service-down'; i++) {
        await this.sleep(1000);
        s = await this.refresh();
      }
      return s;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('WARP install failed', msg);
      setInstall({ stage: 'error', received: this.install.received, total: this.install.total, error: msg });
      return this.status;
    } finally {
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * One fetch of WARP_DOWNLOAD_URL into `dir`. Each chunk is copied before it is written and every
   * write is awaited, so no buffer can be reused under a pending write; the SHA-256 of what arrived is
   * then compared with the file read back from disk (`intact`).
   */
  private async downloadOnce(dir: string, attempt: number, setInstall: (i: WarpInstall) => void): Promise<{ file: string; size: number; intact: boolean }> {
    const res = await (this.deps.fetch ?? fetch)(WARP_DOWNLOAD_URL, { redirect: 'follow' });
    const final = new URL(res.url || WARP_DOWNLOAD_URL);
    // Cloudflare redirects to a versioned URL on the same host. Anything else is refused.
    if (final.protocol !== 'https:' || final.hostname !== new URL(WARP_DOWNLOAD_URL).hostname) throw new Error(`The download was redirected to ${final.host}, not Cloudflare. Stopped.`);
    if (!res.ok || !res.body) throw new Error(`Cloudflare's download server answered ${res.status} ${res.statusText}.`);
    const total = Number(res.headers.get('content-length')) || 0;
    const file = path.join(dir, fileNameFrom(res.headers.get('content-disposition')));
    const hash = createHash('sha256');
    const reader = res.body.getReader();
    const fh = await fs.open(file, 'w');
    let received = 0;
    let last = 0;
    setInstall({ stage: 'downloading', received: 0, total, attempt });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value); // copy: the stream may reuse its memory once we await
        hash.update(chunk);
        let off = 0;
        while (off < chunk.length) off += (await fh.write(chunk, off, chunk.length - off)).bytesWritten;
        received += chunk.length;
        const now = Date.now();
        if (now - last > 150) {
          last = now;
          setInstall({ stage: 'downloading', received, total, attempt });
        }
      }
      await fh.sync();
    } finally {
      await fh.close();
      reader.releaseLock();
    }
    if (total && received !== total) throw new Error(`The download stopped early (${received} of ${total} bytes).`);
    setInstall({ stage: 'downloading', received, total: total || received, attempt });
    const onDisk = await fs.readFile(file);
    const intact = onDisk.length === received && createHash('sha256').update(onDisk).digest('hex') === hash.digest('hex');
    if (!intact) log.warn(`WARP download damaged on disk (attempt ${attempt}): ${onDisk.length} of ${received} bytes`);
    return { file, size: received, intact };
  }
}
