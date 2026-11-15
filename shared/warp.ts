// Cloudflare WARP, driven through the official client's CLI (warp-cli). Pure parsing lives here so it
// can be tested without the client installed.

/** The only place the installer is ever downloaded from. */
export const WARP_DOWNLOAD_URL = 'https://downloads.cloudflareclient.com/v1/download/windows/ga';
export const WARP_DEFAULT_CLI = 'C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe';
export const WARP_SERVICE = 'CloudflareWARP';

export type WarpPhase =
  | 'not-installed'
  | 'service-down'
  | 'connected'
  | 'disconnected'
  | 'connecting'
  | 'registration-missing'
  /** warp-cli answered, but with something we can't read as on or off. Never shown as a toggle state. */
  | 'error';

export interface WarpInstall {
  stage: 'idle' | 'downloading' | 'installing' | 'error';
  /** Download try number (a damaged download is fetched again). */
  attempt?: number;
  /** Bytes received / total (total 0 when the server sent no length). */
  received: number;
  total: number;
  error?: string;
}

export interface WarpStatus {
  phase: WarpPhase;
  /** Set when phase is 'error' or 'service-down', or when the last action failed: the CLI's own text. */
  error?: string;
  /** A connect/disconnect is in flight. */
  busy: boolean;
  install: WarpInstall;
}

export const IDLE_INSTALL: WarpInstall = { stage: 'idle', received: 0, total: 0 };

/** Messages warp-cli prints when it can't reach warp-svc. */
const DAEMON_DOWN = /unable to connect to the cloudflarewarp daemon|daemon (is )?not running|failed to connect to (the )?daemon|ipc.*(refused|not found)|pipe.*(not found|busy)/i;

export function isDaemonDown(out: string): boolean {
  return DAEMON_DOWN.test(out);
}

const REG_MISSING = /registration\s*missing|missing registration|not registered|no registration/i;

export function isRegistrationMissing(out: string): boolean {
  return REG_MISSING.test(out);
}

/**
 * Reads `warp-cli status` output. Known shapes:
 *   "Status update: Connected\nNetwork: healthy"
 *   "Status update: Disconnected\nReason: Manual Disconnection"
 *   "Status update: Connecting\nReason: ..."
 *   "Status update: Unable\nReason: Registration Missing"
 * and the -j form {"status":"Connected","reason":"NetworkHealthy"}.
 */
export function parseWarpStatus(out: string): WarpPhase {
  if (isDaemonDown(out)) return 'service-down';
  if (isRegistrationMissing(out)) return 'registration-missing';
  const m = /status(?: update)?"?\s*[:=]\s*"?([a-z]+)/i.exec(out);
  const word = m?.[1].toLowerCase();
  if (word === 'connected') return 'connected';
  if (word === 'disconnected') return 'disconnected';
  if (word === 'connecting' || word === 'disconnecting') return 'connecting';
  return 'error';
}

/** Whether the Windows service is running, from `sc query CloudflareWARP`. null: couldn't tell. */
export function parseScQuery(out: string): boolean | null {
  const m = /STATE\s*:\s*\d+\s+([A-Z_]+)/.exec(out);
  if (m) return m[1] === 'RUNNING';
  if (/1060|does not exist/i.test(out)) return false;
  return null;
}

/** The CLI's own output, trimmed, for the UI. Falls back when it printed nothing. */
export function cliMessage(out: string, fallback: string): string {
  const text = out.replace(/\r/g, '').trim();
  return text || fallback;
}
