import { describe, expect, it } from 'vitest';
import { RateLimiter, parseRetryAfter, withRetry } from '../shared/rateLimit';
import { redact } from '../shared/redact';

const res = (status: number, retryAfter?: string) => ({
  status,
  headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
});

function fakeClock() {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
  };
}

describe('parseRetryAfter', () => {
  it('handles seconds, dates and junk', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('1.5')).toBe(1500);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(10000);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('RateLimiter', () => {
  it('never exceeds concurrency', async () => {
    const lim = new RateLimiter({ concurrency: 4 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        lim.schedule(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(4);
    expect(lim.running).toBe(0);
    expect(lim.pending).toBe(0);
  });

  it('waits out a pause before running', async () => {
    const c = fakeClock();
    const lim = new RateLimiter({ concurrency: 1, now: c.now, sleep: c.sleep });
    lim.pause(2000);
    await lim.schedule(async () => 1);
    expect(c.slept).toEqual([2000]);
  });
});

describe('withRetry', () => {
  it('honors Retry-After on 429 via the limiter pause', async () => {
    const c = fakeClock();
    const lim = new RateLimiter({ concurrency: 4, now: c.now, sleep: c.sleep });
    const seq = [res(429, '2'), res(200)];
    const r = await withRetry(async () => seq.shift()!, { limiter: lim });
    expect(r.status).toBe(200);
    expect(c.slept).toEqual([2000]);
  });
  it('backs off on 5xx and gives up after maxRetries', async () => {
    const c = fakeClock();
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        return res(503);
      },
      { maxRetries: 2, baseDelayMs: 100, sleep: c.sleep },
    );
    expect(r.status).toBe(503);
    expect(calls).toBe(3);
    expect(c.slept).toEqual([100, 200]);
  });
  it('does not retry 404', async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      return res(404);
    });
    expect(r.status).toBe(404);
    expect(calls).toBe(1);
  });
});

describe('redact', () => {
  it('removes tokens from objects and strings', () => {
    const out = redact({
      accessToken: 'abc',
      token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig',
      nested: { TeamMatchToken: 'x', PlayerKey: 'k', note: 'Bearer abc.def' },
      args: ['-remoting-auth-token=secret123', '-ares-deployment=eu'],
      subject: 'puuid',
    });
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/abc|secret123|eyJhbGci|"k"/);
    expect(s).toContain('-ares-deployment=eu');
    expect(s).toContain('puuid');
  });
});
