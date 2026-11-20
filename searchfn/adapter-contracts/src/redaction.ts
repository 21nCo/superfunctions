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
// following field is kept. Only a leading Bearer, Basic or Token label is kept,
// and only when the next token on the same line is a valid credential token
// (RFC 6750 b64token / RFC 7617 base64: CREDENTIAL_TOKEN); before anything else
// (name=value, name:value, other punctuation) the label may itself be the
// secret, so key, separator and [REDACTED] are printed. After any other key the
// scheme word may be the secret too: when the next token is a name=value or
// "name:" assignment (ASSIGNMENT_TOKEN), the scheme word alone is the value, so
// it is redacted and scanning resumes at that assignment
// (password=basic connectionTimeout=5000 keeps connectionTimeout=5000, and
// password=basic token: x still redacts x); before anything else (a credential
// such as accessToken: Bearer x, or user:pass) word and token are redacted
// together, so the credential is never printed.
const KEY_VALUE_SECRET =
  /(\b[\w-]{0,64}?(?:api[_-]?key|password|passwd|secret|token|authorization|connection(?:[_-]?string)?)(?:\]|%5D)?)(["']?)(\s*[:=]\s*)(?:(["'])((?:\\.|(?!\4)[^\\\n])*)\4(?=$|[\s,;}\]&])|(["'])[^\n]*|((?:bearer|basic|token)[ \t]+)?([^\s,;]+))/gi;
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
// A name=value assignment (an = that is not only trailing base64 padding) or a
// "name:" key whose value follows after whitespace.
const ASSIGNMENT_TOKEN = /^[^=:]+(?:=(?!=*$)|:$)/;
const PLUS_SIGN = /\+/g;
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
 * key hides its whole value; other parameters stay readable.
 */
function redactSearchParams(params: URLSearchParams): string {
  const pairs: string[] = [];
  params.forEach((entry, key) => {
    const value = isSensitiveKey(key) ? REDACTED : redactSensitiveString(entry);
    pairs.push(`${encodeQueryComponent(redactSensitiveString(key))}=${encodeQueryComponent(value)}`);
  });
  return pairs.join("&");
}

/** The key of one URL parameter: its text after the last route delimiter. */
function urlParamKey(name: string): string {
  const start = Math.max(...URL_ROUTE_DELIMITERS.map((delimiter) => name.lastIndexOf(delimiter)));
  return name.slice(start + 1);
}

/** Decodes a raw query or fragment value (%XX escapes and + as space) for scanning. */
function decodeUrlValue(value: string): string {
  return decodePercentEscapes(value.replace(PLUS_SIGN, " "));
}

/**
 * Redacts one &-separated URL parameter on its own. When the text before its
 * first = already holds a secret (authorization:x=), the whole parameter goes
 * through the string redactor, so no part of that secret is copied as a key.
 * Otherwise a parameter whose decoded key is sensitive hides its whole value,
 * and any other parameter goes through the string redactor; if that finds
 * nothing but its decoded value holds a secret (note=token%3Dx), the whole
 * value is hidden.
 */
function redactUrlParam(param: string): string {
  const separator = param.indexOf("=");
  if (separator === -1) {
    return redactSensitiveString(param);
  }
  const key = param.slice(0, separator);
  const redacted = redactSensitiveString(param);
  if (redactSensitiveString(key) !== key) {
    return redacted;
  }
  if (isSensitiveKey(urlParamKey(key))) {
    return `${key}=${REDACTED}`;
  }
  if (redacted !== param) {
    return redacted;
  }
  const value = param.slice(separator + 1);
  const decoded = decodeUrlValue(value);
  if (decoded !== value && redactSensitiveString(decoded) !== decoded) {
    return `${key}=${REDACTED}`;
  }
  return param;
}

/**
 * Redacts the raw text of a URL query (without ?) or fragment (without #) and
 * keeps everything else as written: route text, empty parameters, encodings
 * and delimiters. URL userinfo is masked over the whole component first, so a
 * parameter split can never cut through it; then the component is split on &
 * once and each parameter is redacted on its own, so the work stays linear.
 */
function redactUrlComponent(raw: string): string {
  return raw
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(POSTGRES_CREDENTIALS, "$1[REDACTED]@")
    .split(URL_PARAM_SEPARATOR)
    .map(redactUrlParam)
    .join(URL_PARAM_SEPARATOR);
}

/**
 * Redacts a URL and keeps every delimiter of its href, including an empty ?
 * or #. The raw query and fragment go through redactUrlComponent; userinfo
 * becomes [REDACTED]@. In a serialised href, ? and # outside the query and
 * fragment are always percent-encoded, so the first # starts the fragment and
 * the first ? before it starts the query.
 */
function redactUrl(url: URL): string {
  const href = url.href;
  const hashStart = href.indexOf("#");
  const beforeHash = hashStart === -1 ? href : href.slice(0, hashStart);
  const queryStart = beforeHash.indexOf("?");
  const base = new URL(href);
  const hasUserinfo = base.username !== "" || base.password !== "";
  base.username = "";
  base.password = "";
  base.search = "";
  base.hash = "";
  let output = redactSensitiveString(base.href);
  if (hasUserinfo) {
    output = output.replace("//", `//${REDACTED}@`);
  }
  if (queryStart !== -1) {
    output += `?${redactUrlComponent(beforeHash.slice(queryStart + 1))}`;
  }
  if (hashStart !== -1) {
    output += `#${redactUrlComponent(href.slice(hashStart + 1))}`;
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

function redactKeyValues(input: string): string {
  const pattern = new RegExp(KEY_VALUE_SECRET.source, KEY_VALUE_SECRET.flags);
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const [whole, key, keyQuote, separator, valueQuote, , openQuote, scheme, credential] = match;
    let end = match.index + whole.length;
    let replacement: string;
    if (valueQuote) {
      replacement = `${key}${keyQuote}${separator}${valueQuote}${REDACTED}${valueQuote}`;
    } else if (openQuote) {
      replacement = `${key}${keyQuote}${separator}${openQuote}${REDACTED}`;
    } else if (AUTHORIZATION_KEY.test(key)) {
      const lineBreak = input.slice(end).search(LINE_BREAK);
      end = lineBreak === -1 ? input.length : end + lineBreak;
      const label = scheme !== undefined && CREDENTIAL_TOKEN.test(credential) ? scheme : "";
      replacement = `${key}${keyQuote}${separator}${label}${REDACTED}`;
    } else {
      if (scheme !== undefined && ASSIGNMENT_TOKEN.test(credential)) {
        // The scheme word is the whole value: end right after it and resume
        // scanning at the following assignment.
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
