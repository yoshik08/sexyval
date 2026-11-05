/**
 * Valorant's display mode from its GameUserSettings.ini (read-only, a local file; nothing is sent
 * to the game). The values follow Unreal's EWindowMode: 0 = Fullscreen (exclusive),
 * 1 = Windowed Fullscreen (borderless), 2 = Windowed. On the one real install checked, borderless
 * read 1; the 0 and 2 mapping comes from Unreal and has not been confirmed by switching modes in game.
 */
export type DisplayMode = 'fullscreen' | 'borderless' | 'windowed';

const MODES: Record<string, DisplayMode> = { '0': 'fullscreen', '1': 'borderless', '2': 'windowed' };

function readKey(ini: string, key: string): string | undefined {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, 'mi').exec(ini);
  return m?.[1];
}

/** FullscreenMode wins (the current value); LastConfirmedFullscreenMode is the fallback. */
export function parseDisplayMode(ini: string | null | undefined): DisplayMode | null {
  if (typeof ini !== 'string' || !ini) return null;
  const v = readKey(ini, 'FullscreenMode') ?? readKey(ini, 'LastConfirmedFullscreenMode');
  return v != null ? (MODES[v] ?? null) : null;
}
