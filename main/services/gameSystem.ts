import { app } from 'electron';
import path from 'node:path';
import type { BoostStatus, Settings, StretchStatus } from '../../shared/types';
import { BoostService } from './boost';
import { StretchService } from './stretch';
import { ElevatedRunner, GameWatcher, HelperClient, realRunner } from './system';
import { log } from '../log';

export function helperExe(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'helper', 'stretch.exe') : path.join(app.getAppPath(), 'helper', 'stretch.exe');
}

export interface SystemServices {
  game: GameWatcher;
  helper: HelperClient;
  elevated: ElevatedRunner | null;
  stretch: StretchService;
  boost: BoostService;
}

/**
 * Stretch + Boost and what they share (game-process watcher, helper, elevated task). In mock mode the
 * helper runs with --dry-run (no display change), commands go to a pretend Windows, and the "game" is
 * the mock's phase, so nothing on the machine changes.
 */
export async function createSystemServices(o: {
  mock: boolean;
  mockGameRunning?: () => boolean;
  dataDir: (...p: string[]) => string;
  configDir: string;
  settings: () => Settings;
  setQuiet: (on: boolean) => void;
  onStretch: (s: StretchStatus) => void;
  onBoost: (s: BoostStatus) => void;
}): Promise<SystemServices> {
  const dryRun = o.mock || process.env.SEXYVAL_DRY_RUN === '1';
  const helper = new HelperClient(helperExe(), dryRun);
  const game = new GameWatcher(o.mock ? async () => o.mockGameRunning?.() ?? false : undefined);
  const elevated = dryRun ? null : new ElevatedRunner(helper, o.dataDir('helper'));
  let run = elevated ? realRunner(elevated) : undefined;
  if (!run) {
    const { fakeWindows } = await import('../../mock/fakeWindows');
    run = fakeWindows().run;
  }
  await game.check();
  const stretch = new StretchService({ helper, game, settings: o.settings, configDir: o.configDir, stateFile: o.dataDir('stretch-state.txt'), onStatus: o.onStretch });
  const boost = new BoostService({
    run,
    journalFile: o.dataDir('boost-journal.json'),
    settings: o.settings,
    game,
    setQuiet: o.setQuiet,
    elevatedReady: async () => (elevated ? elevated.ready() : true),
    configDir: o.configDir,
    onStatus: o.onBoost,
    dryRun,
  });
  await stretch.init().catch((e) => log.warn('stretch init failed', e));
  await boost.init().catch((e) => log.warn('boost init failed', e));
  game.start();
  return { game, helper, elevated, stretch, boost };
}

/** Uninstaller entry (SexyVal.exe --sexyval-uninstall): native display, original ini, every tweak reverted, task removed. */
export async function uninstallCleanup(s: SystemServices): Promise<void> {
  await s.stretch.shutdown({ restoreIni: true }).catch((e) => log.warn('uninstall: stretch', e));
  const errors = await s.boost.shutdown({ all: true });
  if (errors.length) log.warn(`uninstall: boost revert errors: ${errors.join('; ')}`);
  await s.elevated?.remove().catch((e) => log.warn('uninstall: remove task', e));
  s.game.stop();
}
