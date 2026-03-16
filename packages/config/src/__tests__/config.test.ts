import { describe, expect, it } from 'vitest';
import { ConfigError, readBooleanEnv, readIntEnv, readIntEnvOrDefault, readStringEnv } from '../index.js';

describe('config', () => {
  it('reads bounded integer env values', () => {
    expect(
      readIntEnv('RECFN_RATE_LIMIT_WINDOW_MS', {
        env: { RECFN_RATE_LIMIT_WINDOW_MS: '2000' },
        defaultValue: 1000,
        min: 100,
      })
    ).toBe(2000);
  });

  it('throws ENV_VALUE_OUT_OF_RANGE for out of range integer', () => {
    expect(() =>
      readIntEnv('RECFN_RATE_LIMIT_WINDOW_MS', {
        env: { RECFN_RATE_LIMIT_WINDOW_MS: '-1' },
        defaultValue: 1000,
        min: 100,
      })
    ).toThrowError(ConfigError);
  });

  it('can fallback deterministically using readIntEnvOrDefault', () => {
    expect(
      readIntEnvOrDefault('RECFN_RATE_LIMIT_WINDOW_MS', {
        env: { RECFN_RATE_LIMIT_WINDOW_MS: '-1' },
        defaultValue: 1000,
        min: 100,
      })
    ).toBe(1000);
  });

  it('reads strings and booleans', () => {
    expect(readStringEnv('A', { env: { A: 'value' }, defaultValue: 'x' })).toBe('value');
    expect(readBooleanEnv('B', { env: { B: 'true' }, defaultValue: false })).toBe(true);
  });
});
