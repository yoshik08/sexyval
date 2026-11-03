import { net, protocol } from 'electron';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { httpBinary } from './riot/http';
import { log } from './log';
import { parseRange } from '../shared/range';

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' svasset: svlocal: data:",
  "media-src 'self' svvideo:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: 'svasset', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'svvideo', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: 'svlocal', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/** app://sexyval/... serves the built renderer with a strict CSP header. */
export function handleApp(rendererDir: string): void {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.normalize(path.join(rendererDir, rel));
    if (!file.startsWith(path.normalize(rendererDir))) return new Response('forbidden', { status: 403 });
    try {
      const data = await fs.readFile(file);
      return new Response(data, {
        headers: { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': CSP },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

const inflight = new Map<string, Promise<{ data: Buffer; type: string } | null>>();

/** svasset://img/<base64url> -> media.valorant-api.com image, cached on disk. */
export function handleAssets(cacheDir: string): void {
  protocol.handle('svasset', async (req) => {
    let remote: URL;
    try {
      const id = new URL(req.url).pathname.slice(1);
      remote = new URL(Buffer.from(id, 'base64url').toString('utf8'));
    } catch {
      return new Response('bad', { status: 400 });
    }
    if (remote.protocol !== 'https:' || !(remote.hostname === 'valorant-api.com' || remote.hostname.endsWith('.valorant-api.com'))) {
      return new Response('forbidden host', { status: 403 });
    }
    const key = crypto.createHash('sha1').update(remote.href).digest('hex');
    const ext = path.extname(remote.pathname) || '.bin';
    const file = path.join(cacheDir, key + ext);
    const type = MIME[ext] ?? 'image/png';
    try {
      const data = await fs.readFile(file);
      return new Response(data, { headers: { 'Content-Type': type, 'Cache-Control': 'max-age=31536000' } });
    } catch {
      /* not cached */
    }
    let p = inflight.get(key);
    if (!p) {
      p = (async () => {
        // One retry: the CDN occasionally resets a connection under a burst of grid thumbnails.
        let r = await httpBinary(remote.href).catch(() => null);
        if (!r || r.status >= 500) r = await httpBinary(remote.href);
        if (r.status !== 200) return null;
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(file, r.data);
        return { data: r.data, type: r.type };
      })()
        .catch((e) => {
          log.warn('asset image failed', remote.pathname, e);
          return null;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const got = await p;
    if (!got) return new Response('unavailable', { status: 502 });
    return new Response(got.data, { headers: { 'Content-Type': got.type, 'Cache-Control': 'max-age=31536000' } });
  });
}

// ---------- videos ----------
//
// Skin videos are 1080p H.264, 3-147 MB (median ~22 MB) with the moov atom first, so they stream
// well. The rules that keep them usable:
//  - never buffer a whole file before answering; pass Range through and pump chunk by chunk
//  - cancel the upstream request the moment the player stops reading
//  - hover previews (?p=1) are never cached and at most PREVIEW_MAX run at once
//  - a deliberate play is tee'd to disk when caching is on, kept only if complete, LRU-capped

export const MB = 1024 * 1024;
const PREVIEW_MAX = 2;
// streamedVideo URLs from valorant-api.com point at Riot's CDN.
const videoHostOk = (h: string) => h === 'valorant.dyn.riotcdn.net' || h === 'valorant-api.com' || h.endsWith('.valorant-api.com');

export interface VideoOptions {
  dir: string;
  cacheEnabled: () => boolean;
  maxBytes: () => number;
}

const previews = new Set<AbortController>();
const caching = new Set<string>();
let evicting = false;

const cachePath = (dir: string, href: string) => path.join(dir, crypto.createHash('sha1').update(href).digest('hex') + '.mp4');

async function serveFile(file: string, range: string | null, type: string): Promise<Response> {
  const { size } = await fs.stat(file);
  const now = new Date();
  void fs.utimes(file, now, now).catch(() => undefined); // LRU: mark as recently used
  const r = parseRange(range, size);
  if (range && !r) return new Response('range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  if (r) {
    const body = Readable.toWeb(createReadStream(file, { start: r.start, end: r.end })) as unknown as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: { 'Content-Type': type, 'Content-Length': String(r.end - r.start + 1), 'Content-Range': `bytes ${r.start}-${r.end}/${size}`, 'Accept-Ranges': 'bytes' },
    });
  }
  const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
  return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
}

/** Upstream GET with retries for network errors / 5xx / 429 before the first byte. */
async function fetchUpstream(url: string, range: string | null, signal: AbortSignal): Promise<Response> {
  let last: unknown = new Error('no attempt');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      const res = await net.fetch(url, { headers: range ? { Range: range } : {}, signal });
      if (res.status < 500 && res.status !== 429) return res;
      last = new Error(`HTTP ${res.status}`);
      await res.body?.cancel().catch(() => undefined);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      last = e;
    }
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1) ** 2));
  }
  throw last;
}

/** Writes a stream to <name>.part and promotes it to <name> only when every byte arrived. */
class CacheSink {
  private ws;
  private received = 0;
  private dead = false;

  constructor(
    private readonly part: string,
    private readonly final: string,
    private readonly total: number,
    private readonly done: () => void,
  ) {
    this.ws = createWriteStream(part);
    this.ws.on('error', () => this.abort());
  }
  async write(chunk: Uint8Array): Promise<void> {
    if (this.dead) return;
    this.received += chunk.byteLength;
    if (!this.ws.write(chunk)) await new Promise<void>((r) => this.ws.once('drain', () => r()));
  }
  async finish(): Promise<void> {
    if (this.dead) return;
    await new Promise<void>((r) => this.ws.end(() => r()));
    if (this.received === this.total) {
      await fs.rename(this.part, this.final);
      this.done();
    } else await fs.rm(this.part, { force: true });
  }
  abort(): void {
    if (this.dead) return;
    this.dead = true;
    this.ws.destroy();
    void fs.rm(this.part, { force: true });
  }
}

function pump(up: Response, ac: AbortController, sink?: CacheSink, onEnd?: () => void): ReadableStream<Uint8Array> {
  const reader = up.body!.getReader();
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          ctrl.close();
          await sink?.finish();
          onEnd?.();
          return;
        }
        if (sink) await sink.write(value);
        ctrl.enqueue(value);
      } catch (e) {
        sink?.abort();
        onEnd?.();
        ctrl.error(e);
      }
    },
    cancel() {
      if (!finished) {
        ac.abort();
        sink?.abort();
      }
      onEnd?.();
      return reader.cancel().catch(() => undefined);
    },
  });
}

/** Drops the least recently used files until the cache fits; also sweeps stale .part files. */
export async function evictVideoCache(dir: string, maxBytes: number): Promise<void> {
  if (evicting) return;
  evicting = true;
  try {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const files: { n: string; size: number; t: number }[] = [];
    for (const n of names) {
      const f = path.join(dir, n);
      const st = await fs.stat(f).catch(() => null);
      if (!st) continue;
      if (n.endsWith('.part')) {
        if (Date.now() - st.mtimeMs > 60 * 60 * 1000) await fs.rm(f, { force: true });
      } else if (n.endsWith('.mp4')) files.push({ n, size: st.size, t: st.mtimeMs });
    }
    let total = files.reduce((a, f) => a + f.size, 0);
    files.sort((a, b) => a.t - b.t);
    for (const f of files) {
      if (total <= maxBytes) break;
      await fs.rm(path.join(dir, f.n), { force: true });
      total -= f.size;
    }
  } finally {
    evicting = false;
  }
}

/** svvideo://v/<base64url>[?p=1] -> streams the remote video; ?p=1 marks a hover preview. */
export function handleVideos(opts: VideoOptions): void {
  void evictVideoCache(opts.dir, opts.maxBytes());
  protocol.handle('svvideo', async (req) => {
    let remote: URL;
    let preview = false;
    try {
      const u = new URL(req.url);
      preview = u.searchParams.get('p') === '1';
      remote = new URL(Buffer.from(u.pathname.slice(1), 'base64url').toString('utf8'));
    } catch {
      return new Response('bad', { status: 400 });
    }
    if (remote.protocol !== 'https:' || !videoHostOk(remote.hostname)) return new Response('forbidden host', { status: 403 });
    const range = req.headers.get('range');
    const file = cachePath(opts.dir, remote.href);

    if (await fs.stat(file).then(() => true, () => false)) return serveFile(file, range, 'video/mp4');

    const ac = new AbortController();
    req.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    if (preview) {
      // A preview the user already hovered away from must not hog the connection.
      while (previews.size >= PREVIEW_MAX) {
        const oldest = previews.values().next().value as AbortController;
        previews.delete(oldest);
        oldest.abort();
      }
      previews.add(ac);
    }
    const release = () => previews.delete(ac);

    try {
      const up = await fetchUpstream(remote.href, range, ac.signal);
      if (!up.ok || !up.body) {
        release();
        return new Response('unavailable', { status: up.status === 404 ? 404 : 502 });
      }
      const headers: Record<string, string> = { 'Content-Type': up.headers.get('content-type') ?? 'video/mp4', 'Accept-Ranges': 'bytes' };
      for (const h of ['content-length', 'content-range']) {
        const v = up.headers.get(h);
        if (v) headers[h] = v;
      }

      // Tee to disk only for a deliberate play that starts at byte 0 and whose full size is known.
      let sink: CacheSink | undefined;
      const key = file;
      if (opts.cacheEnabled() && !preview && !caching.has(key)) {
        const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(up.headers.get('content-range') ?? '');
        const total = up.status === 206 ? (cr && Number(cr[1]) === 0 && Number(cr[2]) === Number(cr[3]) - 1 ? Number(cr[3]) : 0) : Number(up.headers.get('content-length')) || 0;
        if (total > 0 && total <= opts.maxBytes()) {
          await fs.mkdir(opts.dir, { recursive: true });
          caching.add(key);
          sink = new CacheSink(file + '.part', file, total, () => void evictVideoCache(opts.dir, opts.maxBytes()));
        }
      }
      const body = pump(up, ac, sink, () => {
        release();
        if (sink) caching.delete(key);
      });
      return new Response(body, { status: up.status, headers });
    } catch (e) {
      release();
      if ((e as Error).name === 'AbortError') return new Response('aborted', { status: 499 });
      log.warn('video stream failed', remote.pathname, e);
      return new Response('unavailable', { status: 502 });
    }
  });
}

export async function videoCacheInfo(cacheDir: string): Promise<{ bytes: number; files: number }> {
  try {
    const names = (await fs.readdir(cacheDir)).filter((n) => n.endsWith('.mp4'));
    let bytes = 0;
    for (const n of names) bytes += (await fs.stat(path.join(cacheDir, n))).size;
    return { bytes, files: names.length };
  } catch {
    return { bytes: 0, files: 0 };
  }
}

export async function clearVideoCache(cacheDir: string): Promise<void> {
  await fs.rm(cacheDir, { recursive: true, force: true });
}

/** svlocal://img/<file> -> user-added lineup images in one folder only. */
export function handleLocal(dir: string): void {
  protocol.handle('svlocal', async (req) => {
    const name = path.basename(decodeURIComponent(new URL(req.url).pathname));
    if (!/^[a-z0-9-]+\.(png|jpe?g|gif|webp)$/i.test(name)) return new Response('bad', { status: 400 });
    try {
      const data = await fs.readFile(path.join(dir, name));
      const ext = path.extname(name).toLowerCase();
      const type = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      return new Response(data, { headers: { 'Content-Type': type } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}
