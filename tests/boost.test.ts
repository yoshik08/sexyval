import { describe, expect, it } from 'vitest';
import { BoostEngine, COMPETITIVE_PRESET, GPU_PREF_KEY, IFEO_KEY, PRESET_SECTION, parseRegQuery, setDxSetting, TWEAKS, ULTIMATE, type Journal, type TweakId } from '../shared/boost';
import { readIniKeys, setIniKeys } from '../shared/stretch';
import { BALANCED, fakeWindows } from '../mock/fakeWindows';

const EXE = 'C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe';

function engine(w = fakeWindows(), journal: { j: Journal } = { j: { v: 1, applied: {} } }) {
  const quiet: boolean[] = [];
  const e = new BoostEngine({
    run: w.run,
    loadJournal: async () => structuredClone(journal.j),
    saveJournal: async (j) => void (journal.j = structuredClone(j)),
    valorantExe: () => EXE,
    setQuiet: (on) => quiet.push(on),
  });
  return { e, w, journal, quiet };
}

const snapshot = (w: ReturnType<typeof fakeWindows>) => JSON.stringify({ reg: [...w.sys.reg.entries()].sort(), active: w.sys.active, services: w.sys.services });

describe('shared/boost', () => {
  it('parses reg query output', () => {
    expect(parseRegQuery('\r\nHKEY_LOCAL\r\n    CpuPriorityClass    REG_DWORD    0x3\r\n', 'CpuPriorityClass')).toEqual({ type: 'REG_DWORD', data: '3' });
    expect(parseRegQuery(`\r\nHKCU\\x\r\n    ${EXE}    REG_SZ    GpuPreference=2;\r\n`, EXE)).toEqual({ type: 'REG_SZ', data: 'GpuPreference=2;' });
    expect(parseRegQuery('ERROR: unable to find', 'x')).toBeNull();
  });

  it('merges DirectX settings strings', () => {
    expect(setDxSetting('VRROptimizeEnable=0;', 'SwapEffectUpgradeEnable', '1')).toBe('VRROptimizeEnable=0;SwapEffectUpgradeEnable=1;');
    expect(setDxSetting('SwapEffectUpgradeEnable=0;', 'SwapEffectUpgradeEnable', '1')).toBe('SwapEffectUpgradeEnable=1;');
    expect(setDxSetting(null, 'GpuPreference', '2')).toBe('GpuPreference=2;');
  });

  it('apply then revert every tweak returns Windows exactly to where it was', async () => {
    const { e, w, quiet } = engine();
    const before = snapshot(w);
    for (const t of TWEAKS) await e.apply(t.id);
    expect(w.sys.reg.get(`${IFEO_KEY}|CpuPriorityClass`)?.data).toBe('3');
    expect(w.sys.reg.get(`${GPU_PREF_KEY}|${EXE}`)?.data).toBe('GpuPreference=2;');
    expect(w.sys.reg.get(`${GPU_PREF_KEY}|DirectXUserGlobalSettings`)?.data).toBe('VRROptimizeEnable=0;SwapEffectUpgradeEnable=1;');
    expect(w.sys.reg.get('HKCU\\System\\GameConfigStore|GameDVR_Enabled')?.data).toBe('0');
    expect(w.sys.services.WSearch).toBe(false);
    expect(w.sys.active).not.toBe(BALANCED);
    expect(quiet).toEqual([true]);
    expect(snapshot(w)).not.toBe(before);
    expect(await e.revertAll()).toEqual([]);
    expect(snapshot(w)).toBe(before);
    expect(quiet).toEqual([true, false]);
    expect(e.journal.applied).toEqual({});
  });

  it('power plan: uses Ultimate when present, creates it when missing, restores the user plan', async () => {
    const a = engine(fakeWindows({ ultimate: true }));
    await a.e.apply('power');
    expect(a.w.sys.active).toBe(ULTIMATE);
    await a.e.revert('power');
    expect(a.w.sys.active).toBe(BALANCED);
    const b = engine();
    await b.e.apply('power');
    expect(b.w.sys.log).toContain(`powercfg.exe -duplicatescheme ${ULTIMATE}`);
    expect(b.w.sys.active).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('services: only ones that were running are stopped, and only those are started again', async () => {
    const { e, w } = engine();
    await e.apply('searchPause');
    await e.apply('doPause');
    expect(w.sys.log.filter((l) => l.startsWith('sc.exe stop'))).toEqual(['sc.exe stop WSearch']);
    await e.revertAll('session');
    expect(w.sys.services).toEqual({ WSearch: true, DoSvc: false });
  });

  it('crash path: the journal is written before the change, so a restart reverts session tweaks', async () => {
    const journal = { j: { v: 1, applied: {} } as Journal };
    const first = engine(fakeWindows(), journal);
    const before = snapshot(first.w);
    await first.e.apply('power');
    await first.e.apply('searchPause');
    await first.e.apply('gameMode');
    // SexyVal dies here. Next start: same Windows, journal read back from disk.
    const second = engine(first.w, journal);
    await second.e.load();
    expect(Object.keys(second.e.journal.applied).sort()).toEqual(['gameMode', 'power', 'searchPause']);
    await second.e.revertAll('session');
    expect(first.w.sys.active).toBe(BALANCED);
    expect(first.w.sys.services.WSearch).toBe(true);
    expect(second.e.isApplied('gameMode')).toBe(true); // persistent stays until switched off
    // Uninstall: everything goes back.
    await second.e.revertAll();
    expect(snapshot(first.w)).toBe(before);
  });

  it('admin refused: the failure surfaces and the journal still allows a clean revert', async () => {
    const { e, w } = engine(fakeWindows({ denyAdmin: true }));
    await expect(e.apply('cpuPriority')).rejects.toThrow(/Access is denied/);
    expect(w.sys.reg.has(`${IFEO_KEY}|CpuPriorityClass`)).toBe(false);
  });

  it('does nothing twice', async () => {
    const { e, w } = engine();
    await e.apply('gpuPref');
    const n = w.sys.log.length;
    await e.apply('gpuPref');
    expect(w.sys.log.length).toBe(n);
    await e.revert('gpuPref' as TweakId);
    expect(w.sys.reg.has(`${GPU_PREF_KEY}|${EXE}`)).toBe(false);
  });

  it('Competitive FPS preset only writes [ScalabilityGroups]', () => {
    const ini = '[/Script/ShooterGame.ShooterGameUserSettings]\r\nResolutionSizeX=1440\r\n\r\n[ScalabilityGroups]\r\nsg.ShadowQuality=3\r\nsg.TextureQuality=1\r\n';
    const out = setIniKeys(ini, PRESET_SECTION, COMPETITIVE_PRESET);
    expect(readIniKeys(out, PRESET_SECTION)).toMatchObject({ 'sg.ShadowQuality': '0', 'sg.TextureQuality': '0', 'sg.AntiAliasingQuality': '0' });
    expect(readIniKeys(out, '[/Script/ShooterGame.ShooterGameUserSettings]')).toEqual({ ResolutionSizeX: '1440' });
  });
});
