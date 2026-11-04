import type { Collector, CollectorContext } from "../types.js";

export interface ProcessMetricsCollectorOptions {
  /** Sampling interval in milliseconds, at least 1000. Defaults to 30 000. */
  intervalMs?: number;
  /** Event type. Defaults to `infra.process`. */
  type?: string;
}

/**
 * Opt-in collector that samples this process's memory and CPU usage. It runs
 * only when passed to `createWatch({ collectors })` or `registerCollector`, and
 * its timer is unref'd so it never keeps the process alive.
 */
export function processMetricsCollector(options: ProcessMetricsCollectorOptions = {}): Collector {
  const intervalMs = options.intervalMs ?? 30_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) {
    throw new RangeError("processMetricsCollector: intervalMs must be an integer of at least 1000");
  }
  const type = options.type ?? "infra.process";
  let timer: ReturnType<typeof setInterval> | undefined;

  function sample(context: CollectorContext): void {
    let memory: NodeJS.MemoryUsage;
    let cpu: NodeJS.CpuUsage;
    try {
      memory = process.memoryUsage();
      cpu = process.cpuUsage();
    } catch {
      return; // A failed sample is skipped; the next interval tries again.
    }
    void context.ingest({
      type,
      attributes: {
        pid: process.pid,
        uptime_s: process.uptime(),
        memory_rss: memory.rss,
        memory_heap_total: memory.heapTotal,
        memory_heap_used: memory.heapUsed,
        cpu_user_us: cpu.user,
        cpu_system_us: cpu.system,
      },
    });
  }

  return {
    name: "process-metrics",
    start(context) {
      if (timer) return;
      sample(context);
      timer = setInterval(() => sample(context), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
