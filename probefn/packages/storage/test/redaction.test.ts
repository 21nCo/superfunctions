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

  it.each([
    ['password=synthetic-password token=synthetic-token', 'password=[REDACTED] token=[REDACTED]'],
    ['Db_PaSsWoRd=synthetic-password api_Key=synthetic-key', 'Db_PaSsWoRd=[REDACTED] api_Key=[REDACTED]'],
    ['cookie=synthetic-cookie app_session_id=synthetic-session client_secret=synthetic-secret', 'cookie=[REDACTED] app_session_id=[REDACTED] client_secret=[REDACTED]'],
    ['authorization: bearer synthetic-token', 'authorization: Bearer [REDACTED]'],
    ['authorization: bEaReR synthetic-token', 'authorization: Bearer [REDACTED]'],
  ])('redacts credential casing in unstructured event text: %s', (line, expected) => {
    const input = { line, message: 'PORT=3100 status=ready trace_id=abc' };
    const result = redactSensitiveData(input);
    expect(result.value).toEqual({ line: expected, message: input.message });
    expect(result.redactionCount).toBe(1);
    expect(result.redactedPaths).toEqual(['line']);
    expect(input.line).toBe(line);
    expect(JSON.stringify(result.value)).not.toContain('synthetic-');
  });

  it('redacts mixed-case credentials throughout nested arrays without retaining regexp state', () => {
    const input = { events: [
      { text: 'Password=synthetic-one' },
      { text: 'password=synthetic-two TOKEN=synthetic-three' },
      { text: 'bearer synthetic-four' },
    ] };
    const expected = { events: [
      { text: 'Password=[REDACTED]' },
      { text: 'password=[REDACTED] TOKEN=[REDACTED]' },
      { text: 'Bearer [REDACTED]' },
    ] };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(redactSensitiveData(input)).toEqual({ value: expected, redactionCount: 3,
        redactedPaths: ['events[0].text', 'events[1].text', 'events[2].text'] });
    }
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
