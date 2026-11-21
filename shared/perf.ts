// Lightweight background mode (Settings > Performance). Pure.
export type PerfMode = 'auto' | 'always' | 'normal';

/**
 * auto: lightweight while Valorant runs. always: lightweight all the time. normal: never, except that
 * Boost's "quiet" tweak (an explicit choice in Settings > Boost) still applies while the game runs.
 */
export function liteActive(mode: PerfMode, valorantRunning: boolean, boostQuiet: boolean): boolean {
  if (boostQuiet) return true;
  if (mode === 'always') return true;
  if (mode === 'auto') return valorantRunning;
  return false;
}

/**
 * What lightweight mode changes (shown in Settings and the docs). Essential live work never waits:
 * the game loop, Live screen, overlay, account switching and the active account's store.
 */
export const LITE_EFFECTS = [
  'Animations, blur and hover video previews off',
  'Window drawing throttled while it is in the background; SexyVal runs at below-normal priority',
  'Store sync for your other accounts waits until Valorant closes',
  'Friend-watch polling, history indexing and the game-update catalog refresh wait',
] as const;
