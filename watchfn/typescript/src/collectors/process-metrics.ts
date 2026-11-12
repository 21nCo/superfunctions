import type { Collector, CollectorContext } from "../types.js";
import { validateType } from "../validation.js";

/** Largest delay Node and browsers accept for a timer; larger values fire after 1 ms. */
const MAX_INTERVAL_MS = 2_147_483_647;

export interface ProcessMetricsCollectorOptions {
  /** Sampling interval in milliseconds, from 1000 to 2147483647 (about 24.8 days). Defaults to 30 000. */
  intervalMs?: number;
  /** Event type, following the same rules as `ingest`. Defaults to `infra.process`. */
  type?: string;
}

/**
 * Opt-in collector that samples this process's memory and CPU usage. It runs
 * only when passed to `createWatch({ collectors })` or `registerCollector`, and
 * its timer is unref'd so it never keeps the process alive.
 */
export function processMetricsCollector(options: ProcessMetricsCollectorOptions = {}): Collector {
  const intervalMs = options.intervalMs ?? 30_000;
  // Timers clamp delays above 2^31 - 1 ms to 1 ms, so a larger interval would sample continuously.
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > MAX_INTERVAL_MS) {
    throw new RangeError(`processMetricsCollector: intervalMs must be an integer from 1000 to ${MAX_INTERVAL_MS}`);
  }
  const type = options.type ?? "infra.process";
  // An invalid type would fail every sample, so reject it here like an invalid interval.
  const issues: string[] = [];
  if (!validateType(type, "type", issues)) throw new TypeError(`processMetricsCollector: ${issues[0]}`);
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
