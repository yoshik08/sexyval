import { Agent, fetch } from 'undici';

// Self-signed cert is accepted ONLY for the local Riot Client on 127.0.0.1.
const localInsecure = new Agent({ connect: { rejectUnauthorized: false } });

export interface HttpResult {
  status: number;
  headers: { get(name: string): string | null };
  text: string;
  json: any;
  url: string;
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} on ${path}`);
  }
}

export function isConnRefused(e: unknown): boolean {
  const err = e as any;
  const code = err?.cause?.code ?? err?.code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET';
}

/** Path only (no host/query) for logs and errors. */
export function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '?';
  }
}

export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const u = new URL(url);
  const dispatcher = u.protocol === 'https:' && u.hostname === '127.0.0.1' ? localInsecure : undefined;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['Content-Type'] ??= 'application/json';
  }
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body,
    dispatcher,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 12000),
  });
  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, headers: res.headers, text, json, url };
}

/** Fetches binary (used for asset images). */
export async function httpBinary(url: string): Promise<{ status: number; type: string; data: Buffer }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const data = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') ?? 'application/octet-stream', data };
}
