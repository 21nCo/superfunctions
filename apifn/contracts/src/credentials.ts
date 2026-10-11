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
 * JSON Schema `propertyNames` form of {@link isCredentialKey} for keys
 * restricted to `[a-z0-9_.-]`: every fragment, with any run of `_`, `.` or `-`
 * allowed between each pair of characters.
 */
export const CREDENTIAL_KEY_PATTERN = CREDENTIAL_KEY_FRAGMENTS.map((fragment) => Array.from(fragment).join("[_.-]*")).join("|");

/** Percent-decodes, lowercases and drops every character other than a-z and 0-9. */
function normalizeKey(key: string): string {
  return key
    .replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** True when a field, parameter or text key conventionally carries a credential. */
export function isCredentialKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return CREDENTIAL_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export const REDACTED = "[REDACTED]";

/** Template placeholders such as `<token>`, `{{token}}`, `${TOKEN}`, `$TOKEN`, `***` or `[REDACTED]`. */
const PLACEHOLDER = /<[A-Za-z _.-]*>|\{\{\s*[A-Za-z_.-]*\s*\}\}|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{[A-Za-z_.-]*\}|\[[A-Z _-]+\]|\$[A-Z_][A-Z0-9_]*|\*{3,}|\.{3}|…/g;
/** HTTP authentication schemes that precede a credential in an Authorization header. */
const AUTH_SCHEMES = "basic|bearer|digest|token|negotiate|ntlm|dpop|hoba|mutual|apikey|oauth|aws4-hmac-sha256";
const AUTH_SCHEME_WORDS = new RegExp(`(?<![A-Za-z0-9-])(?:${AUTH_SCHEMES})(?![A-Za-z0-9-])`, "gi");
const LEADING_AUTH_SCHEME = new RegExp(`^(?:${AUTH_SCHEMES})\\s+`, "i");

/**
 * True when a value holds nothing secret: only placeholders, scheme names,
 * parameter or cookie names (`name=` before a value) and punctuation.
 */
function isPlaceholderValue(value: string): boolean {
  const rest = value
    .replace(/[A-Za-z0-9_.-]+\s*=(?![=\s]|$)/g, "")
    .replace(PLACEHOLDER, "")
    .replace(AUTH_SCHEME_WORDS, "")
    .replace(/[\s"'`,;:=]/g, "");
  return rest === "";
}

/**
 * A key, bare or quoted, followed by `:` or `=`: HTTP headers, JSON, JS
 * object literals and query strings. `scheme://` is a URL, not a key.
 */
const KEY_SEPARATOR = /(?<![A-Za-z0-9_.%-])(["'`]?)([A-Za-z0-9_.%-]+)\1[ \t]*([:=])(?!\/\/)[ \t]*/g;
/** Identifiers use `:` as a namespace separator (`secrets:read`), so only `=` introduces a value there. */
const IDENTIFIER_KEY_SEPARATOR = /(?<![A-Za-z0-9_.%-])(["'`]?)([A-Za-z0-9_.%-]+)\1[ \t]*(=)[ \t]*/g;
const LEADING_PLACEHOLDER = new RegExp(`^(?:${PLACEHOLDER.source})`);

/** Headers whose whole value, with every scheme parameter, is a credential. */
function isHeaderKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return normalized.endsWith("authorization") || normalized.endsWith("cookie");
}

/** Reads the value after a key: a quoted string, a header line, or a run up to the next delimiter. */
function readValue(text: string, start: number, header: boolean): { end: number; value: string; quote: string } {
  const quote = text[start];
  if (quote === '"' || quote === "'" || quote === "`") {
    let index = start + 1;
    while (index < text.length && text[index] !== quote) index += text[index] === "\\" ? 2 : 1;
    return { end: Math.min(index + 1, text.length), value: text.slice(start + 1, Math.min(index, text.length)), quote };
  }
  const rest = text.slice(start);
  const run = header
    ? /^[^\r\n]*/.exec(rest)![0].trimEnd()
    : (LEADING_PLACEHOLDER.exec(rest) ?? /^[^\s&,;"'`)\]}]*/.exec(rest)!)[0];
  return { end: start + run.length, value: run, quote: "" };
}

/**
 * The key/value rule: a key that satisfies {@link isCredentialKey} makes its
 * whole value a credential unless the value is only placeholders. Scheme
 * names before the value are kept so redacted text stays readable.
 */
function redactKeyValues(text: string, identifier: boolean): string {
  let output = "";
  let copied = 0;
  const pattern = new RegExp((identifier ? IDENTIFIER_KEY_SEPARATOR : KEY_SEPARATOR).source, "g");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const key = match[2];
    if (!isCredentialKey(key)) continue;
    const start = match.index + match[0].length;
    const { end, value, quote } = readValue(text, start, isHeaderKey(key));
    if (end <= start) continue;
    pattern.lastIndex = end;
    if (value === "" || isPlaceholderValue(value)) continue;
    const scheme = LEADING_AUTH_SCHEME.exec(value)?.[0] ?? "";
    output += `${text.slice(copied, start)}${quote}${scheme}${REDACTED}${quote}`;
    copied = end;
  }
  return output + text.slice(copied);
}

/**
 * True when a word after a standalone `Bearer`/`Basic` looks like a token
 * rather than prose: 8+ characters with letters and digits, token punctuation
 * (`+=_~`), or two lower-to-upper case changes. Plain words and version-like
 * words such as `HTTP/1.1` or `OAuth2.0` are prose.
 */
function isTokenShaped(word: string): boolean {
  const trimmed = word.replace(/[.]+$/, "");
  if (trimmed.length < 8 || /^[A-Za-z]{1,8}[/-]?v?\d{1,3}(?:\.\d{1,3})*$/.test(trimmed)) return false;
  return (
    (/\d/.test(trimmed) && /[A-Za-z]/.test(trimmed)) ||
    /[+=_~]/.test(trimmed) ||
    (trimmed.match(/[a-z][A-Z]/g)?.length ?? 0) >= 2
  );
}

interface ShapeRule {
  pattern: RegExp;
  /** Receives the capture groups (unmatched groups as ""); false keeps the match. */
  accept?: (groups: string[]) => boolean;
  /** Replacement built from the capture groups, so redacted text keeps its context. */
  replace?: (groups: string[]) => string;
}

/** Credentials recognizable by their shape, wherever they appear. */
const SHAPE_RULES: ShapeRule[] = [
  {
    pattern: /(?<![A-Za-z0-9-])(bearer|basic)\s+([A-Za-z0-9._~+/-]+=*)(?=$|[\s"'`,;!?)\]}])/gi,
    accept: ([, word]) => isTokenShaped(word),
    replace: ([scheme]) => `${scheme} ${REDACTED}`,
  },
  { pattern: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g },
  { pattern: /(?<![A-Za-z0-9])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g },
  { pattern: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g },
  { pattern: /(?<![A-Za-z0-9])(?:xox[abpr]|AKIA)[A-Za-z0-9-]{12,}/g },
  // Any URL user info, with or without a scheme and however many "@" it holds.
  {
    pattern: /((?:\b[a-z][a-z0-9+.-]*:)?\/\/)[^/\s?#]*@/gi,
    replace: ([prefix]) => `${prefix}${REDACTED}@`,
  },
];

/**
 * Replaces credentials in free text with `[REDACTED]`. This is the single
 * definition of a credential value: {@link containsCredentialValue}, catalog
 * redaction and the failure-event validator all derive from it.
 */
export function redactCredentialValues(value: string): string {
  return redact(value, false);
}

function redact(value: string, identifier: boolean): string {
  return SHAPE_RULES.reduce(
    (text, { pattern, accept, replace }) =>
      text.replace(pattern, (match: string, ...rest: unknown[]) => {
        // `rest` ends with the offset and the whole string after the capture groups.
        const groups = rest.slice(0, -2).map((group) => (typeof group === "string" ? group : ""));
        if (accept && !accept(groups)) return match;
        return replace ? replace(groups) : REDACTED;
      }),
    redactKeyValues(value, identifier)
  );
}

/** True when a string holds a credential, that is, when redaction would change it. */
export function containsCredentialValue(value: string): boolean {
  return redact(value, false) !== value;
}

/**
 * True when an identifier or map key (an operationId, scope, package or
 * attribute name) holds a credential. The rules are those of
 * {@link containsCredentialValue}, except that `:` is a namespace separator
 * in identifiers, so `secrets:read` is a name while `token=abc` is not.
 */
export function containsCredentialIdentifier(value: string): boolean {
  return redact(value, true) !== value;
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
