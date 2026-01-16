import { describe, it, expect, beforeEach } from 'vitest';
import { FlagEvaluator } from '../core/flags';
import { SegmentEvaluator } from '../core/segments';
import { FlagConfig } from '../types';

const MOCK_FLAGS: FlagConfig[] = [
  {
    key: 'feature-A',
    defaultValue: false,
    enabled: true,
    rules: [
      {
        id: 'rule-1',
        constraints: [
          { id: 'c1', field: 'email', operator: 'contains', value: '@test.com' }
        ],
        variationId: 'on'
      }
    ],
    variations: [
      { id: 'on', value: true },
      { id: 'off', value: false },
    ],
  },
  {
    key: 'feature-rollout',
    defaultValue: 'control',
    enabled: true,
    rules: [
      {
        id: 'rule-2',
        rolloutPercentage: 50,
        variationId: 'treatment'
      }
    ],
    variations: [
      { id: 'treatment', value: 'treatment' },
      { id: 'control', value: 'control' }
    ]
  }
];

describe('FlagEvaluator', () => {
  let evaluator: FlagEvaluator;
  let segments: SegmentEvaluator;

  beforeEach(() => {
    segments = new SegmentEvaluator();
    evaluator = new FlagEvaluator(MOCK_FLAGS, segments);
  });

  it('should return variation if rule constraints match', () => {
    const user = { id: 'u1', traits: { email: 'bob@test.com' } };
    expect(evaluator.getFlag('feature-A', false, user)).toBe(true);
  });

  it('should return default if rule constraints do not match', () => {
    const user = { id: 'u2', traits: { email: 'bob@gmail.com' } };
    expect(evaluator.getFlag('feature-A', false, user)).toBe(false);
  });

  it('should handle rollouts deterministically', () => {
    // User 1 might be treatment, User 2 might be control depending on hash
    // We rely on hash stability. 
    // "feature-rollout:user-123" -> hash -> bucket
    const userA = { id: 'user-123', traits: {} };
    const valA = evaluator.getFlag('feature-rollout', 'control', userA);
    
    // Check same user gets same value
    expect(evaluator.getFlag('feature-rollout', 'control', userA)).toBe(valA);

    // Check rollout behavior mock (hard to exact percent w/o mocking hash)
    // but at least it shouldn't crash
  });
});
