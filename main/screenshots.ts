import type { BrowserWindow, WebContents } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { MockHandle, MockPhase } from '../mock/server';
import { PERSONA } from '../mock/career';
import { log } from './log';

interface Step {
  name: string;
  phase?: MockPhase;
  elapsed?: number;
  nav?: string;
  wait: number;
  /** JS to run in the page after navigating (clicks etc). */
  js?: string;
  /** JS whose result is logged (verification). */
  check?: string;
  /** Capture the agent-select overlay window instead of the main window. */
  overlay?: boolean;
}

const ESC = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));`;
const VIDEO_CHECK = `(() => { const v = document.querySelector('[role=dialog] video'); return v ? { t: Math.round(v.currentTime * 10) / 10, paused: v.paused, ready: v.readyState } : 'no video element'; })()`;
const setS = (patch: Record<string, unknown>) => `window.sexyval.setSettings(${JSON.stringify(patch)});`;
/** Types the mock HenrikDev key into Settings → Accounts and presses Save, like a user would. */
const TYPE_KEY = `(() => { const i = document.querySelector('[data-henrik-key]'); if (!i) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'HDEV-mock-0000-key'); i.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => i.form.requestSubmit(), 150); })();`;
const clickTab = (label: string) => `[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))?.click();`;

const STEPS: Step[] = [
  { name: '01-waiting-no-client', phase: 'offline', nav: 'live', wait: 4500 },
  { name: '02-live-valorant-closed', phase: 'noval', nav: 'live', wait: 7000 },
  { name: '03-shop-valorant-closed', nav: 'shop', wait: 4000 },
  { name: '04-shop-video-playing', nav: 'shop', wait: 9000, js: `document.querySelector('[data-skin-card]')?.click();`, check: VIDEO_CHECK },
  { name: '05-shop-bundles', nav: 'shop:bundles', wait: 3000, js: ESC },
  { name: '06-shop-night', nav: 'shop:night', wait: 2500 },
  { name: '07-collection', nav: 'collection', wait: 5000 },
  { name: '08-collection-drawer-video', nav: 'collection', wait: 9000, js: `document.querySelector('[data-skin-card]')?.click();`, check: VIDEO_CHECK },
  { name: '09-collection-drawer-variant', wait: 6000, js: `document.querySelectorAll('[role=dialog] button[title]')[1]?.click();`, check: VIDEO_CHECK },
  { name: '10-collection-buddies', nav: 'collection', wait: 3500, js: `${ESC} setTimeout(() => { ${clickTab('Buddies')} }, 100);` },
  { name: '11-collection-cards', nav: 'collection', wait: 3000, js: clickTab('Cards') },
  { name: '12-loadout', nav: 'loadout', wait: 4000, js: `setTimeout(() => document.querySelectorAll('main button[aria-pressed]')[6]?.click(), 1500);` },
  { name: '13-missions', nav: 'progress', wait: 4500 },
  { name: '14-profiles', nav: 'profiles', wait: 8000 },
  { name: '15-profiles-analysis', nav: 'profiles', wait: 2500, js: clickTab('Analysis') },
  { name: '16-hub-friends', nav: 'hub:friends', wait: 3500 },
  { name: '17-hub-leaderboard', nav: 'hub:leaderboard', wait: 3500 },
  { name: '18-hub-agents', nav: 'hub:agents', wait: 3500 },
  // 1.3: estimated MMR per persona (you: well above rank), lifetime profiles, store archive + calendar.
  { name: '27a-mmr-above-rank', nav: 'mmr', wait: 7000, check: `document.querySelector('[data-mmr] .t-title')?.textContent` },
  { name: '27b-mmr-graph-hover', wait: 1200, js: `(() => { const s = document.querySelector('[data-mmr] svg[role=img]'); if (!s) return; const r = s.getBoundingClientRect(); s.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + r.width * 0.7, clientY: r.top + r.height / 2 })); s.scrollIntoView({ block: 'center' }); })();` },
  { name: '27c-mmr-at-rank', nav: `mmr:${PERSONA.at}`, wait: 6000 },
  { name: '27d-mmr-below-rank', nav: `mmr:${PERSONA.below}`, wait: 6000 },
  { name: '27e-mmr-mostly-excluded', nav: `mmr:${PERSONA.excluded}`, wait: 6000, js: `setTimeout(() => document.querySelector('[data-mmr] > section:last-of-type')?.scrollIntoView({ block: 'end' }), 4000);` },
  { name: '28a-lifetime-tracker-private', nav: `profiles:${PERSONA.trackerPrivate}`, wait: 11000, check: `document.querySelector('[data-lifetime]') ? 'lifetime shown' : 'no lifetime'` },
  { name: '28b-lifetime-matches', wait: 1500, js: `document.querySelector('[data-lifetime] > section:last-of-type')?.scrollIntoView({ block: 'end' });` },
  { name: '29a-shop-past-bundles', nav: 'shop:past', wait: 5000 },
  { name: '29b-shop-history-calendar', nav: 'shop:history', wait: 4000 },
  { name: '29c-shop-history-search', wait: 1500, js: `(() => { const i = document.querySelector('[data-calendar] input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'va'); i.dispatchEvent(new Event('input', { bubbles: true })); })();` },
  { name: '29d-shop-history-day', wait: 1800, js: `(() => { const i = document.querySelector('[data-calendar] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => [...document.querySelectorAll('[data-calendar] [role=gridcell]')].reverse().find((c) => /VP/.test(c.getAttribute('aria-label') || ''))?.click(), 200); })();` },
  { name: '19-live-idle', phase: 'idle', nav: 'live', wait: 7000, js: ESC },
  { name: '19b-live-queue', phase: 'queue', elapsed: 83, nav: 'live', wait: 3500, check: `document.querySelector('[data-queue-time]')?.textContent` },
  { name: '20-party', nav: 'party', wait: 4500 },
  // Queue pops: the overlay shows "Match found" before the map is known (the mock fills MapID after 1.5 s).
  { name: '21a-overlay-match-found', phase: 'pregame', elapsed: 0, nav: 'live', wait: 700, overlay: true },
  { name: '21-agent-select', phase: 'pregame', elapsed: 22, nav: 'live', wait: 7000 },
  { name: '21b-agent-select-overlay', wait: 1200, overlay: true },
  { name: '21c-agent-select-overlay-small', wait: 1200, overlay: true, js: setS({ overlayScale: 'small' }) },
  { name: '21d-agent-select-expanded', nav: 'live', wait: 5000, js: `${setS({ overlayScale: 'medium' })} const c = document.querySelectorAll('[data-row][role=button]')[1]; c?.click(); setTimeout(() => c?.scrollIntoView({ block: 'end' }), 450);` },
  { name: '22-in-game', phase: 'ingame', nav: 'live', wait: 10000, check: `[...document.querySelectorAll('[data-score]')].map((e) => e.textContent.slice(0, 4)).join(' ')` },
  { name: '22b-in-game-expanded', wait: 1500, js: `document.querySelectorAll('.ig-team [data-row][role=button]')[1]?.click();` },
  { name: '22c-in-game-detailed', wait: 1800, js: clickTab('Detailed') },
  { name: '22d-in-game-score-tip', wait: 1200, js: `${clickTab('Compact')} setTimeout(() => document.querySelectorAll('.ig-team [data-score]')[6]?.parentElement?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })), 500);` },
  // Enemy row (the "excluded" persona): lifetime line + estimated MMR chip load only once the row is opened.
  { name: '22e-in-game-enemy-lifetime', wait: 5000, js: `document.querySelectorAll('.ig-team')[1]?.querySelector('[data-row][role=button]')?.click();` },
  { name: '23-settings', nav: 'settings:general', wait: 3000, js: setS({ liveDensity: 'auto' }), check: `!!document.querySelector('[data-fullscreen-note]')` },
  { name: '24-settings-accounts', nav: 'settings:accounts', wait: 6000, js: `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Sign in with Riot'))?.click();` },
  { name: '25-settings-price-source', nav: 'settings:accounts', wait: 3000, js: TYPE_KEY },
  { name: '26-debug', nav: 'settings:debug', wait: 2500 },
  // Mock: the helper runs with --dry-run (the real display never changes) and Boost writes to a pretend Windows.
  { name: '30a-settings-stretch', phase: 'ingame', nav: 'settings:stretch', wait: 3500, js: `setTimeout(() => document.querySelector('[data-stretch] [role=switch]')?.click(), 600);`, check: `document.querySelector('[data-stretch-status]')?.textContent` },
  { name: '30b-settings-boost', nav: 'settings:boost', wait: 3500, js: `setTimeout(() => document.querySelector('[data-boost] [role=switch]')?.click(), 600);` },
  // Switch both back off so the next mock run starts clean.
  { name: '30c-settings-boost-off', wait: 2500, js: `document.querySelector('[data-boost] [role=switch]')?.click();` },
  { name: '30d-settings-stretch-off', nav: 'settings:stretch', wait: 2500, js: `setTimeout(() => document.querySelector('[data-stretch] [role=switch]')?.click(), 600);` },
];

/** Drives the mock scenario through every screen and saves PNGs. Dev only. */
export async function runScreenshots(win: BrowserWindow, mock: MockHandle, pollNow: () => void, dir: string, overlay?: () => WebContents | null): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log.warn(`renderer: ${message}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => log.error(`renderer gone: ${d.reason}`));
  win.webContents.on('did-start-navigation', (_e, url) => log.warn(`page navigation: ${url.slice(0, 70)}`));
  win.webContents.on('did-finish-load', () => log.warn('page finished loading'));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Dev aid: SEXYVAL_SHOT_SIZE=1100x680 captures at a given window size (e.g. the minimum).
  const size = /^(\d+)x(\d+)$/.exec(process.env.SEXYVAL_SHOT_SIZE ?? '');
  if (size) {
    win.unmaximize();
    win.setSize(Number(size[1]), Number(size[2]));
  }
  await sleep(4000);
  const only = process.env.SEXYVAL_SHOT_ONLY;
  // Dev aid: SEXYVAL_STEPS=<file.json> runs a custom list of steps (same shape as STEPS) instead.
  const steps: Step[] = process.env.SEXYVAL_STEPS ? JSON.parse(await fs.readFile(process.env.SEXYVAL_STEPS, 'utf8')) : STEPS;
  for (const s of steps.filter((x) => !only || only.split(',').some((o) => x.name.startsWith(o)))) {
    if (s.phase) mock.setPhase(s.phase, (s.elapsed ?? 0) * 1000);
    if (s.nav) win.webContents.send('nav', s.nav);
    pollNow();
    if (s.js) {
      await sleep(600);
      await win.webContents.executeJavaScript(s.js).catch((e) => log.warn(`step ${s.name} js failed`, e));
    }
    await sleep(s.wait);
    if (s.check) log.info(`step ${s.name}: check = ${JSON.stringify(await win.webContents.executeJavaScript(s.check).catch((e) => String(e)))}`);
    // Dev aid: SEXYVAL_EVAL="<js>" prints what a page expression returns after every step.
    if (process.env.SEXYVAL_EVAL) log.info(`step ${s.name}: eval = ${JSON.stringify(await win.webContents.executeJavaScript(process.env.SEXYVAL_EVAL).catch((e) => String(e)))}`);
    win.webContents.invalidate();
    await sleep(150);
    const target = s.overlay ? overlay?.() : win.webContents;
    if (!target) {
      log.warn(`step ${s.name}: overlay not visible`);
      continue;
    }
    if (s.overlay) log.info(`step ${s.name}: overlay pill = ${JSON.stringify(await target.executeJavaScript('measure()').catch((e) => String(e)))}`);
    const img = await target.capturePage();
    const file = path.join(dir, `${s.name}.png`);
    await fs.writeFile(file, img.toPNG());
    log.info(`screenshot ${s.name}`);
  }
}

const LIVE_STEPS: Step[] = [
  { name: 'live-01-store', nav: 'shop', wait: 9000 },
  { name: 'live-02-collection', nav: 'collection', wait: 9000 },
  { name: 'live-03-collection-skin', nav: 'collection', wait: 8000, js: `document.querySelector('[data-skin-card]')?.click();` },
  { name: 'live-04-loadout', nav: 'loadout', wait: 9000, js: ESC },
  { name: 'live-05-loadout-weapon', nav: 'loadout', wait: 3500, js: `document.querySelectorAll('main button[aria-pressed]')[3]?.click();` },
  { name: 'live-06-live', nav: 'live', wait: 3000 },
];

/** Dev only: captures the real screens against the real Riot Client (no mock). Output stays on this machine. */
export async function runLiveShots(win: BrowserWindow, dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log.warn(`renderer: ${message}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => log.error(`renderer gone: ${d.reason}`));
  win.webContents.on('did-start-navigation', (_e, url) => log.info(`navigation: ${url.slice(0, 60)}`));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await sleep(9000); // catalog + owned items + store need a moment on a fresh profile
  for (const s of LIVE_STEPS) {
    if (s.nav) win.webContents.send('nav', s.nav);
    if (s.js) {
      await sleep(900);
      await win.webContents.executeJavaScript(s.js).catch((e) => log.warn(`step ${s.name} js failed`, e));
    }
    await sleep(s.wait);
    if (process.env.SEXYVAL_EVAL) log.info(`step ${s.name}: eval = ${JSON.stringify(await win.webContents.executeJavaScript(process.env.SEXYVAL_EVAL).catch((e) => String(e)))}`);
    win.webContents.invalidate();
    await sleep(150);
    await fs.writeFile(path.join(dir, `${s.name}.png`), (await win.webContents.capturePage()).toPNG());
    log.info(`screenshot ${s.name}`);
  }
}
