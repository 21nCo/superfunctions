/** Shared log-context redaction for canonical SearchFn adapters. */
const SENSITIVE_KEY =
  /(?:api[_-]?key|password|secret|token|authorization)|connection(?:string|[_-]string)?(?=$|[^a-z])/i;

// key = value pairs inside strings. The key may carry a short prefix
// (accessToken, pgConnectionString, db_password) but must end in a sensitive
// word, so connectionTimeout or tokenCount stay readable; the prefix is bounded
// so matching stays linear on long hyphenated text. An optional quote after the
// key covers JSON ("password":"x"). A closed quoted value followed by a value
// boundary is replaced whole, including spaces; any other quote (unclosed, or
// closed with more characters attached) redacts to the end of the line;
// an unquoted value runs to the next whitespace, comma or semicolon (quotes and
// & inside it are redacted too). An authorization scheme such as Bearer is
// kept and its credential is redacted.
const KEY_VALUE_SECRET =
  /(\b[\w-]{0,64}?(?:api[_-]?key|password|passwd|secret|token|authorization|connection(?:[_-]?string)?))(["']?)(\s*[:=]\s*)(?:(["'])((?:\\.|(?!\4)[^\\\n])*)\4(?=$|[\s,;}\]&])|(["'])[^\n]*|((?:bearer|basic|token)\s+)?([^\s,;]+))/gi;
const URL_CREDENTIALS = /(https?:\/\/)([^\s/@]+)@/gi;
const POSTGRES_CREDENTIALS = /(postgres(?:ql)?:\/\/)([^\s/@]+)@/gi;

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactError(error: Error, seen: WeakSet<object>): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: error.name,
    message: redactSensitiveString(error.message),
  };
  if (typeof error.stack === "string") {
    output.stack = redactSensitiveString(error.stack);
  }
  if ("cause" in error && (error as Error & { cause?: unknown }).cause !== undefined) {
    output.cause = redactSensitiveInternal(
      (error as Error & { cause?: unknown }).cause,
      seen,
    );
  }
  for (const [key, entry] of Object.entries(error)) {
    if (key === "cause") continue;
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitiveInternal(entry, seen);
  }
  return output;
}

function redactSensitiveInternal(value: unknown, seen: WeakSet<object>): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactSensitiveString(value);
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((entry) => redactSensitiveInternal(entry, seen));
      }
      if (value instanceof Error) {
        return redactError(value, seen);
      }

      // Containers whose contents are not own enumerable properties.
      if (value instanceof URL || value instanceof URLSearchParams) {
        return redactSensitiveString(value.toString());
      }
      if (value instanceof Map) {
        const output = new Map<unknown, unknown>();
        for (const [key, entry] of value) {
          output.set(
            key,
            typeof key === "string" && SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitiveInternal(entry, seen),
          );
        }
        return output;
      }
      if (value instanceof Set) {
        return new Set([...value].map((entry) => redactSensitiveInternal(entry, seen)));
      }

      const entries = Object.entries(value);
      if (!isPlainObject(value) && entries.length === 0) {
        return value;
      }

      const output: Record<string, unknown> = {};
      for (const [key, entry] of entries) {
        if (SENSITIVE_KEY.test(key)) {
          output[key] = "[REDACTED]";
        } else {
          output[key] = redactSensitiveInternal(entry, seen);
        }
      }
      return output;
    } finally {
      seen.delete(value);
    }
  }

  return value;
}
export function redactSensitive(value: unknown): any {
  return redactSensitiveInternal(value, new WeakSet<object>());
}

export function redactSensitiveString(input: string): string {
  return input
    .replace(
      KEY_VALUE_SECRET,
      (
        _match,
        key: string,
        keyQuote: string,
        separator: string,
        valueQuote?: string,
        _quoted?: string,
        openQuote?: string,
        scheme?: string,
      ) => {
        if (valueQuote) return `${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`;
        if (openQuote) return `${key}${keyQuote}${separator}${openQuote}[REDACTED]`;
        return `${key}${keyQuote}${separator}${scheme ?? ""}[REDACTED]`;
      },
    )
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(POSTGRES_CREDENTIALS, "$1[REDACTED]@");
}
