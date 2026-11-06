// Game boost: a small set of real, reversible Windows tweaks. Nothing here opens, reads or changes the
// Valorant process (Windows itself applies the CPU priority at launch). Every change is journaled with
// the original value before it is made, and reverted from that journal. Pure: command execution is
// injected (main/services/boost.ts runs reg/powercfg/sc, admin ones through the elevated helper task).

export type TweakId = 'quiet' | 'power' | 'searchPause' | 'doPause' | 'cpuPriority' | 'gpuPref' | 'gameMode' | 'gameDvrOff' | 'windowedOpt' | 'hags';

export interface TweakDef {
  id: TweakId;
  label: string;
  /** session = applied when Valorant starts, reverted when it exits; persistent = while switched on. */
  scope: 'session' | 'persistent';
  admin: boolean;
  /** Default when Boost is first turned on (the opt-in ones start off). */
  defaultOn: boolean;
  /** The only explanatory text the UI shows (HAGS needs a restart). */
  note?: string;
}

export const TWEAKS: TweakDef[] = [
  { id: 'quiet', label: 'SexyVal gets out of the way', scope: 'session', admin: false, defaultOn: true },
  { id: 'power', label: 'High performance power plan', scope: 'session', admin: false, defaultOn: true },
  { id: 'searchPause', label: 'Pause Windows Search indexing', scope: 'session', admin: true, defaultOn: false },
  { id: 'doPause', label: 'Pause update delivery optimization', scope: 'session', admin: true, defaultOn: false },
  { id: 'cpuPriority', label: 'High CPU priority for Valorant', scope: 'persistent', admin: true, defaultOn: true },
  { id: 'gpuPref', label: 'Use the high-performance GPU', scope: 'persistent', admin: false, defaultOn: true },
  { id: 'gameMode', label: 'Windows Game Mode', scope: 'persistent', admin: false, defaultOn: true },
  { id: 'gameDvrOff', label: 'Game Bar background recording off', scope: 'persistent', admin: false, defaultOn: true },
  { id: 'windowedOpt', label: 'Optimizations for windowed games', scope: 'persistent', admin: false, defaultOn: true },
  { id: 'hags', label: 'Hardware-accelerated GPU scheduling', scope: 'persistent', admin: true, defaultOn: false, note: 'takes effect after restart' },
];

export const tweak = (id: TweakId) => TWEAKS.find((t) => t.id === id)!;

export const VALORANT_EXE_NAME = 'VALORANT-Win64-Shipping.exe';
export const DEFAULT_VALORANT_EXE = 'C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe';
export const IFEO_KEY = `HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\${VALORANT_EXE_NAME}\\PerfOptions`;
export const HAGS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers';
export const GPU_PREF_KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
export const ULTIMATE = 'e9a42b02-d5df-448d-aa00-03f14749eb61';
export const HIGH_PERF = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';

export interface Cmd {
  exe: 'reg.exe' | 'powercfg.exe' | 'sc.exe';
  args: string[];
  admin: boolean;
}

export interface CmdResult {
  code: number;
  out: string;
}

/** A registry value; data null = the value doesn't exist. */
export interface RegValue {
  key: string;
  name: string;
  type: 'REG_DWORD' | 'REG_SZ';
  data: string | null;
}

export type Original = { kind: 'reg'; values: RegValue[] } | { kind: 'power'; scheme: string } | { kind: 'service'; name: string; wasRunning: boolean } | { kind: 'internal' };

export interface Journal {
  v: 1;
  applied: Partial<Record<TweakId, Original>>;
}

const admin = (key: string) => key.startsWith('HKLM');

export const regQuery = (key: string, name: string): Cmd => ({ exe: 'reg.exe', args: ['query', key, '/v', name], admin: admin(key) });

/** reg query output -> the value's type and data, or null when it isn't there. */
export function parseRegQuery(out: string, name: string): { type: string; data: string } | null {
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s{4}(REG_\w+)\s{4}(.*)$/.exec(line);
    if (m && m[1].toLowerCase() === name.toLowerCase()) {
      const data = m[2] === 'REG_DWORD' ? String(parseInt(m[3], 16)) : m[3];
      return { type: m[2], data };
    }
  }
  return null;
}

export function regSet(v: RegValue): Cmd {
  if (v.data == null) return { exe: 'reg.exe', args: ['delete', v.key, '/v', v.name, '/f'], admin: admin(v.key) };
  return { exe: 'reg.exe', args: ['add', v.key, '/v', v.name, '/t', v.type, '/d', v.data, '/f'], admin: admin(v.key) };
}

/** "SwapEffectUpgradeEnable=1;VRROptimizeEnable=0;" with one key set, others kept. */
export function setDxSetting(current: string | null, key: string, value: string): string {
  const parts = (current ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => p.split('=')[0] !== key);
  return [...parts, `${key}=${value}`].join(';') + ';';
}

/** Registry values a tweak sets. `current` lets merged string values (DirectX global settings) keep other flags. */
export function desiredValues(id: TweakId, ctx: { valorantExe: string; current: (key: string, name: string) => string | null }): RegValue[] {
  switch (id) {
    case 'cpuPriority':
      return [{ key: IFEO_KEY, name: 'CpuPriorityClass', type: 'REG_DWORD', data: '3' }];
    case 'gpuPref':
      return [{ key: GPU_PREF_KEY, name: ctx.valorantExe, type: 'REG_SZ', data: setDxSetting(ctx.current(GPU_PREF_KEY, ctx.valorantExe), 'GpuPreference', '2') }];
    case 'gameMode':
      return [
        { key: 'HKCU\\Software\\Microsoft\\GameBar', name: 'AutoGameModeEnabled', type: 'REG_DWORD', data: '1' },
        { key: 'HKCU\\Software\\Microsoft\\GameBar', name: 'AllowAutoGameMode', type: 'REG_DWORD', data: '1' },
      ];
    case 'gameDvrOff':
      return [
        { key: 'HKCU\\System\\GameConfigStore', name: 'GameDVR_Enabled', type: 'REG_DWORD', data: '0' },
        { key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR', name: 'AppCaptureEnabled', type: 'REG_DWORD', data: '0' },
      ];
    case 'windowedOpt':
      return [{ key: GPU_PREF_KEY, name: 'DirectXUserGlobalSettings', type: 'REG_SZ', data: setDxSetting(ctx.current(GPU_PREF_KEY, 'DirectXUserGlobalSettings'), 'SwapEffectUpgradeEnable', '1') }];
    case 'hags':
      return [{ key: HAGS_KEY, name: 'HwSchMode', type: 'REG_DWORD', data: '2' }];
    default:
      return [];
  }
}

export const SERVICE: Partial<Record<TweakId, string>> = { searchPause: 'WSearch', doPause: 'DoSvc' };

export function parseActiveScheme(out: string): string | null {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(out)?.[1].toLowerCase() ?? null;
}

/** Every scheme GUID in `powercfg /list`. */
export function parseSchemes(out: string): { guid: string; name: string }[] {
  return [...out.matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+\(([^)]*)\)/gi)].map((m) => ({ guid: m[1].toLowerCase(), name: m[2] }));
}

export const serviceRunning = (scQueryOut: string) => /STATE\s+:\s+\d+\s+RUNNING/i.test(scQueryOut);

export interface BoostDeps {
  run(cmds: Cmd[]): Promise<CmdResult[]>;
  loadJournal(): Promise<Journal>;
  saveJournal(j: Journal): Promise<void>;
  valorantExe(): string;
  /** 'quiet' is SexyVal's own behaviour, toggled in main. */
  setQuiet(on: boolean): void;
}

/**
 * Applies and reverts tweaks. The original value is written to the journal before the change, so a crash
 * mid-apply still reverts cleanly (session tweaks on the next start, everything on uninstall).
 */
export class BoostEngine {
  journal: Journal = { v: 1, applied: {} };
  constructor(private readonly d: BoostDeps) {}

  async load(): Promise<void> {
    const j = await this.d.loadJournal();
    this.journal = j && j.v === 1 && j.applied ? j : { v: 1, applied: {} };
  }

  isApplied(id: TweakId): boolean {
    return !!this.journal.applied[id];
  }

  private async one(cmd: Cmd): Promise<CmdResult> {
    return (await this.d.run([cmd]))[0] ?? { code: -1, out: '' };
  }

  private async readValues(values: { key: string; name: string; type: RegValue['type'] }[]): Promise<RegValue[]> {
    const res = await this.d.run(values.map((v) => regQuery(v.key, v.name)));
    return values.map((v, i) => ({ ...v, data: res[i]?.code === 0 ? (parseRegQuery(res[i].out, v.name)?.data ?? null) : null }));
  }

  async apply(id: TweakId): Promise<void> {
    if (this.isApplied(id)) return;
    if (id === 'quiet') {
      this.journal.applied.quiet = { kind: 'internal' };
      await this.d.saveJournal(this.journal);
      this.d.setQuiet(true);
      return;
    }
    if (id === 'power') {
      const active = parseActiveScheme((await this.one({ exe: 'powercfg.exe', args: ['/getactivescheme'], admin: false })).out);
      if (!active) throw new Error('could not read the active power plan');
      this.journal.applied.power = { kind: 'power', scheme: active };
      await this.d.saveJournal(this.journal);
      const schemes = parseSchemes((await this.one({ exe: 'powercfg.exe', args: ['/list'], admin: false })).out);
      let target = schemes.find((s) => s.guid === ULTIMATE)?.guid ?? schemes.find((s) => /ultimate/i.test(s.name))?.guid;
      if (!target) {
        // Create Ultimate Performance from its template; fall back to High performance if Windows refuses.
        const dup = await this.one({ exe: 'powercfg.exe', args: ['-duplicatescheme', ULTIMATE], admin: false });
        target = dup.code === 0 ? (parseActiveScheme(dup.out) ?? HIGH_PERF) : HIGH_PERF;
      }
      const set = await this.one({ exe: 'powercfg.exe', args: ['/setactive', target], admin: false });
      if (set.code !== 0 && target !== HIGH_PERF) await this.one({ exe: 'powercfg.exe', args: ['/setactive', HIGH_PERF], admin: false });
      return;
    }
    const svc = SERVICE[id];
    if (svc) {
      const wasRunning = serviceRunning((await this.one({ exe: 'sc.exe', args: ['query', svc], admin: true })).out);
      this.journal.applied[id] = { kind: 'service', name: svc, wasRunning };
      await this.d.saveJournal(this.journal);
      if (wasRunning) await this.one({ exe: 'sc.exe', args: ['stop', svc], admin: true });
      return;
    }
    const probe = desiredValues(id, { valorantExe: this.d.valorantExe(), current: () => null });
    const originals = await this.readValues(probe);
    const current = (key: string, name: string) => originals.find((o) => o.key === key && o.name === name)?.data ?? null;
    const want = desiredValues(id, { valorantExe: this.d.valorantExe(), current });
    this.journal.applied[id] = { kind: 'reg', values: originals };
    await this.d.saveJournal(this.journal);
    const res = await this.d.run(want.map(regSet));
    const failed = res.findIndex((r) => r.code !== 0);
    if (failed >= 0) throw new Error(`${tweak(id).label}: ${res[failed].out.trim().slice(0, 160) || `exit ${res[failed].code}`}`);
  }

  async revert(id: TweakId): Promise<void> {
    const o = this.journal.applied[id];
    if (!o) return;
    if (o.kind === 'internal') this.d.setQuiet(false);
    else if (o.kind === 'power') await this.one({ exe: 'powercfg.exe', args: ['/setactive', o.scheme], admin: false });
    else if (o.kind === 'service') {
      if (o.wasRunning) await this.one({ exe: 'sc.exe', args: ['start', o.name], admin: true });
    } else {
      const res = await this.d.run(o.values.map(regSet));
      const failed = res.findIndex((r) => r.code !== 0 && !/unable to find/i.test(r.out));
      if (failed >= 0) throw new Error(`revert ${tweak(id).label}: ${res[failed].out.trim().slice(0, 160)}`);
    }
    delete this.journal.applied[id];
    await this.d.saveJournal(this.journal);
  }

  async revertAll(scope?: TweakDef['scope']): Promise<string[]> {
    const errors: string[] = [];
    for (const id of Object.keys(this.journal.applied) as TweakId[]) {
      if (scope && tweak(id).scope !== scope) continue;
      await this.revert(id).catch((e) => errors.push((e as Error).message));
    }
    return errors;
  }
}

// ---------------- Valorant "Competitive FPS" preset ----------------

/**
 * [ScalabilityGroups] keys, verified on a real install (Nov 2026). 0 = Low / Off. Only these are written:
 * bloom, vignette, distortion and anisotropic filtering aren't in the local ini files on that install, so
 * they are left alone. Resolution, stretch and NVIDIA Reflex live in other keys and are never touched.
 */
export const PRESET_SECTION = '[ScalabilityGroups]';
export const COMPETITIVE_PRESET: Record<string, string> = {
  'sg.ViewDistanceQuality': '0',
  'sg.AntiAliasingQuality': '0',
  'sg.ShadowQuality': '0',
  'sg.GlobalIlluminationQuality': '0',
  'sg.ReflectionQuality': '0',
  'sg.PostProcessQuality': '0',
  'sg.TextureQuality': '0',
  'sg.EffectsQuality': '0',
  'sg.FoliageQuality': '0',
  'sg.ShadingQuality': '0',
};
