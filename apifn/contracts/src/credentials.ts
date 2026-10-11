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

/**
 * True when the word after `Bearer`/`Basic` may be a token. Prose such as
 * "Basic authentication" or "Bearer token-based access" is the only exception.
 */
function looksLikeToken(word: string): boolean {
  return !/^(?:auth|token|credential|scheme|header|access|realm|challenge|login)[A-Za-z-]*$/i.test(word);
}

interface CredentialPattern {
  pattern: RegExp;
  accept?: (match: string, ...groups: string[]) => boolean;
  /** Replacement keeping the URL scheme so redacted text stays readable. */
  keepPrefix?: boolean;
}

const CREDENTIAL_VALUE_PATTERNS: CredentialPattern[] = [
  { pattern: /\b(?:bearer|basic)\s+([A-Za-z0-9._~+/-]{8,}=*)/gi, accept: (_match, token) => looksLikeToken(token) },
  { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g },
  { pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { pattern: /\b(?:xox[abpr]|AKIA)[A-Za-z0-9-]{12,}/g },
  { pattern: /\b(?:access_token|refresh_token|api[_-]?key|password|secret|token)=[^&\s"']+/gi },
  // Any URL user info, with or without a scheme and however many "@" it holds.
  { pattern: /((?:\b[a-z][a-z0-9+.-]*:)?\/\/)[^/\s?#]*@/gi, keepPrefix: true },
];

export const REDACTED = "[REDACTED]";

/** True when a free-text value contains a recognizable credential. */
export function containsCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE_PATTERNS.some(({ pattern, accept }) =>
    Array.from(value.matchAll(pattern)).some((match) => !accept || accept(...(match as unknown as [string, ...string[]])))
  );
}

/** Replaces recognizable credentials in free text with `[REDACTED]`. */
export function redactCredentialValues(value: string): string {
  return CREDENTIAL_VALUE_PATTERNS.reduce(
    (text, { pattern, accept, keepPrefix }) =>
      text.replace(pattern, (match: string, ...groups: unknown[]) => {
        const captured = groups.filter((group): group is string => typeof group === "string");
        if (accept && !accept(match, ...captured)) return match;
        return keepPrefix ? `${captured[0]}${REDACTED}@` : REDACTED;
      }),
    value
  );
}

const URL_PARTS = /^((?:[a-z][a-z0-9+.-]*:)?\/\/)([^/?#]*)([^?#]*)(?:\?([^#]*))?/i;

function isCredentialQueryParameter(pair: string): boolean {
  const separator = pair.indexOf("=");
  const rawKey = separator === -1 ? pair : pair.slice(0, separator);
  let key = rawKey;
  let decoded = pair;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    decoded = decodeURIComponent(pair.replace(/\+/g, " "));
  } catch {
    return true; // Undecodable parameters cannot be shown to be harmless.
  }
  return isCredentialKey(key) || containsCredentialValue(decoded);
}

/**
 * Removes user info (everything before the last "@" of the authority, with or
 * without a scheme), credential-like query parameters and the fragment from a
 * URL or URL template. Other query parameters, such as an OAuth audience, are
 * kept. With `dropQuery`, the whole query is removed (server base URLs).
 */
export function stripUrlCredentials(url: string, options: { dropQuery?: boolean } = {}): string {
  const match = URL_PARTS.exec(url);
  if (!match) {
    // Relative references have no authority; only the query and fragment can carry secrets.
    const [base, query] = url.replace(/#.*$/s, "").split(/\?(.*)/s, 2);
    return joinQuery(base, query, options.dropQuery);
  }
  const [, prefix, authority, path, query] = match;
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  return joinQuery(`${prefix}${host}${path}`, query, options.dropQuery);
}

function joinQuery(base: string, query: string | undefined, dropQuery = false): string {
  if (dropQuery || query === undefined) return base;
  const kept = query.split("&").filter((pair) => pair !== "" && !isCredentialQueryParameter(pair));
  return kept.length > 0 ? `${base}?${kept.join("&")}` : base;
}
