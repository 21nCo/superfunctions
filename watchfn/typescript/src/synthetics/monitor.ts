"""Synthetic monitor manager."""

import { HttpCheck, HttpCheckConfig } from "./http-check";
import { MonitorScheduler } from "./scheduler";

export type MonitorType = "http" | "browser";
export type MonitorStatus = "active" | "paused" | "error";

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
  private scheduler: MonitorScheduler;

  constructor() {
    this.scheduler = new MonitorScheduler();
  }

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
      this.scheduler.cancel(id);
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
    this.scheduler.cancel(id);
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
    const check = new HttpCheck(monitor.config);

    this.scheduler.schedule(monitor.id, monitor.interval, async () => {
      try {
        const result = await check.execute();
        
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

        return result;
      } catch (error) {
        monitor.status = "error";
        monitor.lastResult = {
          success: false,
          duration: 0,
          timestamp: Date.now(),
          error: (error as Error).message,
        };
        throw error;
      }
    });
  }

  private generateId(): string {
    return `mon_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }
}
