import { describe, expect, it } from 'vitest';
import { WarpService, type RunResult } from '../main/services/warp';
import { isDaemonDown, parseScQuery, parseWarpStatus, WARP_DEFAULT_CLI, WARP_DOWNLOAD_URL, type WarpStatus } from '../shared/warp';

describe('shared/warp', () => {
  it('reads warp-cli status output', () => {
    expect(parseWarpStatus('Status update: Connected\r\nNetwork: healthy\r\n')).toBe('connected');
    expect(parseWarpStatus('Status update: Disconnected\nReason: Manual Disconnection')).toBe('disconnected');
    expect(parseWarpStatus('Status update: Connecting\nReason: Performing Captive Portal Check')).toBe('connecting');
    expect(parseWarpStatus('Status update: Unable\nReason: Registration Missing')).toBe('registration-missing');
    expect(parseWarpStatus('{\n  "status": "Connected",\n  "reason": "NetworkHealthy"\n}')).toBe('connected');
    expect(parseWarpStatus('Error: Unable to connect to the CloudflareWARP daemon: The system cannot find the file specified. (os error 2)')).toBe('service-down');
    expect(parseWarpStatus('something new')).toBe('error');
    expect(parseWarpStatus('')).toBe('error');
  });

  it('reads sc query', () => {
    expect(parseScQuery('SERVICE_NAME: CloudflareWARP\n        TYPE               : 10  WIN32_OWN_PROCESS\n        STATE              : 4  RUNNING')).toBe(true);
    expect(parseScQuery('        STATE              : 1  STOPPED')).toBe(false);
    expect(parseScQuery('[SC] EnumQueryServicesStatus:OpenService FAILED 1060:')).toBe(false);
    expect(parseScQuery('Access is denied.')).toBeNull();
  });

  it('spots a missing daemon', () => {
    expect(isDaemonDown('Error: Unable to connect to the CloudflareWARP daemon')).toBe(true);
    expect(isDaemonDown('Success')).toBe(false);
  });
});

/** A fake machine: warp-cli + sc + where, with the real tool's output shapes. */
function fakeMachine(o: { installed?: boolean; onPath?: boolean; registered?: boolean; svc?: boolean; connected?: boolean; connectError?: string } = {}) {
  const m = { installed: o.installed ?? true, onPath: o.onPath ?? false, registered: o.registered ?? true, svc: o.svc ?? true, connected: o.connected ?? false, settling: 0, calls: [] as string[] };
  const run = async (file: string, args: string[]): Promise<RunResult> => {
    const exe = file.split('\\').pop()!.toLowerCase();
    m.calls.push(`${exe} ${args.join(' ')}`);
    if (exe === 'where.exe') return m.installed && m.onPath ? { code: 0, out: 'C:\\tools\\warp-cli.exe\r\n' } : { code: 1, out: 'INFO: Could not find files for the given pattern(s).' };
    if (exe === 'sc.exe') return { code: 0, out: `STATE : ${m.svc ? '4  RUNNING' : '1  STOPPED'}` };
    if (!m.installed) return { code: -1, out: '', spawnError: 'not found' };
    if (!m.svc) return { code: 1, out: 'Error: Unable to connect to the CloudflareWARP daemon: The system cannot find the file specified. (os error 2)' };
    const cmd = args.filter((a) => !a.startsWith('--')).join(' ');
    if (cmd === 'status') {
      if (!m.registered) return { code: 0, out: 'Status update: Unable\nReason: Registration Missing' };
      if (m.settling > 0) {
        m.settling--;
        return { code: 0, out: 'Status update: Connecting\nReason: Checking' };
      }
      return { code: 0, out: m.connected ? 'Status update: Connected\nNetwork: healthy' : 'Status update: Disconnected\nReason: Manual Disconnection' };
    }
    if (cmd === 'registration new') {
      m.registered = true;
      return { code: 0, out: 'Success' };
    }
    if (cmd === 'connect') {
      if (o.connectError) return { code: 1, out: o.connectError };
      if (!m.registered) return { code: 1, out: 'Error: Registration Missing' };
      m.connected = true;
      m.settling = 2;
      return { code: 0, out: 'Success' };
    }
    if (cmd === 'disconnect') {
      m.connected = false;
      return { code: 0, out: 'Success' };
    }
    return { code: 1, out: `error: unrecognized subcommand '${cmd}'` };
  };
  return { m, run };
}

function service(machine: ReturnType<typeof fakeMachine>, extra: Partial<ConstructorParameters<typeof WarpService>[0]> = {}) {
  const events: WarpStatus[] = [];
  const paths = new Set(machine.m.installed ? [WARP_DEFAULT_CLI, 'C:\\tools\\warp-cli.exe'] : []);
  const w = new WarpService({ run: machine.run, exists: async (f) => machine.m.installed && paths.has(f), sleep: async () => undefined, onStatus: (s) => events.push(s), ...extra });
  return { w, events };
}

describe('WarpService', () => {
  it('reports not installed when neither PATH nor the default folder has warp-cli', async () => {
    const { w } = service(fakeMachine({ installed: false }));
    expect((await w.refresh()).phase).toBe('not-installed');
  });

  it('prefers warp-cli on PATH', async () => {
    const f = fakeMachine({ onPath: true });
    const { w } = service(f);
    await w.refresh();
    expect(f.m.calls).toContain('warp-cli.exe status');
    expect(await w.locate()).toBe('C:\\tools\\warp-cli.exe');
  });

  it('turns on and off, waiting for the tunnel to settle', async () => {
    const f = fakeMachine();
    const { w, events } = service(f);
    expect((await w.refresh()).phase).toBe('disconnected');
    const on = await w.set(true);
    expect(on.phase).toBe('connected');
    expect(on.busy).toBe(false);
    expect(on.error).toBeUndefined();
    expect(events.some((e) => e.busy)).toBe(true);
    expect((await w.set(false)).phase).toBe('disconnected');
  });

  it('registers once before the first connect', async () => {
    const f = fakeMachine({ registered: false });
    const { w } = service(f);
    expect((await w.refresh()).phase).toBe('registration-missing');
    expect((await w.set(true)).phase).toBe('connected');
    expect(f.m.calls.filter((c) => c.includes('registration new'))).toHaveLength(1);
    await w.set(false);
    await w.set(true);
    expect(f.m.calls.filter((c) => c.includes('registration new'))).toHaveLength(1);
  });

  it("says the service isn't running instead of offering a dead toggle", async () => {
    const f = fakeMachine({ svc: false });
    const { w } = service(f);
    const s = await w.refresh();
    expect(s.phase).toBe('service-down');
    expect(s.error).toMatch(/daemon/);
    expect((await w.set(true)).phase).toBe('service-down');
    expect(f.m.calls.some((c) => c.endsWith(' connect'))).toBe(false);
    f.m.svc = true;
    expect((await w.refresh()).phase).toBe('disconnected');
  });

  it("passes the CLI's own error text through", async () => {
    const { w } = service(fakeMachine({ connectError: 'Error: Settings are locked by your organization' }));
    const s = await w.set(true);
    expect(s.phase).toBe('disconnected');
    expect(s.error).toBe('Error: Settings are locked by your organization');
  });

  it('never shows a guessed state for output it cannot read', async () => {
    const f = fakeMachine();
    const run = async (file: string, args: string[]) => (args[0] === 'status' ? { code: 0, out: 'Status update: Sleeping' } : f.run(file, args));
    const { w } = service({ ...f, run });
    const s = await w.refresh();
    expect(s.phase).toBe('error');
    expect(s.error).toBe('Status update: Sleeping');
  });
});

describe('WarpService install', () => {
  const okFetch = (url = 'https://downloads.cloudflareclient.com/v1/download/windows/version/2026.8.2115.0', bytes = 1000) =>
    (async (input: any) => {
      expect(String(input)).toBe(WARP_DOWNLOAD_URL);
      const res = new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes), 'content-disposition': 'attachment; filename="Cloudflare_WARP_2026.8.2115.0.msi"' } });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as typeof fetch;

  it('downloads from Cloudflare, checks the signature, runs the installer, then sees the install', async () => {
    const f = fakeMachine({ installed: false });
    const launched: string[] = [];
    const { w, events } = service(f, {
      fetch: okFetch(),
      verify: async () => null,
      launch: async (file) => {
        launched.push(file);
        f.m.installed = true;
        return 0;
      },
      exists: async (p) => f.m.installed && p === WARP_DEFAULT_CLI,
    });
    expect((await w.refresh()).phase).toBe('not-installed');
    await w.refresh();
    const s = await w.installWarp();
    expect(launched[0]).toMatch(/Cloudflare_WARP_2026\.8\.2115\.0\.msi$/);
    expect(s?.phase).toBe('disconnected');
    expect(s?.install.stage).toBe('idle');
    expect(events.some((e) => e.install.stage === 'downloading')).toBe(true);
    expect(events.some((e) => e.install.stage === 'installing')).toBe(true);
  });

  it('refuses a redirect off the Cloudflare host', async () => {
    const launched: string[] = [];
    const { w } = service(fakeMachine({ installed: false }), { fetch: okFetch('https://mirror.example.com/warp.msi'), verify: async () => null, launch: async (f) => (launched.push(f), 0) });
    await w.refresh();
    const s = await w.installWarp();
    expect(s?.install.stage).toBe('error');
    expect(s?.install.error).toMatch(/mirror\.example\.com/);
    expect(launched).toHaveLength(0);
  });

  it('does not open an installer whose signature fails', async () => {
    const launched: string[] = [];
    const { w } = service(fakeMachine({ installed: false }), { fetch: okFetch(), verify: async () => 'bad signature', launch: async (f) => (launched.push(f), 0) });
    await w.refresh();
    const s = await w.installWarp();
    expect(s?.install).toMatchObject({ stage: 'error', error: 'bad signature' });
    expect(launched).toHaveLength(0);
  });

  it('says so when the install is cancelled', async () => {
    const { w } = service(fakeMachine({ installed: false }), { fetch: okFetch(), verify: async () => null, launch: async () => 1602 });
    await w.refresh();
    const s = await w.installWarp();
    expect(s?.install.error).toMatch(/cancelled/);
  });
});
