// Credential detection shared by the catalog builder and the failure envelope.
// The rules are deliberately conservative: rejecting a harmless key such as
// `page_token` is preferable to persisting a live credential.

const CREDENTIAL_KEY_FRAGMENTS = [
  "authorization",
  "cookie",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "apikey",
  "accountkey",
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
 * True when a value holds nothing secret: only placeholders and punctuation.
 * In an Authorization or Cookie header, scheme names and parameter or cookie
 * names (`name=` before a value) are not secret either; elsewhere a scheme
 * word is part of the value.
 */
function isPlaceholderValue(value: string, header: boolean): boolean {
  let rest = value;
  // The lookbehind starts a name only at the start of a word, so a long word is scanned once, not once per character.
  if (header) rest = rest.replace(/(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]+\s*=(?![=\s]|$)/g, "").replace(AUTH_SCHEME_WORDS, "");
  return rest.replace(PLACEHOLDER, "").replace(/[\s"'`,;:=\\]/g, "") === "";
}

const KEY_WORD = "[A-Za-z0-9_.%-]+";
/**
 * A key of one or two words (`token`, `API key`), bare, quoted or with
 * backslash-escaped quotes, then `:`, `=`, `=>` or `:=`. This covers HTTP
 * headers, JSON (also escaped inside a string), JS object literals, query
 * strings and prose such as `Invalid API key: ...`. `scheme://` is a URL.
 */
const KEY_SEPARATOR = new RegExp(`(?<![A-Za-z0-9_.%-])(\\\\?["'\`]|)((?:${KEY_WORD}[ \\t]+)?${KEY_WORD})\\1[ \\t]*(=>|:=|[:=])(?!\\/\\/)[ \\t]*`, "g");
/** Identifiers use `:` as a namespace separator (`secrets:read`), so only `=`, `=>` and `:=` introduce a value there. */
const IDENTIFIER_KEY_SEPARATOR = new RegExp(`(?<![A-Za-z0-9_.%-])(\\\\?["'\`]|)((?:${KEY_WORD}[ \\t]+)?${KEY_WORD})\\1[ \\t]*(=>|:=|=)[ \\t]*`, "g");
/** A value that is not quoted or bracketed runs to the next delimiter; placeholders such as `<your token>` may hold spaces. */
const PLAIN_VALUE = new RegExp(`^(?:${PLACEHOLDER.source}|[^\\s&,;"'\`)\\]}])*`);
const SCHEME_ONLY = new RegExp(`^(?:${AUTH_SCHEMES})$`, "i");
/** A YAML block scalar indicator (`|`, `>-`, `|2+`, ...) or nothing, ending the key's line: the value is on the indented lines below. */
const BLOCK_HEAD = /^(?:[|>](?:[1-9]?[+-]?|[+-]?[1-9]?))?[ \t]*(?:#[^\r\n]*)?(?=\r?\n)/;
/** An XML element named like a credential: `<password>...</password>`. */
const XML_ELEMENT = /<([A-Za-z][A-Za-z0-9_.:-]*)>([^<]*)<\/\1>/g;

/**
 * End of a YAML block value whose first line break is at `from`: every
 * following line indented more than the key's line (`indent`), and blank
 * lines between them. Returns the start of the first content character and
 * the end of the last content line, or null when no line is indented further.
 * When indentation cannot be compared (tabs and spaces mixed), the block
 * fails closed and runs to the end of the text.
 */
function blockSpan(text: string, from: number, indent: string): { begin: number; end: number } | null {
  let begin = -1;
  let end = -1;
  for (let lineStart = from + 1; lineStart <= text.length; ) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (line.trim() !== "") {
      const lead = /^[ \t]*/.exec(line)![0];
      if (!lead.startsWith(indent) && !indent.startsWith(lead)) return { begin: begin === -1 ? lineStart + lead.length : begin, end: text.length };
      if (lead.length <= indent.length) break;
      if (begin === -1) begin = lineStart + lead.length;
      end = lineStart + line.length;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return begin === -1 ? null : { begin, end };
}

/** Leading spaces and tabs of the line holding `index`. */
function lineIndent(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const indent = /[ \t]*/y;
  indent.lastIndex = lineStart;
  return indent.exec(text)![0];
}

/** Headers whose whole value, with every scheme parameter, is a credential. */
function isHeaderKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return normalized.endsWith("authorization") || normalized.endsWith("cookie");
}

/** End of a quoted string that opens at `start`, after its closing quote; -1 when unterminated. */
function quotedEnd(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === quote) return index + 1;
  }
  return -1;
}

/** End of a balanced `{...}` or `[...]` that opens at `start`; -1 when unbalanced. */
function bracketedEnd(text: string, start: number): number {
  const closers: string[] = [];
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1; // An escaped character, such as \" inside escaped JSON, never opens or closes anything.
    } else if (char === '"' || char === "'" || char === "`") {
      const end = quotedEnd(text, index);
      if (end === -1) return -1;
      index = end - 1;
    } else if (char === "{" || char === "[") {
      closers.push(char === "{" ? "}" : "]");
    } else if (char === "}" || char === "]") {
      if (closers.pop() !== char) return -1;
      if (closers.length === 0) return index + 1;
    }
  }
  return -1;
}

interface ValueSpan {
  /** Where the redacted span starts; after the separator unless the value is on the next line. */
  begin?: number;
  end: number;
  /** The value without its delimiters. */
  value: string;
  /** Delimiters kept around the redacted value (`"`, `\\"`), or "" for none. */
  quote: string;
}

/**
 * Reads the whole value after a key: a quoted string (also with escaped
 * quotes), a balanced `{...}`/`[...]`, an Authorization or Cookie header line,
 * a YAML block (every line indented below the key), or a run up to the next
 * delimiter that also takes the token after a bare scheme word (`Bearer abc`).
 * A value that cannot be delimited fails closed: it runs to the end of the text.
 */
function readValue(text: string, start: number, keyStart: number, header: boolean): ValueSpan {
  const rest = text.slice(start);
  const escaped = /^\\(["'`])/.exec(rest);
  if (escaped) {
    const close = text.indexOf(`\\${escaped[1]}`, start + 2);
    if (close === -1) return { end: text.length, value: text.slice(start), quote: "" };
    return { end: close + 2, value: text.slice(start + 2, close), quote: `\\${escaped[1]}` };
  }
  const first = text[start];
  if (first === '"' || first === "'" || first === "`") {
    const end = quotedEnd(text, start);
    if (end === -1) return { end: text.length, value: text.slice(start), quote: "" };
    return { end, value: text.slice(start + 1, end - 1), quote: first };
  }
  if (first === "{" || first === "[") {
    const end = bracketedEnd(text, start);
    return { end: end === -1 ? text.length : end, value: text.slice(start, end === -1 ? text.length : end), quote: "" };
  }
  // `password: |`, `password: >-` or `password:` ending a line: the value is every line indented below the key (YAML block style).
  const head = BLOCK_HEAD.exec(rest);
  if (head) {
    const newline = text.indexOf("\n", start + head[0].length);
    const block = blockSpan(text, newline, lineIndent(text, keyStart));
    if (!block) return { end: start, value: "", quote: "" };
    return { begin: block.begin, end: block.end, value: text.slice(block.begin, block.end), quote: "" };
  }
  if (header) {
    const line = /^[^\r\n]*/.exec(rest)![0].trimEnd();
    return { end: start + line.length, value: line, quote: "" };
  }
  let run = PLAIN_VALUE.exec(rest)![0];
  if (SCHEME_ONLY.test(run)) {
    const token = /^[ \t]+/.exec(rest.slice(run.length));
    const next = token ? PLAIN_VALUE.exec(rest.slice(run.length + token[0].length))![0] : "";
    if (next !== "") run = rest.slice(0, run.length + token![0].length + next.length);
  }
  return { end: start + run.length, value: run, quote: "" };
}

/**
 * The key/value rule: a key that satisfies {@link isCredentialKey} (its last
 * word, or its last two words joined) makes its whole value a credential
 * unless all of the value is placeholders. In Authorization headers the
 * scheme name is kept so redacted text stays readable.
 */
function redactKeyValues(text: string, identifier: boolean): string {
  let output = "";
  let copied = 0;
  const pattern = new RegExp((identifier ? IDENTIFIER_KEY_SEPARATOR : KEY_SEPARATOR).source, "g");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const key = match[2];
    const lastWord = key.split(/[ \t]+/).pop()!;
    if (!isCredentialKey(lastWord) && !isCredentialKey(key)) continue;
    const start = match.index + match[0].length;
    const header = isHeaderKey(lastWord);
    const { begin = start, end, value, quote } = readValue(text, start, match.index, header);
    if (end <= start) continue;
    pattern.lastIndex = end;
    if (value.trim() === "" || isPlaceholderValue(value, header)) continue;
    const scheme = header ? (LEADING_AUTH_SCHEME.exec(value)?.[0] ?? "") : "";
    output += `${text.slice(copied, begin)}${quote}${scheme}${REDACTED}${quote}`;
    copied = end;
  }
  return (output + text.slice(copied)).replace(XML_ELEMENT, (element, name: string, value: string) =>
    isCredentialKey(name) && !isPlaceholderValue(value, false) && value.trim() !== "" ? `<${name}>${REDACTED}</${name}>` : element
  );
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
  { pattern: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{22,}/g },
  { pattern: /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{35}/g },
  { pattern: /(?<![A-Za-z0-9])(?:xox[abpr]|AKIA)[A-Za-z0-9-]{12,}/g },
  // Any URL user info, with or without a scheme and however many "@" it holds.
  // A scheme starts only at the start of a word, so a long word is scanned once, not once per character.
  {
    pattern: /((?:(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:)?\/\/)[^/\s?#]*@/gi,
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

/** True when a URL or URL template has user info in its authority. */
export function hasUrlUserInfo(url: string): boolean {
  return URL_PARTS.exec(url)?.[2].includes("@") ?? false;
}

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

function unescapeSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Not percent-encoded; judge the raw segment.
  }
  return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * One JSON Pointer segment for a diagnostic or issue. The raw key is redacted
 * before escaping: escaping first would turn the `//` of a URL key into
 * `~1~1` and hide its user info from the URL rule.
 */
export function pointerSegment(key: string): string {
  return redactCredentialValues(key).replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Redacts each segment of a JSON Pointer, judged on its unescaped (and percent-decoded) key; clean segments are kept as they are. */
export function sanitizePointer(pointer: string): string {
  return pointer
    .split("/")
    .map((segment) => {
      const key = unescapeSegment(segment);
      return containsCredentialValue(key) ? pointerSegment(key) : segment;
    })
    .join("/");
}

/**
 * The one sanitizer for every diagnostic and issue: the pointer is redacted
 * segment by segment, and the message (which may quote that pointer, keys or
 * values) is redacted as text.
 */
export function sanitizeReport(pointer: string, message: string): { pointer: string; message: string } {
  const safePointer = sanitizePointer(pointer);
  const quoted = pointer === "" ? message : message.split(pointer).join(safePointer);
  return { pointer: safePointer, message: redactCredentialValues(quoted) };
}
