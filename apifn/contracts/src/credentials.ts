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
  if (header) rest = rest.replace(/(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]+\s*=(?![=\s]|$)/g, "");
  // Placeholders go first, so a scheme word inside one (`$TOKEN`) cannot break it apart.
  rest = rest.replace(PLACEHOLDER, "");
  if (header) rest = rest.replace(AUTH_SCHEME_WORDS, "");
  return rest.replace(/[\s"'`,;:=\\]/g, "") === "";
}

const KEY_WORD = "[A-Za-z0-9_.%-]+";
/**
 * A quote, alone or escaped at any depth (`"`, `\"` or `\\\"`, as in JSON
 * stringified once or twice). A backslash run is read from its start only, so
 * a long run is scanned once, not once per backslash.
 */
const QUOTE_DELIMITER = "(?<!\\\\)\\\\+[\"'`]|[\"'`]";
/**
 * A key of one or two words (`token`, `API key`), bare, quoted or with
 * backslash-escaped quotes, then `:`, `=`, `=>` or `:=`. This covers HTTP
 * headers, JSON (also escaped inside a string, at any depth), JS object
 * literals, query strings and prose such as `Invalid API key: ...`.
 * `scheme://` is a URL.
 */
const KEY_SEPARATOR = new RegExp(`(?<![A-Za-z0-9_.%-])(${QUOTE_DELIMITER}|)((?:${KEY_WORD}[ \\t]+)?${KEY_WORD})\\1[ \\t]*(=>|:=|[:=])(?!\\/\\/)[ \\t]*`, "g");
/** Identifiers use `:` as a namespace separator (`secrets:read`), so only `=`, `=>` and `:=` introduce a value there. */
const IDENTIFIER_KEY_SEPARATOR = new RegExp(`(?<![A-Za-z0-9_.%-])(${QUOTE_DELIMITER}|)((?:${KEY_WORD}[ \\t]+)?${KEY_WORD})\\1[ \\t]*(=>|:=|=)[ \\t]*`, "g");
/** A YAML block scalar indicator (`|`, `>-`, `|2+`, ...) or nothing, then spaces; a block head when the line ends there or a `#` comment does. */
const BLOCK_INDICATOR = /(?:[|>](?:[1-9][+-]?|[+-][1-9]?)?)?[ \t]*/y;
/** What may follow a bracketed header value for it to end there: a delimiter or the end of the line. */
const HEADER_VALUE_END = /[^\S\r\n]*(?:[,;\]})]|[\r\n]|$)/y;
/** Characters that continue a word after a closing quote; punctuation that ends a sentence or a member does not. */
const WORD_CONTINUATION = /[A-Za-z0-9_$%+~*@-]/;
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

const CLOSERS: Record<string, string> = { "{": "}", "[": "]", "<": ">" };
const GROUP_CLOSERS: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
const QUOTES = new Set(['"', "'", "`"]);

/** End of a quoted string that opens at `start`, after its closing quote; -1 when unterminated. */
function quotedEnd(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === quote) return index + 1;
  }
  return -1;
}

/** Length of the run of backslashes at `index`. */
function backslashRun(text: string, index: number): number {
  let run = 0;
  while (text[index + run] === "\\") run += 1;
  return run;
}

/**
 * The quoting level of a quote after `run` backslashes: 0 for a raw quote,
 * 1 for `\"` (JSON inside a JSON string), 2 for `\\\"` (stringified twice),
 * and so on. Each level of decoding halves the run, and an odd run escapes
 * the quote at that level.
 */
function quoteLevel(run: number): number {
  let level = 0;
  for (let rest = run; rest % 2 === 1; rest = (rest - 1) / 2) level += 1;
  return level;
}

interface EscapedQuote {
  /** After the closing delimiter; when ambiguous, after the quote of a lower level; when unterminated, the end of the text. */
  end: number;
  status: "closed" | "ambiguous" | "unterminated";
  /** Lengths of the opening and (when closed) closing delimiters, backslashes included. */
  open: number;
  close: number;
}

/**
 * Reads a string quoted with escaped quotes (`\"...\"` as in JSON inside a
 * JSON string, `\\\"...\\\"` as in JSON stringified twice) whose backslash
 * run starts at `start`. The text is decoded level by level as it is read: a
 * quote of the same level closes the string, a quote of a deeper level (an
 * escaped quote inside the value, such as `\\\"` in `\"...\"`) is part of it,
 * and a quote of a lower level ends the outer string first, which makes the
 * closing delimiter ambiguous. The scan never passes the returned end, nor
 * `limit` (unterminated there).
 */
function escapedQuotedEnd(text: string, start: number, limit = text.length): EscapedQuote {
  const open = backslashRun(text, start) + 1;
  const quote = text[start + open - 1];
  const level = quoteLevel(open - 1);
  for (let index = start + open; index < limit; ) {
    const run = backslashRun(text, index);
    if (text[index + run] !== quote) {
      index += Math.max(run, 1);
      continue;
    }
    const found = quoteLevel(run);
    if (found === level) return { end: index + run + 1, status: "closed", open, close: run + 1 };
    if (found < level) return { end: index + run + 1, status: "ambiguous", open, close: 0 };
    index += run + 1;
  }
  return { end: limit, status: "unterminated", open, close: 0 };
}

/** When a quote escaped at some level (`\"`, `\\\"`, ...) starts at `index`, the length of its backslash run; otherwise 0. */
function escapedQuoteAt(text: string, index: number): number {
  const run = backslashRun(text, index);
  return run > 0 && QUOTES.has(text[index + run] ?? "") && quoteLevel(run) > 0 ? run : 0;
}

/** End of the line holding `index`, before any line break. */
function lineEnd(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  if (newline === -1) return text.length;
  return text[newline - 1] === "\r" && newline - 1 >= index ? newline - 1 : newline;
}

/**
 * Memoized scans of one text for one pass of a key or pair rule, so the work
 * each match does is bounded by the span it consumes: a bracketed value, a
 * line or a YAML block that several matches reach is scanned once.
 */
class TextScan {
  /** Bracket start -> its end after the matching closer, or -1 when unbalanced; one map for `{[`, one for `{[(`. */
  private readonly brackets = new Map<number, number>();
  private readonly groups = new Map<number, number>();
  /** Quote start -> its end after the closing quote, or -1 when unterminated. */
  private readonly quotes = new Map<number, number>();
  private structured?: Structure;
  /** Positions of every `\r` and `\n`, in order. */
  private breaks?: number[];
  /** Line break ending a key's line -> the YAML block below it. */
  private readonly blocks = new Map<number, { begin: number; end: number } | null>();

  constructor(readonly text: string) {}

  /** End of a balanced `{...}` or `[...]` that opens at `start`; -1 when unbalanced. */
  bracketedEnd(start: number): number {
    return this.balancedEnd(start, this.brackets, false);
  }

  /** End of a balanced `{...}`, `[...]` or `(...)` that opens at `start`; -1 when unbalanced. */
  groupEnd(start: number): number {
    return this.balancedEnd(start, this.groups, true);
  }

  /** End of a quoted string that opens at `start` (see {@link quotedEnd}). */
  quotedEnd(start: number): number {
    let end = this.quotes.get(start);
    if (end === undefined) this.quotes.set(start, (end = quotedEnd(this.text, start)));
    return end;
  }

  /** The containers and strings of the text (see {@link textStructure}), computed once. */
  structure(): Structure {
    return (this.structured ??= textStructure(this.text));
  }

  /**
   * Every bracket the scan passes is recorded with its end, and a recorded
   * inner bracket is skipped, so nested values are scanned once.
   */
  private balancedEnd(start: number, memo: Map<number, number>, parentheses: boolean): number {
    const known = memo.get(start);
    if (known !== undefined) return known;
    const { text } = this;
    const open: number[] = [];
    const fail = () => {
      for (const opener of open) memo.set(opener, -1);
      return -1;
    };
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (char === "\\") {
        index += 1; // An escaped character, such as \" inside escaped JSON, never opens or closes anything.
      } else if (QUOTES.has(char)) {
        const end = this.quotedEnd(index);
        if (end === -1) return fail();
        index = end - 1;
      } else if (char === "{" || char === "[" || (parentheses && char === "(")) {
        const inner = index === start ? undefined : memo.get(index);
        if (inner === -1) return fail(); // Unbalanced inside means unbalanced outside.
        if (inner !== undefined) index = inner - 1;
        else open.push(index);
      } else if (char === "}" || char === "]" || (parentheses && char === ")")) {
        if (GROUP_CLOSERS[text[open[open.length - 1]]] !== char) return fail();
        memo.set(open.pop()!, index + 1);
        if (open.length === 0) return index + 1;
      }
    }
    return fail();
  }

  /** The first `\r` or `\n` at or after `index`, or the end of the text. */
  lineBreak(index: number): number {
    const breaks = (this.breaks ??= Array.from(this.text.matchAll(/[\r\n]/g), (match) => match.index));
    let [low, high] = [0, breaks.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (breaks[middle] < index) low = middle + 1;
      else high = middle;
    }
    return low < breaks.length ? breaks[low] : this.text.length;
  }

  /**
   * When the value at `start` is a YAML block head (`|`, `>-` or nothing,
   * optionally a `#` comment, then the end of the line), the `\n` ending the
   * key's line and where the comment starts (or -1); otherwise null. As in
   * YAML, a `#` starts a comment only after a space or tab: `Pwd=#abc` and
   * `password: |#abc` are values.
   */
  blockHead(start: number): { newline: number; comment: number } | null {
    BLOCK_INDICATOR.lastIndex = start;
    BLOCK_INDICATOR.exec(this.text);
    const after = BLOCK_INDICATOR.lastIndex;
    const comment = this.text[after] === "#" && (this.text[after - 1] === " " || this.text[after - 1] === "\t") ? after : -1;
    const stop = comment === -1 ? after : this.lineBreak(after);
    if (this.text[stop] === "\n") return { newline: stop, comment };
    if (this.text[stop] === "\r" && this.text[stop + 1] === "\n") return { newline: stop + 1, comment };
    return null;
  }

  /** The YAML block below the key at `keyStart` whose line ends at `newline` (see {@link blockSpan}); keys on one line share it. */
  block(newline: number, keyStart: number): { begin: number; end: number } | null {
    if (!this.blocks.has(newline)) this.blocks.set(newline, blockSpan(this.text, newline, lineIndent(this.text, keyStart)));
    return this.blocks.get(newline)!;
  }
}

interface ValueSpan {
  /** Where the redacted span starts; after the separator unless the value is on the next line. */
  begin?: number;
  end: number;
  /** The value without its delimiters. */
  value: string;
  /** Delimiters kept around the redacted value (`"`, `\"`), or "" for none; `closing` when the closing one differs. */
  quote: string;
  closing?: string;
}

/** Where a value that is not quoted or bracketed may end before the end of its line; see {@link plainEnd}. */
interface PlainContext {
  /** The closer of the container holding the key (`}`, `]`, `)` or `>`), or "" outside one. */
  closer: string;
  /** A comma separates members of that container. */
  comma: boolean;
  /** `;` and `&` separate `key=value` settings, as in connection and query strings. */
  settings: boolean;
  /** A ` #` starts a comment (YAML, .env); only outside containers and strings. */
  comment: boolean;
  /** Start of the closing delimiter of the string holding the key, or -1 outside one. */
  stringClose: number;
}

/**
 * End of a value that is not quoted or bracketed: it runs to the end of its
 * line and stops earlier only at a delimiter that ends a value in the
 * surrounding syntax (see {@link PlainContext}), never at whitespace inside
 * it, so `password: first second` is one value. Quoted strings and balanced
 * `{...}`, `[...]` and `(...)` inside the value are part of it; an unbalanced
 * one fails closed to the end of the text (or of the string holding the key).
 * Trailing whitespace is left out. Nothing is scanned beyond the returned end
 * except through `scan`'s memos.
 */
function plainEnd(scan: TextScan, start: number, context: PlainContext): number {
  const { text } = scan;
  const limit = context.stringClose === -1 ? text.length : context.stringClose;
  let stop = Math.min(scan.lineBreak(start), limit);
  let end = start;
  for (let index = start; index < stop; ) {
    const char = text[index];
    let skip = -1; // The end of an escaped character, string or group that starts here.
    if (char === "\\") skip = index + 2;
    else if (QUOTES.has(char)) skip = scan.quotedEnd(index); // An unterminated quote is a character of the value.
    else if (char === "{" || char === "[" || char === "(") {
      skip = scan.groupEnd(index);
      if (skip === -1) return limit;
    } else if (char === context.closer || (context.closer === ">" && char === "/" && text[index + 1] === ">")) break;
    else if ((char === "," && context.comma) || ((char === ";" || char === "&") && context.settings)) break;
    else if (char === "#" && context.comment && (text[index - 1] === " " || text[index - 1] === "\t") && index > start) break;
    if (skip > limit) return limit;
    if (skip !== -1) {
      index = end = skip;
      if (index > stop) stop = Math.min(scan.lineBreak(index), limit); // A string may span lines.
      continue;
    }
    index += 1;
    if (char !== " " && char !== "\t") end = index;
  }
  return end;
}

/**
 * Reads the whole value after a key: a quoted string (also with quotes
 * escaped at any depth), a balanced `{...}`/`[...]`, an Authorization or
 * Cookie header line, a YAML block (every line indented below the key), or a
 * run to the end of the line that stops earlier only where `context` says the
 * surrounding syntax ends it. A value that cannot be delimited fails closed:
 * it runs to the end of the text. Nothing is scanned beyond the returned end
 * except through `scan`'s memos.
 */
function readValue(scan: TextScan, start: number, keyStart: number, header: boolean, context: () => PlainContext): ValueSpan {
  const { text } = scan;
  const first = text[start];
  // A closing quote directly followed by a word character does not end the value: the shell or dotenv word goes on (`PASSWORD="<token>"abc`).
  const concatenated = (end: number): ValueSpan | null => {
    if (!WORD_CONTINUATION.test(text[end] ?? "")) return null;
    const stop = plainEnd(scan, end, context());
    return { end: stop, value: text.slice(start, stop), quote: "" };
  };
  if (escapedQuoteAt(text, start) > 0) {
    const { end, status, open, close } = escapedQuotedEnd(text, start);
    if (status === "closed") return concatenated(end) ?? { end, value: text.slice(start + open, end - close), quote: text.slice(start, start + open), closing: text.slice(end - close, end) };
    // Ambiguous: to the end of the line, or past the lower-level quote when that is further. Unterminated: to the end of the text.
    const stop = Math.max(end, lineEnd(text, start));
    return { end: stop, value: text.slice(start, stop), quote: "" };
  }
  if (QUOTES.has(first)) {
    const end = scan.quotedEnd(start);
    if (end === -1) return { end: text.length, value: text.slice(start), quote: "" };
    return concatenated(end) ?? { end, value: text.slice(start + 1, end - 1), quote: first };
  }
  // `password: |`, `password: >-` or `password:` ending a line: the value is every line indented below the key (YAML block style).
  const head = scan.blockHead(start);
  if (head) {
    const block = scan.block(head.newline, keyStart);
    if (!block) return { end: start, value: "", quote: "" };
    return { begin: block.begin, end: block.end, value: text.slice(block.begin, block.end), quote: "" };
  }
  if (first === "{" || first === "[") {
    const close = scan.bracketedEnd(start);
    if (close === -1) return { end: text.length, value: text.slice(start), quote: "" };
    // The value runs to its real delimiter, so a placeholder such as `[REDACTED]` or `{{token}}` followed by
    // more text is judged with it. In a header the rest of the line belongs to the value unless a delimiter follows.
    let end: number;
    if (header) {
      HEADER_VALUE_END.lastIndex = close;
      end = HEADER_VALUE_END.test(text) ? close : close + text.slice(close, scan.lineBreak(close)).trimEnd().length;
    } else {
      end = plainEnd(scan, close, context());
    }
    return { end, value: text.slice(start, end), quote: "" };
  }
  if (header) {
    const line = text.slice(start, scan.lineBreak(start)).trimEnd();
    return { end: start + line.length, value: line, quote: "" };
  }
  const end = plainEnd(scan, start, context());
  return { end, value: text.slice(start, end), quote: "" };
}

/** A JSON or JS escape in a name, at any depth. */
const NAME_ESCAPE = /\\+(?:u([0-9a-fA-F]{4})|(.))/g;
const NAME_ESCAPE_CHARACTERS: Record<string, string> = { t: "\t", n: "\n", r: "\r", f: "\f", v: "\v", b: "\b" };

/** A quoted name as its string holds it: `API\tkey` read as `API<tab>key` and `the \"API key\"` as `the "API key"`, as structured data has them. */
function decodeNameEscapes(name: string): string {
  return name.replace(NAME_ESCAPE, (_match, hex: string | undefined, character: string) =>
    hex === undefined ? (NAME_ESCAPE_CHARACTERS[character] ?? character) : String.fromCharCode(Number.parseInt(hex, 16))
  );
}
/**
 * Fields that name a header, parameter or setting: `{"name": "X-Api-Key", ...}`,
 * `<add key="password" .../>`. A quoted name is read from its opening
 * delimiter by {@link quotedName}; a bare name is one or two words.
 */
const NAME_FIELD = new RegExp(
  `(?<![A-Za-z0-9_.%-])(${QUOTE_DELIMITER}|)(?:(?:(?:header|field|param(?:eter)?)[_-]?)?name|key|header|field|param(?:eter)?)\\1[ \\t]*(?:=>|:=|[:=])[ \\t]*` +
    `(?:(${QUOTE_DELIMITER})|(${KEY_WORD}(?:[ \\t]+${KEY_WORD})?)(?![A-Za-z0-9_.%-]))`,
  "gi"
);
/**
 * A quoted name whose opening delimiter starts at `start`, read as the
 * structured rule reads a name: up to its real closing delimiter (the same
 * quote at the same escape level, as {@link quotedEnd} and
 * {@link escapedQuotedEnd} read strings), so quotes of another type and
 * deeper-escaped quotes are part of it (`user's password`, `the \"API key\"`);
 * then decoded and trimmed, so a raw character and its escape read alike.
 * Null when the line ends first. Returns where the closing delimiter starts
 * and ends.
 */
function quotedName(scan: TextScan, start: number): { name: string; close: number; end: number } | null {
  const { text } = scan;
  const limit = scan.lineBreak(start);
  const run = backslashRun(text, start);
  let found: { from: number; close: number; end: number } | null = null;
  if (quoteLevel(run) === 0) {
    // A raw quote, or one after an even backslash run, which escapes nothing.
    const quote = text[start + run];
    for (let index = start + run + 1; index < limit; index += 1) {
      if (text[index] === "\\") index += 1;
      else if (text[index] === quote) {
        found = { from: start + run + 1, close: index, end: index + 1 };
        break;
      }
    }
  } else {
    const quoted = escapedQuotedEnd(text, start, limit);
    if (quoted.status === "closed") found = { from: start + quoted.open, close: quoted.end - quoted.close, end: quoted.end };
  }
  if (!found) return null;
  return { name: decodeNameEscapes(text.slice(found.from, found.close)).trim(), close: found.close, end: found.end };
}
/** Fields that hold the value of the header, parameter or setting their container names; mirrors {@link NAME_FIELD}. */
const VALUE_FIELD = /^(?:(?:header|field|param(?:eter)?)[_-]?)?(?:values?|val|content|data|default|examples?)$/i;
/** The member names {@link NAME_FIELD} matches in text, for structured data. */
const NAME_FIELD_KEY = /^(?:(?:(?:header|field|param(?:eter)?)[_-]?)?name|key|header|field|param(?:eter)?)$/i;

/**
 * The name/value rule of {@link redactKeyValues} for structured data: when a
 * name field of `record` holds a credential key, its value fields are
 * credentials unless they are empty, null or only placeholders. Returns those
 * value-field keys, so `{name: "X-Api-Key", value: "..."}` is judged the same
 * as an object or in text.
 */
export function credentialValueFields(record: Record<string, unknown>): string[] {
  let header: boolean | undefined;
  for (const [key, child] of Object.entries(record)) {
    if (NAME_FIELD_KEY.test(key) && typeof child === "string" && isCredentialKey(child.trim())) header = header === true || isHeaderKey(child.trim());
  }
  if (header === undefined) return [];
  return Object.entries(record)
    .filter(([key, child]) => VALUE_FIELD.test(key) && child !== null && !(typeof child === "string" && (child.trim() === "" || isPlaceholderValue(child, header))))
    .map(([key]) => key);
}

interface Structure {
  /** For each index, the start of the innermost `{...}`, `[...]` or XML tag holding it, or -1. */
  containers: Int32Array;
  /** For each index inside a string, where the string's closing delimiter starts; -1 outside strings. */
  stringCloses: Int32Array;
}

/**
 * The containers and strings of a text. Strings are skipped: a delimiter
 * inside `"..."`, `'...'`, `` `...` `` or a string quoted with escaped quotes
 * at any depth (`\"...\"`, `\\\"...\\\"`, read as {@link escapedQuotedEnd}
 * reads them) neither opens nor closes a container, and neither does an
 * escaped character. When the structure cannot be trusted (an unterminated or
 * ambiguous quote, a closer that does not match the innermost open container,
 * or a stray closer with no open container, as an unquoted `}` in a regex,
 * comment or prose leaves behind) the whole text is one container with no
 * strings, which fails closed. One linear pass.
 */
function textStructure(text: string): Structure {
  const containers = new Int32Array(text.length + 1);
  const stringCloses = new Int32Array(text.length + 1).fill(-1);
  const untrusted = () => ({ containers: containers.fill(-1), stringCloses: stringCloses.fill(-1) });
  const stack: number[] = [];
  const current = () => (stack.length === 0 ? -1 : stack[stack.length - 1]);
  for (let index = 0; index < text.length; ) {
    const char = text[index];
    let skip = 0; // The end of a string or escaped character that starts here.
    let close = -1; // For a string, where its closing delimiter starts.
    if (escapedQuoteAt(text, index) > 0) {
      const quoted = escapedQuotedEnd(text, index);
      if (quoted.status !== "closed") return untrusted();
      [skip, close] = [quoted.end, quoted.end - quoted.close];
    } else if (char === "\\") {
      // An odd run escapes the character after it; an even run (before a raw quote, say) escapes nothing.
      const run = backslashRun(text, index);
      skip = Math.min(index + run + (run % 2), text.length);
    } else if (QUOTES.has(char)) {
      skip = quotedEnd(text, index);
      if (skip === -1) return untrusted();
      close = skip - 1;
    }
    if (skip > 0) {
      containers.fill(current(), index, skip);
      if (close !== -1) stringCloses.fill(close, index, skip);
      index = skip;
      continue;
    }
    containers[index] = current();
    if (char === "{" || char === "[" || (char === "<" && /[A-Za-z_]/.test(text[index + 1] ?? ""))) {
      stack.push(index);
    } else if (char === "}" || char === "]" || char === ">") {
      // With no open container, current() is -1 and nothing matches.
      if (CLOSERS[text[current()]] !== char) return untrusted();
      stack.pop();
    }
    index += 1;
  }
  containers[text.length] = current();
  return { containers, stringCloses };
}

/**
 * Where the plain value of a key at `keyStart` may end (see {@link plainEnd}):
 * at the closing delimiter of a string holding the key; otherwise at a comma
 * or the closer of the container holding it, or at a ` #` comment outside
 * containers. `;` and `&` end `key=value` settings in either case.
 */
function keyValueContext(scan: TextScan, keyStart: number, start: number, separator: string): PlainContext {
  const { containers, stringCloses } = scan.structure();
  const stringClose = stringCloses[keyStart] >= start ? stringCloses[keyStart] : -1;
  const opener = stringClose === -1 ? scan.text[containers[keyStart]] ?? "" : "";
  return {
    closer: CLOSERS[opener] ?? "",
    comma: opener === "{" || opener === "[",
    settings: separator !== ":",
    comment: stringClose === -1 && opener === "",
    stringClose,
  };
}

interface NamedContainers {
  containers: Int32Array;
  headers: Map<number, boolean>;
  /** Where the delimiter closing each quoted credential name starts, mapped to where it ends. */
  nameCloses: Map<number, number>;
}

/**
 * The containers whose name field holds a credential key, each mapped to
 * whether that key is an Authorization or Cookie header; null when there are
 * none, so ordinary text never pays for the container index.
 */
function namedCredentialContainers(scan: TextScan): NamedContainers | null {
  let found: NamedContainers | null = null;
  const pattern = new RegExp(NAME_FIELD.source, NAME_FIELD.flags);
  for (let match = pattern.exec(scan.text); match; match = pattern.exec(scan.text)) {
    let name = match[3];
    let close: { close: number; end: number } | undefined;
    if (match[2] !== undefined) {
      const quoted = quotedName(scan, match.index + match[0].length - match[2].length);
      if (!quoted) continue;
      // The name is consumed whole, so a field inside it (`"name: x"`) is not read again.
      pattern.lastIndex = quoted.end;
      [name, close] = [quoted.name, quoted];
    }
    if (!isCredentialKey(name)) continue;
    found ??= { containers: scan.structure().containers, headers: new Map(), nameCloses: new Map() };
    const container = found.containers[match.index];
    found.headers.set(container, (found.headers.get(container) ?? false) || isHeaderKey(name));
    if (close) found.nameCloses.set(close.close, close.end);
  }
  return found;
}

/** The first index at or after `index` that is not whitespace within a line. */
function afterSpaces(text: string, index: number): number {
  while (index < text.length && /[^\S\r\n\u2028\u2029]/.test(text[index])) index += 1;
  return index;
}

/** An XML attribute name and its `=`, as the next field of a tag. */
const NEXT_XML_ATTRIBUTE = /[A-Za-z_:][\w.:-]*\s*=/y;

/**
 * Whether a field ends at `index`, right after a quoted name, so nothing there
 * can be the name's value: the closing delimiter of a string holding the
 * name, the next attribute of an XML tag, the end of the text, or a comma or
 * closer where {@link plainEnd} ends a field, which is only for the container
 * holding it. At top level a comma or closer is part of the value.
 */
function endsNameField(scan: TextScan, index: number): boolean {
  const { text } = scan;
  if (index >= text.length) return true;
  if (",}])>/".includes(text[index]) && plainEnd(scan, index, keyValueContext(scan, index, index, ":")) === index) return true;
  const { containers, stringCloses } = scan.structure();
  if (stringCloses[index] === index) return true;
  NEXT_XML_ATTRIBUTE.lastIndex = index;
  return text[containers[index]] === "<" && NEXT_XML_ATTRIBUTE.test(text);
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
  const scan = new TextScan(text);
  const named = namedCredentialContainers(scan);
  const pattern = new RegExp((identifier ? IDENTIFIER_KEY_SEPARATOR : KEY_SEPARATOR).source, "g");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const key = match[2];
    const lastWord = key.split(/[ \t]+/).pop()!;
    // `{"name": "X-Api-Key", "value": "..."}`: the value field of a container whose name field holds a credential key.
    const container = named && VALUE_FIELD.test(lastWord) ? named.containers[match.index] : undefined;
    const indirect = container !== undefined && named!.headers.has(container);
    if (!indirect && !isCredentialKey(lastWord) && !isCredentialKey(key)) continue;
    let start = match.index + match[0].length;
    let keyStart = match.index;
    const nameEnd = named?.nameCloses.get(afterSpaces(text, start));
    if (nameEnd !== undefined) {
      // A quoted credential name that ends in its separator (`"X-Api-Key:"`): what follows its closing quote on the
      // line is its value. When a field ends right there (an empty read at the comma or closer of its container), the
      // container's value field holds the value instead. The name's own separator is not the field's, so `;` and `&`
      // do not end the value.
      start = afterSpaces(text, nameEnd);
      if (endsNameField(scan, start)) continue;
      keyStart = start;
    }
    const header = indirect ? named!.headers.get(container)! : isHeaderKey(lastWord);
    const separator = nameEnd === undefined ? match[3] : ":";
    const { begin = start, end, value, quote, closing = quote } = readValue(scan, start, match.index, header, () => keyValueContext(scan, keyStart, start, separator));
    if (end <= start) continue;
    pattern.lastIndex = end;
    if (begin > start) {
      // Before a YAML block: the rest of the key's line, such as a `# token=...` comment, is judged as text of its own.
      const gap = redactKeyValues(text.slice(start, begin), identifier);
      output += `${text.slice(copied, start)}${gap}`;
      copied = begin;
    }
    if (value.trim() === "" || isPlaceholderValue(value, header)) continue;
    const scheme = header ? (LEADING_AUTH_SCHEME.exec(value)?.[0] ?? "") : "";
    output += `${text.slice(copied, begin)}${quote}${scheme}${REDACTED}${closing}`;
    copied = end;
  }
  return output + text.slice(copied);
}

/**
 * A two-element list or tuple opening with a quoted credential key: an opening
 * `[` or `(`, the key (spaces inside its quotes trimmed), a comma, then the
 * value; after it an optional trailing comma and the matching `]` or `)`. This
 * covers JSON, escaped JSON, JS literals and Python reprs of header entries
 * (`new Headers([[name, value]])`, `dict_items([(name, value)])`).
 */
const PAIR_KEY = new RegExp(`([\\[(])\\s*(${QUOTE_DELIMITER})\\s*((?:${KEY_WORD}[ \\t]+)?${KEY_WORD})\\s*\\2\\s*,\\s*`, "g");
const PAIR_END = /\s*(?:,\s*)?([\])])/y;
/** After a value, what makes the list not a pair: another element or a closer that does not match. */
const LIST_GOES_ON = /\s*[,\])}]/y;
const PAIR_CLOSERS: Record<string, string> = { "[": "]", "(": ")" };
/** A key as {@link PAIR_KEY} reads it, for structured data. */
const PAIR_KEY_TEXT = new RegExp(`^(?:${KEY_WORD}[ \\t]+)?${KEY_WORD}$`);

/**
 * True when `list` is a name/value pair naming a credential: two elements, the
 * first a credential key (one or two words once trimmed, as in text) and the
 * second a value that is not empty, null or only placeholders. Text and
 * structured data judge pairs alike.
 */
export function isCredentialPair(list: readonly unknown[]): boolean {
  if (list.length !== 2 || typeof list[0] !== "string") return false;
  const [name, value] = [list[0].trim(), list[1]];
  if (!PAIR_KEY_TEXT.test(name) || !isCredentialKey(name) || value === null) return false;
  return !(typeof value === "string" && (value.trim() === "" || isPlaceholderValue(value, isHeaderKey(name))));
}

/**
 * The pair rule in text: the second element of a two-element list or tuple
 * whose first is a quoted credential key is a credential. A plain value runs
 * to the comma or closer that ends it (see {@link plainEnd}). A longer list or
 * a mismatched closer is not a pair; a value that no comma or closer follows
 * cannot be shown to end the list and fails closed.
 */
function redactPairs(text: string): string {
  let output = "";
  let copied = 0;
  const scan = new TextScan(text);
  const pattern = new RegExp(PAIR_KEY.source, "g");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const key = match[3];
    if (!isCredentialKey(key)) continue;
    const start = match.index + match[0].length;
    const header = isHeaderKey(key);
    const closer = PAIR_CLOSERS[match[1]];
    const context = (): PlainContext => {
      const close = scan.structure().stringCloses[match.index];
      return { closer, comma: true, settings: false, comment: false, stringClose: close >= start ? close : -1 };
    };
    const { end, value, quote, closing = quote } = readValue(scan, start, match.index, header, context);
    if (end <= start) continue;
    PAIR_END.lastIndex = end;
    LIST_GOES_ON.lastIndex = end;
    if (PAIR_END.exec(text)?.[1] !== closer && LIST_GOES_ON.test(text)) continue;
    pattern.lastIndex = end;
    if (value.trim() === "" || isPlaceholderValue(value, header)) continue;
    const scheme = header ? (LEADING_AUTH_SCHEME.exec(value)?.[0] ?? "") : "";
    output += `${text.slice(copied, start)}${quote}${scheme}${REDACTED}${closing}`;
    copied = end;
  }
  return output + text.slice(copied);
}

/** An XML attribute: its name, then a quoted or bare value. A name starts only at the start of a word, so the scan is linear. */
const XML_ATTRIBUTE = /(?<![A-Za-z0-9_.:-])([A-Za-z_][A-Za-z0-9_.:-]*)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>/=`]+))/g;
/** Redacts every attribute value of a credential-named element that is not all placeholders. */
function redactAttributeValues(attributes: string): string {
  return attributes.replace(XML_ATTRIBUTE, (whole, name: string, equals: string, double?: string, single?: string, bare?: string) => {
    const value = double ?? single ?? bare ?? "";
    if (value.trim() === "" || isPlaceholderValue(value, false)) return whole;
    const quote = double !== undefined ? '"' : single !== undefined ? "'" : "";
    return `${name}${equals}${quote}${REDACTED}${quote}`;
  });
}

/** Markup that delimits an XML element value: comments, CDATA sections, closing tags and opening tags (name, then any attributes). */
const XML_TOKEN = /<!--|<!\[CDATA\[|<\/([A-Za-z_][A-Za-z0-9_.:-]*)\s*>|<([A-Za-z_][A-Za-z0-9_.:-]*)(\s[^<>]*)?>/g;

interface XmlElement {
  /** Start of the opening tag; for a closing tag with nothing open, the end of the markup before it. */
  index: number;
  /** Where the value starts: the end of the opening tag. */
  start: number;
  name: string;
  /** The opening tag's attributes, or null for a closing tag with nothing open. */
  attributes: string | null;
  /** Start of the nesting-matched closing tag; -1 runs the value to the end of the text. */
  close: number;
  /** The comment or CDATA section holding the opening tag (numbered from 1), or 0 outside one. */
  scope: number;
  /**
   * Left open where the structure cannot be trusted: reopened by a closing tag
   * with nothing of its name open, or open while a closing tag of its name
   * closed a nested element or fell in a comment or CDATA section. The value
   * runs to the end of the text, bare placeholder tag or not.
   */
  ambiguous: boolean;
}

/** The open elements of one name, innermost last; the `ambiguous` bottom ones are marked when they leave or when the text ends. */
interface OpenStack {
  elements: XmlElement[];
  ambiguous: number;
}

/**
 * Credential-named XML elements, in order, each with the closing tag that
 * matches it by nesting: an opening tag of the same name nests one level
 * deeper. A comment or CDATA section is a scope of its own, so a closing tag
 * there never ends an element opened outside it, while elements wholly inside
 * it are still found. Where the structure cannot be trusted the value runs to
 * the end of the text: an element left open (also by an unterminated comment
 * or CDATA section), or a closing tag with nothing of its name open, which
 * reopens the first element of that name or, with none, takes the text since
 * the markup before it. An element left open while a closing tag of its name
 * went elsewhere is ambiguous. One linear pass.
 */
function credentialXmlElements(text: string): XmlElement[] {
  const elements: XmlElement[] = [];
  const open = new Map<string, OpenStack>();
  const first = new Map<string, XmlElement>();
  let scope = 0;
  let scopes = 0;
  let scopeEnd = -1;
  let markupEnd = 0;
  const pop = (stack: OpenStack): XmlElement => {
    const element = stack.elements.pop()!;
    if (stack.ambiguous > stack.elements.length) {
      element.ambiguous = true;
      stack.ambiguous = stack.elements.length;
    }
    return element;
  };
  const leaveScope = () => {
    // Elements the section left open stay unmatched (they run to the end of the text) and no longer nest.
    for (const stack of open.values()) while (stack.elements.length > 0 && stack.elements[stack.elements.length - 1].scope === scope) pop(stack);
    scope = 0;
  };
  const pattern = new RegExp(XML_TOKEN.source, "g");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const [token, closing, opening, attributes = ""] = match;
    if (scope !== 0 && match.index >= scopeEnd) {
      leaveScope();
      markupEnd = scopeEnd;
    }
    if (token === "<!--" || token === "<![CDATA[") {
      if (scope !== 0) continue; // Sections do not nest; this is text inside one.
      const end = text.indexOf(token === "<!--" ? "-->" : "]]>", match.index + token.length);
      scopes += 1;
      scope = scopes;
      scopeEnd = end === -1 ? text.length + 1 : end + 3; // Unterminated: the section never ends.
      continue;
    }
    const end = match.index + token.length;
    const name = closing ?? opening;
    if (isCredentialKey(name)) {
      let stack = open.get(name);
      if (!stack) open.set(name, (stack = { elements: [], ambiguous: 0 }));
      const top = stack.elements[stack.elements.length - 1];
      if (opening !== undefined) {
        const element: XmlElement = { index: match.index, start: end, name, attributes, close: -1, scope, ambiguous: false };
        elements.push(element);
        if (!attributes.endsWith("/")) {
          // `<password value="..."/>` has no element value.
          stack.elements.push(element);
          if (!first.has(name)) first.set(name, element);
        }
      } else if (top !== undefined && top.scope === scope) {
        pop(stack).close = match.index;
        stack.ambiguous = stack.elements.length; // Whatever stays open around the element it closed is ambiguous.
      } else if (top !== undefined) {
        stack.ambiguous = stack.elements.length; // A closing tag in a section never ends an element opened outside it.
      } else if (scope === 0) {
        // Nothing of this name is open: the structure cannot be trusted. (In a section, a closing tag of an outer element does not count.)
        const earlier = first.get(name);
        if (earlier) Object.assign(earlier, { close: -1, ambiguous: true });
        else elements.push({ index: markupEnd, start: markupEnd, name, attributes: null, close: match.index, scope, ambiguous: false });
      }
    }
    markupEnd = end;
  }
  for (const stack of open.values()) stack.elements.slice(0, stack.ambiguous).forEach((element) => (element.ambiguous = true));
  return elements;
}

/**
 * XML elements named like a credential: every attribute value is a
 * credential, and the element value runs from the end of the opening tag to
 * the closing tag that matches it by nesting, with any nested markup, CDATA
 * and comments (see {@link credentialXmlElements}). Without a matching
 * closing tag the value fails closed to the end of the text, unless the tag is
 * a bare placeholder such as `<token>` followed by a space, punctuation, a
 * quote escaped at any depth (`"<token>"` in escaped JSON) or the end of the
 * text, and its structure is not ambiguous.
 */
function redactXmlElements(text: string): string {
  let output = "";
  let copied = 0;
  for (const { index, start, name, attributes, close, ambiguous } of credentialXmlElements(text)) {
    if (index < copied) continue; // Inside a value already redacted.
    if (attributes !== null) {
      const safeAttributes = redactAttributeValues(attributes);
      if (safeAttributes !== attributes) {
        output += `${text.slice(copied, index)}<${name}${safeAttributes}>`;
        copied = start;
      }
      if (attributes.endsWith("/")) continue;
      const bare = /^(?:$|[\s"'`.,;:!?)\]}])/.test(text.slice(start, start + 1)) || escapedQuoteAt(text, start) > 0;
      if (close === -1 && !ambiguous && !attributes.includes("=") && bare) continue;
    }
    const end = close === -1 ? text.length : close;
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
    identifier ? redactNamespaceSegments(redactXmlElements(redactKeyValues(redactPairs(text), true))) : redactXmlElements(redactKeyValues(redactPairs(text), false))
  );
}

/** True when a string holds a credential, that is, when redaction would change it. */
export function containsCredentialValue(value: string): boolean {
  return redact(value, false) !== value;
}

/**
 * `value`, or `[REDACTED]` in its place when it holds a credential. Copied and
 * quoted author text uses this, so no part of a value survives however its
 * end is read; {@link redactCredentialValues} keeps the readable rest and is
 * only the last-resort sanitizer of whole diagnostic messages.
 */
export function redactWhole(value: string): string {
  return containsCredentialValue(value) ? REDACTED : value;
}

/** An author string quoted for a report: unchanged, or `"[REDACTED]"` whole when it holds a credential. */
export function quote(value: unknown): string {
  return `"${redactWhole(String(value))}"`;
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
 * One JSON Pointer segment for a diagnostic or issue. A raw key holding a
 * credential becomes `[REDACTED]`, judged before escaping: escaping first would turn the `//` of a URL key into
 * `~1~1` and hide its user info from the URL rule.
 */
export function pointerSegment(key: string): string {
  return redactWhole(key).replace(/~/g, "~0").replace(/\//g, "~1");
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
  return { pointer: safePointer, message: redactQuotedSegments(quoted) };
}

/**
 * The backstop behind {@link quote}, so a call site that quoted author text
 * without it cannot publish the part of a value a boundary rule reads past.
 * The first credential is found in the whole message or, judged on its own
 * content, in a double-quoted segment (one opened after a space or bracket and
 * closed before one or before punctuation). From the opening quote before it
 * through the message's last quote becomes `"[REDACTED]"`: an author string
 * holding quotes cannot end before the last one. Text outside is redacted as text.
 */
function redactQuotedSegments(message: string): string {
  const redacted = redactCredentialValues(message);
  let open = firstCredentialSegment(message);
  let end = -1;
  if (redacted !== message) {
    // Every change lies in [start, end): the first differing character through the common suffix.
    let start = 0;
    while (message[start] === redacted[start]) start += 1;
    let suffix = 0;
    while (suffix < Math.min(message.length, redacted.length) - start && message[message.length - 1 - suffix] === redacted[redacted.length - 1 - suffix]) suffix += 1;
    end = message.length - suffix;
    const before = message.lastIndexOf('"', start);
    if (before !== -1 && (open === -1 || before < open)) open = before;
  }
  if (open === -1) return redacted;
  const cut = Math.max(end, message.lastIndexOf('"') + 1);
  return `${redactCredentialValues(message.slice(0, open))}"${REDACTED}"${redactCredentialValues(message.slice(cut))}`;
}

const SEGMENT_OPEN = /(?:^|[\s([{,:=])"/g;
const SEGMENT_CLOSE = /"(?=$|[\s.,;:)\]}])/g;

/** The opening quote of the first double-quoted segment whose content holds a credential, or -1. Segments are disjoint, so this is linear. */
function firstCredentialSegment(message: string): number {
  SEGMENT_OPEN.lastIndex = 0;
  for (let match = SEGMENT_OPEN.exec(message); match; match = SEGMENT_OPEN.exec(message)) {
    const opening = match.index + match[0].length - 1;
    SEGMENT_CLOSE.lastIndex = opening + 1;
    const close = SEGMENT_CLOSE.exec(message);
    if (!close) return -1;
    if (containsCredentialValue(message.slice(opening + 1, close.index))) return opening;
    SEGMENT_OPEN.lastIndex = close.index + 1;
  }
  return -1;
}
