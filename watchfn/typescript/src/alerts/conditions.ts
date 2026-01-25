"""Alert condition types and evaluation."""

export type ConditionOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "ne";

export interface ThresholdCondition {
  type: "threshold";
  metric: string;
  operator: ConditionOperator;
  threshold: number;
  window: string; // e.g., "5m", "1h"
  aggregation?: "avg" | "sum" | "min" | "max" | "count";
}

export interface AnomalyCondition {
  type: "anomaly";
  metric: string;
  sensitivity: number; // 0-1
  minDataPoints: number;
  algorithm: "moving-average" | "stddev";
}

export interface CompositeCondition {
  type: "composite";
  operator: "and" | "or";
  conditions: AlertCondition[];
}

export type AlertCondition = ThresholdCondition | AnomalyCondition | CompositeCondition;

export class ConditionEvaluator {
  /**
   * Evaluate an alert condition
   */
  evaluate(condition: AlertCondition, data: any[]): boolean {
    switch (condition.type) {
      case "threshold":
        return this.evaluateThreshold(condition, data);
      case "anomaly":
        return this.evaluateAnomaly(condition, data);
      case "composite":
        return this.evaluateComposite(condition, data);
      default:
        return false;
    }
  }

  private evaluateThreshold(condition: ThresholdCondition, data: any[]): boolean {
    if (data.length === 0) return false;

    const values = data.map((d) => d.value);
    let value: number;

    switch (condition.aggregation || "avg") {
      case "avg":
        value = values.reduce((sum, v) => sum + v, 0) / values.length;
        break;
      case "sum":
        value = values.reduce((sum, v) => sum + v, 0);
        break;
      case "min":
        value = Math.min(...values);
        break;
      case "max":
        value = Math.max(...values);
        break;
      case "count":
        value = values.length;
        break;
      default:
        value = 0;
    }

    return this.compareValue(value, condition.operator, condition.threshold);
  }

  private evaluateAnomaly(condition: AnomalyCondition, data: any[]): boolean {
    if (data.length < condition.minDataPoints) {
      return false;
    }

    const values = data.map((d) => d.value);
    const currentValue = values[values.length - 1];

    if (condition.algorithm === "moving-average") {
      return this.detectMovingAverageAnomaly(values, currentValue, condition.sensitivity);
    } else if (condition.algorithm === "stddev") {
      return this.detectStdDevAnomaly(values, currentValue, condition.sensitivity);
    }

    return false;
  }

  private evaluateComposite(condition: CompositeCondition, data: any[]): boolean {
    const results = condition.conditions.map((c) => this.evaluate(c, data));

    if (condition.operator === "and") {
      return results.every((r) => r);
    } else {
      return results.some((r) => r);
    }
  }

  private compareValue(value: number, operator: ConditionOperator, threshold: number): boolean {
    switch (operator) {
      case "gt":
        return value > threshold;
      case "gte":
        return value >= threshold;
      case "lt":
        return value < threshold;
      case "lte":
        return value <= threshold;
      case "eq":
        return value === threshold;
      case "ne":
        return value !== threshold;
      default:
        return false;
    }
  }

  private detectMovingAverageAnomaly(values: number[], currentValue: number, sensitivity: number): boolean {
    // Calculate moving average (excluding current value)
    const historicalValues = values.slice(0, -1);
    const avg = historicalValues.reduce((sum, v) => sum + v, 0) / historicalValues.length;

    // Calculate deviation percentage
    const deviation = Math.abs(currentValue - avg) / avg;

    // Sensitivity: 1.0 = very sensitive (trigger on small deviations)
    const threshold = 1 - sensitivity;

    return deviation > threshold;
  }

  private detectStdDevAnomaly(values: number[], currentValue: number, sensitivity: number): boolean {
    const historicalValues = values.slice(0, -1);
    const mean = historicalValues.reduce((sum, v) => sum + v, 0) / historicalValues.length;

    const squaredDiffs = historicalValues.map((v) => Math.pow(v - mean, 2));
    const variance = squaredDiffs.reduce((sum, v) => sum + v, 0) / historicalValues.length;
    const stdDev = Math.sqrt(variance);

    // Number of standard deviations from mean
    const zScore = Math.abs(currentValue - mean) / stdDev;

    // Sensitivity maps to z-score threshold (higher sensitivity = lower threshold)
    const threshold = 3 - sensitivity * 2; // Range: 1 to 3 standard deviations

    return zScore > threshold;
  }
}
