import { describe, it, expect, beforeEach } from 'vitest';
import { SegmentEvaluator } from '../core/segments';
import { Segment } from '../types';

describe('SegmentEvaluator', () => {
  let evaluator: SegmentEvaluator;

  beforeEach(() => {
    evaluator = new SegmentEvaluator();
  });

  it('matches simple equality rule', () => {
    const segment: Segment = {
      id: 'seg1',
      name: 'Test',
      rules: [{ id: 'r1', field: 'plan', operator: 'equals', value: 'pro' }]
    };
    evaluator.setSegments([segment]);

    expect(evaluator.evaluate('seg1', { plan: 'pro' })).toBe(true);
    expect(evaluator.evaluate('seg1', { plan: 'free' })).toBe(false);
  });

  it('matches regex', () => {
    const segment: Segment = {
      id: 'seg2',
      name: 'Test Regex',
      rules: [{ id: 'r2', field: 'email', operator: 'regex', value: '^.*@company\.com$' }]
    };
    evaluator.setSegments([segment]);

    expect(evaluator.evaluate('seg2', { email: 'bob@company.com' })).toBe(true);
    expect(evaluator.evaluate('seg2', { email: 'bob@gmail.com' })).toBe(false);
  });

  it('matches numeric comparisons', () => {
    const segment: Segment = {
      id: 'seg3',
      name: 'Test Numeric',
      rules: [{ id: 'r3', field: 'age', operator: 'gte', value: 18 }]
    };
    evaluator.setSegments([segment]);
    
    expect(evaluator.evaluate('seg3', { age: 20 })).toBe(true);
    expect(evaluator.evaluate('seg3', { age: 10 })).toBe(false);
  });
});
