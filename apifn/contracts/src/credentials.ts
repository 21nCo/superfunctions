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

/** Template placeholders such as `<token>`, `{token}`, `${TOKEN}`, `***` or `[REDACTED]`. */
function isPlaceholder(value: string): boolean {
  return /^(?:<[^<>]*>|\{+[^{}]*\}+|\[[^[\]]*\]|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\*+|\.{3}|\u2026)$/.test(value);
}

/**
 * True when a word could be a credential rather than prose: it holds a digit,
 * base64 or token punctuation, a lower-to-upper case change, or is 16+ long.
 */
function isTokenShaped(word: string): boolean {
  return word.length >= 16 || /\d|[+/=_~]|[a-z][A-Z]/.test(word);
}

/** HTTP authentication schemes that precede a credential in an Authorization header. */
const AUTH_SCHEMES = "basic|bearer|digest|token|negotiate|ntlm|dpop|hoba|mutual|apikey|oauth|aws4-hmac-sha256";

interface CredentialPattern {
  pattern: RegExp;
  /** Receives the capture groups (unmatched groups as ""); false keeps the match. */
  accept?: (groups: string[]) => boolean;
  /** Replacement built from the capture groups, so redacted text keeps its context. */
  replace?: (groups: string[]) => string;
}

const CREDENTIAL_VALUE_PATTERNS: CredentialPattern[] = [
  // Header context: an Authorization value is a credential at any length; a
  // single word without a scheme only when it is token-shaped.
  {
    pattern: new RegExp(`\\b((?:proxy-)?authorization\\s*:\\s*)(?:(${AUTH_SCHEMES})\\s+)?([^\\s"',;]+)`, "gi"),
    accept: ([, scheme, value]) => !isPlaceholder(value) && (scheme !== "" || isTokenShaped(value)),
    replace: ([prefix, scheme]) => `${prefix}${scheme ? `${scheme} ` : ""}${REDACTED}`,
  },
  // Cookie headers: every name=value pair up to the end of the line.
  {
    pattern: /\b((?:set-)?cookie\s*:\s*)([^\r\n"']*=[^\r\n"']*)/gi,
    accept: ([, cookies]) => cookies.split(/[;,]/).some((pair) => {
      const value = pair.slice(pair.indexOf("=") + 1).trim();
      return pair.includes("=") && value !== "" && !isPlaceholder(value);
    }),
    replace: ([prefix]) => `${prefix}${REDACTED}`,
  },
  // A standalone Bearer/Basic counts only when the next word is token-shaped.
  {
    pattern: /\b(bearer|basic)\s+([^\s"',;]+?)(?=[.,;:!?)]*(?:\s|["',;]|$))/gi,
    accept: ([, word]) => !isPlaceholder(word) && word.length >= 4 && isTokenShaped(word),
    replace: ([scheme]) => `${scheme} ${REDACTED}`,
  },
  { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g },
  { pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { pattern: /\b(?:xox[abpr]|AKIA)[A-Za-z0-9-]{12,}/g },
  { pattern: /\b(?:access_token|refresh_token|api[_-]?key|password|secret|token)=[^&\s"']+/gi },
  // Any URL user info, with or without a scheme and however many "@" it holds.
  {
    pattern: /((?:\b[a-z][a-z0-9+.-]*:)?\/\/)[^/\s?#]*@/gi,
    replace: ([prefix]) => `${prefix}${REDACTED}@`,
  },
];

export const REDACTED = "[REDACTED]";

function groupsOf(match: RegExpMatchArray | unknown[]): string[] {
  return Array.from(match as ArrayLike<unknown>).slice(1).map((group) => (typeof group === "string" ? group : ""));
}

/** True when a free-text value contains a recognizable credential. */
export function containsCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE_PATTERNS.some(({ pattern, accept }) =>
    Array.from(value.matchAll(pattern)).some((match) => !accept || accept(groupsOf(match)))
  );
}

/** Replaces recognizable credentials in free text with `[REDACTED]`. */
export function redactCredentialValues(value: string): string {
  return CREDENTIAL_VALUE_PATTERNS.reduce(
    (text, { pattern, accept, replace }) =>
      text.replace(pattern, (match: string, ...rest: unknown[]) => {
        // `rest` ends with the offset and the whole string after the capture groups.
        const groups = rest.slice(0, -2).map((group) => (typeof group === "string" ? group : ""));
        if (accept && !accept(groups)) return match;
        return replace ? replace(groups) : REDACTED;
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
