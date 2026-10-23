import { WatchFn } from "../core/watch-fn";

export interface AlertCondition {
  metric: string;
  operator: "gt" | "lt" | "eq" | "gte" | "lte";
  threshold: number;
  window: string;
  aggregation?: "avg" | "sum" | "count" | "min" | "max";
}

export interface AlertChannel {
  type: "email" | "slack" | "pagerduty" | "webhook";
  recipients?: string[];
  webhook?: string;
  integrationKey?: string;
  channel?: string;
}

export interface AlertConfig {
  name: string;
  description?: string;
  enabled?: boolean;
  condition: AlertCondition | any; // allow composite for now
  channels: AlertChannel[];
  severity?: "info" | "warning" | "error" | "critical";
  tags?: string[];
  autoResolve?: any;
}

export class AlertManager {
  private watch: WatchFn;
  private alerts: Map<string, AlertConfig & { id: string }> = new Map();
  private listeners: Map<string, Function[]> = new Map();

  constructor(watch: WatchFn) {
    this.watch = watch;
  }

  async create(config: AlertConfig) {
    const id = Math.random().toString(36).substring(7);
    this.alerts.set(id, { ...config, id, enabled: config.enabled ?? true });
    return { id, ...config };
  }

  async list(filter?: { status?: string }) {
      return Array.from(this.alerts.values());
  }

  onTrigger(cb: (alert: any, context: any) => void) {
      this.addListener("trigger", cb);
  }

  onResolve(cb: (alert: any, context: any) => void) {
      this.addListener("resolve", cb);
  }

  private addListener(event: string, cb: Function) {
      if (!this.listeners.has(event)) {
          this.listeners.set(event, []);
      }
      this.listeners.get(event)!.push(cb);
  }

  // Stub for manually triggering an alert (for testing/simulation)
  async trigger(id: string, context: any) {
      const alert = this.alerts.get(id);
      if (alert) {
          const callbacks = this.listeners.get("trigger") || [];
          callbacks.forEach(cb => cb(alert, context));
      }
  }

  async resolve(id: string, context: any) {
      const alert = this.alerts.get(id);
      if (alert) {
          const callbacks = this.listeners.get("resolve") || [];
          callbacks.forEach(cb => cb(alert, context));
      }
  }

  async acknowledge(id: string, data: any) {
      // Stub
  }
  
  async addNote(id: string, note: any) {
      // Stub
  }
}
