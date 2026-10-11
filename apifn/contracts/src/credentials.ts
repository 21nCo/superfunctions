// Credential detection shared by the catalog builder and the failure envelope.
// The rules are deliberately conservative: rejecting a harmless key such as
// `page_token` is preferable to persisting a live credential.

const CREDENTIAL_KEY_FRAGMENTS = [
  "authorization",
  "cookie",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "apikey",
  "token",
  "privatekey",
  "credential",
  "sessionid",
] as const;

/**
 * Lowercase, separator-tolerant form of the fragments for JSON Schema
 * `propertyNames` checks over keys restricted to `[a-z0-9_.-]`.
 */
export const CREDENTIAL_KEY_PATTERN =
  "authorization|cookie|password|passwd|passphrase|secret|api[_.-]*key|token|private[_.-]*key|credential|session[_.-]*id";

/** True when a field or parameter name conventionally carries a credential. */
export function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return CREDENTIAL_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

const CREDENTIAL_VALUE_PATTERNS: RegExp[] = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\b(?:xox[abpr]|AKIA)[A-Za-z0-9-]{12,}/g,
  /\b(?:access_token|refresh_token|api[_-]?key|password|secret|token)=[^&\s"']+/gi,
  /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
];

export const REDACTED = "[REDACTED]";

/** True when a free-text value contains a recognizable credential. */
export function containsCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

/** Replaces recognizable credentials in free text with `[REDACTED]`. */
export function redactCredentialValues(value: string): string {
  return CREDENTIAL_VALUE_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, (match, scheme?: string) =>
      typeof scheme === "string" && match.startsWith(scheme) ? `${scheme}${REDACTED}@` : REDACTED
    ),
    value
  );
}

/**
 * Removes user info, query and fragment from a URL or URL template. Server
 * URLs in a catalog identify an endpoint; they never carry credentials.
 */
export function stripUrlCredentials(url: string): string {
  const withoutQuery = url.replace(/[?#].*$/s, "");
  return withoutQuery.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}
