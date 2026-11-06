import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { startMockServer, type MockHandle } from '../mock/server';
import { PERSONA, TRACKER_PRIVATE } from '../mock/career';
import { ME } from '../mock/data';
import { RiotSession } from '../main/riot/session';
import { RiotApi } from '../main/riot/api';
import { HistoryService, NameService } from '../main/services/history';
import { ProfileService } from '../main/services/profiles';
import { LifetimeService } from '../main/services/lifetime';
import { MmrEstimateService } from '../main/services/mmrEstimate';

process.env.SEXYVAL_QUIET = '1';

const assets = { agent: (id?: string) => (id ? { id, name: `agent-${id.slice(0, 4)}` } : undefined), mapName: (m?: string) => m?.split('/').pop(), rank: (t: unknown) => ({ tier: Number(t), name: `tier ${t}` }) } as any;
const catalog = { browse: { seasons: [] as any[] }, catalog: { cards: [], titles: [] } } as any;

describe('lifetime + estimated MMR against the mock', () => {
  let mock: MockHandle;
  let api: RiotApi;
  let dir: string;
  let history: HistoryService;
  let profiles: ProfileService;
  let names: NameService;
  const hidden = new Set<string>();
  const mk = () => new LifetimeService(api, assets, catalog, history, profiles, (p) => hidden.has(p));

  beforeAll(async () => {
    mock = await startMockServer({ quiet: true, lockDir: path.join(os.tmpdir(), `sexyval-test-lt-${process.pid}`) });
    mock.setPhase('noval');
    const session = new RiotSession({ lockfilePath: mock.lockfilePath, shooterLogPath: path.join(os.tmpdir(), 'sexyval-no-log'), overrideGlz: `${mock.base}/glz`, overridePd: `${mock.base}/pd`, overrideShared: `${mock.base}/shared`, loadCache: async () => ({}) });
    api = new RiotApi(session, () => undefined);
    await session.ensure();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sexyval-lt-'));
    history = new HistoryService(api, assets, path.join(dir, 'matches'), () => undefined);
    names = new NameService(api, () => undefined);
    profiles = new ProfileService(api, assets, catalog, history, names);
  });
  afterAll(async () => {
    await mock.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('pages competitive updates and history past 20 (45+ matches, two acts), no duplicates', async () => {
    const before = mock.requests.length;
    const v = await mk().get(PERSONA.at, 20);
    const calls = mock.requests.slice(before);
    expect(calls.filter((c) => c.includes('/competitiveupdates')).length).toBeGreaterThanOrEqual(3);
    expect(calls.filter((c) => c.includes('/match-history/')).length).toBe(3);
    expect(v.totalMatches).toBe(48);
    expect(v.competitive.matches).toBeGreaterThan(20);
    expect(new Set(v.timeline.map((p) => p.matchId)).size).toBe(v.timeline.length);
    expect(v.actStarts).toHaveLength(2);
    expect(v.loaded).toBe(20);
    expect(v.matches.length).toBe(20);
    expect(v.hasMore).toBe(true);
    const more = await mk().get(PERSONA.at, 60);
    expect(more.loaded).toBe(48);
    expect(more.hasMore).toBe(false);
  });

  it('a tracker-private player gets the full lifetime view, and nothing talks to a tracker', async () => {
    expect(TRACKER_PRIVATE.has(PERSONA.trackerPrivate)).toBe(true);
    const before = mock.requests.length;
    const priv = await mk().get(PERSONA.trackerPrivate, 20);
    const normal = await mk().get(PERSONA.below, 20);
    expect(priv.totalMatches).toBe(normal.totalMatches);
    expect(priv.loaded).toBe(20);
    expect(Object.keys(priv).sort()).toEqual(Object.keys(normal).sort());
    expect(priv.byAgent.length).toBeGreaterThan(0);
    expect(priv.totals.n).toBe(20);
    // Only Riot's own pd endpoints were used.
    expect(mock.requests.slice(before).every((r) => / \/pd\/(mmr|match-history|match-details)\//.test(r))).toBe(true);
  });

  it('second open is served from cache: no new pd calls for matches already on disk', async () => {
    const svc = mk();
    await svc.get(PERSONA.excluded, 20);
    const before = mock.requests.length;
    await svc.get(PERSONA.excluded, 20);
    expect(mock.requests.length).toBe(before);
    // A fresh service (app restart) re-pages the lists but reads every match from the disk cache.
    const restart = new LifetimeService(api, assets, catalog, new HistoryService(api, assets, path.join(dir, 'matches'), () => undefined), profiles);
    const b2 = mock.requests.length;
    await restart.get(PERSONA.excluded, 20);
    expect(mock.requests.slice(b2).filter((r) => r.includes('/match-details/'))).toHaveLength(0);
  });

  it('expanding several players in a row stays within the pd rate limiter', async () => {
    let peak = 0;
    const t = setInterval(() => (peak = Math.max(peak, api.pdLimiter.running)), 1);
    const svc = mk();
    await Promise.all([ME, PERSONA.at, PERSONA.below, PERSONA.trackerPrivate].map((p) => svc.get(p, 40)));
    clearInterval(t);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(4);
  }, 60_000);

  it('players the live match marks hidden are refused, not looked up', async () => {
    hidden.add(PERSONA.below);
    const before = mock.requests.length;
    await expect(mk().get(PERSONA.below, 20)).rejects.toThrow(/Hidden player/);
    const est = new MmrEstimateService(api, assets, catalog, history, names, profiles, path.join(dir, 'mmr'), (p) => hidden.has(p));
    await expect(est.get(PERSONA.below)).rejects.toThrow(/Hidden player/);
    expect(mock.requests.length).toBe(before);
    hidden.clear();
  });

  it('estimated MMR personas: you above rank, then at and below rank', async () => {
    const est = new MmrEstimateService(api, assets, catalog, history, names, profiles, path.join(dir, 'mmr'));
    const me = await est.get(ME);
    expect(me.estimate.gapDivisions).toBeGreaterThan(0.5);
    expect(['above rank', 'well above rank']).toContain(me.estimate.label);
    expect(me.matches.length).toBe(20);
    expect((await est.get(PERSONA.at)).estimate.label).toBe('at rank');
    expect(['below rank', 'well below rank']).toContain((await est.get(PERSONA.below)).estimate.label);
    const ex = await est.get(PERSONA.excluded);
    expect(ex.estimate.confidence).toBe('Low');
    expect(ex.matches.filter((m) => m.excluded).length).toBeGreaterThan(5);
    // Competitive updates are kept on disk for scripts/mmr-backtest.mjs.
    await new Promise((r) => setTimeout(r, 50));
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'mmr', `${ME}.json`), 'utf8'));
    expect(stored.updates.length).toBe(20);
  });
});
