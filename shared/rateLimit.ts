/** Parses Retry-After (seconds or HTTP date) into ms. Null if absent/invalid. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.max(0, Math.round(Number(v) * 1000));
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - now);
}

export interface LimiterOptions {
  concurrency: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Concurrency-limited queue with a shared pause (set from Retry-After).
 * Tasks wait for both a free slot and for the pause window to end.
 */
export class RateLimiter {
  private active = 0;
  private queue: (() => void)[] = [];
  private pausedUntil = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: LimiterOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  get running(): number {
    return this.active;
  }

  get pending(): number {
    return this.queue.length;
  }

  get pauseRemaining(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }

  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.opts.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      let wait = this.pauseRemaining;
      while (wait > 0) {
        await this.sleep(wait);
        wait = this.pauseRemaining;
      }
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export interface RetryableResponse {
  status: number;
  headers: { get(name: string): string | null };
}

export interface RetryOptions {
  limiter?: RateLimiter;
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Runs a request, retrying on 429 (honoring Retry-After) and 5xx (exp backoff). */
export async function withRetry<R extends RetryableResponse>(doRequest: () => Promise<R>, opts: RetryOptions = {}): Promise<R> {
  const max = opts.maxRetries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    const run = () => doRequest();
    const res = opts.limiter ? await opts.limiter.schedule(run) : await run();
    if (res.status === 429 && attempt < max) {
      const ra = parseRetryAfter(res.headers.get('retry-after')) ?? base * 2 ** attempt;
      if (opts.limiter) opts.limiter.pause(ra);
      else await sleep(ra);
      attempt++;
      continue;
    }
    if (res.status >= 500 && res.status <= 599 && attempt < max) {
      await sleep(base * 2 ** attempt);
      attempt++;
      continue;
    }
    return res;
  }
}
