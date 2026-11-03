import { app, nativeImage, shell, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log';

export const APP_ID = 'com.sexyval.app';

/** .ico for Windows shell use. Packaged builds ship them outside the asar (extraResources), where the shell can read them. */
function icoPath(name: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'icons', `${name}.ico`) : path.join(app.getAppPath(), 'build', 'icons', `${name}.ico`);
}

/** SexyVal's own shortcuts: Start Menu and Desktop (made by the installer) and any taskbar pin. */
function shortcuts(): string[] {
  const appData = app.getPath('appData');
  const pinned = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
  let pins: string[] = [];
  try {
    pins = fs.readdirSync(pinned).filter((f) => f.toLowerCase().endsWith('.lnk')).map((f) => path.join(pinned, f));
  } catch {
    // no pins folder
  }
  return [path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'SexyVal.lnk'), path.join(app.getPath('desktop'), 'SexyVal.lnk'), ...pins];
}

/**
 * Applies the chosen icon everywhere Windows shows it. The taskbar button takes its icon from the
 * shortcut that launched the app (matched by app ID), not from the window, so the shortcuts are
 * updated too; the window's relaunch details make pinning use the same icon.
 */
export function applyAppIcon(win: BrowserWindow | null, name: string, pngPath: string): void {
  if (!win || win.isDestroyed()) return;
  win.setIcon(nativeImage.createFromPath(pngPath));
  if (process.platform !== 'win32' || !app.isPackaged) return; // dev runs as electron.exe: leave the system alone
  const ico = icoPath(name);
  if (!fs.existsSync(ico)) return log.warn(`app icon: ${ico} missing`);
  const exe = path.resolve(process.execPath).toLowerCase();
  for (const lnk of shortcuts()) {
    try {
      if (!fs.existsSync(lnk)) continue;
      const cur = shell.readShortcutLink(lnk);
      if (path.resolve(cur.target ?? '').toLowerCase() !== exe) continue; // another app, or another copy of SexyVal
      if ((cur.icon ?? '').toLowerCase() === ico.toLowerCase()) continue;
      shell.writeShortcutLink(lnk, 'update', { ...cur, icon: ico, iconIndex: 0 }); // keeps target, args and app ID
    } catch (e) {
      log.warn(`app icon: could not update ${lnk}`, e);
    }
  }
  const details = { appIconPath: ico, appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'SexyVal' };
  // Briefly switching the window's app ID makes the taskbar re-read the icon instead of keeping its cached one.
  win.setAppDetails({ appId: `${APP_ID}.icon`, ...details });
  win.setAppDetails({ appId: APP_ID, ...details });
}
