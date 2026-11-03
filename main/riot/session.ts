import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseLockfile, type Lockfile } from '../../shared/lockfile';
import { glzUrl, hasValorantSession, parseExternalSessions, parseShooterLog, pdUrl } from '../../shared/region';
import {
  chooseRegion,
  pickTokenSource,
  resolveVersion,
  type RegionCandidate,
  type TokenSource,
  type VersionCandidate,
} from '../../shared/connection';
import { httpRequest, isConnRefused, type HttpResult } from './http';
import { log } from '../log';

const CLIENT_PLATFORM_BASE = {
  platformType: 'PC',
  platformOS: 'Windows',
  platformOSVersion: '10.0.19042.1.256.64bit',
  platformChipset: 'Unknown',
};

const USER_AGENT = 'ShooterGame/13 Windows/10.0.19043.1.256.64bit';
const TOKEN_TTL_MS = 30 * 60 * 1000;

/** No usable tokens at all (no Riot Client, not signed in). */
export class WaitingError extends Error {}

/** Signed-in session provider (implemented by the AccountManager in main). */
export interface SignInProvider {
  /** Valid tokens for the active account, re-authenticating silently if needed. Null if none. */
  getTokens(): Promise<{ accessToken: string; entitlement: string; subject: string; region: string | null; label: string } | null>;
  /** Called on 401: force a silent re-auth of the active account. */
  reauth(): Promise<boolean>;
  hasAccount(): boolean;
}

export interface ConnectionCache {
  version?: string;
  at?: number;
  /** Verified region per PUUID. */
  accounts?: Record<string, { region: string; shard: string }>;
  /** Legacy (pre per-account cache); ignored. */
  region?: string;
  shard?: string;
}

export interface SessionOptions {
  lockfilePath?: string;
  shooterLogPath?: string;
  overrideGlz?: string;
  overridePd?: string;
  overrideShared?: string;
  onRaw?: (key: string, data: unknown) => void;
  signin?: SignInProvider;
  loadCache?: () => Promise<ConnectionCache>;
  saveCache?: (c: ConnectionCache) => Promise<void>;
  platformType?: () => string;
}

interface Auth {
  accessToken: string;
  entitlement: string;
  subject: string;
  at: number;
}

export function defaultLockfilePath(): string {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Riot Games', 'Riot Client', 'Config', 'lockfile');
}

export function defaultShooterLogPath(): string {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'VALORANT', 'Saved', 'Logs', 'ShooterGame.log');
}

/**
 * Connection state. Tokens come from the Riot Client (works with Valorant closed) or,
 * if it isn't running, from a signed-in session. Only Live needs the Valorant process.
 * Tokens live only in memory here: never persisted, never logged.
 */
export class RiotSession {
  private lock: Lockfile | null = null;
  private lockKey = '';
  private localAuth: Auth | null = null;
  private active: Auth | null = null;
  tokenSource: TokenSource = 'none';
  accountLabel: string | null = null;
  riotClient: 'up' | 'down' = 'down';
  valorantRunning = false;
  region: string | null = null;
  shard: string | null = null;
  regionSource: string | null = null;
  version: string | null = null;
  versionSource: string | null = null;
  private resolvedKey = '';
  private lastSessions: unknown = null;
  private signinRegion: string | null = null;

  constructor(private readonly opts: SessionOptions = {}) {}

  get puuid(): string | null {
    return this.active?.subject ?? null;
  }

  get ready(): boolean {
    return !!(this.active && this.region && this.shard && this.version);
  }

  get localAvailable(): boolean {
    return this.riotClient === 'up' && !!this.lock;
  }

  invalidateAuth(): void {
    if (this.tokenSource === 'riot-client') this.localAuth = null;
    this.active = null;
  }

  reset(): void {
    this.lock = null;
    this.lockKey = '';
    this.localAuth = null;
    this.riotClient = 'down';
    this.valorantRunning = false;
  }

  private async readLockfile(): Promise<Lockfile | null> {
    try {
      return parseLockfile(await fs.readFile(this.opts.lockfilePath ?? defaultLockfilePath(), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Local Riot Client API (Basic riot:password). Throws WaitingError if the client is gone. */
  async local(pathname: string, init: { method?: string; body?: unknown } = {}): Promise<HttpResult> {
    if (!this.lock) throw new WaitingError('Riot Client not running');
    const basic = Buffer.from(`riot:${this.lock.password}`).toString('base64');
    try {
      return await httpRequest(`${this.lock.protocol}://127.0.0.1:${this.lock.port}${pathname}`, {
        method: init.method,
        body: init.body,
        headers: { Authorization: `Basic ${basic}` },
        timeoutMs: 5000,
      });
    } catch (e) {
      if (isConnRefused(e) || (e as any)?.name === 'TimeoutError') {
        this.reset();
        throw new WaitingError('Riot Client closed');
      }
      throw e;
    }
  }

  /** Probe the Riot Client: lockfile, sessions (Valorant running?), local tokens. Never throws. */
  private async probeLocal(): Promise<void> {
    const lf = await this.readLockfile();
    if (!lf) {
      this.reset();
      return;
    }
    const key = `${lf.pid}:${lf.port}:${lf.password}`;
    if (key !== this.lockKey) {
      if (this.lockKey) log.info('Lockfile changed, re-authenticating');
      this.reset();
      this.lock = lf;
      this.lockKey = key;
    }
    try {
      const sessions = await this.local('/product-session/v1/external-sessions');
      if (sessions.status !== 200) throw new Error(`sessions ${sessions.status}`);
      this.opts.onRaw?.('externalSessions', sessions.json);
      this.lastSessions = sessions.json;
      this.valorantRunning = hasValorantSession(sessions.json);
      if (!this.localAuth || Date.now() - this.localAuth.at > TOKEN_TTL_MS) await this.refreshLocalAuth();
      this.riotClient = this.localAuth ? 'up' : 'down';
    } catch (e) {
      if (!(e instanceof WaitingError)) log.warn('Riot Client probe failed', e);
      this.riotClient = 'down';
      this.valorantRunning = false;
      this.localAuth = null;
    }
  }

  private async refreshLocalAuth(): Promise<void> {
    const res = await this.local('/entitlements/v1/token');
    const j = res.json;
    const accessToken = typeof j?.accessToken === 'string' ? j.accessToken : '';
    const entitlement = typeof j?.token === 'string' ? j.token : '';
    const subject = typeof j?.subject === 'string' ? j.subject : '';
    if (res.status !== 200 || !accessToken || !entitlement || !subject) {
      this.localAuth = null;
      throw new Error(`Riot Client not signed in (entitlements ${res.status})`);
    }
    this.localAuth = { accessToken, entitlement, subject, at: Date.now() };
    this.opts.onRaw?.('entitlements', { subject, hasAccessToken: true, hasEntitlement: true, keys: Object.keys(j) });
    log.info('Tokens refreshed (Riot Client)');
  }

  /** Kept for callers that force a refresh after a 400/401. */
  async refreshAuth(): Promise<void> {
    if (this.tokenSource === 'signin' && this.opts.signin) {
      await this.opts.signin.reauth();
    } else if (this.lock) {
      await this.refreshLocalAuth();
    }
    await this.pickTokens();
  }

  private async pickTokens(): Promise<void> {
    let signed: Awaited<ReturnType<SignInProvider['getTokens']>> = null;
    if (!this.localAuth && this.opts.signin?.hasAccount()) {
      signed = await this.opts.signin.getTokens().catch((e) => {
        log.warn('signed-in session unavailable', e);
        return null;
      });
    }
    this.tokenSource = pickTokenSource({ riotClientTokens: !!this.localAuth, signedInTokens: !!signed });
    if (this.tokenSource === 'riot-client') {
      this.active = this.localAuth;
      this.accountLabel = null;
      this.signinRegion = null;
    } else if (this.tokenSource === 'signin' && signed) {
      this.active = { accessToken: signed.accessToken, entitlement: signed.entitlement, subject: signed.subject, at: Date.now() };
      this.accountLabel = signed.label;
      this.signinRegion = signed.region;
    } else {
      this.active = null;
      this.accountLabel = null;
    }
  }

  /**
   * Ensures tokens + region + shard + version. Does NOT require Valorant.
   * Throws WaitingError only when there are no tokens at all.
   */
  async ensure(): Promise<void> {
    await this.probeLocal();
    await this.pickTokens();
    if (!this.active) {
      throw new WaitingError(this.opts.signin?.hasAccount() ? 'Riot Client closed and signed-in session expired' : 'Riot Client not running and not signed in');
    }
    const key = `${this.tokenSource}:${this.active.subject}:${this.valorantRunning}:${this.lockKey}`;
    if (key !== this.resolvedKey || !this.region || !this.version) {
      await this.resolveRegionAndVersion();
      this.resolvedKey = key;
    }
  }

  private async readShooterLog(): Promise<ReturnType<typeof parseShooterLog>> {
    try {
      return parseShooterLog(await fs.readFile(this.opts.shooterLogPath ?? defaultShooterLogPath(), 'utf8'));
    } catch {
      return {};
    }
  }

  private async resolveRegionAndVersion(): Promise<void> {
    const fromSession = this.valorantRunning ? parseExternalSessions(this.lastSessions) : null;
    const cache = (await this.opts.loadCache?.().catch(() => ({}) as ConnectionCache)) ?? {};
    const logInfo = await this.readShooterLog();

    const puuid = this.active!.subject;

    // Version first: the shard probe below needs full headers.
    // Version: session -> disk cache -> ShooterGame.log -> valorant-api.com
    const versionCandidates: VersionCandidate[] = [
      { source: 'valorant-session', version: fromSession?.version },
      { source: 'disk-cache', version: cache.version },
      { source: 'shooter-log', version: logInfo.version },
    ];
    let version = resolveVersion(versionCandidates);
    if (!version) {
      try {
        const r = await httpRequest('https://valorant-api.com/v1/version', { timeoutMs: 8000 });
        version = resolveVersion([{ source: 'valorant-api', version: r.json?.data?.riotClientVersion }]);
      } catch (e) {
        log.warn('valorant-api version fallback failed', e);
      }
    }
    if (!version) throw new WaitingError('Could not determine client version');
    this.version = version.version;
    this.versionSource = version.source;

    // Region: session args -> sign-in geo -> per-account disk cache -> ShooterGame.log -> region-locale.
    // Anything not from the game is verified against the shard (region-locale is the Riot Client's UI
    // region and was observed as "NA" for an AP account). Nothing verifies -> probe every shard.
    const cached = cache.accounts?.[puuid];
    const regionCandidates: RegionCandidate[] = [];
    if (fromSession) regionCandidates.push({ source: 'valorant-session', region: fromSession.region, shard: fromSession.shard });
    if (this.tokenSource === 'signin' && this.signinRegion) regionCandidates.push({ source: 'riot-geo', region: this.signinRegion });
    if (cached?.region) regionCandidates.push({ source: 'disk-cache', region: cached.region, shard: cached.shard });
    if (logInfo.region) regionCandidates.push({ source: 'shooter-log', region: logInfo.region, shard: logInfo.shard });
    if (this.localAvailable) {
      try {
        const rl = await this.local('/riotclient/region-locale');
        this.opts.onRaw?.('regionLocale', rl.json);
        if (rl.status === 200) {
          regionCandidates.push({ source: 'region-locale', region: rl.json?.region });
          regionCandidates.push({ source: 'region-locale', region: rl.json?.webRegion });
        }
      } catch (e) {
        log.warn('region-locale failed', e);
      }
    }
    const probes: Record<string, string> = {};
    const region = await chooseRegion(regionCandidates, async (shard) => {
      const n = await this.ownedAgentsOn(shard);
      probes[shard] = n < 0 ? 'error' : `${n} agents`;
      return n > 0;
    });
    this.opts.onRaw?.('connectionResolution', { regionCandidates, probes, region, versionCandidates, version });
    if (!region) throw new WaitingError('Could not determine region (start Valorant once so it can be detected)');

    const changed = region.region !== this.region || region.shard !== this.shard;
    this.region = region.region;
    this.shard = region.shard;
    this.regionSource = region.verified ? region.source : `${region.source} (unverified)`;
    if (changed) log.info(`Region ${this.region}/${this.shard} (${this.regionSource}), version ${this.version} (${this.versionSource})`);
    const next: ConnectionCache = { ...cache, version: this.version, at: Date.now(), accounts: { ...(cache.accounts ?? {}) } };
    // Only remember regions we trust.
    if (region.verified) next.accounts![puuid] = { region: this.region, shard: this.shard };
    delete next.region;
    delete next.shard;
    await this.opts.saveCache?.(next).catch(() => undefined);
  }

  /** Number of owned agents on a shard (an account's data only exists on its own shard). -1 on error. */
  private async ownedAgentsOn(shard: string): Promise<number> {
    try {
      const base = this.opts.overridePd ?? pdUrl(shard);
      const r = await httpRequest(`${base}/store/v1/entitlements/${this.active!.subject}/01bb38e1-da47-4e6a-9b3d-945fe4655707`, { headers: this.headers(), timeoutMs: 8000 });
      if (r.status !== 200) return -1;
      const list = Array.isArray(r.json?.Entitlements) ? r.json.Entitlements : Array.isArray(r.json?.EntitlementsByTypes) ? r.json.EntitlementsByTypes.flatMap((g: any) => g?.Entitlements ?? []) : [];
      return list.length;
    } catch {
      return -1;
    }
  }

  base(kind: 'glz' | 'pd' | 'shared'): string {
    if (!this.region || !this.shard) throw new WaitingError('Region not resolved');
    if (kind === 'glz') return this.opts.overrideGlz ?? glzUrl(this.region, this.shard);
    if (kind === 'shared') return this.opts.overrideShared ?? `https://shared.${this.shard}.a.pvp.net`;
    return this.opts.overridePd ?? pdUrl(this.shard);
  }

  headers(): Record<string, string> {
    if (!this.active || !this.version) throw new WaitingError('Not authenticated');
    const platform = { ...CLIENT_PLATFORM_BASE, platformType: this.opts.platformType?.() ?? 'PC' };
    return {
      Authorization: `Bearer ${this.active.accessToken}`,
      'X-Riot-Entitlements-JWT': this.active.entitlement,
      'X-Riot-ClientVersion': this.version,
      'X-Riot-ClientPlatform': Buffer.from(JSON.stringify(platform)).toString('base64'),
      'User-Agent': USER_AGENT,
    };
  }
}
