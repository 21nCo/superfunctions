const SENSITIVE_KEY = /apikey|password|secret|token|authorization|connectionstring/i;

const KEY_VALUE_SECRET = /\b(api[_-]?key|password|secret|token|authorization|connection[_-]?string)\s*[:=]\s*([^\s,;]+)/gi;
const URL_CREDENTIALS = /(https?:\/\/)([^\s/@]+)@/gi;
const POSTGRES_CREDENTIALS = /(postgres(?:ql)?:\/\/)([^\s/@]+)@/gi;

export function redactSensitive(value: unknown): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactSensitiveString(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry));
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (SENSITIVE_KEY.test(key)) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = redactSensitive(entry);
      }
    }
    return output;
  }

  return value;
}

export function redactSensitiveString(input: string): string {
  return input
    .replace(KEY_VALUE_SECRET, (_match, key) => `${key}=[REDACTED]`)
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(POSTGRES_CREDENTIALS, "$1[REDACTED]@");
}
