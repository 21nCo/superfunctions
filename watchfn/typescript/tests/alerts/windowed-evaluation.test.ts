import { expect, it } from 'vitest';
import { ConditionEvaluator, type ThresholdCondition } from '../../src/alerts/conditions';
import { AlertEvaluator, type Alert } from '../../src/alerts/evaluator';
const now = 1_000_000;
const threshold = (metric: string): ThresholdCondition => ({ type: 'threshold', metric, operator: 'gt', threshold: 80, window: '5m' });
const alert = (condition: Alert['condition']): Alert => ({ id: 'test', name: 'test', enabled: true, condition, severity: 'warning', channels: [], state: 'normal', consecutiveFailures: 0 });
it('excludes expired, future and nonfinite metric samples from the declared window', () => {
  const evaluator = new ConditionEvaluator();
  expect(evaluator.evaluate(threshold('cpu'), [{ value: 1000, timestamp: now - 300001 }, { value: 1000, timestamp: now + 1 }, { value: 20, timestamp: now }], now)).toBe(false);
  expect(evaluator.evaluate(threshold('cpu'), [{ value: Infinity, timestamp: now }, { value: 90, timestamp: now }], now)).toBe(true);
});
it('uses each composite metric independently instead of reusing the first metric', () => {
  const evaluator = new AlertEvaluator();
  const rule = alert({ type: 'composite', operator: 'and', conditions: [threshold('cpu'), threshold('memory')] });
  const data = new Map([['cpu', [{ value: 90, timestamp: now }]], ['memory', [{ value: 10, timestamp: now }]]]);
  expect(evaluator.evaluate(rule, data, now).triggered).toBe(false);
});
it('retains triggered state on missing data instead of reporting recovery', () => {
  const evaluator = new AlertEvaluator();
  const rule = alert(threshold('cpu'));
  evaluator.evaluate(rule, new Map([['cpu', [{ value: 90, timestamp: now }]]]), now);
  expect(rule.state).toBe('triggered');
  const missing = evaluator.evaluate(rule, new Map(), now + 1);
  expect(missing.observed).toBe(false);
  expect(rule.state).toBe('triggered');
});
it('does not assign unlabeled composite samples by array position', () => {
  expect(new ConditionEvaluator().evaluate({ type: 'composite', operator: 'and', conditions: [threshold('cpu'), threshold('memory')] }, [{ value: 90, timestamp: now }, { value: 95, timestamp: now }], now)).toBe(false);
});
it('accepts the specification threshold shorthand and inclusive window boundaries', () => {
  const evaluator = new ConditionEvaluator();
  const { type: _, ...rule } = threshold('cpu');
  expect(evaluator.evaluateResult(rule, [{ value: 90, timestamp: now - 300000 }], now)).toEqual({ matched: true, value: 90, dataPoints: 1 });
  expect(evaluator.evaluateResult(rule, [{ value: 90, timestamp: now - 300001 }], now).matched).toBe(null);
});
it('uses three-valued composite logic and does not confuse unknown with healthy', () => {
  const evaluator = new ConditionEvaluator();
  const data = new Map([['cpu', [{ value: 90, timestamp: now }]]]);
  const rules = [threshold('cpu'), { type: 'composite' as const, operator: 'or' as const, conditions: [threshold('memory')] }];
  expect(evaluator.evaluateResult({ type: 'composite', operator: 'and', conditions: rules }, data, now).matched).toBe(null);
  expect(evaluator.evaluateResult({ type: 'composite', operator: 'or', conditions: rules }, data, now).matched).toBe(true);
});
it('sorts anomaly samples by timestamp and handles zero or negative baselines', () => {
  const evaluator = new ConditionEvaluator();
  for (const algorithm of ['moving-average', 'stddev'] as const) {
    const rule = { type: 'anomaly' as const, metric: 'cpu', algorithm, sensitivity: 0.8, minDataPoints: 3 };
    expect(evaluator.evaluate(rule, [{ value: 50, timestamp: now }, { value: 0, timestamp: now - 2 }, { value: 0, timestamp: now - 1 }], now)).toBe(true);
    expect(evaluator.evaluate(rule, [{ value: 0, timestamp: now }, { value: 0, timestamp: now - 1 }, { value: 0, timestamp: now - 2 }], now)).toBe(false);
    expect(evaluator.evaluate(rule, [{ value: -50, timestamp: now }, { value: -100, timestamp: now - 2 }, { value: -100, timestamp: now - 1 }], now)).toBe(true);
  }
});
it('rejects invalid configuration instead of silently reporting normal', () => {
  const evaluator = new ConditionEvaluator();
  for (const window of ['0m', '-1m', 'forever', '999999999999999999999d']) expect(() => evaluator.evaluate({ ...threshold('cpu'), window }, [], now)).toThrow();
  expect(() => evaluator.evaluate({ type: 'composite', operator: 'and', conditions: [] }, [], now)).toThrow();
  const cyclic = { type: 'composite' as const, operator: 'and' as const, conditions: [] as any[] }; cyclic.conditions.push(cyclic);
  expect(() => evaluator.evaluate(cyclic, [], now)).toThrow(/nested/);
});
it('does not treat numeric aggregation overflow as a threshold observation', () => {
  const evaluator = new ConditionEvaluator();
  expect(evaluator.evaluateResult({ ...threshold('cpu'), aggregation: 'sum' }, [{ value: Number.MAX_VALUE, timestamp: now }, { value: Number.MAX_VALUE, timestamp: now }], now).matched).toBe(null);
});

it('does not flag constant decimal samples at maximum anomaly sensitivity', () => {
  for (const algorithm of ['moving-average', 'stddev'] as const) {
    expect(new ConditionEvaluator().evaluate({ type: 'anomaly', metric: 'cpu', algorithm, sensitivity: 1, minDataPoints: 2 }, Array.from({ length: 7 }, (_, timestamp) => ({ value: 0.1, timestamp })), 100)).toBe(false);
  }
});
