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
 * Redact sensitive values from an object
 */
export function redactObject(obj: any, customPatterns: RegExp[] = []): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  const patterns = [...SENSITIVE_PATTERNS, ...customPatterns];

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, customPatterns));
  }

  const result: any = {};

  for (const [key, value] of Object.entries(obj)) {
    // Check if key matches sensitive pattern
    const isSensitive = patterns.some((pattern) => pattern.test(key));

    if (isSensitive) {
      result[key] = "[REDACTED]";
    } else if (value && typeof value === "object") {
      result[key] = redactObject(value, customPatterns);
    } else {
      result[key] = value;
    }
  }

  return result;
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
    const urlObj = new URL(url);
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

    allSensitiveParams.forEach((param) => {
      if (urlObj.searchParams.has(param)) {
        urlObj.searchParams.set(param, "[REDACTED]");
      }
    });

    return urlObj.toString();
  } catch {
    // If URL parsing fails, return original
    return url;
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
