import { app } from 'electron';
import { appendFile } from 'node:fs/promises';
export { liteActive } from '../../shared/perf';

/**
 * CPU and memory of every SexyVal process (main, renderer, GPU, utility), from Electron's own
 * app.getAppMetrics(). Used by Settings > Performance and by scripts/perf-measure.mjs, which compares
 * normal and lightweight runs of the mock build (SEXYVAL_PERF_LOG=<file> writes one sample every 5 s).
 */
export class PerfSampler {
  sample(): Promise<{ cpuPercent: number; memoryMB: number; processes: number; at: number }> {
    const m = app.getAppMetrics();
    // percentCPUUsage is since the previous call; the first call after a long gap is still a fair average.
    const cpu = m.reduce((s, p) => s + (p.cpu?.percentCPUUsage ?? 0), 0);
    const mem = m.reduce((s, p) => s + (p.memory?.workingSetSize ?? 0), 0) / 1024;
    return Promise.resolve({ cpuPercent: Math.round(cpu * 10) / 10, memoryMB: Math.round(mem), processes: m.length, at: Date.now() });
  }

  /** Dev/measurement only. */
  startLog(file: string, label: () => string): void {
    setInterval(() => {
      void this.sample().then((s) => appendFile(file, JSON.stringify({ ...s, mode: label() }) + '\n').catch(() => undefined));
    }, 5_000).unref?.();
  }
}
