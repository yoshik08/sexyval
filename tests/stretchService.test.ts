import { afterAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, constants as fsc } from 'node:fs';
import { StretchService, valorantIniFiles } from '../main/services/stretch';
import { readIniKeys, SECTION } from '../shared/stretch';
import type { Settings } from '../shared/types';

process.env.SEXYVAL_QUIET = '1';
const ORIGINAL = '[/Script/ShooterGame.ShooterGameUserSettings]\r\nResolutionSizeX=1920\r\nResolutionSizeY=1080\r\nbShouldLetterbox=True\r\nFullscreenMode=0\r\n\r\n[ScalabilityGroups]\r\nsg.ShadowQuality=3\r\n';

const writable = (f: string) =>
  fs.access(f, fsc.W_OK).then(
    () => true,
    () => false,
  );

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sexyval-stretch-'));
  const files = [path.join(dir, 'WindowsClient'), path.join(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-ap', 'WindowsClient'), path.join(dir, 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee-eu', 'Windows')].map((d) => path.join(d, 'GameUserSettings.ini'));
  for (const f of files) {
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, ORIGINAL);
  }
  const listeners: ((r: boolean) => void)[] = [];
  const game = { running: false, on: (fn: (r: boolean) => void) => listeners.push(fn) };
  const calls: string[][] = [];
  const helper = {
    dryRun: true,
    watchdog: () => undefined,
    call: async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'list') return { ok: true, monitors: [{ device: '\\\\.\\DISPLAY1', name: 'Panel', primary: true, current: { w: 1920, h: 1080, hz: 240 }, modes: [{ w: 1920, h: 1080, hz: 240 }, { w: 1440, h: 1080, hz: 60 }, { w: 1440, h: 1080, hz: 240 }] }] };
      return { ok: true, dryRun: true, stretched: true };
    },
  };
  let settings = { stretchEnabled: false, stretchRes: { w: 1440, h: 1080 }, stretchDevice: null, stretchNativeOnAltTab: false } as unknown as Settings;
  const svc = new StretchService({ helper: helper as any, game: game as any, settings: () => settings, configDir: dir, stateFile: path.join(dir, 'state.txt'), onStatus: () => undefined });
  await svc.init();
  const set = async (patch: Partial<Settings>) => {
    const prev = settings;
    settings = { ...settings, ...patch };
    await svc.onSettings(settings, prev);
  };
  const setGame = async (running: boolean) => {
    game.running = running;
    for (const l of listeners) l(running);
    await new Promise((r) => setTimeout(r, 30));
  };
  return { dir, files, svc, set, setGame, calls };
}

describe('StretchService: Valorant ini', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) {
      for (const f of await valorantIniFiles(d)) await fs.chmod(f, 0o666).catch(() => undefined);
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('finds every account folder (WindowsClient and Windows) plus the machine-wide file', async () => {
    const t = await setup();
    dirs.push(t.dir);
    expect((await valorantIniFiles(t.dir)).sort()).toEqual([...t.files].sort());
  });

  it('enable: every file edited, original backed up once, read-only; disable: originals back, writable', async () => {
    const t = await setup();
    dirs.push(t.dir);
    await t.set({ stretchEnabled: true });
    for (const f of t.files) {
      expect(readIniKeys(await fs.readFile(f, 'utf8'), SECTION)).toMatchObject({ ResolutionSizeX: '1440', ResolutionSizeY: '1080', bShouldLetterbox: 'False', FullscreenMode: '1' });
      expect(readIniKeys(await fs.readFile(f, 'utf8'), '[ScalabilityGroups]')).toEqual({ 'sg.ShadowQuality': '3' });
      expect(await writable(f)).toBe(false);
      expect(await fs.readFile(path.join(path.dirname(f), 'GameUserSettings.sexyval-backup.ini'), 'utf8')).toBe(ORIGINAL);
    }
    // A second resolution keeps the first backup (the true original).
    await t.set({ stretchRes: { w: 1280, h: 960 } });
    expect(readIniKeys(await fs.readFile(t.files[1], 'utf8'), SECTION).ResolutionSizeX).toBe('1280');
    expect(await fs.readFile(path.join(path.dirname(t.files[1]), 'GameUserSettings.sexyval-backup.ini'), 'utf8')).toBe(ORIGINAL);
    await t.set({ stretchEnabled: false });
    for (const f of t.files) {
      expect(await fs.readFile(f, 'utf8')).toBe(ORIGINAL);
      expect(await writable(f)).toBe(true);
    }
  });

  it('game running: the display stretches now (highest refresh) and the ini waits for the game to close', async () => {
    const t = await setup();
    dirs.push(t.dir);
    await t.setGame(true);
    await t.set({ stretchEnabled: true });
    expect(t.calls.find((c) => c[0] === 'apply')).toEqual(['apply', '\\\\.\\DISPLAY1', '1440', '1080', '240']);
    expect(await fs.readFile(t.files[0], 'utf8')).toBe(ORIGINAL);
    await t.setGame(false);
    expect(t.calls.find((c) => c[0] === 'restore')).toEqual(['restore', '\\\\.\\DISPLAY1', '1920', '1080', '240', '0']);
    expect(readIniKeys(await fs.readFile(t.files[0], 'utf8'), SECTION).ResolutionSizeX).toBe('1440');
    await t.set({ stretchEnabled: false });
  });
});
