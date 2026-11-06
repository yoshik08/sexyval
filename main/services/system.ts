import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Cmd, CmdResult } from '../../shared/boost';
import { VALORANT_EXE_NAME } from '../../shared/boost';
import { log } from '../log';

const sys32 = (exe: string) => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe);

function exec(file: string, args: string[], timeoutMs = 20_000): Promise<CmdResult> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });
}

/**
 * Watches for VALORANT-Win64-Shipping.exe by polling the process list (tasklist), not the Riot API.
 * Opens no handle to the game. In mock mode the mock's phase stands in for the process.
 */
export class GameWatcher {
  running = false;
  private timer: NodeJS.Timeout | null = null;
  private listeners: ((running: boolean) => void)[] = [];

  constructor(private readonly probe: () => Promise<boolean> = GameWatcher.tasklist) {}

  static async tasklist(): Promise<boolean> {
    const r = await exec(sys32('tasklist.exe'), ['/FI', `IMAGENAME eq ${VALORANT_EXE_NAME}`, '/NH', '/FO', 'CSV'], 8000);
    return r.out.toLowerCase().includes(VALORANT_EXE_NAME.toLowerCase());
  }

  on(fn: (running: boolean) => void): void {
    this.listeners.push(fn);
  }

  async check(): Promise<boolean> {
    const now = await this.probe().catch(() => this.running);
    if (now !== this.running) {
      this.running = now;
      log.info(`Valorant process ${now ? 'started' : 'exited'}`);
      for (const l of this.listeners) l(now);
    }
    return now;
  }

  start(everyMs = 2000): void {
    if (this.timer) return;
    const tick = () => void this.check().finally(() => (this.timer = setTimeout(tick, everyMs)));
    tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** helper/stretch.exe (display modes, foreground window, watchdog, allow-listed elevated runner). */
export class HelperClient {
  constructor(
    readonly exe: string,
    readonly dryRun: boolean,
  ) {}

  async call<T = any>(args: string[]): Promise<T> {
    const r = await exec(this.exe, this.dryRun ? [...args, '--dry-run'] : args, 15_000);
    const line = r.out.trim().split(/\r?\n/).pop() ?? '';
    try {
      return JSON.parse(line) as T;
    } catch {
      throw new Error(`helper: ${r.out.trim().slice(0, 200) || `exit ${r.code}`}`);
    }
  }

  /** Detached: outlives SexyVal and restores native if SexyVal dies while stretched. */
  watchdog(stateFile: string): void {
    if (this.dryRun) return;
    const p = spawn(this.exe, ['watchdog', String(process.pid), stateFile], { detached: true, stdio: 'ignore', windowsHide: true });
    p.unref();
  }
}

export const TASK_NAME = 'SexyVal\\Helper';

/**
 * Admin-only Boost steps go through one elevated Windows Scheduled Task, registered once (the only UAC
 * prompt). After that SexyVal writes the commands to a file and triggers the task with no prompt; the
 * helper runs only an allow-list of reg / sc / schtasks commands from that file.
 */
export class ElevatedRunner {
  constructor(
    private readonly helper: HelperClient,
    private readonly dir: string,
  ) {}

  private get cmdFile() {
    return path.join(this.dir, 'elevated-commands.txt');
  }
  private get resultFile() {
    return path.join(this.dir, 'elevated-result.txt');
  }

  async ready(): Promise<boolean> {
    return (await exec(sys32('schtasks.exe'), ['/Query', '/TN', TASK_NAME])).code === 0;
  }

  /** Registers the task (one UAC prompt). Returns false if the user said no. */
  async ensure(): Promise<boolean> {
    if (await this.ready()) return true;
    await fs.mkdir(this.dir, { recursive: true });
    const user = `${process.env.USERDOMAIN ?? os.hostname()}\\${process.env.USERNAME ?? os.userInfo().username}`;
    const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>SexyVal: applies and reverts Boost tweaks that need admin. Created once by SexyVal; removed on uninstall.</Description></RegistrationInfo>
  <Principals><Principal id="Author"><UserId>${xmlEsc(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>Queue</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT2M</ExecutionTimeLimit><Hidden>true</Hidden></Settings>
  <Actions Context="Author"><Exec><Command>${xmlEsc(this.helper.exe)}</Command><Arguments>${xmlEsc(`run "${this.cmdFile}" "${this.resultFile}"`)}</Arguments></Exec></Actions>
</Task>`;
    const xmlFile = path.join(this.dir, 'task.xml');
    await fs.writeFile(xmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
    // Start-Process -Verb RunAs is the UAC prompt; -Wait so we know when it's done.
    const ps = `Start-Process -FilePath '${sys32('schtasks.exe')}' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('/Create','/TN','${TASK_NAME}','/XML','"${xmlFile}"','/F')`;
    await exec(sys32('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', ps], 120_000);
    await fs.rm(xmlFile, { force: true });
    return this.ready();
  }

  async run(cmds: Cmd[]): Promise<CmdResult[]> {
    if (!cmds.length) return [];
    if (!(await this.ensure())) return cmds.map(() => ({ code: 5, out: 'Admin permission was not granted' }));
    await fs.writeFile(this.cmdFile, cmds.map((c) => [c.exe, ...c.args].join('\t')).join('\r\n'));
    await fs.rm(this.resultFile, { force: true });
    await exec(sys32('schtasks.exe'), ['/Run', '/TN', TASK_NAME]);
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const text = await fs.readFile(this.resultFile, 'utf8').catch(() => null);
      if (text == null) continue;
      await fs.rm(this.cmdFile, { force: true });
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => {
          const [code, b64] = l.split('\t');
          return { code: Number(code), out: Buffer.from(b64 ?? '', 'base64').toString('utf8') };
        });
    }
    return cmds.map(() => ({ code: -1, out: 'The elevated helper did not answer' }));
  }

  /** Uninstall: the task deletes itself from inside its own elevated run. */
  async remove(): Promise<void> {
    if (!(await this.ready())) return;
    await fs.writeFile(this.cmdFile, ['schtasks.exe', '/Delete', '/TN', TASK_NAME, '/F'].join('\t'));
    await fs.rm(this.resultFile, { force: true });
    await exec(sys32('schtasks.exe'), ['/Run', '/TN', TASK_NAME]);
    for (let i = 0; i < 50 && (await this.ready()); i++) await new Promise((r) => setTimeout(r, 200));
  }
}

/** reg / powercfg / sc: normal ones run directly, admin ones through the elevated task. */
export function realRunner(elevated: ElevatedRunner): (cmds: Cmd[]) => Promise<CmdResult[]> {
  return async (cmds) => {
    const out: CmdResult[] = new Array(cmds.length);
    const adminIdx = cmds.map((c, i) => (c.admin ? i : -1)).filter((i) => i >= 0);
    for (const [i, c] of cmds.entries()) if (!c.admin) out[i] = await exec(sys32(c.exe), c.args);
    if (adminIdx.length) {
      const res = await elevated.run(adminIdx.map((i) => cmds[i]));
      adminIdx.forEach((i, k) => (out[i] = res[k] ?? { code: -1, out: 'no result' }));
    }
    return out;
  };
}
