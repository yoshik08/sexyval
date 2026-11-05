import { describe, expect, it } from 'vitest';
import { CURRENT_SETTINGS_VERSION, loginItemOutOfSync, migrateStartupDefault } from '../shared/settingsMigration';

describe('startup default migration', () => {
  it('fresh install (no file, so raw is {}) gets launchAtStartup forced on and registered', () => {
    expect(migrateStartupDefault({})).toEqual({ settingsVersion: CURRENT_SETTINGS_VERSION, launchAtStartup: true, shouldRegister: true });
  });

  it('a pre-1.3 install with no settingsVersion gets forced on once, even if the user had it off', () => {
    expect(migrateStartupDefault({ launchAtStartup: false })).toEqual({ settingsVersion: CURRENT_SETTINGS_VERSION, launchAtStartup: true, shouldRegister: true });
  });

  it('an install already at the current version keeps the user choice and does not re-register', () => {
    expect(migrateStartupDefault({ settingsVersion: CURRENT_SETTINGS_VERSION, launchAtStartup: false })).toEqual({
      settingsVersion: CURRENT_SETTINGS_VERSION,
      launchAtStartup: false,
      shouldRegister: false,
    });
    expect(migrateStartupDefault({ settingsVersion: CURRENT_SETTINGS_VERSION, launchAtStartup: true })).toEqual({
      settingsVersion: CURRENT_SETTINGS_VERSION,
      launchAtStartup: true,
      shouldRegister: false,
    });
  });

  it('a future version (newer app ran once, then an older build runs) is left alone, not downgraded', () => {
    expect(migrateStartupDefault({ settingsVersion: CURRENT_SETTINGS_VERSION + 1, launchAtStartup: false })).toEqual({
      settingsVersion: CURRENT_SETTINGS_VERSION + 1,
      launchAtStartup: false,
      shouldRegister: false,
    });
  });
});

describe('login item resync', () => {
  it('flags a mismatch either direction', () => {
    expect(loginItemOutOfSync(false, true)).toBe(true);
    expect(loginItemOutOfSync(true, false)).toBe(true);
  });
  it('matching state needs no resync', () => {
    expect(loginItemOutOfSync(true, true)).toBe(false);
    expect(loginItemOutOfSync(false, false)).toBe(false);
  });
});
