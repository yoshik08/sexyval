import { describe, expect, it } from 'vitest';
import { chooseRegion, normalizeRegion, parseAuthRedirect, pickTokenSource, resolveRegion, resolveVersion, shardFor } from '../shared/connection';

describe('region/shard fallback chain', () => {
  it('uses the first valid candidate in order', () => {
    expect(
      resolveRegion([
        { source: 'valorant-session', region: null },
        { source: 'region-locale', region: 'EUW' },
        { source: 'disk-cache', region: 'na', shard: 'na' },
      ]),
    ).toEqual({ region: 'eu', shard: 'eu', source: 'region-locale' });
  });
  it('session args win over everything', () => {
    expect(resolveRegion([{ source: 'valorant-session', region: 'ap', shard: 'ap' }, { source: 'region-locale', region: 'NA' }])?.source).toBe('valorant-session');
  });
  it('falls through region-locale garbage to disk cache, then ShooterGame.log', () => {
    expect(resolveRegion([{ source: 'region-locale', region: 'XX9' }, { source: 'disk-cache', region: 'kr' }])).toEqual({ region: 'kr', shard: 'kr', source: 'disk-cache' });
    expect(resolveRegion([{ source: 'region-locale', region: '' }, { source: 'shooter-log', region: 'latam', shard: 'na' }])).toEqual({ region: 'latam', shard: 'na', source: 'shooter-log' });
    expect(resolveRegion([])).toBeNull();
  });
  it('maps region -> shard (latam/br on na)', () => {
    expect(shardFor('latam')).toBe('na');
    expect(shardFor('br')).toBe('na');
    expect(shardFor('eu')).toBe('eu');
    expect(resolveRegion([{ source: 'riot-geo', region: 'br', shard: 'br' }])?.shard).toBe('na');
  });
  it('normalises Riot Client region strings', () => {
    expect(normalizeRegion('NA')).toBe('na');
    expect(normalizeRegion('EUNE')).toBe('eu');
    expect(normalizeRegion('LA2')).toBe('latam');
    expect(normalizeRegion('BR1')).toBe('br');
    expect(normalizeRegion('OC1')).toBe('ap');
    expect(normalizeRegion('KR')).toBe('kr');
    expect(normalizeRegion('mars')).toBeNull();
  });
});

describe('client version fallback chain', () => {
  it('session -> cache -> log -> valorant-api, skipping non release-* values', () => {
    expect(
      resolveVersion([
        { source: 'valorant-session', version: '111.0.0.123' },
        { source: 'disk-cache', version: null },
        { source: 'shooter-log', version: 'release-13.09-shipping-11-5777412' },
        { source: 'valorant-api', version: 'release-13.08-shipping-1-1' },
      ]),
    ).toEqual({ version: 'release-13.09-shipping-11-5777412', source: 'shooter-log' });
    expect(resolveVersion([{ source: 'disk-cache', version: 'release-12.01-x' }])?.source).toBe('disk-cache');
    expect(resolveVersion([{ source: 'valorant-session', version: '' }])).toBeNull();
  });
});

describe('token source priority', () => {
  it('Riot Client first, then signed-in session, else none', () => {
    expect(pickTokenSource({ riotClientTokens: true, signedInTokens: true })).toBe('riot-client');
    expect(pickTokenSource({ riotClientTokens: false, signedInTokens: true })).toBe('signin');
    expect(pickTokenSource({ riotClientTokens: false, signedInTokens: false })).toBe('none');
  });
});

describe('sign-in redirect capture', () => {
  it('extracts tokens from the playvalorant.com opt_in fragment', () => {
    const url = 'https://playvalorant.com/opt_in#access_token=AAA.BBB.CCC&scope=account+openid&iss=x&id_token=III&token_type=Bearer&session_state=s&expires_in=3600';
    expect(parseAuthRedirect(url)).toEqual({ accessToken: 'AAA.BBB.CCC', idToken: 'III', expiresIn: 3600 });
  });
  it('ignores other hosts, paths, or missing tokens', () => {
    expect(parseAuthRedirect('https://auth.riotgames.com/login#access_token=a&id_token=b')).toBeNull();
    expect(parseAuthRedirect('https://evil.example/opt_in#access_token=a&id_token=b')).toBeNull();
    expect(parseAuthRedirect('https://playvalorant.com/opt_in#access_token=a')).toBeNull();
    expect(parseAuthRedirect('https://playvalorant.com/en-us/')).toBeNull();
    expect(parseAuthRedirect('not a url')).toBeNull();
  });
  it('defaults expiry when absent', () => {
    expect(parseAuthRedirect('https://playvalorant.com/opt_in#access_token=a&id_token=b')?.expiresIn).toBe(3600);
  });
});

describe('chooseRegion (verified)', () => {
  // Real-world case: Riot Client region-locale says NA, account data lives on AP.
  const dataOn = (shards: string[]) => {
    const calls: string[] = [];
    return { calls, verify: async (s: string) => (calls.push(s), shards.includes(s)) };
  };
  it('rejects an unverified region-locale and probes to the real shard', async () => {
    const v = dataOn(['ap']);
    const r = await chooseRegion([{ source: 'region-locale', region: 'NA' }], v.verify);
    expect(r).toEqual({ region: 'ap', shard: 'ap', source: 'shard-probe', verified: true });
    expect(v.calls).toEqual(['na', 'eu', 'ap']);
  });
  it('accepts ShooterGame.log when the shard has data, before region-locale', async () => {
    const v = dataOn(['ap']);
    const r = await chooseRegion([{ source: 'shooter-log', region: 'ap', shard: 'ap' }, { source: 'region-locale', region: 'NA' }], v.verify);
    expect(r).toMatchObject({ region: 'ap', source: 'shooter-log', verified: true });
    expect(v.calls).toEqual(['ap']);
  });
  it('trusts the Valorant session without probing', async () => {
    const v = dataOn([]);
    expect(await chooseRegion([{ source: 'valorant-session', region: 'eu', shard: 'eu' }], v.verify)).toMatchObject({ region: 'eu', verified: true });
    expect(v.calls).toEqual([]);
  });
  it('falls back to the first candidate (unverified) for an account with no data anywhere', async () => {
    const v = dataOn([]);
    expect(await chooseRegion([{ source: 'region-locale', region: 'NA' }], v.verify)).toMatchObject({ region: 'na', verified: false });
    expect(await chooseRegion([], v.verify)).toBeNull();
  });
});
