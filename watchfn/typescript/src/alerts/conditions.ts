/** Windowed alert conditions. Missing observations are distinct from a healthy measurement. */
export type ConditionOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne';
export interface ThresholdCondition {
  type?: 'threshold'; metric: string; operator: ConditionOperator; threshold: number;
  window: string; aggregation?: 'avg' | 'sum' | 'min' | 'max' | 'count';
}
export interface AnomalyCondition {
  type: 'anomaly'; metric: string; sensitivity: number; minDataPoints: number;
  algorithm: 'moving-average' | 'stddev';
}
export interface CompositeCondition {
  type: 'composite'; operator: 'and' | 'or'; conditions: AlertCondition[];
}
export type AlertCondition = ThresholdCondition | AnomalyCondition | CompositeCondition;
export interface AlertMetricPoint { value: number; timestamp: number; metric?: string }
export type AlertMetricData = ReadonlyMap<string, readonly AlertMetricPoint[]> | readonly AlertMetricPoint[];
export interface ConditionResult { matched: boolean | null; value?: number; dataPoints: number }

export function alertWindowMs(window: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(window);
  const value = match ? Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]] ?? 0) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Alert window must be a positive finite duration');
  return value;
}
export function validateAlertCondition(condition: AlertCondition): void {
  let nodes = 0;
  const visit = (value: AlertCondition, depth: number) => {
    if (!value || typeof value !== 'object' || ++nodes > 128 || depth > 16) throw new TypeError('Invalid or excessively nested alert condition');
    if (value.type === 'composite') {
      if (!['and', 'or'].includes(value.operator) || !Array.isArray(value.conditions) || !value.conditions.length) throw new TypeError('Composite alerts require an operator and conditions');
      for (const child of value.conditions) visit(child, depth + 1);
      return;
    }
    if (typeof value.metric !== 'string' || !value.metric.trim() || value.metric.length > 255) throw new TypeError('Alert metric is required');
    if (value.type === 'anomaly') {
      if (!Number.isFinite(value.sensitivity) || value.sensitivity < 0 || value.sensitivity > 1 || !Number.isSafeInteger(value.minDataPoints) || value.minDataPoints < 2 || !['moving-average', 'stddev'].includes(value.algorithm)) throw new TypeError('Invalid anomaly condition');
    } else {
      if (value.type !== undefined && value.type !== 'threshold') throw new TypeError('Unsupported alert condition');
      if (!Number.isFinite(value.threshold) || !['gt', 'gte', 'lt', 'lte', 'eq', 'ne'].includes(value.operator) || (value.aggregation !== undefined && !['avg', 'sum', 'min', 'max', 'count'].includes(value.aggregation))) throw new TypeError('Invalid threshold condition');
      alertWindowMs(value.window);
    }
  };
  visit(condition, 0);
}
export class ConditionEvaluator {
  evaluate(condition: AlertCondition, data: AlertMetricData, now = Date.now()): boolean {
    return this.evaluateResult(condition, data, now).matched === true;
  }
  evaluateResult(condition: AlertCondition, data: AlertMetricData, now = Date.now(), windows?: ReadonlyMap<string, readonly AlertMetricPoint[]>): ConditionResult {
    validateAlertCondition(condition);
    if (!Number.isFinite(now)) throw new TypeError('Evaluation time must be finite');
    const unlabelledMetric = condition.type === 'composite' ? undefined : condition.metric;
    const evaluate = (rule: AlertCondition): ConditionResult => {
      if (rule.type === 'composite') {
        const results = rule.conditions.map(evaluate);
        const matches = results.map(result => result.matched);
        const matched = rule.operator === 'and'
          ? matches.includes(false) ? false : matches.includes(null) ? null : true
          : matches.includes(true) ? true : matches.includes(null) ? null : false;
        return { matched, dataPoints: results.reduce((count, result) => count + result.dataPoints, 0) };
      }
      const cutoff = rule.type === 'anomaly' ? -Infinity : now - alertWindowMs(rule.window);
      const raw: readonly AlertMetricPoint[] = windows
        ? windows.get(JSON.stringify([rule.metric, rule.type === 'anomaly' ? null : cutoff])) ?? []
        : Array.isArray(data) ? data : (data as ReadonlyMap<string, readonly AlertMetricPoint[]>).get(rule.metric) ?? [];
      const points = raw.filter(point => point && Number.isFinite(point.value) && Number.isFinite(point.timestamp) && point.timestamp >= cutoff && point.timestamp <= now &&
        (Array.isArray(data) ? (point.metric ?? unlabelledMetric) === rule.metric : point.metric === undefined || point.metric === rule.metric));
      if (!points.length) return { matched: null, dataPoints: 0 };
      let value: number;
      if (rule.type === 'anomaly') {
        if (points.length < rule.minDataPoints) return { matched: null, dataPoints: points.length };
        points.sort((a, b) => a.timestamp - b.timestamp);
        value = points[points.length - 1].value;
        const history = points.slice(0, -1);
        const mean = history.reduce((sum, point) => sum + point.value / history.length, 0);
        const delta = Math.abs(value - mean);
        if (!Number.isFinite(mean) || !Number.isFinite(delta)) return { matched: null, dataPoints: points.length };
        // Floating-point mean rounding is not an observation of an anomaly.
        const scale = history.reduce((max, point) => Math.max(max, Math.abs(point.value)), Math.abs(value));
        if (delta <= Number.EPSILON * scale * 8) return { matched: false, value, dataPoints: points.length };
        let matched: boolean;
        if (rule.algorithm === 'moving-average') matched = mean === 0 ? delta > 0 : delta / Math.abs(mean) > 1 - rule.sensitivity;
        else {
          const variance = history.reduce((sum, point) => sum + (point.value - mean) ** 2 / history.length, 0);
          if (!Number.isFinite(variance)) return { matched: null, dataPoints: points.length };
          matched = variance === 0 ? delta > 0 : delta / Math.sqrt(variance) > 3 - rule.sensitivity * 2;
        }
        return { matched, value, dataPoints: points.length };
      }
      switch (rule.aggregation ?? 'avg') {
        case 'avg': value = points.reduce((sum, point) => sum + point.value / points.length, 0); break;
        case 'sum': value = points.reduce((sum, point) => sum + point.value, 0); break;
        case 'min': value = points.reduce((min, point) => Math.min(min, point.value), Infinity); break;
        case 'max': value = points.reduce((max, point) => Math.max(max, point.value), -Infinity); break;
        case 'count': value = points.length; break;
      }
      if (!Number.isFinite(value)) return { matched: null, dataPoints: points.length };
      const matched = ({ gt: value > rule.threshold, gte: value >= rule.threshold, lt: value < rule.threshold, lte: value <= rule.threshold, eq: value === rule.threshold, ne: value !== rule.threshold })[rule.operator];
      return { matched, value, dataPoints: points.length };
    };
    return evaluate(condition);
  }
}
