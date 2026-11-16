// Reproducible lightweight-mode measurement (Phoenix F10).
//
//   npm run build:main && npm run build:renderer && node scripts/perf-measure.mjs [seconds=90]
//
// Starts the mock build twice (same mock data; the mock cycles menus → queue → agent select → match, so the live loop is busy), once with
// lightweight mode forced off and once forced on, each in its own temporary data folder. Electron's
// app.getAppMetrics() is sampled every 5 s (SEXYVAL_PERF_LOG). The first 20 s of each run are dropped
// (startup), then the median CPU % and median working-set MB over all SexyVal processes are printed.
// The window is shown inactive (it doesn't take focus) because a hidden window would hide renderer cost.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron');
const secs = Number(process.argv[2]) || 90;

function run(mode) {
  return new Promise((resolve) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `sv-perf-${mode}-`));
    const log = path.join(dir, 'perf.jsonl');
    const env = { ...process.env, MOCK: '1', SEXYVAL_PERF_MODE: mode, SEXYVAL_PERF_LOG: log, SEXYVAL_USER_DATA: dir, SEXYVAL_SHOW_INACTIVE: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, ['.'], { env, stdio: 'ignore' });
    setTimeout(() => {
      child.kill();
      setTimeout(() => {
        const rows = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
        const t0 = rows[0]?.at ?? 0;
        resolve(rows.filter((r) => r.at - t0 >= 20_000));
      }, 1500);
    }, secs * 1000);
  });
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

const out = {};
for (const mode of ['normal', 'always']) {
  const rows = await run(mode);
  out[mode] = { samples: rows.length, cpuMedian: median(rows.map((r) => r.cpuPercent)), memMedianMB: median(rows.map((r) => r.memoryMB)), processes: rows.at(-1)?.processes, lite: rows.at(-1)?.mode };
}
console.log(JSON.stringify({ seconds: secs, node: process.version, platform: `${os.platform()} ${os.release()}`, cpus: os.cpus()[0]?.model, ...out }, null, 2));
