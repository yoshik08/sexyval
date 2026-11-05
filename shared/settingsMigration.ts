/** Bump whenever a one-time migration is added below. */
export const CURRENT_SETTINGS_VERSION = 2;

export interface StartupMigrationResult {
  settingsVersion: number;
  launchAtStartup: boolean;
  /** True exactly once: the run that should push `launchAtStartup` to Windows' login items. */
  shouldRegister: boolean;
}

/**
 * Installs before 1.3 never wrote a `settingsVersion`, and that covers both a truly fresh install
 * (no settings file at all, so `raw` is `{}`) and an upgrade from a version that defaulted
 * `launchAtStartup` to false. Either way, force it on once and bump the version; from then on
 * (version already current) whatever the user has chosen sticks.
 */
export function migrateStartupDefault(raw: { settingsVersion?: number; launchAtStartup?: boolean }): StartupMigrationResult {
  if (typeof raw.settingsVersion === 'number' && raw.settingsVersion >= CURRENT_SETTINGS_VERSION) {
    return { settingsVersion: raw.settingsVersion, launchAtStartup: raw.launchAtStartup ?? true, shouldRegister: false };
  }
  return { settingsVersion: CURRENT_SETTINGS_VERSION, launchAtStartup: true, shouldRegister: true };
}

/** Windows disables a login item it can't find (moved install folder, changed update path) without telling the app; resync on every start. */
export function loginItemOutOfSync(gotOpenAtLogin: boolean, wantOpenAtLogin: boolean): boolean {
  return gotOpenAtLogin !== wantOpenAtLogin;
}
