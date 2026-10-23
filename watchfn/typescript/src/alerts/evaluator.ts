/** Alert evaluator engine. */

import { AlertCondition, ConditionEvaluator } from "./conditions";

export interface Alert {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  condition: AlertCondition;
  severity: "info" | "warning" | "critical";
  channels: string[];
  state: "normal" | "triggered";
  triggeredAt?: number;
  lastEvaluated?: number;
  consecutiveFailures: number;
}

export interface EvaluationResult {
  alert: Alert;
  triggered: boolean;
  value?: number;
  timestamp: number;
  message?: string;
}

export class AlertEvaluator {
  private conditionEvaluator: ConditionEvaluator;
  private alerts: Map<string, Alert> = new Map();

  constructor() {
    this.conditionEvaluator = new ConditionEvaluator();
  }

  /**
   * Register an alert
   */
  register(alert: Alert): void {
    this.alerts.set(alert.id, {
      ...alert,
      state: "normal",
      consecutiveFailures: 0,
    });
  }

  /**
   * Evaluate all alerts
   */
  evaluateAll(data: Map<string, any[]>): EvaluationResult[] {
    const results: EvaluationResult[] = [];

    for (const alert of this.alerts.values()) {
      if (!alert.enabled) continue;

      const result = this.evaluate(alert, data);
      results.push(result);
    }

    return results;
  }

  /**
   * Evaluate a single alert
   */
  evaluate(alert: Alert, data: Map<string, any[]>): EvaluationResult {
    const timestamp = Date.now();
    
    // Get relevant data for this alert
    const alertData = this.getAlertData(alert, data);
    
    // Evaluate condition
    const triggered = this.conditionEvaluator.evaluate(alert.condition, alertData);

    // Update alert state
    if (triggered) {
      alert.consecutiveFailures++;
      if (alert.state === "normal") {
        alert.state = "triggered";
        alert.triggeredAt = timestamp;
      }
    } else {
      alert.consecutiveFailures = 0;
      if (alert.state === "triggered") {
        alert.state = "normal";
        delete alert.triggeredAt;
      }
    }

    alert.lastEvaluated = timestamp;

    return {
      alert,
      triggered,
      timestamp,
      message: triggered ? `Alert ${alert.name} triggered` : undefined,
    };
  }

  /**
   * Get alert configuration
   */
  get(id: string): Alert | undefined {
    return this.alerts.get(id);
  }

  /**
   * Get all alerts
   */
  getAll(): Alert[] {
    return Array.from(this.alerts.values());
  }

  /**
   * Get triggered alerts
   */
  getTriggered(): Alert[] {
    return Array.from(this.alerts.values()).filter((a) => a.state === "triggered");
  }

  /**
   * Disable an alert
   */
  disable(id: string): void {
    const alert = this.alerts.get(id);
    if (alert) {
      alert.enabled = false;
    }
  }

  /**
   * Enable an alert
   */
  enable(id: string): void {
    const alert = this.alerts.get(id);
    if (alert) {
      alert.enabled = true;
    }
  }

  /**
   * Remove an alert
   */
  remove(id: string): void {
    this.alerts.delete(id);
  }

  private getAlertData(alert: Alert, allData: Map<string, any[]>): any[] {
    // Extract metric name from condition
    const metric = this.extractMetric(alert.condition);
    return allData.get(metric) || [];
  }

  private extractMetric(condition: AlertCondition): string {
    if (condition.type === "threshold" || condition.type === "anomaly") {
      return condition.metric;
    } else if (condition.type === "composite") {
      // For composite conditions, return the first metric found
      for (const c of condition.conditions) {
        const metric = this.extractMetric(c);
        if (metric) return metric;
      }
    }
    return "";
  }
}
