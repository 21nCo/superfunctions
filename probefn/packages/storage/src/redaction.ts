import { createProbefnError } from '@probefn/contracts/errors';
import type { JsonObject, JsonValue } from '@probefn/contracts/envelopes';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN = /(authorization|cookie|set-cookie|token|secret|password|api[_-]?key|session)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/g;
const KEY_VALUE_PATTERN =
  /\b([A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|COOKIE|SESSION)[A-Z0-9_]*)=([^\s]+)/g;
const SECRET_VALUE_PATTERN =
  /\b(sk_(live|test)_[A-Za-z0-9]+|ghp_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+)\b/g;

export interface RedactionResult<TValue> {
  value: TValue;
  redactionCount: number;
  redactedPaths: string[];
}

export function redactSensitiveData<TValue>(input: TValue): RedactionResult<TValue> {
  const seen = new WeakSet<object>();
  const redactedPaths: string[] = [];
  let redactionCount = 0;

  const walk = (value: unknown, currentPath: string): unknown => {
    if (typeof value === 'string') {
      const redactedValue = redactString(value);
      if (redactedValue !== value) {
        redactionCount += 1;
        redactedPaths.push(currentPath || '$');
      }
      return redactedValue;
    }

    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (seen.has(value)) {
      throw createProbefnError({
        code: 'E_REDACTION_FAILURE',
        message: 'Redaction pipeline failed before sensitive data could be persisted safely.',
        retryable: false,
        details: {
          path: currentPath || '$',
        },
      });
    }

    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, `${currentPath}[${index}]`));
    }

    const result: JsonObject = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;

      if (SENSITIVE_KEY_PATTERN.test(key)) {
        if (nestedValue !== REDACTED) {
          redactionCount += 1;
          redactedPaths.push(nextPath);
        }
        result[key] = REDACTED;
        continue;
      }

      result[key] = walk(nestedValue, nextPath) as JsonValue;
    }

    return result;
  };

  return {
    value: walk(input, '') as TValue,
    redactionCount,
    redactedPaths,
  };
}

function redactString(value: string): string {
  let redacted = value.replace(BEARER_PATTERN, 'Bearer [REDACTED]');
  redacted = redacted.replace(KEY_VALUE_PATTERN, (_match, keyName: string) => `${keyName}=${REDACTED}`);
  redacted = redacted.replace(SECRET_VALUE_PATTERN, REDACTED);
  return redacted;
}
