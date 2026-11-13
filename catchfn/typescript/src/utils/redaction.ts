import { serializeEntry, type SerializedValue } from "./serialization.js";

/**
 * Data redaction utilities
 */

const SENSITIVE_PATTERNS = [
  /password/i,
  /passwd/i,
  /pwd/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /auth/i,
  /credit[_-]?card/i,
  /card[_-]?number/i,
  /cvv/i,
  /ssn/i,
  /social[_-]?security/i,
];

const CREDIT_CARD_PATTERN = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;
// EMAIL_PATTERN can be used to redact emails if needed (commented out by default)
// const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

/**
 * Redact sensitive values from an object. The input is first snapshotted
 * under the serialization closed set, so the result is bounded JSON data.
 * Keys matching a sensitive pattern become "[REDACTED]", and strings under a
 * key that names a URL or href are passed through {@link redactUrl}. The
 * redacted result is bounded again, since a replacement can be longer than
 * the value it replaces.
 */
// The result mirrors the caller's shape, so it stays loosely typed.
export function redactObject(obj: unknown, customPatterns: RegExp[] = []): any {
  const patterns = [...SENSITIVE_PATTERNS, ...customPatterns];
  function visit(value: SerializedValue, field = ""): SerializedValue {
    if (typeof value === "string") return redactString(/url|href/i.test(field) ? redactUrl(value) : value);
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((entry) => visit(entry, field));
    const result: Record<string, SerializedValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const sensitive = patterns.some((pattern) => { pattern.lastIndex = 0; return pattern.test(key); });
      Object.defineProperty(result, key, { value: sensitive ? "[REDACTED]" : visit(entry, key), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  return serializeEntry(visit(serializeEntry(obj)));
}

/**
 * Redact sensitive data from strings
 */
export function redactString(str: string): string {
  let result = str;

  // Redact credit card numbers
  result = result.replace(CREDIT_CARD_PATTERN, "XXXX-XXXX-XXXX-XXXX");

  // Optionally redact emails (commented out by default)
  // result = result.replace(EMAIL_PATTERN, "[EMAIL]");

  return result;
}

/**
 * Redact URL parameters
 */
export function redactUrl(url: string, sensitiveParams: string[] = []): string {
  try {
    // A browser accepts path/query/protocol-relative URLs. Parse those too,
    // without inserting a fabricated origin into captured report metadata.
    const input = url.trim();
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(input);
    const authorityRelative = /^[\\/]{2}/.test(input);
    const urlObj = new URL(input, "https://catchfn.invalid/");
    const defaultSensitiveParams = [
      "token",
      "key",
      "secret",
      "password",
      "api_key",
      "access_token",
      "auth",
    ];

    const allSensitiveParams = [...defaultSensitiveParams, ...sensitiveParams];

    urlObj.username = "";
    urlObj.password = "";
    const names = new Set(allSensitiveParams.map((name) => name.toLowerCase()));
    for (const param of [...urlObj.searchParams.keys()]) {
      if (names.has(param.toLowerCase())) urlObj.searchParams.set(param, "[REDACTED]");
    }
    // Fragments can carry percent-encoded OAuth parameter names. A malformed
    // encoding is not safe to echo into a report either.
    try {
      if (/token|secret|password|api[_-]?key/i.test(decodeURIComponent(urlObj.hash))) urlObj.hash = "[REDACTED]";
    } catch { urlObj.hash = "[REDACTED]"; }

    if (absolute) return urlObj.toString();
    if (authorityRelative) return urlObj.toString().replace(/^https:/, "");
    const path = input.split(/[?#]/, 1)[0];
    return path + urlObj.search + urlObj.hash;
  } catch {
    // Malformed authorities may still contain credentials; never echo them.
    return "[REDACTED_URL]";
  }
}

/**
 * Redact headers
 */
export function redactHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const sensitiveHeaders = [
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-access-token",
  ];

  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (sensitiveHeaders.includes(key.toLowerCase())) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = value;
    }
  }

  return result;
}
