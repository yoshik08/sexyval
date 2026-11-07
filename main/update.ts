import { app, powerMonitor, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { Phase, Settings, UpdateStatus } from '../shared/types';
import { isSafeToInstall, SAFE_MOMENT_POLL_MS, type SafeToInstallInput } from '../shared/update';
import { log } from './log';
import type { ResumeStore } from './services/resume';

const CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60_000;
const OWNER = 'yoshik08';
const REPO = 'sexyval';
export const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases/latest`;

/** electron-builder's portable target sets this at runtime; a portable exe can't replace itself. */
export function isPortableBuild(): boolean {
  return !!process.env.PORTABLE_EXECUTABLE_FILE;
}

export interface UpdaterDeps {
  getWindow: () => BrowserWindow | null;
  getPhase: () => Phase;
  getSettings: () => Settings;
  resume: ResumeStore;
  onStatus: (s: UpdateStatus) => void;
}

/**
 * Wraps electron-updater so updates download and apply themselves with no dialogs: we never call
 * `checkForUpdatesAndNotify` (that fires an OS notification), and NSIS auto-updates are always
 * silent regardless of the `oneClick` installer setting. The only user-visible trace is a toast
 * after relaunch (fired by the caller once `app.getVersion()` differs from what resume.json saved)
 * and the status this class exposes to Settings.
 */
export class AppUpdater {
  status: UpdateStatus;
  private checkTimer: NodeJS.Timeout | null = null;
  private safeTimer: NodeJS.Timeout | null = null;
  private unfocusedSince = 0;
  private windowHidden = false;
  private installing = false;

  constructor(private readonly deps: UpdaterDeps) {
    this.status = { state: 'idle', currentVersion: app.getVersion(), portable: isPortableBuild(), releasesUrl: RELEASES_URL };
  }

  start(): void {
    // Dev escape hatch for scripts/mock-update-server.mjs: lets a packaged build point at a local
    // fake feed instead of GitHub, to exercise download -> safe-moment wait -> relaunch by hand.
    const mockFeed = process.env.SEXYVAL_UPDATE_FEED_URL;
    if (this.status.portable || (!app.isPackaged && !mockFeed)) return; // dev runs and the portable build never self-update
    if (mockFeed) autoUpdater.setFeedURL({ provider: 'generic', url: mockFeed });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null; // we log ourselves below; electron-updater's default logger is noisy and unredacted

    autoUpdater.on('checking-for-update', () => this.setStatus({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => this.setStatus({ state: 'up-to-date', lastCheckedAt: Date.now() }));
    autoUpdater.on('update-available', (info) => this.setStatus({ state: 'downloading', availableVersion: info.version, lastCheckedAt: Date.now() }));
    autoUpdater.on('download-progress', (p) => this.setStatus({ progressPercent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => {
      this.setStatus({ state: 'downloaded', availableVersion: info.version });
      log.info(`update ${info.version} downloaded; watching for a safe moment to install`);
      this.watchForSafeMoment();
    });
    autoUpdater.on('error', (e) => {
      log.error('autoUpdater', e);
      this.setStatus({ state: 'error', error: e.message });
    });

    this.trackWindow();
    setTimeout(() => this.checkNow(), CHECK_DELAY_MS);
    this.checkTimer = setInterval(() => this.checkNow(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.safeTimer) clearInterval(this.safeTimer);
    this.checkTimer = null;
    this.safeTimer = null;
  }

  checkNow(): void {
    if (this.status.portable || !app.isPackaged || !this.deps.getSettings().autoUpdate) return;
    autoUpdater.checkForUpdates().catch((e) => log.warn('update check failed', e));
  }

  /** "Update now": installs a downloaded update right away instead of waiting for a quiet moment. */
  async installNow(): Promise<void> {
    if (this.installing || this.status.state !== 'downloaded') return;
    this.installing = true;
    if (this.safeTimer) clearInterval(this.safeTimer);
    this.safeTimer = null;
    const settings = this.deps.getSettings();
    await this.deps.resume.save(settings.window, this.windowHidden, app.getVersion()).catch((e) => log.warn('resume save failed', e));
    log.info(`installing update ${this.status.availableVersion ?? ''} now (user asked)`);
    autoUpdater.quitAndInstall(true, true);
  }

  private trackWindow(): void {
    const win = this.deps.getWindow();
    if (!win) return;
    this.windowHidden = !win.isVisible();
    win.on('hide', () => (this.windowHidden = true));
    win.on('show', () => (this.windowHidden = false));
    win.on('blur', () => (this.unfocusedSince = Date.now()));
    win.on('focus', () => (this.unfocusedSince = 0));
  }

  private watchForSafeMoment(): void {
    if (this.safeTimer) return;
    this.safeTimer = setInterval(() => void this.maybeInstall(), SAFE_MOMENT_POLL_MS);
    void this.maybeInstall();
  }

  private async maybeInstall(): Promise<void> {
    if (this.installing) return;
    const flags = this.deps.resume.getFlags();
    const input: SafeToInstallInput = {
      phase: this.deps.getPhase(),
      videoPlaying: flags.videoPlaying,
      unsavedLoadoutChanges: flags.unsavedLoadoutChanges,
      windowHidden: this.windowHidden,
      unfocusedForMs: this.unfocusedSince ? Date.now() - this.unfocusedSince : 0,
      systemIdleSeconds: powerMonitor.getSystemIdleTime(),
    };
    if (!isSafeToInstall(input)) return;
    this.installing = true;
    if (this.safeTimer) clearInterval(this.safeTimer);
    this.safeTimer = null;
    const settings = this.deps.getSettings();
    await this.deps.resume.save(settings.window, this.windowHidden, app.getVersion()).catch((e) => log.warn('resume save failed', e));
    log.info(`installing update ${this.status.availableVersion ?? ''} now (safe moment)`);
    autoUpdater.quitAndInstall(true, true);
  }

  private setStatus(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.deps.onStatus(this.status);
  }
}
