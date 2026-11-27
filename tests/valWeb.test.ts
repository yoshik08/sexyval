import { describe, expect, it } from 'vitest';
import {
  cookieHeader,
  hasPasswordField,
  isUploadableCookie,
  makeLinkCode,
  normalizeCode,
  parseSetCookie,
  snapshotReject,
} from '../shared/valWeb';
import { toSnapshot } from '../main/services/valWebSync';
import type { ShopView } from '../shared/types';

describe('isUploadableCookie', () => {
  it('accepts only the SSO cookie names on riotgames.com', () => {
    expect(isUploadableCookie({ name: 'ssid', domain: 'auth.riotgames.com' })).toBe(true);
    expect(isUploadableCookie({ name: 'clid', domain: '.riotgames.com' })).toBe(true);
    expect(isUploadableCookie({ name: 'tdid', domain: 'riotgames.com' })).toBe(true);
  });
  it('rejects analytics, consent and foreign-domain cookies', () => {
    expect(isUploadableCookie({ name: '_ga', domain: '.riotgames.com' })).toBe(false);
    expect(isUploadableCookie({ name: 'osano_consentmanager', domain: '.authenticate.riotgames.com' })).toBe(false);
    expect(isUploadableCookie({ name: '__cf_bm', domain: '.riotgames.com' })).toBe(false);
    // Never an ssid planted on a look-alike domain.
    expect(isUploadableCookie({ name: 'ssid', domain: 'riotgames.com.evil.com' })).toBe(false);
    expect(isUploadableCookie({ name: 'ssid', domain: 'notriotgames.com' })).toBe(false);
  });
});

describe('cookieHeader', () => {
  it('joins name=value pairs', () => {
    expect(cookieHeader([{ name: 'ssid', value: 'a' }, { name: 'clid', value: 'b' }])).toBe('ssid=a; clid=b');
  });
});

describe('parseSetCookie', () => {
  it('reads name/value and a Max-Age expiry', () => {
    const r = parseSetCookie('ssid=NEW; Domain=.riotgames.com; Path=/; Max-Age=2592000; Secure; HttpOnly');
    expect(r?.name).toBe('ssid');
    expect(r?.value).toBe('NEW');
    expect(r?.expires).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
  it('returns null for a malformed line', () => {
    expect(parseSetCookie('garbage')).toBeNull();
  });
});

describe('link codes', () => {
  it('is 8 letters grouped XXXX-XXXX from the readable alphabet', () => {
    const code = makeLinkCode(() => [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(code).not.toMatch(/[ILO01]/);
  });
  it('normalizes what the user types', () => {
    expect(normalizeCode('k7p - 4qr')).toBe('K7P4QR');
  });
});

describe('snapshotReject', () => {
  const ok = { puuid: 'p', shopDate: '2026-11-28', daily: [{ offerId: 'o', name: 'x', cost: 1 }], wallet: { vp: 1, rad: 0, kc: 0 } };
  it('accepts a well-formed snapshot', () => {
    expect(snapshotReject(ok)).toBeNull();
  });
  it('rejects bad shapes', () => {
    expect(snapshotReject(null)).toBeTruthy();
    expect(snapshotReject({ ...ok, puuid: '' })).toBeTruthy();
    expect(snapshotReject({ ...ok, shopDate: 'nope' })).toBeTruthy();
    expect(snapshotReject({ ...ok, daily: 'x' })).toBeTruthy();
  });
  it('rejects anything carrying a password field, however deep', () => {
    expect(hasPasswordField({ a: { b: { password: 'x' } } })).toBe(true);
    expect(hasPasswordField({ a: [{ Password: 'x' }] })).toBe(true);
    expect(snapshotReject({ ...ok, extra: { password: 'leak' } })).toBe('contains a password field');
  });
});

describe('toSnapshot', () => {
  const base: ShopView = {
    status: 'done',
    daily: [{ offerId: 'o1', skinId: 's1', levelId: 'l1', name: 'Skin', cost: 1775 }],
    dailyEndsAt: Date.UTC(2026, 10, 28, 12, 0, 0),
    wallet: { vp: 1000, rad: 20, kc: 0 },
    fetchedAt: 123,
    source: 'v3 POST',
    puuid: 'puuid-1',
  };
  it('keys the snapshot by the rotation day, not local midnight', () => {
    const snap = toSnapshot(base, 'puuid-1')!;
    expect(snap.shopDate).toBe('2026-11-28');
    expect(snap.daily).toHaveLength(1);
    expect(snap.wallet?.vp).toBe(1000);
    expect(snap.source).toBe('v3 POST');
  });
  it('returns null when there is nothing to send', () => {
    expect(toSnapshot({ ...base, daily: [] }, 'puuid-1')).toBeNull();
  });
  it('turns the app-only svasset:// art into the https URL the web page can load', () => {
    const real = 'https://media.valorant-api.com/weaponskinlevels/l1/displayicon.png';
    const wrap = (u: string) => `svasset://img/${Buffer.from(u).toString('base64url')}`;
    const item = { ...base.daily[0], icon: wrap(real), tier: { name: 'Premium', color: '#d1548d', icon: wrap('https://media.valorant-api.com/contenttiers/t/displayicon.png') } };
    const snap = toSnapshot(
      { ...base, daily: [item], night: { items: [item], endsAt: 1 }, bundles: [{ id: 'b', name: 'B', icon: wrap('https://media.valorant-api.com/bundles/b/displayicon2.png'), items: [item] }] },
      'puuid-1',
    )!;
    expect(snap.daily[0].icon).toBe(real);
    expect(snap.daily[0].tier?.icon).toBe('https://media.valorant-api.com/contenttiers/t/displayicon.png');
    expect(snap.night?.items[0].icon).toBe(real);
    expect(snap.bundles?.[0].icon).toBe('https://media.valorant-api.com/bundles/b/displayicon2.png');
    expect(snap.bundles?.[0].items[0].icon).toBe(real);
    expect(JSON.stringify(snap)).not.toContain('svasset:');
  });
  it('drops art from any host the page may not load', () => {
    const wrap = (u: string) => `svasset://img/${Buffer.from(u).toString('base64url')}`;
    for (const bad of ['https://blitz-cdn.blitz.gg/x.png', 'http://media.valorant-api.com/x.png', 'svasset://img/%%%']) {
      const snap = toSnapshot({ ...base, daily: [{ ...base.daily[0], icon: bad.startsWith('svasset') ? bad : wrap(bad) }] }, 'puuid-1')!;
      expect(snap.daily[0].icon).toBeUndefined();
    }
  });
});
