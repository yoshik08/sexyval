import { describe, expect, it } from 'vitest';
import { IDLE_SAFE_SECONDS, isSafeToInstall, UNFOCUSED_SAFE_MS, type SafeToInstallInput } from '../shared/update';

const base: SafeToInstallInput = {
  phase: 'idle',
  videoPlaying: false,
  unsavedLoadoutChanges: false,
  windowHidden: false,
  unfocusedForMs: 0,
  systemIdleSeconds: 0,
};

describe('safe moment to silently install', () => {
  it('blocks whenever Valorant is queuing, in agent select or in game', () => {
    expect(isSafeToInstall({ ...base, phase: 'queue', windowHidden: true })).toBe(false);
    expect(isSafeToInstall({ ...base, phase: 'pregame', windowHidden: true })).toBe(false);
    expect(isSafeToInstall({ ...base, phase: 'ingame', windowHidden: true })).toBe(false);
  });

  it('blocks on a playing video or unsaved loadout edits even when hidden in the tray', () => {
    expect(isSafeToInstall({ ...base, windowHidden: true, videoPlaying: true })).toBe(false);
    expect(isSafeToInstall({ ...base, windowHidden: true, unsavedLoadoutChanges: true })).toBe(false);
  });

  it('hidden in the tray is safe on its own, with no focus/idle wait', () => {
    expect(isSafeToInstall({ ...base, windowHidden: true })).toBe(true);
  });

  it('a visible, focused window is never safe', () => {
    expect(isSafeToInstall({ ...base, windowHidden: false, unfocusedForMs: 0, systemIdleSeconds: 0 })).toBe(false);
  });

  it('visible but unfocused for 5+ minutes is safe', () => {
    expect(isSafeToInstall({ ...base, unfocusedForMs: UNFOCUSED_SAFE_MS - 1 })).toBe(false);
    expect(isSafeToInstall({ ...base, unfocusedForMs: UNFOCUSED_SAFE_MS })).toBe(true);
  });

  it('system idle 300s+ is safe even if SexyVal itself is focused', () => {
    expect(isSafeToInstall({ ...base, systemIdleSeconds: IDLE_SAFE_SECONDS - 1 })).toBe(false);
    expect(isSafeToInstall({ ...base, systemIdleSeconds: IDLE_SAFE_SECONDS })).toBe(true);
  });
});
