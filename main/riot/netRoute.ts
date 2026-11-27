import net from 'node:net';
import tls from 'node:tls';
import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import { parseProxy, isBlockedError, type NetMode, type ProxySpec, type RouteStatus } from '../../shared/netRoute';
import { log } from '../log';

/**
 * Smart Store Sync routing (Settings > Network). Store requests (storefront, wallet) can go direct, direct
 * first with a proxy fallback, or only through a proxy the user configured. Only loopback proxies are
 * accepted (shared/netRoute.ts): software on this PC the user runs, such as Cloudflare WARP in proxy mode
 * (`warp-cli mode proxy`, SOCKS5 on 127.0.0.1:40000). SexyVal never changes WARP's mode or any system
 * network setting, and TLS runs end to end with full certificate checks: the proxy only ever sees an
 * encrypted tunnel to Riot, never tokens. Each proxied request uses a fresh dispatcher that is closed
 * afterwards, so nothing lingers. Sign-in (Riot Client, saved sign-in windows) never uses the proxy.
 */

const HANDSHAKE_MS = 8000;
/** After the direct route looked blocked, fallback mode goes to the proxy first for this long. */
export const DIRECT_BLOCKED_MS = 15 * 60_000;

/** SOCKS5 CONNECT (no auth) to host:port through the proxy, then TLS with normal certificate checks. */
export function socks5Agent(p: ProxySpec): Agent {
  return new Agent({
    connect: (opts: any, cb: (err: Error | null, socket: any) => void) => {
      const host: string = opts.hostname;
      const port = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
      const sock = net.connect({ host: p.host, port: p.port });
      let done = false;
      const fail = (e: Error) => {
        if (done) return;
        done = true;
        sock.destroy();
        cb(e, null);
      };
      sock.setTimeout(HANDSHAKE_MS, () => fail(Object.assign(new Error('SOCKS5 proxy did not answer'), { code: 'ETIMEDOUT' })));
      sock.once('error', fail);
      let stage = 0;
      let buf: Buffer = Buffer.alloc(0);
      sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (stage === 0) {
          if (buf.length < 2) return;
          if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error('SOCKS5 proxy refused (it needs a login, which SexyVal does not support)'));
          buf = buf.subarray(2);
          stage = 1;
          const h = Buffer.from(host, 'utf8');
          sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
          return;
        }
        if (stage === 1) {
          if (buf.length < 5) return;
          if (buf[1] !== 0) return fail(Object.assign(new Error(`SOCKS5 proxy could not reach ${host} (code ${buf[1]})`), { code: 'ECONNREFUSED' }));
          const atyp = buf[3];
          const len = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buf[4];
          if (buf.length < 4 + len + 2) return;
          stage = 2;
          sock.removeAllListeners('data');
          sock.removeListener('error', fail);
          sock.setTimeout(0);
          if (opts.protocol !== 'https:') {
            done = true;
            return cb(null, sock);
          }
          // Normal TLS: rejectUnauthorized stays at its default (true); servername = the real Riot host.
          const t = tls.connect({ socket: sock, servername: opts.servername || host, ALPNProtocols: ['http/1.1'] });
          t.once('secureConnect', () => {
            done = true;
            cb(null, t);
          });
          t.once('error', (e) => {
            if (!done) {
              done = true;
              cb(e, null);
            }
          });
        }
      });
    },
  });
}

export function makeDispatcher(p: ProxySpec): Dispatcher {
  return p.scheme === 'socks5' ? socks5Agent(p) : new ProxyAgent({ uri: `http://${p.host}:${p.port}` });
}

export interface RouteConfig {
  mode: NetMode;
  proxyUrl: string;
}

export class NetRouter {
  status: RouteStatus = { mode: 'direct', proxyState: 'unused' };
  private directBlockedUntil = 0;
  /** Proxied requests in flight (each holds its own dispatcher until it finishes). */
  open = 0;

  constructor(
    private readonly cfg: () => RouteConfig,
    private readonly factory: (p: ProxySpec) => Dispatcher = makeDispatcher,
    private readonly onChange: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  private set(patch: Partial<RouteStatus>): void {
    this.status = { ...this.status, ...patch, mode: this.cfg().mode };
    this.onChange();
  }

  /** Runs one store request on the configured route. `fn` must pass the dispatcher to its requests. */
  async run<T>(fn: (dispatcher?: Dispatcher) => Promise<T>): Promise<T> {
    const { mode, proxyUrl } = this.cfg();
    // No proxy entered: there is nothing to route through, so go direct. ("Proxy only" with an empty
    // proxy field used to fail every store request with "No proxy is set", forever.)
    if (mode === 'direct' || !proxyUrl.trim()) return this.direct(fn);
    if (mode === 'proxy') return this.viaProxy(proxyUrl, fn);
    if (this.now() < this.directBlockedUntil) {
      try {
        return await this.viaProxy(proxyUrl, fn);
      } catch (e) {
        if (!isBlockedError(e)) throw e;
        this.directBlockedUntil = 0; // proxy down too: try direct once more below
      }
    }
    try {
      return await this.direct(fn);
    } catch (e) {
      if (!isBlockedError(e)) throw e;
      this.directBlockedUntil = this.now() + DIRECT_BLOCKED_MS;
      log.info('store: direct route failed, trying the configured proxy');
      return this.viaProxy(proxyUrl, fn);
    }
  }

  private async direct<T>(fn: (d?: Dispatcher) => Promise<T>): Promise<T> {
    try {
      const r = await fn(undefined);
      this.set({ lastRoute: 'direct', lastOkAt: this.now(), lastError: undefined, lastBlocked: false });
      return r;
    } catch (e) {
      this.set({ lastError: describe(e), lastErrorAt: this.now(), lastBlocked: isBlockedError(e) });
      throw e;
    }
  }

  private async viaProxy<T>(url: string, fn: (d?: Dispatcher) => Promise<T>): Promise<T> {
    const p = parseProxy(url);
    if (!p.ok) {
      this.set({ proxyState: 'failed', proxyError: p.error });
      throw new Error(`Proxy: ${p.error}`);
    }
    const d = this.factory(p.proxy);
    this.open++;
    try {
      const r = await fn(d);
      this.set({ lastRoute: 'proxy', lastOkAt: this.now(), proxyState: 'ok', proxyOkAt: this.now(), proxyError: undefined, lastError: undefined, lastBlocked: false });
      return r;
    } catch (e) {
      const msg = describe(e);
      if (isBlockedError(e)) this.set({ proxyState: 'failed', proxyError: `${msg} (is the proxy running on ${p.proxy.host}:${p.proxy.port}?)`, lastError: msg, lastErrorAt: this.now(), lastBlocked: true });
      else this.set({ lastError: msg, lastErrorAt: this.now(), lastBlocked: false });
      throw e;
    } finally {
      this.open--;
      await d.close().catch(() => undefined);
    }
  }

  /** Settings > Network > Test: one harmless HTTPS request through the proxy (no Riot tokens). */
  async test(url: string, request: (d: Dispatcher) => Promise<unknown>): Promise<{ ok: boolean; ms?: number; error?: string }> {
    const p = parseProxy(url);
    if (!p.ok) return { ok: false, error: p.error };
    const d = this.factory(p.proxy);
    const t0 = this.now();
    try {
      await request(d);
      this.set({ proxyState: 'ok', proxyOkAt: this.now(), proxyError: undefined });
      return { ok: true, ms: this.now() - t0 };
    } catch (e) {
      const error = describe(e);
      this.set({ proxyState: 'failed', proxyError: error });
      return { ok: false, error };
    } finally {
      await d.close().catch(() => undefined);
    }
  }

  /** Settings changed: forget what we learned about the old route. */
  reset(): void {
    this.directBlockedUntil = 0;
    this.status = { mode: this.cfg().mode, proxyState: 'unused' };
    this.onChange();
  }
}

function describe(e: unknown): string {
  const err = e as any;
  const code = err?.cause?.code ?? err?.code;
  const m = String(err?.cause?.message ?? err?.message ?? e);
  return code && !m.includes(code) ? `${m} (${code})` : m;
}
