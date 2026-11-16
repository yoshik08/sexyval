// Store-sync routing rules (pure; main/riot/netRoute.ts does the sockets).

export type NetMode = 'direct' | 'fallback' | 'proxy';
export interface ProxySpec {
  scheme: 'socks5' | 'http';
  host: string;
  port: number;
}

export interface RouteStatus {
  mode: NetMode;
  lastRoute?: 'direct' | 'proxy';
  lastOkAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  /** The last failure looked like a blocked network path (not an HTTP answer from Riot). */
  lastBlocked?: boolean;
  proxyState: 'unused' | 'ok' | 'failed';
  proxyOkAt?: number;
  proxyError?: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Only proxies on this PC are accepted (socks5:// or http://, loopback host, explicit port, no login).
 * A remote proxy would be a third party in the path of Riot-authenticated requests; that is refused.
 */
export function parseProxy(url: string): { ok: true; proxy: ProxySpec } | { ok: false; error: string } {
  const s = String(url ?? '').trim();
  if (!s) return { ok: false, error: 'No proxy is set (Settings > Network)' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'Proxy address is not a valid URL (example: socks5://127.0.0.1:40000)' };
  }
  const scheme = u.protocol === 'socks5:' || u.protocol === 'socks5h:' || u.protocol === 'socks:' ? 'socks5' : u.protocol === 'http:' ? 'http' : null;
  if (!scheme) return { ok: false, error: 'Use socks5:// or http://' };
  if (u.username || u.password) return { ok: false, error: 'Proxies with a login are not supported' };
  if (!LOOPBACK.has(u.hostname)) return { ok: false, error: 'Only a proxy running on this PC (127.0.0.1) is allowed' };
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'The proxy address needs a port (example: socks5://127.0.0.1:40000)' };
  return { ok: true, proxy: { scheme, host: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname.replace(/^\[|\]$/g, ''), port } };
}

const BLOCKED = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * The network path looks blocked (refused, reset, timed out, DNS failed, or an intercepted TLS
 * certificate). HTTP answers (401, 403, 429...) are not: those came from Riot and a proxy would not help.
 * A certificate error is never ignored: the request fails and, in fallback mode, is retried through the
 * proxy with the same certificate checks.
 */
export function isBlockedError(e: unknown): boolean {
  const err = e as any;
  if (!err || typeof err !== 'object') return false;
  if (typeof err.status === 'number') return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const code = err.cause?.code ?? err.code;
  if (typeof code === 'string' && BLOCKED.has(code)) return true;
  return err.message === 'fetch failed' && !!err.cause && isBlockedError(err.cause);
}

/** Last store per account, shown with its time when a refresh fails or the account is offline. */
export function cacheLabel(fetchedAt: number | undefined, now: number): string {
  if (!fetchedAt) return '';
  const m = Math.round((now - fetchedAt) / 60_000);
  if (m < 1) return 'Fetched just now';
  if (m < 60) return `Fetched ${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `Fetched ${h} h ago` : `Fetched ${Math.round(h / 24)} days ago`;
}
