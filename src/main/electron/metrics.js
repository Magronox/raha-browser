// The metrics port: per-process memory/CPU from Chromium, normalized to the
// units the engine speaks (MB, percent). ProcessMetric.memory.workingSetSize
// is documented in KILOBYTES; cpu.percentCPUUsage is percent of a single core
// since the previous getAppMetrics() call.
import { app } from 'electron';

/** @returns {{ sample: () => Array<{ pid: number, memMB: number, cpuPct: number }> }} */
export function createMetricsPort() {
  return {
    sample() {
      /** @type {Array<{ pid: number, memMB: number, cpuPct: number }>} */
      const out = [];
      try {
        for (const m of app.getAppMetrics()) {
          // Only renderer ("Tab") processes can host our tabs.
          if (m.type !== 'Tab') continue;
          out.push({
            pid: m.pid,
            memMB: Math.round((m.memory?.workingSetSize ?? 0) / 1024),
            cpuPct: Math.round((m.cpu?.percentCPUUsage ?? 0) * 10) / 10,
          });
        }
      } catch {
        // Metrics are best-effort; the governor treats missing data as null.
      }
      return out;
    },
  };
}
