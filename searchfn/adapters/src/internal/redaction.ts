const SECRET = /apikey|password|secret|token|authorization|connectionstring/i;

export function redactSensitive(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry));
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET.test(key) ? '[REDACTED]' : redactSensitive(entry);
    }
    return output;
  }

  if (typeof value === 'string') {
    return value.replace(/\b(api[_-]?key|password|secret|token|authorization|connection[_-]?string)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]');
  }

  return value;
}
