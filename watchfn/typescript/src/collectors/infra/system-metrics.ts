import * as os from "os";
import { WatchFn } from "../../core/watch-fn";

export class SystemMetricsCollector {
  private watch: WatchFn;
  private interval: NodeJS.Timeout | null = null;
  private intervalMs: number = 30000; // 30s default

  constructor(watch: WatchFn, intervalMs?: number) {
    this.watch = watch;
    if (intervalMs) this.intervalMs = intervalMs;
  }

  start() {
    if (this.interval) return;
    this.collect(); // Collect immediately
    this.interval = setInterval(() => this.collect(), this.intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async collect() {
    try {
      const cpuUsage = this.getCpuUsage();
      const freeMem = os.freemem();
      const totalMem = os.totalmem();
      const memUsage = ((totalMem - freeMem) / totalMem) * 100;

      this.watch.track("infra.system", {
        cpu_usage: cpuUsage,
        memory_usage: memUsage,
        memory_free: freeMem,
        memory_total: totalMem,
        uptime: os.uptime(),
        load_avg: os.loadavg(), // [1m, 5m, 15m]
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
      });
    } catch (e) {
      // suppress errors during collection
    }
  }

  private getCpuUsage(): number {
    const cpus = os.cpus();
    if (!cpus || cpus.length === 0) return 0;

    // Simple snapshot-based calculation might not be accurate for instantaneous load
    // without comparing previous snapshot. 
    // For now, calculating average across cores based on 'times' since boot is not 'current usage'.
    // A better approach for 'current usage' requires delta between two reads.
    // Implementing a simplified version here, or relying on loadavg which is standard on unix.
    
    // Using loadavg[0] (1 minute average) normalized by core count is a common proxy
    const load = os.loadavg()[0];
    return (load / cpus.length) * 100;
  }
}
