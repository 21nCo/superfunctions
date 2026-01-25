import { WatchFn } from "../../core/watch-fn";

export class ProcessMetricsCollector {
  private watch: WatchFn;
  private interval: NodeJS.Timeout | null = null;
  private intervalMs: number = 30000;

  constructor(watch: WatchFn, intervalMs?: number) {
    this.watch = watch;
    if (intervalMs) this.intervalMs = intervalMs;
  }

  start() {
    if (this.interval) return;
    this.collect();
    this.interval = setInterval(() => this.collect(), this.intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private collect() {
    try {
      const memUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage(); // Returns usage since process start
      
      // To get % we'd need delta. For now reporting raw values.
      
      this.watch.track("infra.process", {
        pid: process.pid,
        uptime: process.uptime(),
        memory_rss: memUsage.rss,
        memory_heap_total: memUsage.heapTotal,
        memory_heap_used: memUsage.heapUsed,
        cpu_user: cpuUsage.user,
        cpu_system: cpuUsage.system,
      });
    } catch (e) {
      // suppress
    }
  }
}
