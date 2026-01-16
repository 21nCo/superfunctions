import { describe, it, expect, beforeEach } from 'vitest';
import { FlagEvaluator } from '../core/flags';
import { FlagConfig } from '../types';

const MOCK_FLAGS: FlagConfig[] = [
  {
    key: 'feature-A',
    defaultValue: true,
    enabled: true,
    rules: [],
    variations: [
      { id: 'on', value: true },
      { id: 'off', value: false },
    ],
  },
  {
    key: 'feature-B',
    defaultValue: 'blue',
    enabled: true,
    rules: [],
    variations: [
      { id: 'red', value: 'red' },
      { id: 'blue', value: 'blue' },
    ],
  },
  {
    key: 'feature-disabled',
    defaultValue: false,
    enabled: false,
    rules: [],
    variations: [],
  }
];

describe('FlagEvaluator', () => {
  let evaluator: FlagEvaluator;

  beforeEach(() => {
    evaluator = new FlagEvaluator(MOCK_FLAGS);
  });

  it('should return default value for existing enabled flag', () => {
    expect(evaluator.getFlag('feature-A', false)).toBe(true);
  });

  it('should return requested default value if flag does not exist', () => {
    expect(evaluator.getFlag('non-existent', 'default')).toBe('default');
  });

  it('should return requested default value if flag is disabled', () => {
    // Flag has defaultValue false, but we ask for true if missing/disabled?
    // Wait, getFlag 2nd arg is defaultValue in case of failure/missing.
    // If flag is disabled, it should probably return the "fallback" provided by caller
    // or the "default variation" configured?
    // The implementation currently returns defaultValue (arg) if !enabled.
    expect(evaluator.getFlag('feature-disabled', 'fallback')).toBe('fallback');
  });

  it('should return configured default value', () => {
      expect(evaluator.getFlag('feature-B', 'red')).toBe('blue');
  });
});
