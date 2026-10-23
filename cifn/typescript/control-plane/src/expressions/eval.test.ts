import { describe, it, expect } from 'vitest';
import {
  evaluateConditionSync,
  evaluateConditionAsync,
  validateExpression,
  EXPR_MAX_LENGTH,
} from './eval.js';

describe('evaluateConditionSync', () => {
  it('success() is true when no prior step failed', () => {
    expect(evaluateConditionSync('success()', { stepOutcomes: [] })).toBe(true);
    expect(evaluateConditionSync('success()', { stepOutcomes: ['success', 'success'] })).toBe(true);
  });

  it('success() is false when any prior step failed', () => {
    expect(evaluateConditionSync('success()', { stepOutcomes: ['failure'] })).toBe(false);
    expect(evaluateConditionSync('success()', { stepOutcomes: ['success', 'failure'] })).toBe(false);
  });

  it('failure() is true when any prior step failed', () => {
    expect(evaluateConditionSync('failure()', { stepOutcomes: ['failure'] })).toBe(true);
    expect(evaluateConditionSync('failure()', { stepOutcomes: ['success', 'failure'] })).toBe(true);
  });

  it('failure() is false when no prior step failed', () => {
    expect(evaluateConditionSync('failure()', { stepOutcomes: [] })).toBe(false);
    expect(evaluateConditionSync('failure()', { stepOutcomes: ['success'] })).toBe(false);
  });

  it('always() is true', () => {
    expect(evaluateConditionSync('always()', {})).toBe(true);
  });

  it('rejects unsupported operator', () => {
    expect(() => validateExpression("github.ref =~ 'main'")).toThrow(/Unsupported|PIPELINE_INVALID/);
  });

  it('rejects expression over 2048 chars', () => {
    const long = 'a'.repeat(2049);
    expect(() => validateExpression(long)).toThrow(/2048|length/);
  });

  it('accepts expression exactly 2048 chars', () => {
    const exact = 'success()';
    expect(() => validateExpression(exact)).not.toThrow();
  });
});

describe('evaluateConditionAsync', () => {
  it('resolves secrets when getSecret provided', async () => {
    const getSecret = async (name: string) => (name === 'MY_TOKEN' ? 'secret123' : null);
    const result = await evaluateConditionAsync("secrets.MY_TOKEN == 'secret123'", { getSecret });
    expect(result).toBe(true);
  });
});

describe('validateExpression', () => {
  it('accepts valid expressions', () => {
    expect(() => validateExpression('success()')).not.toThrow();
    expect(() => validateExpression("github.ref == 'refs/heads/main'")).not.toThrow();
    expect(() => validateExpression('failure() && always()')).not.toThrow();
  });
});
