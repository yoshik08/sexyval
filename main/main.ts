import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import type { AppState, Phase, Settings, ShopView, Toast } from '../shared/types';
import { registerSchemes, handleApp, handleAssets, handleVideos, handleLocal, videoCacheInfo, clearVideoCache, MB } from './protocol';
import { loadSettings, getSettings, updateSettings, onSettings, publicSettings } from './settings';
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
import { MmrService } from './services/mmr';
import { MmrEstimateService } from './services/mmrEstimate';
import { LifetimeService } from './services/lifetime';
import { StoreArchive } from './services/bundles';
import { StoreSync } from './services/storeSync';
import { PriceScrapeService } from './services/priceScrape';
import { createSystemServices, uninstallCleanup, type SystemServices } from './services/gameSystem';
import os from 'node:os';
import { OffersService } from './services/offers';
import { RiotEvents } from './riot/events';
import { defaultValorantConfigDir, detectDisplayMode } from './services/displayMode';
import type { DisplayMode } from '../shared/fullscreen';
import { trackerUrl } from '../shared/tracker';
import type { MockHandle, MockPhase } from '../mock/server';
import { AppUpdater, RELEASES_URL } from './update';
import { ResumeStore } from './services/resume';
import type { ResumeFile, UiReport, UiResumeState } from '../shared/update';

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
let events: RiotEvents | null = null;
let displayMode: DisplayMode | null = null;
let fullscreenWarned = false;
let valorantConfigDir = defaultValorantConfigDir();
const debug = new DebugStore();
const recentToasts = new Map<string, number>();
const rpc: Record<string, (...args: any[]) => unknown> = {};
/** Last work before the app exits (archives, native display, session tweaks). Awaited, max 8 s. */
const beforeQuit: (() => Promise<void>)[] = [];
let systems: SystemServices | null = null;
/** Boost: SexyVal gets out of the way while Valorant runs. */
let quiet = false;

function setQuiet(on: boolean): void {
  quiet = on;
  win?.webContents.setBackgroundThrottling(on || !SHOTS);
  const level = on ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL;
  for (const m of app.getAppMetrics()) {
    try {
      os.setPriority(m.pid, level);
    } catch {
      // a process that just exited
    }
  }
  send('quiet', on);
  log.info(`quiet mode ${on ? 'on' : 'off'}`);
}
let resume: ResumeStore | null = null;
let resumed: ResumeFile | null = null;
let updater: AppUpdater | null = null;

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
  // Started at Windows login (--hidden), or relaunching hidden after a silent update, with close-to-tray on: stay in the tray until clicked.
  const startHidden = (process.argv.includes('--hidden') || resumed?.hiddenInTray) && getSettings().closeToTray;
  w.once('ready-to-show', () => (SHOTS ? w.showInactive() : startHidden ? undefined : w.show()));
  const saveBounds = () => {
    if (w.isDestroyed() || w.isMinimized()) return;
    const maximized = w.isMaximized();
    const b = maximized ? getSettings().window : w.getNormalBounds();
    updateSettings({ window: { width: b.width, height: b.height, x: b.x, y: b.y, maximized } });
  };
  // Boost quiet mode: a minimized window goes to the tray while Valorant runs.
  w.on('minimize', () => {
    if (quiet && tray) w.hide();
  });
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
    const durations = process.env.MOCK_FAST === '1' ? { idle: 6000, queue: 4000, pregame: 12000, ingame: 10000 } : undefined;
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
    if (process.env.MOCK_PHASE) mock.setPhase(process.env.MOCK_PHASE as MockPhase, 20_000);
    valorantConfigDir = mock.valorantConfigDir;
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
  // Price loads below fire this before `offers` and `catalog` exist; wait until both are built.
  let pricesReady = false;
  const sendPrices = () => {
    if (pricesReady) send('prices', prices.quotes(catalog.catalog, offers.prices(catalog.catalog)));
  };
  const prices = new PriceBook(dataDir('prices.json'), () => sendPrices());
  await prices.load();
  // Wiki prices re-scraped once per game version (user data folder); the bundled list is the fallback.
  const priceScrape = new PriceScrapeService(dataDir('skin-prices.json'), (l) => prices.setList(l));
  await priceScrape.load();
  const archive = new StoreArchive(dataDir());
  await archive.load();
  beforeQuit.push(() => archive.flush());
  if (MOCK) {
    const { mockShopHistory } = await import('../mock/shopSeed');
    archive.seedDays(mockShopHistory());
  }
  let storeSync: StoreSync | null = null;
  const offers = new OffersService(dataDir('offers.json'), MOCK && mock ? `${mock.base}/henrik` : 'https://api.henrikdev.xyz', () => getSettings().henrikKey, () => sendPrices(), onRaw);
  await offers.load();
  let reportedFor = '';
  const catalog = new CatalogService(dataDir('catalog'), () => {
    send('catalog', catalog.catalog);
    sendPrices();
    // Once per catalog: how many skins have a known price, an approximation, or nothing.
    if (catalog.catalog.skins.length && reportedFor !== String(catalog.catalog.version)) {
      reportedFor = String(catalog.catalog.version);
      const counts: Record<string, number> = {};
      for (const q of Object.values(prices.quotes(catalog.catalog, offers.prices(catalog.catalog)))) {
        const k = q.kind === 'exact' ? `exact:${q.source}` : q.kind === 'approx' ? `approx:${q.basis}` : q.kind;
        counts[k] = (counts[k] ?? 0) + 1;
      }
      log.info(`prices: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')} (of ${catalog.catalog.skins.length} skins)`);
    }
    void offers.refresh(catalog.catalog).then(sendPrices);
  });
  pricesReady = true;
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
      onRaw: (sf, puuid) => storeSync?.ingestActive(sf, puuid),
      afterRefresh: (walletChanged) => {
        if (walletChanged) void owned.refresh(); // purchase likely: refresh owned items
      },
    },
    dataDir('wishlist.json'),
  );
  await shop.loadWishlist();
  const shopRef = shop;
  storeSync = new StoreSync({
    api,
    archive,
    shop: shopRef,
    assets,
    prices,
    accounts,
    activePuuid: () => session.puuid,
    activeLabel: () => session.accountLabel ?? (session.puuid ? (names.get(session.puuid) ? `${names.get(session.puuid)!.name}#${names.get(session.puuid)!.tag}` : 'Riot Client account') : 'account'),
    onNewBundles: (list) => notify('New bundle in the store', list.map((b) => b.name ?? 'Featured bundle').join(', ')),
    onChange: () => send('store-archive', Date.now()),
  });
  const progression = new ProgressionService(api, catalog, assets);
  const party = new PartyService(api, assets, catalog, names);
  const loadout = new LoadoutService(api, dataDir('loadout-presets.json'), () => void owned.refresh());
  const profiles = new ProfileService(api, assets, catalog, history, names);
  const mmr = new MmrService(api, assets, catalog, () => emitLater());
  const hiddenInMatch = (p: string) => loop?.isHidden(p) ?? false;
  const mmrEstimate = new MmrEstimateService(api, assets, catalog, history, names, profiles, dataDir('mmr-updates'), hiddenInMatch);
  const lifetime = new LifetimeService(api, assets, catalog, history, profiles, hiddenInMatch);
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
      onPhase(s);
      onVersion(s.conn.version);
    },
    toast,
    mock: MOCK,
    pollMs: () => Number(process.env.SEXYVAL_POLL_MS) || (MOCK ? 2000 : getSettings().pollMs),
    mmr,
    eventsState: () => events?.state ?? 'off',
    onAccount: (puuid) => {
      owned.ensure(puuid);
      void storeSync?.syncOthers('tokens');
    },
    onNoTokens: () => {
      if (owned.state.status !== 'signed-out') owned.signedOut();
    },
  });
  emitLater = () => loop?.requestEmit();
  loop.start();
  // Instant phase changes from the Riot Client's own event socket; polling stays as the fallback.
  events = new RiotEvents(
    () => session.lockInfo,
    (uri) => {
      log.info(`event ${uri.replace(/[0-9a-f-]{36}/gi, '…')}`);
      loop?.nudge();
    },
    () => loop?.requestEmit(),
  );
  events.start();

  storeSync.start();

  // A new game version: fresh catalog (new skins, bundle names, art), every account's store, and one
  // wiki price scrape for that version. None of it blocks the UI; failures keep what was there.
  let seenVersion = '';
  function onVersion(v: string | undefined): void {
    if (!v || v === seenVersion) return;
    const changed = !!seenVersion;
    seenVersion = v;
    const followUp = () => {
      // Boost quiet mode: heavy background work waits until Valorant closes (the store fetch never waits).
      if (quiet) return void setTimeout(followUp, 60_000);
      if (!MOCK || process.env.SEXYVAL_SCRAPE === '1') priceScrape.ensure(v);
      if (changed) void catalog.load(true);
    };
    followUp();
    if (!changed) return;
    log.info(`game version changed to ${v}`);
    shop?.clearBundleNames();
    void storeSync?.syncAll('game update');
  }

  // Tray text + display-mode check follow the phase.
  let lastPhaseKey = '';
  function onPhase(s: AppState): void {
    const key = `${s.conn.message}|${s.conn.valorant}`;
    if (key === lastPhaseKey) return;
    lastPhaseKey = key;
    tray?.setToolTip(s.conn.status === 'connected' ? `SexyVal · ${s.conn.message}` : 'SexyVal');
    if (s.conn.valorant) void checkDisplayMode();
  }

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
  const uiReport = (v: unknown): UiReport => {
    const o = v as Partial<UiReport> | null;
    if (!o || typeof o !== 'object' || !o.nav || typeof o.nav.view !== 'string') throw new Error('bad ui report');
    const nav: UiResumeState = {
      view: o.nav.view.slice(0, 32),
      sub: typeof o.nav.sub === 'string' ? o.nav.sub.slice(0, 32) : undefined,
      scrollTop: typeof o.nav.scrollTop === 'number' && Number.isFinite(o.nav.scrollTop) ? Math.max(0, Math.round(o.nav.scrollTop)) : 0,
      profileQuery: typeof o.nav.profileQuery === 'string' ? o.nav.profileQuery.slice(0, 64) : undefined,
    };
    return { nav, videoPlaying: !!o.videoPlaying, unsavedLoadoutChanges: !!o.unsavedLoadoutChanges };
  };
  Object.assign(rpc, {
    'catalog:get': () => catalog.catalog,
    'catalog:refresh': () => catalog.load(true).then(() => catalog.catalog),
    'browse:get': () => catalog.browse,
    'owned:get': () => owned.state,
    'owned:refresh': () => owned.refresh(),
    // Every catalog skin gets a quote: an exact price (your store, then HenrikDev offers), a contract reward, or the reason there is none.
    'prices:get': () => prices.quotes(catalog.catalog, offers.prices(catalog.catalog)),
    'offers:status': () => offers.status,
    'offers:refresh': () => offers.refresh(catalog.catalog, true).then(() => (sendPrices(), offers.status)),
    'overlay:displayMode': () => checkDisplayMode().then(() => displayMode),
    'open:tracker': (name: unknown, tag: unknown) => {
      const url = trackerUrl(str(name, 32), str(tag, 16));
      if (!url) throw new Error('bad Riot ID');
      return shell.openExternal(url);
    },
    'store:bundles': () => archive.bundles(),
    'store:history': () => archive.days(),
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
    'mmr:get': (q: unknown, force: unknown) => mmrEstimate.get(str(q, 64), force === true),
    'mmr:chip': (p: unknown) => mmrEstimate.chip(str(p, 64)),
    'lifetime:get': (p: unknown, count: unknown) => lifetime.get(str(p, 64), Number(count) || 20),
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
    'ui:report': (v: unknown) => resume?.report(uiReport(v)),
    'update:status': () => updater?.status,
    'update:check': () => updater?.checkNow(),
    'update:openReleases': () => shell.openExternal(RELEASES_URL),
  });

  // Stretch + Boost (Settings tabs). Mock: dry-run helper, pretend Windows, the mock's phase as the game.
  systems = await createSystemServices({
    mock: MOCK,
    mockGameRunning: () => !!mock && mock.phase() !== 'offline' && mock.phase() !== 'noval',
    dataDir,
    configDir: valorantConfigDir,
    settings: getSettings,
    setQuiet,
    onStretch: (s) => send('stretch', s),
    onBoost: (s) => send('boost', s),
  });
  const sys = systems;
  beforeQuit.push(async () => {
    await sys.stretch.shutdown();
    await sys.boost.shutdown();
    sys.game.stop();
  });
  Object.assign(rpc, {
    'stretch:status': () => sys.stretch.status,
    'stretch:monitors': () => sys.stretch.refreshMonitors().then(() => sys.stretch.status),
    'boost:status': () => sys.boost.emit(),
    'boost:preset': () => sys.boost.applyPreset(),
    'boost:restorePreset': () => sys.boost.restorePreset(),
  });

  onSettings((s, prev) => {
    void sys.stretch.onSettings(s, prev);
    if (s.boostEnabled !== prev.boostEnabled || JSON.stringify(s.boostTweaks) !== JSON.stringify(prev.boostTweaks)) sys.boost.onSettings();
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
    if (s.overlayEnabled && !prev.overlayEnabled) void checkDisplayMode();
    if (s.henrikKey !== prev.henrikKey) void offers.refresh(catalog.catalog, true).then(sendPrices);
  });
}

/**
 * Exclusive Fullscreen hides every normal window, the overlay included. Read Valorant's own settings
 * file (read-only) and warn once per run; say nothing when the file can't be found.
 */
async function checkDisplayMode(): Promise<void> {
  const found = await detectDisplayMode(valorantConfigDir, loop?.state.conn.puuid).catch(() => null);
  displayMode = found?.mode ?? null;
  if (displayMode === 'fullscreen' && getSettings().overlayEnabled && !fullscreenWarned) {
    fullscreenWarned = true;
    toast('warn', 'Valorant is in Fullscreen. Switch Display Mode to Windowed Fullscreen to see the overlay.');
  }
}

function registerIpc(): void {
  handle('state:get', () => loop?.state);
  handle('shop:get', () => shop?.view ?? { status: 'idle', daily: [], wallet: null });
  handle('shop:refresh', () => shop?.refresh());
  // The renderer never sees the HenrikDev key, only that one is set.
  handle('settings:get', () => publicSettings());
  handle('settings:set', (patch: Partial<Settings>) => publicSettings(updateSettings(patch ?? {})));
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
    // Run by the NSIS uninstaller (build/installer.nsh): undo Stretch and Boost, remove the helper task, exit.
    if (process.argv.includes('--sexyval-uninstall')) {
      const s = await createSystemServices({ mock: false, dataDir, configDir: valorantConfigDir, settings: getSettings, setQuiet: () => undefined, onStretch: () => undefined, onBoost: () => undefined });
      await uninstallCleanup(s);
      app.exit(0);
      return;
    }
    resume = new ResumeStore(dataDir('resume.json'));
    resumed = await resume.consume().catch(() => null);
    handleApp(path.join(app.getAppPath(), 'dist-renderer'));
    handleAssets(dataDir('assets', 'img'));
    handleVideos({ dir: dataDir('videos'), cacheEnabled: () => getSettings().cacheVideos && !quiet, maxBytes: () => getSettings().videoCacheMaxMb * MB });
    registerIpc();
    win = createWindow();
    applyAppIcon(win, getSettings().appIcon, iconPath()); // re-apply the saved choice (shortcuts may have been recreated by an update)
    if (resumed) {
      const r = resumed;
      win.webContents.once('did-finish-load', () => {
        if (r.ui) send('resume', r.ui);
        if (r.version !== app.getVersion()) toast('info', `Updated to ${app.getVersion()}`);
      });
    }
    if (!SHOTS) createTray();
    await removeOldCalibrationData();
    // A failure here must not take the updater down with it: that is how a fixed build gets in.
    try {
      await startServices();
    } catch (e) {
      log.error('startup failed', e);
      const msg = `SexyVal couldn't start: ${(e as Error).message}`;
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => toast('error', msg));
      else toast('error', msg);
    }
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed'] as const) screen.on(ev as any, () => overlay.relayout());

    updater = new AppUpdater({
      getWindow: () => win,
      getPhase: () => loop?.state.phase ?? 'idle',
      getSettings,
      resume,
      onStatus: (s) => send('update', s),
    });
    if (!SHOTS) updater.start(); // start() itself no-ops unless packaged (or SEXYVAL_UPDATE_FEED_URL is set for manual testing)

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

  let cleanedUp = false;
  app.on('before-quit', (e) => {
    // Native display and session tweaks must be back before the process ends: finish them first.
    if (!cleanedUp && beforeQuit.length) {
      e.preventDefault();
      cleanedUp = true;
      const all = Promise.all(beforeQuit.map((f) => f().catch((err) => log.warn('quit cleanup', err))));
      void Promise.race([all, new Promise((r) => setTimeout(r, 8000))]).finally(() => app.quit());
      return;
    }
    overlay.destroy();
    quitting = true;
    loop?.stop();
    events?.stop();
    accounts?.stop();
    updater?.stop();
    void mock?.close();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
  });
}
