import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, Tray, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import type { AppState, Phase, Settings, ShopView, Toast } from '../shared/types';
import { registerSchemes, handleApp, handleAssets, handleVideos, handleLocal, videoCacheInfo, clearVideoCache, MB } from './protocol';
import { loadSettings, getSettings, updateSettings, onSettings } from './settings';
import { dataDir, readJson, writeJson } from './paths';
import { log } from './log';
import { applyAppIcon, APP_ID } from './appIcon';
import { RiotSession, type ConnectionCache } from './riot/session';
import { RiotApi } from './riot/api';
import { AssetService } from './services/assets';
import { HistoryService, NameService } from './services/history';
import { AgentSelectOverlay, listDisplays } from './overlay';
import { promises as fsp } from 'node:fs';
import { ShopService } from './services/shop';
import { DebugStore } from './services/debug';
import { CatalogService } from './services/catalog';
import { OwnedService } from './services/owned';
import { PriceBook } from './services/prices';
import { ProgressionService } from './services/progression';
import { PartyService } from './services/party';
import { LoadoutService } from './services/loadout';
import { ProfileService } from './services/profiles';
import { HubService } from './services/hub';
import { AccountManager, REAL_AUTH_URLS, type AuthUrls } from './auth/accounts';
import { GameLoop } from './loop';
import type { MockHandle } from '../mock/server';

const MOCK = process.env.MOCK === '1';
const SHOTS = process.env.SEXYVAL_SCREENSHOTS || process.env.SEXYVAL_LIVE_SHOTS;
if (MOCK) app.setPath('userData', path.join(app.getPath('appData'), 'SexyVal-mock'));
// Dev aid: run a separate profile (its own single-instance lock) next to an installed copy.
if (process.env.SEXYVAL_USER_DATA) app.setPath('userData', path.resolve(process.env.SEXYVAL_USER_DATA));

registerSchemes();
// Screenshot mode: keep painting even when the window is behind other windows.
if (SHOTS) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let loop: GameLoop | null = null;
let shop: ShopService | null = null;
const overlay = new AgentSelectOverlay(getSettings);
let mock: MockHandle | null = null;
let accounts: AccountManager | null = null;
const debug = new DebugStore();
const recentToasts = new Map<string, number>();
const rpc: Record<string, (...args: any[]) => unknown> = {};

/** Side calibration was removed (the rule is hardcoded now); delete what it stored. Nothing to do once gone. */
async function removeOldCalibrationData(): Promise<void> {
  for (const f of ['calibration.json', 'observations.json', 'snapshots.json']) {
    const p = dataDir(f);
    try {
      await fsp.rm(p);
      log.info(`removed old ${f}`);
    } catch {
      // already gone
    }
  }
}

function iconPath(name = getSettings().appIcon): string {
  return path.join(app.getAppPath(), 'build', 'icons', `${name}.png`);
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function toast(level: Toast['level'], message: string): void {
  const now = Date.now();
  if (now - (recentToasts.get(message) ?? 0) < 30_000) return;
  recentToasts.set(message, now);
  send('toast', { id: `${now}-${Math.random().toString(36).slice(2, 7)}`, level, message, at: now } satisfies Toast);
}

function notify(title: string, body: string): void {
  toast('info', `${title}: ${body}`);
  if (getSettings().notifications && Notification.isSupported()) new Notification({ title, body, icon: iconPath() }).show();
}

function trusted(e: IpcMainInvokeEvent): boolean {
  return (e.senderFrame?.url ?? '').startsWith('app://sexyval/');
}

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('untrusted sender');
    return fn(...args);
  });
}

function createWindow(): BrowserWindow {
  const s = getSettings().window;
  const onScreen =
    s.x != null &&
    s.y != null &&
    screen.getAllDisplays().some((d) => s.x! >= d.bounds.x - 50 && s.y! >= d.bounds.y - 50 && s.x! < d.bounds.x + d.bounds.width && s.y! < d.bounds.y + d.bounds.height);
  const w = new BrowserWindow({
    width: Math.max(1100, s.width),
    height: Math.max(680, s.height),
    x: onScreen ? s.x : undefined,
    y: onScreen ? s.y : undefined,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#000000',
    title: 'SexyVal',
    icon: iconPath(),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#a1a1a6', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      backgroundThrottling: !SHOTS,
    },
  });
  if (s.maximized) w.maximize();
  w.removeMenu();
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://sexyval/')) e.preventDefault();
  });
  // Capture modes must never take focus: a focused test window catches keystrokes meant for the game.
  // Started at Windows login (--hidden) with close-to-tray on: stay in the tray until clicked.
  const startHidden = process.argv.includes('--hidden') && getSettings().closeToTray;
  w.once('ready-to-show', () => (SHOTS ? w.showInactive() : startHidden ? undefined : w.show()));
  const saveBounds = () => {
    if (w.isDestroyed() || w.isMinimized()) return;
    const maximized = w.isMaximized();
    const b = maximized ? getSettings().window : w.getNormalBounds();
    updateSettings({ window: { width: b.width, height: b.height, x: b.x, y: b.y, maximized } });
  };
  w.on('resize', saveBounds);
  w.on('move', saveBounds);
  w.on('close', (e) => {
    if (!quitting && getSettings().closeToTray && !SHOTS) {
      e.preventDefault();
      w.hide();
    }
  });
  void w.loadURL('app://sexyval/index.html');
  return w;
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
  tray.setToolTip('SexyVal');
  tray.on('click', () => (win?.isVisible() && win.isFocused() ? win.hide() : showMain()));
  updateTrayMenu();
}

function showMain(): void {
  win?.show();
  win?.focus();
}

/** Rebuilt whenever the overlay setting changes so the checkbox stays in sync. */
function updateTrayMenu(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show SexyVal', click: showMain },
      { label: 'Agent select overlay', type: 'checkbox', checked: getSettings().overlayEnabled, click: (item) => void updateSettings({ overlayEnabled: item.checked }) },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

async function startServices(): Promise<void> {
  let lockfilePath: string | undefined;
  let overrideGlz: string | undefined;
  let overridePd: string | undefined;
  let overrideShared: string | undefined;
  let authUrls: AuthUrls = REAL_AUTH_URLS;
  let shooterLogPath: string | undefined;
  if (MOCK) {
    const { startMockServer } = await import('../mock/server');
    const durations = process.env.MOCK_FAST === '1' ? { idle: 6000, pregame: 12000, ingame: 10000 } : undefined;
    mock = await startMockServer({ quiet: false, durations });
    lockfilePath = mock.lockfilePath;
    overrideGlz = `${mock.base}/glz`;
    overridePd = `${mock.base}/pd`;
    overrideShared = `${mock.base}/shared`;
    shooterLogPath = path.join(app.getPath('temp'), 'sexyval-mock', 'no-shooter-log');
    authUrls = {
      authorize: `${mock.base}/__auth/authorize`,
      entitlements: `${mock.base}/__auth/entitlements`,
      userinfo: `${mock.base}/__auth/userinfo`,
      geo: `${mock.base}/__auth/geo`,
    };
    if (process.env.MOCK_PHASE) mock.setPhase(process.env.MOCK_PHASE as Phase, 20_000);
  }

  const onRaw = (k: string, d: unknown) => debug.put(k, d);
  let emitLater = () => {};
  accounts = new AccountManager(
    dataDir('accounts.json'),
    authUrls,
    () => send('accounts', accounts?.list()),
    (label) => {
      send('alert', { kind: 'session-expired', label });
      notify('Session expired', `${label}: sign in again or remove the account`);
    },
  );
  await accounts.load();

  const cacheFile = dataDir('connection-cache.json');
  const session = new RiotSession({
    lockfilePath,
    shooterLogPath,
    overrideGlz,
    overridePd,
    overrideShared,
    onRaw,
    signin: accounts,
    loadCache: () => readJson<ConnectionCache>(cacheFile, {}),
    saveCache: (c) => writeJson(cacheFile, c),
    platformType: () => getSettings().platformType,
  });
  const api = new RiotApi(session, onRaw);
  const assets = new AssetService(dataDir('assets'));
  const history = new HistoryService(api, assets, dataDir('matches'), () => emitLater());
  const names = new NameService(api, () => emitLater());
  const prices = new PriceBook(dataDir('prices.json'), () => send('prices', prices.quotes(catalog.catalog)));
  await prices.load();
  const catalog = new CatalogService(dataDir('catalog'), () => {
    send('catalog', catalog.catalog);
    send('prices', prices.quotes(catalog.catalog));
  });
  const owned = new OwnedService(api, (s) => {
    send('owned', s);
    shop?.refreshOwnedFlags();
  });
  shop = new ShopService(
    api,
    assets,
    {
      onChange: (v: ShopView) => send('shop', v),
      onError: (m) => toast('error', m),
      isOwnedLevel: (id) => owned.state.levels.includes(id.toLowerCase()),
      onWishlistHit: (n) => notify('Wishlist skin in your shop', n.join(', ')),
      onLoaded: (v) => {
        prices.record(v);
      },
      afterRefresh: (walletChanged) => {
        if (walletChanged) void owned.refresh(); // purchase likely: refresh owned items
      },
    },
    dataDir('wishlist.json'),
  );
  await shop.loadWishlist();
  const progression = new ProgressionService(api, catalog, assets);
  const party = new PartyService(api, assets, catalog, names);
  const loadout = new LoadoutService(api, dataDir('loadout-presets.json'), () => void owned.refresh());
  const profiles = new ProfileService(api, assets, catalog, history, names);
  const hub = new HubService(api, assets, catalog, dataDir('lineups.json'), dataDir('lineups'));
  handleLocal(dataDir('lineups'));

  loop = new GameLoop({
    session,
    api,
    assets,
    history,
    names,
    shop,
    emit: (s: AppState) => {
      send('state', s);
      overlay.update(s);
    },
    toast,
    mock: MOCK,
    pollMs: () => Number(process.env.SEXYVAL_POLL_MS) || (MOCK ? 2000 : getSettings().pollMs),
    onAccount: (puuid) => owned.ensure(puuid),
    onNoTokens: () => {
      if (owned.state.status !== 'signed-out') owned.signedOut();
    },
  });
  emitLater = () => loop?.requestEmit();
  loop.start();

  // Public catalog loads regardless of login.
  void catalog.load();
  assets
    .load()
    .then(() => {
      loop?.requestEmit();
      shop?.reresolve();
    })
    .catch((e) => {
      log.error('assets load failed', e);
      toast('warn', 'Could not load game art from valorant-api.com; showing names only');
    });

  // ---- RPC registry: renderer -> main. Arguments are validated here or by each service. ----
  const str = (v: unknown, max = 200) => {
    if (typeof v !== 'string' || v.length > max) throw new Error('bad argument');
    return v;
  };
  Object.assign(rpc, {
    'catalog:get': () => catalog.catalog,
    'catalog:refresh': () => catalog.load(true).then(() => catalog.catalog),
    'browse:get': () => catalog.browse,
    'owned:get': () => owned.state,
    'owned:refresh': () => owned.refresh(),
    // Every catalog skin gets a quote: exact (seen in the live store), a contract reward, or the typical tier price.
    'prices:get': () => prices.quotes(catalog.catalog),
    'wishlist:get': () => shop?.wishlistIds ?? [],
    'wishlist:toggle': (id: unknown) => shop?.toggleWish(str(id, 64)),
    'overlay:displays': () => listDisplays(),
    'videos:info': () => videoCacheInfo(dataDir('videos')),
    'videos:clear': () => clearVideoCache(dataDir('videos')).then(() => videoCacheInfo(dataDir('videos'))),
    'accounts:list': () => accounts?.list() ?? [],
    'accounts:add': async () => {
      try {
        const a = await accounts?.add();
        loop?.pollNow();
        return a;
      } catch (e) {
        toast('error', `Sign-in failed: ${(e as Error).message}`);
        return null;
      }
    },
    'accounts:switch': (id: unknown) => {
      accounts?.switchTo(str(id, 32));
      loop?.pollNow();
    },
    'accounts:remove': (id: unknown) => accounts?.remove(str(id, 32)).then(() => loop?.pollNow()),
    'accounts:signInAgain': (id: unknown) =>
      accounts?.signInAgain(str(id, 32)).then((ok) => {
        loop?.pollNow();
        return ok;
      }),
    'progress:get': () => progression.refresh(),
    'progress:future': (ms: unknown) => progression.futureWeeklies(Number(ms) || Date.now()),
    'progress:activate': (id: unknown) => progression.activate(str(id, 64)),
    'party:get': () => party.refresh(),
    'party:action': async (name: unknown, arg: unknown) => {
      const n = str(name, 32);
      const v = await party.action(n, typeof arg === 'string' || typeof arg === 'boolean' ? arg : undefined);
      // Actions whose result isn't visible on the page get a confirmation.
      if (n === 'invite') toast('info', `Invite sent to ${String(arg).trim()}`);
      if (n === 'join-code') toast('info', 'Joined the party');
      return v;
    },
    'party:configs': () => api.customGameConfigs().then((r) => r.json),
    'loadout:get': () => loadout.refresh(),
    'loadout:apply': (v: unknown) => loadout.apply(v as any),
    'loadout:presets': () => loadout.presets(),
    'loadout:savePreset': (name: unknown, v: unknown) => loadout.savePreset(str(name, 60), v as any),
    'loadout:deletePreset': (id: unknown) => loadout.deletePreset(str(id, 64)),
    'profile:get': (q: unknown, queue: unknown) => profiles.profile(str(q, 64), { count: 15, queue: typeof queue === 'string' ? queue : getSettings().historyQueue }),
    'profile:match': (id: unknown) => profiles.matchDetail(str(id, 64)),
    'hub:friends': () => hub.friends(),
    'hub:friendRequest': (nt: unknown) => hub.sendFriendRequest(str(nt, 64)),
    'hub:cancelRequest': (p: unknown) => hub.cancelFriendRequest(str(p, 64)),
    'hub:leaderboard': (season: unknown, start: unknown) => hub.leaderboard(typeof season === 'string' ? season : undefined, Number(start) || 0),
    'hub:acts': () => hub.acts(),
    'hub:lineups': () => hub.lineups(),
    'hub:saveLineup': (l: unknown) => hub.saveLineup(l as any),
    'hub:deleteLineup': (id: unknown) => hub.deleteLineup(str(id, 64)),
    'hub:pickImage': async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      return hub.importImage(r.filePaths[0]);
    },
  });

  onSettings((s, prev) => {
    if (s.appIcon !== prev.appIcon) {
      applyAppIcon(win, s.appIcon, iconPath());
      tray?.setImage(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
    }
    if (s.platformType !== prev.platformType) loop?.pollNow();
    if (s.overlayEnabled !== prev.overlayEnabled) {
      updateTrayMenu();
      overlay.update(loop?.state);
    }
    if (s.overlayPosition !== prev.overlayPosition || s.overlayScale !== prev.overlayScale || s.overlayDisplay !== prev.overlayDisplay) overlay.relayout();
  });
}

function registerIpc(): void {
  handle('state:get', () => loop?.state);
  handle('shop:get', () => shop?.view ?? { status: 'idle', daily: [], wallet: null });
  handle('shop:refresh', () => shop?.refresh());
  handle('settings:get', () => getSettings());
  handle('settings:set', (patch: Partial<Settings>) => updateSettings(patch ?? {}));
  handle('debug:get', () => debug.dump());
  handle('mock:is', () => MOCK);
  handle('mock:phase', (p: Phase | 'auto' | 'offline' | 'noval') => {
    if (!mock) return;
    mock.setPhase(p as any, p === 'pregame' ? 15_000 : 0);
    loop?.pollNow();
  });
  handle('rpc', async (method: unknown, args: unknown) => {
    if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(rpc, method)) throw new Error(`unknown rpc ${String(method)}`);
    try {
      return await rpc[method](...(Array.isArray(args) ? args : []));
    } catch (e) {
      log.warn(`rpc ${method} failed`, e);
      throw e;
    }
  });
}

process.on('uncaughtException', (e) => {
  log.error('uncaught', e);
  toast('error', `Internal error: ${e.message}`);
});
process.on('unhandledRejection', (e) => {
  log.error('unhandled rejection', e as Error);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    win?.show();
    win?.focus();
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    app.setAppUserModelId(APP_ID);
    await loadSettings();
    handleApp(path.join(app.getAppPath(), 'dist-renderer'));
    handleAssets(dataDir('assets', 'img'));
    handleVideos({ dir: dataDir('videos'), cacheEnabled: () => getSettings().cacheVideos, maxBytes: () => getSettings().videoCacheMaxMb * MB });
    registerIpc();
    win = createWindow();
    applyAppIcon(win, getSettings().appIcon, iconPath()); // re-apply the saved choice (shortcuts may have been recreated by an update)
    if (!SHOTS) createTray();
    await removeOldCalibrationData();
    await startServices();
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed'] as const) screen.on(ev as any, () => overlay.relayout());

    if (process.env.SEXYVAL_LIVE_SHOTS && !MOCK) {
      const { runLiveShots } = await import('./screenshots');
      await runLiveShots(win, path.resolve(process.env.SEXYVAL_LIVE_SHOTS));
      quitting = true;
      app.quit();
    }

    if (process.env.SEXYVAL_SCREENSHOTS && mock) {
      const { runScreenshots } = await import('./screenshots');
      await runScreenshots(win, mock, () => loop?.pollNow(), path.resolve(process.env.SEXYVAL_SCREENSHOTS), () => overlay.webContents);
      quitting = true;
      app.quit();
    }
  });

  app.on('before-quit', () => {
    overlay.destroy();
    quitting = true;
    loop?.stop();
    accounts?.stop();
    void mock?.close();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
  });
}
