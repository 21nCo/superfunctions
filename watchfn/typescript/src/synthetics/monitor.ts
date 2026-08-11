/** Synthetic monitor manager. */

import { HttpCheckRunner } from "./http-check";
import type { SyntheticCheck } from "./types";

export type MonitorType = "http" | "browser";
export type MonitorStatus = "active" | "paused" | "error";
export type HttpCheckConfig = Omit<SyntheticCheck, "id" | "name" | "type" | "interval">;

export interface Monitor {
  id: string;
  name: string;
  type: MonitorType;
  status: MonitorStatus;
  config: HttpCheckConfig; // | BrowserCheckConfig in future
  interval: number; // ms
  lastRun?: number;
  lastResult?: {
    success: boolean;
    duration: number;
    timestamp: number;
    error?: string;
  };
}

export class MonitorManager {
  private monitors: Map<string, Monitor> = new Map();
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private httpRunner = new HttpCheckRunner();

  /**
   * Create a new monitor
   */
  create(config: {
    name: string;
    type: MonitorType;
    config: HttpCheckConfig;
    interval: number;
  }): Monitor {
    const monitor: Monitor = {
      id: this.generateId(),
      name: config.name,
      type: config.type,
      status: "active",
      config: config.config,
      interval: config.interval,
    };

    this.monitors.set(monitor.id, monitor);

    // Schedule the monitor
    if (monitor.type === "http") {
      this.scheduleHttpMonitor(monitor);
    }

    return monitor;
  }

  /**
   * Get a monitor by ID
   */
  get(id: string): Monitor | undefined {
    return this.monitors.get(id);
  }

  /**
   * Get all monitors
   */
  getAll(): Monitor[] {
    return Array.from(this.monitors.values());
  }

  /**
   * Pause a monitor
   */
  pause(id: string): void {
    const monitor = this.monitors.get(id);
    if (monitor) {
      monitor.status = "paused";
      this.cancel(id);
    }
  }

  /**
   * Resume a monitor
   */
  resume(id: string): void {
    const monitor = this.monitors.get(id);
    if (monitor && monitor.status === "paused") {
      monitor.status = "active";
      
      if (monitor.type === "http") {
        this.scheduleHttpMonitor(monitor);
      }
    }
  }

  /**
   * Delete a monitor
   */
  delete(id: string): void {
    this.cancel(id);
    this.monitors.delete(id);
  }

  /**
   * Get monitor uptime percentage
   */
  getUptime(id: string, from: number, to: number): number {
    // This would query historical results from storage
    // Placeholder implementation
    return 99.9;
  }

  private scheduleHttpMonitor(monitor: Monitor): void {
    this.cancel(monitor.id);
    const run = async () => {
      try {
        const result = await this.httpRunner.run({
          ...monitor.config,
          id: monitor.id,
          name: monitor.name,
          type: "http",
          interval: monitor.interval,
        });
        
        monitor.lastRun = Date.now();
        monitor.lastResult = {
          success: result.success,
          duration: result.duration,
          timestamp: result.timestamp,
          error: result.error,
        };

        if (!result.success) {
          monitor.status = "error";
        } else if (monitor.status === "error") {
          monitor.status = "active";
        }

      } catch (error) {
        monitor.status = "error";
        monitor.lastResult = {
          success: false,
          duration: 0,
          timestamp: Date.now(),
          error: (error as Error).message,
        };
      }
    };

    this.timers.set(monitor.id, setInterval(() => void run(), monitor.interval));
    void run();
  }

  private cancel(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
  }

  private generateId(): string {
    return `mon_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }
}
