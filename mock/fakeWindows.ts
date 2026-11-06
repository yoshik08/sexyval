// A pretend Windows for mock mode and tests: registry, power plans and services, driven by the same
// reg / powercfg / sc commands Boost runs for real. Nothing here touches the machine.
import { GPU_PREF_KEY, HIGH_PERF, ULTIMATE, type Cmd, type CmdResult } from '../shared/boost';

export const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';

export function fakeWindows(opts: { ultimate?: boolean; denyAdmin?: boolean } = {}) {
  const reg = new Map<string, { type: string; data: string }>();
  reg.set(`${GPU_PREF_KEY}|DirectXUserGlobalSettings`, { type: 'REG_SZ', data: 'VRROptimizeEnable=0;' });
  reg.set('HKCU\\Software\\Microsoft\\GameBar|AutoGameModeEnabled', { type: 'REG_DWORD', data: '0' });
  reg.set('HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers|HwSchMode', { type: 'REG_DWORD', data: '1' });
  const schemes = [
    { guid: BALANCED, name: 'Balanced' },
    { guid: HIGH_PERF, name: 'High performance' },
  ];
  if (opts.ultimate) schemes.push({ guid: ULTIMATE, name: 'Ultimate Performance' });
  const services: Record<string, boolean> = { WSearch: true, DoSvc: false };
  const sys = { reg, schemes, active: BALANCED, services, log: [] as string[] };
  const exec = (c: Cmd): CmdResult => {
    sys.log.push(`${c.exe} ${c.args.join(' ')}`);
    if (c.admin && opts.denyAdmin) return { code: 5, out: 'ERROR: Access is denied.' };
    const [verb, ...a] = c.args;
    if (c.exe === 'reg.exe') {
      const k = `${a[0]}|${a[2]}`;
      if (verb === 'query') {
        const v = reg.get(k);
        return v ? { code: 0, out: `\r\n${a[0]}\r\n    ${a[2]}    ${v.type}    ${v.type === 'REG_DWORD' ? `0x${Number(v.data).toString(16)}` : v.data}\r\n` } : { code: 1, out: 'ERROR: The system was unable to find the specified registry key or value.' };
      }
      if (verb === 'add') {
        reg.set(k, { type: a[4], data: a[6] });
        return { code: 0, out: 'The operation completed successfully.' };
      }
      if (verb === 'delete') return reg.delete(k) ? { code: 0, out: '' } : { code: 1, out: 'ERROR: The system was unable to find the specified registry key or value.' };
    }
    if (c.exe === 'powercfg.exe') {
      if (verb === '/getactivescheme') return { code: 0, out: `Power Scheme GUID: ${sys.active}  (x)` };
      if (verb === '/list') return { code: 0, out: schemes.map((s) => `Power Scheme GUID: ${s.guid}  (${s.name})`).join('\r\n') };
      if (verb === '-duplicatescheme') {
        const guid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        schemes.push({ guid, name: 'Ultimate Performance' });
        return { code: 0, out: `Power Scheme GUID: ${guid}  (Ultimate Performance)` };
      }
      if (verb === '/setactive') {
        if (!schemes.some((s) => s.guid === a[0])) return { code: 1, out: 'Invalid' };
        sys.active = a[0];
        return { code: 0, out: '' };
      }
    }
    if (c.exe === 'sc.exe') {
      if (verb === 'query') return { code: 0, out: `STATE              : ${services[a[0]] ? '4  RUNNING' : '1  STOPPED'}` };
      if (verb === 'stop' || verb === 'start') {
        services[a[0]] = verb === 'start';
        return { code: 0, out: '' };
      }
    }
    return { code: 1, out: 'unknown' };
  };
  const run = async (cmds: Cmd[]): Promise<CmdResult[]> => cmds.map(exec);
  return { sys, run };
}
