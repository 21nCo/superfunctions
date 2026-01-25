/**
 * Monitoring and health check system for FlowFn
 */

export interface HealthStatus {
  healthy: boolean;
  timestamp: number;
  checks: HealthCheck[];
  details?: Record<string, any>;
}

export interface HealthCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  message?: string;
  responseTime?: number;
  details?: Record<string, any>;
}

export interface MonitoringMetrics {
  // Queue metrics
  queues?: {
    [queueName: string]: {
      waiting: number;
      active: number;
      completed: number;
      failed: number;
      delayed: number;
      throughput: number; // jobs/min
      avgDuration: number; // ms
      errorRate: number; // %
    };
  };

  // Stream metrics
  streams?: {
    [streamName: string]: {
      messageCount: number;
      publishRate: number; // msgs/sec
      consumerCount: number;
      lag: number;
    };
  };

  // Workflow metrics
  workflows?: {
    [workflowName: string]: {
      totalExecutions: number;
      running: number;
      completed: number;
      failed: number;
      successRate: number;
      avgDuration: number;
    };
  };

  // System metrics
  system?: {
    uptime: number;
    memoryUsage: number;
    cpuUsage?: number;
  };
}

export interface HealthChecker {
  /**
   * Perform health check
   */
  check(): Promise<HealthStatus>;

  /**
   * Add custom health check
   */
  addCheck(name: string, checker: () => Promise<HealthCheck>): void;

  /**
   * Remove health check
   */
  removeCheck(name: string): void;
}

/**
 * Health checker implementation
 */
export class HealthCheckerImpl implements HealthChecker {
  private checks: Map<string, () => Promise<HealthCheck>> = new Map();
  private startTime = Date.now();

  constructor() {
    // Add default system checks
    this.addCheck("uptime", async () => ({
      name: "uptime",
      status: "pass",
      responseTime: 0,
      details: {
        uptime: Date.now() - this.startTime,
        startTime: this.startTime,
      },
    }));

    this.addCheck("memory", async () => {
      if (typeof process !== "undefined" && process.memoryUsage) {
        const mem = process.memoryUsage();
        const usedMB = mem.heapUsed / 1024 / 1024;
        const totalMB = mem.heapTotal / 1024 / 1024;
        const usagePercent = (usedMB / totalMB) * 100;

        return {
          name: "memory",
          status: usagePercent > 90 ? "warn" : "pass",
          message: usagePercent > 90 ? "High memory usage" : undefined,
          responseTime: 0,
          details: {
            heapUsedMB: Math.round(usedMB),
            heapTotalMB: Math.round(totalMB),
            usagePercent: Math.round(usagePercent),
          },
        };
      }

      return {
        name: "memory",
        status: "pass",
        responseTime: 0,
      };
    });
  }

  addCheck(name: string, checker: () => Promise<HealthCheck>): void {
    this.checks.set(name, checker);
  }

  removeCheck(name: string): void {
    this.checks.delete(name);
  }

  async check(): Promise<HealthStatus> {
    const results: HealthCheck[] = [];
    let allHealthy = true;

    for (const [name, checker] of this.checks.entries()) {
      try {
        const start = Date.now();
        const result = await checker();
        result.responseTime = Date.now() - start;
        results.push(result);

        if (result.status === "fail") {
          allHealthy = false;
        }
      } catch (error) {
        results.push({
          name,
          status: "fail",
          message: (error as Error).message,
          responseTime: 0,
        });
        allHealthy = false;
      }
    }

    return {
      healthy: allHealthy,
      timestamp: Date.now(),
      checks: results,
    };
  }
}

/**
 * Event tracking for monitoring
 */
export interface TrackedEvent {
  id: string;
  type: string;
  category: "queue" | "stream" | "workflow" | "system";
  severity: "info" | "warn" | "error";
  message: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface EventTracker {
  /**
   * Track an event
   */
  track(event: Omit<TrackedEvent, "id" | "timestamp">): void;

  /**
   * Get events
   */
  getEvents(filter?: {
    category?: string;
    severity?: string;
    since?: number;
    limit?: number;
  }): TrackedEvent[];

  /**
   * Clear old events
   */
  cleanup(maxAge: number): number;
}

export class MemoryEventTracker implements EventTracker {
  private events: TrackedEvent[] = [];
  private maxEvents = 10000;

  track(event: Omit<TrackedEvent, "id" | "timestamp">): void {
    const trackedEvent: TrackedEvent = {
      ...event,
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      timestamp: Date.now(),
    };

    this.events.push(trackedEvent);

    // Trim if exceeds max
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }

  getEvents(filter?: {
    category?: string;
    severity?: string;
    since?: number;
    limit?: number;
  }): TrackedEvent[] {
    let filtered = [...this.events];

    if (filter?.category) {
      filtered = filtered.filter((e) => e.category === filter.category);
    }

    if (filter?.severity) {
      filtered = filtered.filter((e) => e.severity === filter.severity);
    }

    if (filter?.since !== undefined) {
      filtered = filtered.filter((e) => e.timestamp >= filter.since!);
    }

    if (filter?.limit) {
      filtered = filtered.slice(-filter.limit);
    }

    return filtered;
  }

  cleanup(maxAge: number): number {
    const now = Date.now();
    const before = this.events.length;
    this.events = this.events.filter((e) => now - e.timestamp <= maxAge);
    return before - this.events.length;
  }

  clear(): void {
    this.events = [];
  }
}
