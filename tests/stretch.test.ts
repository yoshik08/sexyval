import { describe, expect, it } from 'vitest';
import { pickMode, readIniKeys, SECTION, setIniKeys, stretchIni, stretchStep, watchdogState, type StretchState } from '../shared/stretch';

// The real file's layout (Nov 2026), trimmed.
const REAL = [
  '[/Script/ShooterGame.ShooterGameUserSettings]',
  'DefaultMonitorDeviceID="MONITOR\\\\CMN1521\\\\{4d36e96e-e325-11ce-bfc1-08002be10318}\\\\0002"',
  'bShouldLetterbox=True',
  'bLastConfirmedShouldLetterbox=True',
  'ResolutionSizeX=1920',
  'ResolutionSizeY=1080',
  'LastUserConfirmedResolutionSizeX=1920',
  'LastUserConfirmedResolutionSizeY=1080',
  'LastConfirmedFullscreenMode=0',
  'PreferredFullscreenMode=0',
  'DesiredScreenWidth=1280',
  'DesiredScreenHeight=720',
  'FullscreenMode=0',
  '',
  '[ScalabilityGroups]',
  'sg.ShadowQuality=3',
  '',
  '[/Script/Engine.GameUserSettings]',
  'bUseDesiredScreenHeight=False',
  '',
].join('\r\n');

describe('shared/stretch: ini', () => {
  it('sets every stretch key, keeps every other line, order and CRLF', () => {
    const out = stretchIni(REAL, { w: 1440, h: 1080 });
    const k = readIniKeys(out, SECTION);
    expect(k).toMatchObject({
      ResolutionSizeX: '1440',
      ResolutionSizeY: '1080',
      LastUserConfirmedResolutionSizeX: '1440',
      LastUserConfirmedResolutionSizeY: '1080',
      DesiredScreenWidth: '1440',
      DesiredScreenHeight: '1080',
      LastUserConfirmedDesiredScreenWidth: '1440',
      LastUserConfirmedDesiredScreenHeight: '1080',
      bShouldLetterbox: 'False',
      bLastConfirmedShouldLetterbox: 'False',
      FullscreenMode: '1',
      LastConfirmedFullscreenMode: '1',
    });
    expect(k.DefaultMonitorDeviceID).toContain('CMN1521');
    expect(out.split('\r\n').length).toBe(REAL.split('\r\n').length + 2); // two keys were missing and got added
    expect(out).not.toMatch(/[^\r]\n/);
    expect(readIniKeys(out, '[ScalabilityGroups]')).toEqual({ 'sg.ShadowQuality': '3' });
    // Added keys go inside the section, before the blank line that ends it.
    const lines = out.split('\r\n');
    expect(lines.indexOf('LastUserConfirmedDesiredScreenWidth=1440')).toBeLessThan(lines.indexOf('[ScalabilityGroups]'));
  });

  it('round-trips: applying twice changes nothing, and other sections are untouched', () => {
    const once = stretchIni(REAL, { w: 1280, h: 960 });
    expect(stretchIni(once, { w: 1280, h: 960 })).toBe(once);
    expect(readIniKeys(once, '[/Script/Engine.GameUserSettings]')).toEqual({ bUseDesiredScreenHeight: 'False' });
  });

  it('adds the section to an empty or LF file', () => {
    expect(setIniKeys('', '[A]', { x: '1' })).toBe('[A]\nx=1\n');
    expect(setIniKeys('[B]\ny=2\n', '[A]', { x: '1' })).toBe('[B]\ny=2\n\n[A]\nx=1\n');
  });
});

describe('shared/stretch: modes', () => {
  const modes = [
    { w: 1440, h: 1080, hz: 60 },
    { w: 1440, h: 1080, hz: 240 },
    { w: 1440, h: 1080, hz: 144 },
    { w: 1920, h: 1080, hz: 240 },
  ];
  it('picks the highest refresh rate for the size, never dropping to 60', () => {
    expect(pickMode(modes, { w: 1440, h: 1080 })).toEqual({ w: 1440, h: 1080, hz: 240 });
    expect(pickMode(modes, { w: 1080, h: 1080 })).toBeNull();
  });
  it('watchdog state file', () => {
    expect(watchdogState(true, '\\\\.\\DISPLAY1', { w: 1920, h: 1080, hz: 144, fixedOutput: 0 })).toBe('stretched=1\r\ndevice=\\\\.\\DISPLAY1\r\nw=1920\r\nh=1080\r\nhz=144\r\nfixed=0\r\n');
    expect(watchdogState(false, 'x')).toBe('stretched=0\r\n');
  });
});

describe('shared/stretch: state machine', () => {
  const off: StretchState = { phase: 'off', iniPending: false };
  const o = { nativeOnAltTab: false };
  it('enable with the game closed writes the ini; game start stretches; exit restores', () => {
    let r = stretchStep(off, { type: 'enable', gameRunning: false }, o);
    expect(r).toEqual({ state: { phase: 'idle', iniPending: false }, actions: ['writeIni'] });
    r = stretchStep(r.state, { type: 'gameStart' }, o);
    expect(r.actions).toEqual(['saveNative', 'applyStretch', 'startWatchdog']);
    expect(r.state.phase).toBe('stretched');
    r = stretchStep(r.state, { type: 'gameExit' }, o);
    expect(r).toEqual({ state: { phase: 'idle', iniPending: false, native: undefined }, actions: ['restoreNative'] });
  });

  it('enable while Valorant runs: display now, ini queued for when it closes', () => {
    let r = stretchStep(off, { type: 'enable', gameRunning: true }, o);
    expect(r.state).toEqual({ phase: 'stretched', iniPending: true });
    expect(r.actions).toContain('applyStretch');
    expect(r.actions).not.toContain('writeIni');
    r = stretchStep(r.state, { type: 'gameExit' }, o);
    expect(r.actions).toEqual(['restoreNative', 'writeIni']);
  });

  it('crash: SexyVal starts with the desktop still stretched and no game -> restore native', () => {
    const r = stretchStep({ phase: 'idle', iniPending: false }, { type: 'startupCheck', desktopStretched: true, gameRunning: false }, o);
    expect(r.actions).toEqual(['restoreNative']);
    expect(stretchStep(off, { type: 'startupCheck', desktopStretched: true, gameRunning: false }, o).actions).toEqual(['restoreNative']);
    expect(stretchStep({ phase: 'idle', iniPending: false }, { type: 'startupCheck', desktopStretched: false, gameRunning: true }, o).state.phase).toBe('stretched');
  });

  it('disable restores the display and the ini from any state', () => {
    expect(stretchStep({ phase: 'stretched', iniPending: false }, { type: 'disable' }, o).actions).toEqual(['restoreNative', 'restoreIni']);
    expect(stretchStep({ phase: 'idle', iniPending: false }, { type: 'disable' }, o).actions).toEqual(['restoreIni']);
    expect(stretchStep(off, { type: 'disable' }, o).actions).toEqual([]);
  });

  it('native while alt-tabbed only when switched on', () => {
    const s: StretchState = { phase: 'stretched', iniPending: false };
    expect(stretchStep(s, { type: 'focusLost' }, o).actions).toEqual([]);
    const lost = stretchStep(s, { type: 'focusLost' }, { nativeOnAltTab: true });
    expect(lost).toEqual({ state: { phase: 'native-alt-tab', iniPending: false }, actions: ['restoreNative'] });
    expect(stretchStep(lost.state, { type: 'focusGained' }, { nativeOnAltTab: true }).actions).toEqual(['applyStretch']);
    // Exiting while alt-tabbed: already native, nothing to restore.
    expect(stretchStep(lost.state, { type: 'gameExit' }, { nativeOnAltTab: true }).actions).toEqual([]);
  });
});
