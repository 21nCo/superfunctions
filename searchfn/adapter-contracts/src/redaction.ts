/** Shared log-context redaction for canonical SearchFn adapters. */
const SENSITIVE_KEY =
  /(?:api[_-]?key|password|passwd|secret|token|authorization)|connection(?:string|[_-]string)?(?=$|[^a-z])/i;

// key = value pairs inside strings. The key may carry a short prefix
// (accessToken, pgConnectionString, db_password) but must end in a sensitive
// word, so connectionTimeout or tokenCount stay readable; the prefix is bounded
// so matching stays linear on long hyphenated text. An optional quote after the
// key covers JSON ("password":"x"). A closed quoted value followed by a value
// boundary is replaced whole, including spaces; any other quote (unclosed, or
// closed with more characters attached) redacts to the end of the line;
// an unquoted value runs to the next whitespace, comma or semicolon (quotes and
// & inside it are redacted too). A bracketed key such as user[password] or
// user%5Bpassword%5D may close with "]" or "%5D" before the separator.
// An unquoted value after an authorization key is redacted to the end of its
// line, because schemes such as Digest or AWS4-HMAC-SHA256 carry
// comma-separated name=value parameters (Credential=..., Signature=...) that
// cannot be told apart from trailing diagnostics such as status=401, so no
// following field is kept. One rule (schemeWordStandsAlone) decides, for both
// key kinds, whether a Bearer, Basic or Token word is followed by a new key or
// assignment rather than a credential: it is when a sensitive key of this
// pattern's key group (dotted or bracket prefix, optional quote) followed by
// optional whitespace and : or = begins anywhere inside the next token, whether
// or not a value follows (token=, password=, db.password = x, "token" = x),
// or when that token, optionally quoted, is a name followed by optional
// whitespace and : or = (status = 401, name=value, name:), where an = attached
// to an unquoted non-sensitive name and followed only by more = is base64
// padding, not an assignment. After an authorization key the label is kept only when the next
// token on the same line is a valid credential token (RFC 6750 b64token /
// RFC 7617 base64: CREDENTIAL_TOKEN) and the scheme word does not stand alone;
// otherwise the label may itself be the secret, so key, separator and
// [REDACTED] are printed. After any other key the scheme word may be the secret
// too: when it stands alone it is the whole value, so it is redacted and
// scanning resumes at the next token (password=basic connectionTimeout=5000
// keeps connectionTimeout=5000, and password=basic token= x still redacts x);
// otherwise (a credential such as accessToken: Bearer x, or user:pass) word and
// token are redacted together, so the credential is never printed.
const KEY_VALUE_SECRET =
  /(\b[\w-]{0,64}?(?:api[_-]?key|password|passwd|secret|token|authorization|connection(?:[_-]?string)?)(?:\]|%5D)?)(["']?)(\s*[:=]\s*)(?:(["'])((?:\\.|(?!\4)[^\\\n])*)\4(?=$|[\s,;}\]&])|(["'])[^\n]*|((?:bearer|basic|token)[ \t]+)?([^\s,;]+))/gi;
// The key group of KEY_VALUE_SECRET and its separator, with or without a value,
// searched from one position (see sensitiveKeyStartsWithin).
const SENSITIVE_KEY_SEPARATOR_FIND =
  /\b[\w-]{0,64}?(?:api[_-]?key|password|passwd|secret|token|authorization|connection(?:[_-]?string)?)(?:\]|%5D)?["']?\s*[:=]/gi;
const URL_CREDENTIALS = /(https?:\/\/)([^\s/@]+)@/gi;
const POSTGRES_CREDENTIALS = /(postgres(?:ql)?:\/\/)([^\s/@]+)@/gi;
const AUTHORIZATION_KEY = /authorization(?:\]|%5D)?$/i;
const REDACTED = "[REDACTED]";
const ENCODED_REDACTED = /%5BREDACTED%5D/g;
const MAX_KEY_DECODE_PASSES = 3;

const PERCENT_ESCAPE = /%([0-9a-f]{2})/gi;
const LINE_BREAK = /[\r\n]/;
// A credential token after a scheme label: RFC 6750 b64token / RFC 7617 base64.
const CREDENTIAL_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
// At the token after a scheme word: a quoted name followed by optional
// whitespace and : or =, or an unquoted name followed by whitespace and : or =,
// by a : that ends the token, or by an = that is not only trailing base64
// padding (name=value). user:pass and dGVzdA== are not assignments.
const ASSIGNMENT_START =
  /(?:(["'])[^\s"'=:,;]+\1[ \t]*[:=]|[^\s"'=:,;]+(?:[ \t]+[:=]|:(?=[\s,;]|$)|=(?!=*(?:[\s,;]|$))))/y;
const PLUS_SIGN = /\+/g;
// A URL parameter value the string pass already masked whole, quotes kept.
const MASKED_VALUE = /^(["']?)\[REDACTED\]\1$/;
const URL_PARAM_SEPARATOR = "&";
const URL_ROUTE_DELIMITERS = ["/", "?", "#"];

/**
 * Decodes each well-formed %XX escape on its own and leaves malformed %
 * sequences as written, so one bad escape (%ZZ, a trailing %, invalid UTF-8)
 * cannot stop the rest of the key from being decoded. Bytes map to single
 * characters, which is enough to recognise the ASCII sensitive words.
 */
function decodePercentEscapes(input: string): string {
  return input.replace(PERCENT_ESCAPE, (_escape, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

/**
 * Tests a key against SENSITIVE_KEY as written and after up to
 * MAX_KEY_DECODE_PASSES escape-decoding passes, so keys that still carry
 * escapes after parsing (user%5Bpass%77ord%5D) are recognised.
 */
function isSensitiveKey(key: string): boolean {
  let candidate = key;
  for (let pass = 0; pass <= MAX_KEY_DECODE_PASSES; pass += 1) {
    if (SENSITIVE_KEY.test(candidate)) return true;
    if (pass === MAX_KEY_DECODE_PASSES) return false;
    const decoded = decodePercentEscapes(candidate);
    if (decoded === candidate) return false;
    candidate = decoded;
  }
  return false;
}

/** Form-encodes one query component, keeping the redaction marker readable. */
function encodeQueryComponent(input: string): string {
  return new URLSearchParams([["", input]]).toString().slice(1).replace(ENCODED_REDACTED, REDACTED);
}

/**
 * Redacts query parameters by their decoded keys, so bracketed or
 * percent-encoded keys such as user%5Bpassword%5D are recognised, including
 * keys that still hold escapes after parsing. A sensitive
 * key hides its whole value; other parameters stay readable. A key that still
 * holds escapes and whose decoded form holds a secret (authorization%3Ax) is
 * printed as [REDACTED] as a whole, and a value whose decoded form holds a
 * secret is hidden.
 */
function redactSearchParams(params: URLSearchParams): string {
  const pairs: string[] = [];
  params.forEach((entry, key) => {
    const redactedKey = redactSensitiveString(key);
    if (redactedKey === key && holdsSecret(key, false)) {
      pairs.push(REDACTED);
      return;
    }
    const redactedEntry = redactSensitiveString(entry);
    const hidden = isSensitiveKey(key) || (redactedEntry === entry && holdsSecret(entry, false));
    const value = hidden ? REDACTED : redactedEntry;
    pairs.push(`${encodeQueryComponent(redactedKey)}=${encodeQueryComponent(value)}`);
  });
  return pairs.join("&");
}

/** The key of one URL parameter: its text after the last route delimiter. */
function urlParamKey(name: string): string {
  const start = Math.max(...URL_ROUTE_DELIMITERS.map((delimiter) => name.lastIndexOf(delimiter)));
  return name.slice(start + 1);
}

/**
 * Whether the string redactor finds a secret in text as written or in up to
 * MAX_KEY_DECODE_PASSES escape-decoded forms of it (the first pass also reads
 * + as a space when plusAsSpace is set, as URL query text does).
 */
function holdsSecret(text: string, plusAsSpace: boolean): boolean {
  if (redactSensitiveString(text) !== text) return true;
  let candidate = text;
  for (let pass = 0; pass < MAX_KEY_DECODE_PASSES; pass += 1) {
    const source = pass === 0 && plusAsSpace ? candidate.replace(PLUS_SIGN, " ") : candidate;
    const decoded = decodePercentEscapes(source);
    if (decoded === candidate) return false;
    if (redactSensitiveString(decoded) !== decoded) return true;
    candidate = decoded;
  }
  return false;
}

/**
 * Additive post-pass over one already-redacted URL query (without ?) or
 * fragment (without #), split on & once so it stays linear. It only adds
 * masks and never re-emits raw text that the string pass changed:
 * (i) a parameter whose key (for a parameter without =, its whole text) holds
 * a secret as written or decoded becomes [REDACTED] as a whole;
 * (ii) a parameter whose key after the last route delimiter is sensitive,
 * and whose value is not already a (quoted) [REDACTED], becomes key=[REDACTED];
 * (iii) a parameter whose value holds a secret as written or decoded becomes
 * key=[REDACTED].
 * Empty parameters, route text and delimiters stay as written.
 */
function maskUrlComponent(component: string): string {
  return component
    .split(URL_PARAM_SEPARATOR)
    .map((param) => {
      if (param === "" || param === REDACTED) return param;
      const separator = param.indexOf("=");
      const key = separator === -1 ? param : param.slice(0, separator);
      if (holdsSecret(key, true)) return REDACTED;
      if (separator === -1) return param;
      const value = param.slice(separator + 1);
      if (MASKED_VALUE.test(value)) return param;
      if (isSensitiveKey(urlParamKey(key)) || holdsSecret(value, true)) return `${key}=${REDACTED}`;
      return param;
    })
    .join(URL_PARAM_SEPARATOR);
}

/**
 * Redacts a URL and keeps every delimiter of its href, including an empty ?
 * or #. Its first step is the pin's step: the base URL's own userinfo (any
 * scheme) becomes [REDACTED]@ and the whole href goes through the string
 * redactor, so embedded userinfo and key/value secrets are masked before any
 * & split. maskUrlComponent then adds masks to the redacted query and
 * fragment. In a serialised href, ? and # outside the query and fragment are
 * percent-encoded, and redaction only removes text or inserts [REDACTED], so
 * the first # left starts the fragment and the first ? before it the query.
 */
function redactUrl(url: URL): string {
  const base = new URL(url.href);
  const hasUserinfo = base.username !== "" || base.password !== "";
  base.username = "";
  base.password = "";
  const href = hasUserinfo ? base.href.replace("//", `//${REDACTED}@`) : base.href;
  const redacted = redactSensitiveString(href);
  const hashStart = redacted.indexOf("#");
  const beforeHash = hashStart === -1 ? redacted : redacted.slice(0, hashStart);
  const queryStart = beforeHash.indexOf("?");
  let output = queryStart === -1 ? beforeHash : beforeHash.slice(0, queryStart);
  if (queryStart !== -1) {
    output += `?${maskUrlComponent(beforeHash.slice(queryStart + 1))}`;
  }
  if (hashStart !== -1) {
    output += `#${maskUrlComponent(redacted.slice(hashStart + 1))}`;
  }
  return output;
}

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
    output[key] = isSensitiveKey(key) ? "[REDACTED]" : redactSensitiveInternal(entry, seen);
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
      if (value instanceof URL) {
        return redactUrl(value);
      }
      if (value instanceof URLSearchParams) {
        return redactSearchParams(value);
      }
      if (value instanceof Map) {
        const output = new Map<unknown, unknown>();
        for (const [key, entry] of value) {
          output.set(
            key,
            typeof key === "string" && isSensitiveKey(key) ? "[REDACTED]" : redactSensitiveInternal(entry, seen),
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
        if (isSensitiveKey(key)) {
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
  return redactKeyValues(input)
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(POSTGRES_CREDENTIALS, "$1[REDACTED]@");
}

/**
 * Whether a sensitive key and its separator (with or without a value) begin at
 * or after start and before end. Every KEY_VALUE_SECRET match begins with such
 * a key, so the search stops no later than the caller's next match and
 * repeated calls stay linear overall.
 */
function sensitiveKeyStartsWithin(input: string, start: number, end: number): boolean {
  SENSITIVE_KEY_SEPARATOR_FIND.lastIndex = start;
  const match = SENSITIVE_KEY_SEPARATOR_FIND.exec(input);
  return match !== null && match.index < end;
}

/**
 * Whether the scheme word before the token at [start, end) stands alone: a
 * sensitive key with its separator begins inside that token (an empty field
 * such as token= included), or the token is a name assignment.
 */
function schemeWordStandsAlone(input: string, start: number, end: number): boolean {
  if (sensitiveKeyStartsWithin(input, start, end)) return true;
  ASSIGNMENT_START.lastIndex = start;
  return ASSIGNMENT_START.test(input);
}

function redactKeyValues(input: string): string {
  const pattern = new RegExp(KEY_VALUE_SECRET.source, KEY_VALUE_SECRET.flags);
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const [whole, key, keyQuote, separator, valueQuote, , openQuote, scheme, credential] = match;
    let end = match.index + whole.length;
    // The scheme word is followed by a new key or assignment, not a credential.
    const standsAlone = scheme !== undefined && schemeWordStandsAlone(input, end - credential.length, end);
    let replacement: string;
    if (valueQuote) {
      replacement = `${key}${keyQuote}${separator}${valueQuote}${REDACTED}${valueQuote}`;
    } else if (openQuote) {
      replacement = `${key}${keyQuote}${separator}${openQuote}${REDACTED}`;
    } else if (AUTHORIZATION_KEY.test(key)) {
      const lineBreak = input.slice(end).search(LINE_BREAK);
      end = lineBreak === -1 ? input.length : end + lineBreak;
      const label = scheme !== undefined && !standsAlone && CREDENTIAL_TOKEN.test(credential) ? scheme : "";
      replacement = `${key}${keyQuote}${separator}${label}${REDACTED}`;
    } else {
      if (standsAlone) {
        // The scheme word is the whole value: end right after it and resume
        // scanning at the following key/value or assignment.
        end = end - credential.length - scheme.length + scheme.trimEnd().length;
      }
      replacement = `${key}${keyQuote}${separator}${REDACTED}`;
    }
    output += input.slice(cursor, match.index) + replacement;
    cursor = end;
    pattern.lastIndex = end;
  }
  return output + input.slice(cursor);
}
