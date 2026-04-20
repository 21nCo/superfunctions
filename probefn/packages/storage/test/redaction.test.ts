import { describe, expect, it } from 'vitest';

import { isProbefnError } from '@probefn/contracts/errors';
import { redactSensitiveData } from '../src/redaction.js';

describe('redactSensitiveData', () => {
  it('redacts headers, cookies, bearer tokens, and env-like output', () => {
    const input = {
      headers: {
        authorization: 'Bearer super-secret-token',
        'x-trace-id': 'trace_123',
      },
      cookie: 'session=abc123',
      logLine: 'API_KEY=sk_test_123456',
      nested: {
        message: 'Deploy used ghp_secretvalue',
      },
    };

    expect(redactSensitiveData(input)).toMatchSnapshot();
  });

  it('fails safely on circular objects', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    try {
      redactSensitiveData(circular);
      throw new Error('Expected circular redaction to fail.');
    } catch (error) {
      expect(isProbefnError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'E_REDACTION_FAILURE',
        message: 'Redaction pipeline failed before sensitive data could be persisted safely.',
      });
    }
  });
});
