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
/** An XML opening tag: its name, then any attributes. */
const XML_OPEN_TAG = /<([A-Za-z_][A-Za-z0-9_.:-]*)(\s[^<>]*)?>/g;
/** CDATA delimiters, removed before an element value is judged as placeholders. */
const CDATA_DELIMITERS = /<!\[CDATA\[|\]\]>/g;

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

/**
 * End of a string quoted with escaped quotes (`\"...\"`, as in JSON inside a
 * JSON string) that opens at `start`, after its closing `\"`. The text is
 * decoded one level as it is read, so an escaped quote inside the value
 * (`\\\"`) does not close it. Returns -1 when the closing delimiter is
 * ambiguous (an unescaped quote ends the outer string first) and -2 when
 * the value is unterminated.
 */
function escapedQuotedEnd(text: string, start: number): number {
  const quote = text[start + 1];
  let innerEscaped = false;
  for (let index = start + 2; index < text.length; ) {
    const pair = text[index] === "\\" && index + 1 < text.length;
    const char = pair ? text[index + 1] : text[index];
    index += pair ? 2 : 1;
    if (innerEscaped) innerEscaped = false;
    else if (pair && char === "\\") innerEscaped = true;
    else if (char === quote) return pair ? index : -1;
  }
  return -2;
}

/** End of the line holding `index`, before any line break. */
function lineEnd(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  if (newline === -1) return text.length;
  return text[newline - 1] === "\r" && newline - 1 >= index ? newline - 1 : newline;
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
    const end = escapedQuotedEnd(text, start);
    if (end === -1) return { end: lineEnd(text, start), value: text.slice(start, lineEnd(text, start)), quote: "" };
    if (end === -2) return { end: text.length, value: text.slice(start), quote: "" };
    return { end, value: text.slice(start + 2, end - 2), quote: `\\${escaped[1]}` };
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

/** Fields that name a header, parameter or setting: `{"name": "X-Api-Key", ...}`, `<add key="password" .../>`. */
const NAME_FIELD = new RegExp(
  `(?<![A-Za-z0-9_.%-])(\\\\?["'\`]|)(?:(?:(?:header|field|param(?:eter)?)[_-]?)?name|key|header|field|param(?:eter)?)\\1[ \\t]*(?:=>|:=|[:=])[ \\t]*(\\\\?["'\`]|)(${KEY_WORD})\\2(?![A-Za-z0-9_.%-])`,
  "gi"
);
/** Fields that hold the value of the header, parameter or setting their container names; mirrors {@link NAME_FIELD}. */
const VALUE_FIELD = /^(?:(?:(?:header|field|param(?:eter)?)[_-]?)?(?:values?|val)|content|data|default|examples?)$/i;

const CLOSERS: Record<string, string> = { "{": "}", "[": "]", "<": ">" };
const QUOTES = new Set(['"', "'", "`"]);

/**
 * For each index, the start of the innermost `{...}`, `[...]` or XML tag
 * holding it, or -1. Strings are skipped: a delimiter inside `"..."`,
 * `'...'`, `` `...` `` or an escaped-quoted `\"...\"` (decoded one level, as
 * {@link escapedQuotedEnd} reads it) neither opens nor closes a container, and
 * neither does an escaped character. A stray closer is ignored. When the
 * structure cannot be trusted (an unterminated or ambiguous quote, or a closer
 * that does not match the innermost open container) the whole text is one
 * container, which fails closed. One linear pass.
 */
function containerStarts(text: string): Int32Array {
  const starts = new Int32Array(text.length + 1);
  const stack: number[] = [];
  const open: Record<string, number> = { "}": 0, "]": 0, ">": 0 };
  const current = () => (stack.length === 0 ? -1 : stack[stack.length - 1]);
  for (let index = 0; index < text.length; ) {
    const char = text[index];
    let skip = 0; // The end of a string or escaped character that starts here.
    if (char === "\\") skip = QUOTES.has(text[index + 1] ?? "") ? escapedQuotedEnd(text, index) : Math.min(index + 2, text.length);
    else if (QUOTES.has(char)) skip = quotedEnd(text, index);
    if (skip < 0) return starts.fill(-1);
    if (skip > 0) {
      starts.fill(current(), index, skip);
      index = skip;
      continue;
    }
    starts[index] = current();
    if (char === "{" || char === "[" || (char === "<" && /[A-Za-z_]/.test(text[index + 1] ?? ""))) {
      stack.push(index);
      open[CLOSERS[char]] += 1;
    } else if (open[char] > 0) {
      if (CLOSERS[text[current()]] !== char) return starts.fill(-1);
      stack.pop();
      open[char] -= 1;
    }
    index += 1;
  }
  starts[text.length] = current();
  return starts;
}

/**
 * The containers whose name field holds a credential key, each mapped to
 * whether that key is an Authorization or Cookie header; null when there are
 * none, so ordinary text never pays for the container index.
 */
function namedCredentialContainers(text: string): { containers: Int32Array; headers: Map<number, boolean> } | null {
  let found: { containers: Int32Array; headers: Map<number, boolean> } | null = null;
  for (const match of text.matchAll(NAME_FIELD)) {
    if (!isCredentialKey(match[3])) continue;
    found ??= { containers: containerStarts(text), headers: new Map() };
    const container = found.containers[match.index];
    found.headers.set(container, (found.headers.get(container) ?? false) || isHeaderKey(match[3]));
  }
  return found;
}

/**
 * The key/value rule: a key that satisfies {@link isCredentialKey} (its last
 * word, or its last two words joined) makes its whole value a credential
 * unless all of the value is placeholders. So does a value field (`value`,
 * `content`, ...) whose container (`{...}`, `[...]` or an XML tag) has a
 * name field (`name`, `key`, `header`, ...) holding a credential key. In
 * Authorization headers the scheme name is kept so redacted text stays readable.
 */
function redactKeyValues(text: string, identifier: boolean): string {
  let output = "";
  let copied = 0;
  const named = namedCredentialContainers(text);
  const pattern = new RegExp((identifier ? IDENTIFIER_KEY_SEPARATOR : KEY_SEPARATOR).source, "g");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const key = match[2];
    const lastWord = key.split(/[ \t]+/).pop()!;
    // `{"name": "X-Api-Key", "value": "..."}`: the value field of a container whose name field holds a credential key.
    const container = named && VALUE_FIELD.test(lastWord) ? named.containers[match.index] : undefined;
    const indirect = container !== undefined && named!.headers.has(container);
    if (!indirect && !isCredentialKey(lastWord) && !isCredentialKey(key)) continue;
    const start = match.index + match[0].length;
    const header = indirect ? named!.headers.get(container)! : isHeaderKey(lastWord);
    const { begin = start, end, value, quote } = readValue(text, start, match.index, header);
    if (end <= start) continue;
    pattern.lastIndex = end;
    if (value.trim() === "" || isPlaceholderValue(value, header)) continue;
    const scheme = header ? (LEADING_AUTH_SCHEME.exec(value)?.[0] ?? "") : "";
    output += `${text.slice(copied, begin)}${quote}${scheme}${REDACTED}${quote}`;
    copied = end;
  }
  return output + text.slice(copied);
}

/** An XML attribute: its name, then a quoted or bare value. A name starts only at the start of a word, so the scan is linear. */
const XML_ATTRIBUTE = /(?<![A-Za-z0-9_.:-])([A-Za-z_][A-Za-z0-9_.:-]*)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>/=`]+))/g;
/** An XML closing tag and its name. */
const XML_CLOSE_TAG = /<\/([A-Za-z_][A-Za-z0-9_.:-]*)\s*>/g;

/** Redacts every attribute value of a credential-named element that is not all placeholders. */
function redactAttributeValues(attributes: string): string {
  return attributes.replace(XML_ATTRIBUTE, (whole, name: string, equals: string, double?: string, single?: string, bare?: string) => {
    const value = double ?? single ?? bare ?? "";
    if (value.trim() === "" || isPlaceholderValue(value, false)) return whole;
    const quote = double !== undefined ? '"' : single !== undefined ? "'" : "";
    return `${name}${equals}${quote}${REDACTED}${quote}`;
  });
}

/**
 * XML elements named like a credential: every attribute value is a
 * credential, and the element value runs from the end of the opening tag to
 * the matching closing tag, CDATA included. Without a closing tag the value
 * fails closed to the end of the text, unless the tag is a bare placeholder
 * such as `<token>` followed by a space, punctuation or the end of the text.
 */
function redactXmlElements(text: string): string {
  let output = "";
  let copied = 0;
  // Closing tags by name, indexed in one pass on first use. Opening tags are read in order, so each name's cursor only moves forward.
  let closings: Map<string, { at: number[]; length: number[]; next: number }> | null = null;
  const closing = (name: string, from: number) => {
    if (closings === null) {
      closings = new Map();
      for (const match of text.matchAll(XML_CLOSE_TAG)) {
        const entry = closings.get(match[1]) ?? { at: [], length: [], next: 0 };
        entry.at.push(match.index);
        entry.length.push(match[0].length);
        closings.set(match[1], entry);
      }
    }
    const entry = closings.get(name);
    if (!entry) return { at: -1, length: 0 };
    while (entry.next < entry.at.length && entry.at[entry.next] < from) entry.next += 1;
    return entry.next < entry.at.length ? { at: entry.at[entry.next], length: entry.length[entry.next] } : { at: -1, length: 0 };
  };
  const pattern = new RegExp(XML_OPEN_TAG.source, "g");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const [tag, name, attributes = ""] = match;
    if (!isCredentialKey(name)) continue;
    const start = match.index + tag.length;
    const safeAttributes = redactAttributeValues(attributes);
    if (safeAttributes !== attributes) {
      output += `${text.slice(copied, match.index)}<${name}${safeAttributes}>`;
      copied = start;
    }
    if (attributes.endsWith("/")) continue; // `<password value="..."/>` has no element value.
    const close = closing(name, start);
    if (close.at === -1 && !attributes.includes("=") && /^(?:$|[\s"'`.,;:!?)\]}])/.test(text.slice(start, start + 1))) continue;
    const end = close.at === -1 ? text.length : close.at;
    pattern.lastIndex = close.at === -1 ? text.length : close.at + close.length;
    const value = text.slice(start, end).replace(CDATA_DELIMITERS, "");
    if (value.trim() === "" || isPlaceholderValue(value, false)) continue;
    output += `${text.slice(copied, start)}${REDACTED}`;
    copied = end;
  }
  return output + text.slice(copied);
}

/** In identifiers, a namespace segment (`<key>:<segment>`) whose key is a credential key. */
const NAMESPACE_SEGMENT = /(?<![A-Za-z0-9_.%-])([A-Za-z0-9_.%-]+):(?!\/\/)([A-Za-z0-9_.~+%-]+)/g;

/**
 * True when an identifier segment after a credential-key namespace looks like
 * a value rather than a name: one of its words (split at `_`, `.` and `-`) is
 * token-shaped or has 16+ characters. `password:too_short`, `token:expired`
 * and `secrets:read` are names; `password:hunter2SEED99` is not.
 */
function isTokenSegment(segment: string): boolean {
  return segment.split(/[_.-]+/).some((word) => word.length >= 16 || /[+~%]/.test(word) || isTokenShaped(word));
}

/** Redacts token-shaped segments after a credential-key namespace in an identifier. */
function redactNamespaceSegments(text: string): string {
  const pattern = new RegExp(NAMESPACE_SEGMENT.source, "g");
  let output = "";
  let copied = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const [, key, segment] = match;
    const start = match.index + key.length + 1;
    if (!isCredentialKey(key) || !isTokenSegment(segment)) {
      pattern.lastIndex = start; // The segment can itself be the key of the next namespace (`a:password:...`).
      continue;
    }
    output += `${text.slice(copied, start)}${REDACTED}`;
    copied = start + segment.length;
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
  { pattern: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{22,}/g },
  { pattern: /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{35}/g },
  { pattern: /(?<![A-Za-z0-9])(?:xox[abpr]|AKIA)[A-Za-z0-9-]{12,}/g },
  // Any URL user info, with or without a scheme and however many "@" it holds.
  // A scheme starts only at the start of a word, so a long word is scanned once, not once per character.
  // Special schemes need no "//": URL parsers read user info from `https:user:pw@host` and `https:\\user:pw@host`.
  // The match takes the whole authority whether or not it holds an "@", so the scan never restarts inside it.
  {
    pattern: /((?<![a-z0-9+.-])(?:https?|wss?|ftp|file):[\/\\]*)([^/\s?#]*)/gi,
    accept: ([, authority]) => authority.includes("@"),
    replace: ([prefix, authority]) => `${prefix}${REDACTED}@${authority.slice(authority.lastIndexOf("@") + 1)}`,
  },
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

/** A PEM private key block, through its END line or, unterminated, to the end of the text. Bounded label runs keep it linear. */
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z0-9 ]{0,40}-----|$)/g;

function redact(value: string, identifier: boolean): string {
  const text = value.replace(PEM_PRIVATE_KEY, REDACTED);
  return SHAPE_RULES.reduce(
    (text, { pattern, accept, replace }) =>
      text.replace(pattern, (match: string, ...rest: unknown[]) => {
        // `rest` ends with the offset and the whole string after the capture groups.
        const groups = rest.slice(0, -2).map((group) => (typeof group === "string" ? group : ""));
        if (accept && !accept(groups)) return match;
        return replace ? replace(groups) : REDACTED;
      }),
    identifier ? redactNamespaceSegments(redactXmlElements(redactKeyValues(text, true))) : redactXmlElements(redactKeyValues(text, false))
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

/**
 * Prefix, authority, path and query. Special schemes (http, https, ws, wss,
 * ftp, file) need no "//": any run of "/" or "\\", even none, starts the
 * authority, as URL parsers read it.
 */
const URL_PARTS = /^((?:https?|wss?|ftp|file):[\/\\]*|(?:[a-z][a-z0-9+.-]*:)?\/\/)([^/?#]*)([^?#]*)(?:\?([^#]*))?/i;

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

/**
 * The spans that `stripUrlCredentials(url, { dropQuery: true })` removes:
 * the user info through its last "@", and everything from the first "?" or
 * "#" on. Lets a caller tell which part of an expanded URL template is gone.
 */
export function removedServerUrlSpans(url: string): Array<{ start: number; end: number; userInfo: boolean }> {
  const spans: Array<{ start: number; end: number; userInfo: boolean }> = [];
  const match = URL_PARTS.exec(url);
  const at = match ? match[2].lastIndexOf("@") : -1;
  if (match && at !== -1) spans.push({ start: match[1].length, end: match[1].length + at + 1, userInfo: true });
  const tail = url.search(/[?#]/);
  if (tail !== -1) spans.push({ start: tail, end: url.length, userInfo: false });
  return spans;
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
