/** Alert evaluator engine. */

import { AlertCondition, ConditionEvaluator, validateAlertCondition, type AlertMetricPoint } from "./conditions";

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
  /** False when observations cannot establish either a breach or recovery. */
  observed: boolean;
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
    validateAlertCondition(alert.condition);
    this.alerts.set(alert.id, {
      ...alert,
      state: "normal",
      consecutiveFailures: 0,
    });
  }

  /**
   * Evaluate all alerts
   */
  evaluateAll(data: ReadonlyMap<string, readonly AlertMetricPoint[]>, now = Date.now()): EvaluationResult[] {
    const results: EvaluationResult[] = [];

    for (const alert of this.alerts.values()) {
      if (!alert.enabled) continue;

      const result = this.evaluate(alert, data, now);
      results.push(result);
    }

    return results;
  }

  /**
   * Evaluate a single alert
   */
  evaluate(alert: Alert, data: ReadonlyMap<string, readonly AlertMetricPoint[]>, timestamp = Date.now()): EvaluationResult {
    const result = this.conditionEvaluator.evaluateResult(alert.condition, data, timestamp);
    const triggered = result.matched === true;

    // Update alert state
    if (triggered) {
      alert.consecutiveFailures++;
      if (alert.state === "normal") {
        alert.state = "triggered";
        alert.triggeredAt = timestamp;
      }
    } else if (result.matched === false) {
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
      value: result.value,
      observed: result.matched !== null,
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

}
