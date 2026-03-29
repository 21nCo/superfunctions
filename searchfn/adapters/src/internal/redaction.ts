const SECRET = /apikey|password|secret|token|authorization|connection(?:[_-]?string)?/i;

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactSensitiveInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveInternal(entry, seen));
  }

  if (typeof value === "object") {
    if (!isPlainObject(value)) {
      return value;
    }
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SECRET.test(key) ? "[REDACTED]" : redactSensitiveInternal(entry, seen);
    }
    return output;
  }

  if (typeof value === "string") {
    return value.replace(
      /\b(api[_-]?key|password|secret|token|authorization|connection[_-]?string)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[REDACTED]",
    );
  }

  return value;
}

export function redactSensitive(value: unknown): unknown {
  return redactSensitiveInternal(value, new WeakSet<object>());
}
