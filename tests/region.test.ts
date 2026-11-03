import { describe, expect, it } from 'vitest';
import { glzUrl, hasValorantSession, normalizeShard, parseExternalSessions, parseShooterLog, pdUrl } from '../shared/region';

const session = (args: string[], version = 'release-13.09-shipping-11-5777412') => ({
  host_app: { productId: 'riot_client', launchConfiguration: { arguments: [] } },
  abc: { productId: 'valorant', version, launchConfiguration: { arguments: args } },
});

describe('region/shard', () => {
  it('reads region, shard and version from external-sessions', () => {
    expect(parseExternalSessions(session(['-ares-deployment=eu', '-config-endpoint=https://shared.eu.a.pvp.net']))).toEqual({
      region: 'eu',
      shard: 'eu',
      version: 'release-13.09-shipping-11-5777412',
    });
  });
  it('maps latam and br to the na shard', () => {
    expect(parseExternalSessions(session(['-ares-deployment=latam', '-config-endpoint=https://shared.na.a.pvp.net']))?.shard).toBe('na');
    expect(parseExternalSessions(session(['-ares-deployment=br']))?.shard).toBe('na');
    expect(normalizeShard('br', 'br')).toBe('na');
  });
  it('derives shard from region if config-endpoint is missing', () => {
    expect(parseExternalSessions(session(['-ares-deployment=ap']))).toMatchObject({ region: 'ap', shard: 'ap' });
  });
  it('returns null without a valorant session or region', () => {
    expect(parseExternalSessions({ x: { productId: 'riot_client' } })).toBeNull();
    expect(parseExternalSessions(session([]))).toBeNull();
    expect(parseExternalSessions(null)).toBeNull();
    expect(hasValorantSession(session([]))).toBe(true);
    expect(hasValorantSession({})).toBe(false);
  });
  it('parses ShooterGame.log, last occurrence wins', () => {
    const log = [
      'LogShooter: CI server version: release-13.08-shipping-1-1',
      'https://glz-eu-1.eu.a.pvp.net/session/v1',
      'LogShooter: CI server version: release-13.09-shipping-11-5777412',
      'GET https://glz-latam-1.na.a.pvp.net/pregame/v1/players',
    ].join('\n');
    expect(parseShooterLog(log)).toEqual({ version: 'release-13.09-shipping-11-5777412', region: 'latam', shard: 'na' });
    expect(parseShooterLog('nothing')).toEqual({});
  });
  it('builds hosts', () => {
    expect(glzUrl('na', 'na')).toBe('https://glz-na-1.na.a.pvp.net');
    expect(pdUrl('eu')).toBe('https://pd.eu.a.pvp.net');
  });
});
