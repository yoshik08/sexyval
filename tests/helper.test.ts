// helper/stretch.exe in --dry-run: reads display modes, never changes them, and the elevated command
// runner refuses anything outside its allow-list. Skipped where the helper isn't built (non-Windows CI).
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exe = path.join(__dirname, '..', 'helper', 'stretch.exe');
const run = (...args: string[]) => JSON.parse(execFileSync(exe, args, { encoding: 'utf8' }).trim().split(/\r?\n/).pop()!);

describe.skipIf(!fs.existsSync(exe))('helper/stretch.exe --dry-run', () => {
  it('lists monitors and their modes', () => {
    const r = run('list', '--dry-run');
    expect(r.ok).toBe(true);
    expect(r.monitors.length).toBeGreaterThan(0);
    expect(r.monitors[0].modes.length).toBeGreaterThan(0);
  });

  it('apply in dry run reports what it would do and leaves the display alone', () => {
    const before = run('list').monitors[0];
    const r = run('apply', before.device, '1280', '960', String(before.current.hz), '--dry-run');
    expect(r).toMatchObject({ ok: true, dryRun: true, wanted: { w: 1280, h: 960, fixedOutput: 1 } });
    expect(run('list').monitors[0].current).toEqual(before.current);
  });

  it('the elevated runner only accepts its allow-list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sexyval-helper-'));
    const cmd = path.join(dir, 'cmd.txt');
    const res = path.join(dir, 'res.txt');
    const t = '\t';
    fs.writeFileSync(
      cmd,
      [
        `reg.exe${t}add${t}HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\VALORANT-Win64-Shipping.exe\\PerfOptions${t}/v${t}CpuPriorityClass${t}/t${t}REG_DWORD${t}/d${t}3${t}/f`,
        `reg.exe${t}add${t}HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run${t}/v${t}x${t}/d${t}calc${t}/f`,
        `reg.exe${t}add${t}HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers${t}/v${t}HwSchMode${t}/t${t}REG_SZ${t}/d${t}2${t}/f`,
        `cmd.exe${t}/c${t}whoami`,
        `sc.exe${t}stop${t}WSearch`,
        `sc.exe${t}stop${t}WinDefend`,
        `schtasks.exe${t}/Delete${t}/TN${t}SexyVal\\Helper${t}/F`,
        `schtasks.exe${t}/Create${t}/TN${t}x`,
      ].join('\r\n'),
    );
    execFileSync(exe, ['run', cmd, res, '--dry-run']);
    const codes = fs.readFileSync(res, 'utf8').trim().split(/\r?\n/).map((l) => Number(l.split('\t')[0]));
    expect(codes).toEqual([0, -1, -1, -1, 0, -1, 0, -1]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
