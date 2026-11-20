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
// [REDACTED] are printed. After any other key the scanner never resumes inside
// the text after a scheme word: when the word does not stand alone and the
// token after it is a valid credential token (accessToken: Bearer x), word and
// token are redacted together and scanning resumes after the token, so later
// fields stay readable; otherwise (password=basic token: x, Bearer sv=1&sig=x,
// Basic admin:mytoken=, Basic user:pass, basic "a b", password=basic
// status = 401) the word may start a credential that holds =, :, quotes or
// spaces, so key, separator and [REDACTED] are printed to the end of the line,
// as after an authorization key. Any whitespace but a line break (space, tab,
// NBSP, \v, \f, other Unicode spaces) counts as a blank between a scheme word
// and its token and before a folded line. A credential may continue on folded lines
// (RFC 7230 obs-fold): after an authorization value that is unquoted or whose
// quote does not close on its line, and after a scheme-labelled value (a bare
// scheme word, a word with its token, or an unclosed quote that opens, after
// optional blanks, with a scheme word) under any sensitive key, when only blanks remain before
// the line break,
// blank lines are skipped and each following line that begins with a blank is
// redacted too (see foldEnd); a next line that starts in column 0 stays
// readable.
const KEY_VALUE_SECRET =
  /(\b[\w-]{0,64}?(?:api[_-]?key|password|passwd|secret|token|authorization|connection(?:[_-]?string)?)(?:\]|%5D)?)(["']?)(\s*[:=]\s*)(?:(["'])((?:\\.|(?!\4)[^\\\n])*)\4(?=$|[\s,;}\]&])|(["'])[^\n]*|((?:bearer|basic|token)[^\S\r\n]+)?([^\s,;]+))/gi;
// The key group of KEY_VALUE_SECRET and its separator, with or without a value,
// searched from one position (see sensitiveKeyStartsWithin).
const SENSITIVE_KEY_SEPARATOR_FIND =
  /\b[\w-]{0,64}?(?:api[_-]?key|password|passwd|secret|token|authorization|connection(?:[_-]?string)?)(?:\]|%5D)?["']?\s*[:=]/gi;
const URL_CREDENTIALS = /(https?:\/\/)([^\s/@]+)@/gi;
const POSTGRES_CREDENTIALS = /(postgres(?:ql)?:\/\/)([^\s/@]+)@/gi;
// Embedded URL or Postgres userinfo (see maskUserinfo): only an authority's
// userinfo, so a match never crosses /, ?, #, whitespace or a double quote.
const USERINFO_CREDENTIALS = /((?:https?|postgres(?:ql)?):\/\/)([^\s/@?#"]+)@/gi;
// KEY_VALUE_SECRET tried at one position (see keyValueMaskEnd).
const KEY_VALUE_SECRET_AT = new RegExp(KEY_VALUE_SECRET.source, "iy");
// The end of a chunk of the text after a userinfo @: in a string, whitespace,
// & or #; in a URL href part (the text before its first # or the fragment), &.
const STRING_USERINFO_CHUNK_END = /[\s&#]/g;
const URL_USERINFO_CHUNK_END = /&/g;
const AUTHORIZATION_KEY = /authorization(?:\]|%5D)?$/i;
const REDACTED = "[REDACTED]";
const ENCODED_REDACTED = /%5BREDACTED%5D/g;
const MAX_KEY_DECODE_PASSES = 3;

const PERCENT_ESCAPE = /%([0-9a-f]{2})/gi;
const LINE_BREAK = /[\r\n]/g;
// A credential token after a scheme label: RFC 6750 b64token / RFC 7617 base64.
const CREDENTIAL_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
// A value that is only a scheme word, with no credential on its line.
const BARE_SCHEME_WORD = /^(?:bearer|basic|token)$/i;
// Quoted text that opens, after optional blanks, with a scheme word followed by
// a blank or its line end.
const QUOTED_SCHEME_START = /^[^\S\r\n]*(?:bearer|basic|token)(?:[^\S\r\n]|\r?$)/i;
// Blanks: any whitespace but a line break (space, tab, NBSP, \v, \f, ...).
const BLANKS = /[^\S\r\n]*/y;
// At the token after a scheme word: a quoted name followed by optional
// whitespace and : or =, or an unquoted name followed by whitespace and : or =,
// by a : that ends the token, or by an = that is not only trailing base64
// padding (name=value). user:pass and dGVzdA== are not assignments.
const ASSIGNMENT_START =
  /(?:(["'])[^\s"'=:,;]+\1[^\S\r\n]*[:=]|[^\s"'=:,;]+(?:[^\S\r\n]+[:=]|:(?=[\s,;]|$)|=(?!=*(?:[\s,;]|$))))/y;
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
 * secret is hidden. The decoded forms of the original key and value are
 * checked before the string pass can split them (token=%27a;b%27), and those of
 * the redacted text after it, so an escaped secret behind a secret the pass
 * already masked is still found.
 */
function redactSearchParams(params: URLSearchParams): string {
  const pairs: string[] = [];
  params.forEach((entry, key) => {
    const redactedKey = redactSensitiveString(key);
    // The original text is judged in its decoded forms before the string pass
    // can split it, and the redacted text again after it.
    if (decodedFormHoldsSecret(key, false) || decodedFormHoldsSecret(redactedKey, false)) {
      pairs.push(REDACTED);
      return;
    }
    const redactedEntry = redactSensitiveString(entry);
    const hidden =
      isSensitiveKey(key) || decodedFormHoldsSecret(entry, false) || decodedFormHoldsSecret(redactedEntry, false);
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
  return redactSensitiveString(text) !== text || decodedFormHoldsSecret(text, plusAsSpace);
}

/**
 * Whether the string redactor finds a secret in one of up to
 * MAX_KEY_DECODE_PASSES escape-decoded forms of text (not in text as written,
 * which the caller has already redacted).
 */
function decodedFormHoldsSecret(text: string, plusAsSpace: boolean): boolean {
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

/** An opening or closing quote as written: ' or ", or its single or double escape. */
const QUOTE_AT = /(["'])|%(?:25)?2([27])/y;
// The first key/value separator of a URL parameter, as written or escaped.
const PARAM_SEPARATOR_FIND = /[=:]|%(?:25)?3[ad]/i;

/** The quote character and token length of a quote at position, if any. */
function quoteAt(text: string, position: number): { quote: string; length: number } | undefined {
  QUOTE_AT.lastIndex = position;
  const match = QUOTE_AT.exec(text);
  if (match === null) return undefined;
  return { quote: match[1] ?? (match[2] === "2" ? '"' : "'"), length: match[0].length };
}

/** The length of the quote (literal, %2X or %252X) that ends text, or 0. */
function closingQuoteLength(text: string, quote: string): number {
  if (text.endsWith(quote)) return 1;
  const escape = quote === '"' ? "22" : "27";
  if (text.endsWith(`%25${escape}`)) return 5;
  return text.endsWith(`%${escape}`) ? 3 : 0;
}

/**
 * The quoted value of a masked URL parameter, which may span &-parts. When the
 * text of params[index] at valueStart opens with a quote, the value runs to the
 * first &-part (this one included) that ends with the same quote, literal or
 * escaped, so that quote is followed by & or the end of the component; without
 * one it runs to the end of the component. Returns the quotes as written and
 * the index of the value's last &-part. Each part is read once.
 */
function quotedValueSpan(
  params: string[],
  index: number,
  valueStart: number,
): { open: string; close: string; last: number } {
  const param = params[index];
  const opening = valueStart === -1 ? undefined : quoteAt(param, valueStart);
  if (opening === undefined) return { open: "", close: "", last: index };
  const open = param.slice(valueStart, valueStart + opening.length);
  const rest = param.slice(valueStart + opening.length);
  let closeLength = closingQuoteLength(rest, opening.quote);
  if (closeLength > 0) return { open, close: rest.slice(-closeLength), last: index };
  for (let next = index + 1; next < params.length; next += 1) {
    closeLength = closingQuoteLength(params[next], opening.quote);
    if (closeLength > 0) return { open, close: params[next].slice(-closeLength), last: next };
  }
  return { open, close: "", last: params.length - 1 };
}

/** The position after the first separator (=, :, %3D or %3A) of param, or -1. */
function firstSeparatorEnd(param: string): number {
  const match = PARAM_SEPARATOR_FIND.exec(param);
  return match === null ? -1 : match.index + match[0].length;
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
 * In (i) and (ii), a value that opens with a quote (literal, %22/%27 or
 * double-escaped) after the first separator is masked as one value across &
 * (see quotedValueSpan), as the string pass masks it after a raw key; (ii)
 * keeps its quotes as written. Empty parameters, route text and delimiters
 * stay as written.
 */
function maskUrlComponent(component: string): string {
  const params = component.split(URL_PARAM_SEPARATOR);
  const output: string[] = [];
  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    const separator = param.indexOf("=");
    const key = separator === -1 ? param : param.slice(0, separator);
    const value = param.slice(separator + 1);
    if (param === "" || param === REDACTED) {
      output.push(param);
    } else if (holdsSecret(key, true)) {
      index = quotedValueSpan(params, index, firstSeparatorEnd(param)).last;
      output.push(REDACTED);
    } else if (separator === -1 || MASKED_VALUE.test(value)) {
      output.push(param);
    } else if (isSensitiveKey(urlParamKey(key))) {
      const span = quotedValueSpan(params, index, separator + 1);
      index = span.last;
      output.push(`${key}=${span.open}${REDACTED}${span.close}`);
    } else {
      output.push(holdsSecret(value, true) ? `${key}=${REDACTED}` : param);
    }
  }
  return output.join(URL_PARAM_SEPARATOR);
}

const QUOTE_CHARACTER = /["']/;
// The quote of a quoted value the string redactor leaves open (masked to the
// end of its line).
const UNCLOSED_QUOTED_MASK = /(["'])\[REDACTED\]$/;
const HEX_DIGIT = /^[0-9a-f]$/i;

/**
 * The fully decoded form of URL text: + read as a space, then up to
 * MAX_KEY_DECODE_PASSES escape-decoding passes, so %2520%2522 reads as a space
 * and a quote.
 */
function decodeUrlText(text: string): string {
  let candidate = text.replace(PLUS_SIGN, " ");
  for (let pass = 0; pass < MAX_KEY_DECODE_PASSES; pass += 1) {
    const decoded = decodePercentEscapes(candidate);
    if (decoded === candidate) break;
    candidate = decoded;
  }
  return candidate;
}

/**
 * URL text decoded as decodeUrlText decodes it, one code unit per character,
 * with the escape depth of each character: 0 as written (a + read as a space
 * included), 1 for %27, 2 for %2527, and so on. Linear in the text length.
 */
interface DecodedUrlText {
  characters: string[];
  depths: number[];
}

function decodeUrlTextWithDepth(text: string): DecodedUrlText {
  let characters = Array.from({ length: text.length }, (_unused, position) =>
    text[position] === "+" ? " " : text[position],
  );
  let depths = new Array<number>(text.length).fill(0);
  for (let pass = 0; pass < MAX_KEY_DECODE_PASSES; pass += 1) {
    const nextCharacters: string[] = [];
    const nextDepths: number[] = [];
    for (let position = 0; position < characters.length; position += 1) {
      if (
        characters[position] === "%" &&
        position + 2 < characters.length &&
        HEX_DIGIT.test(characters[position + 1]) &&
        HEX_DIGIT.test(characters[position + 2])
      ) {
        nextCharacters.push(
          String.fromCodePoint(Number.parseInt(characters[position + 1] + characters[position + 2], 16)),
        );
        nextDepths.push(Math.max(depths[position], depths[position + 1], depths[position + 2]) + 1);
        position += 2;
      } else {
        nextCharacters.push(characters[position]);
        nextDepths.push(depths[position]);
      }
    }
    if (nextCharacters.length === characters.length) break;
    characters = nextCharacters;
    depths = nextDepths;
  }
  return { characters, depths };
}

/**
 * A quote and the escape depth it is written at (see decodeUrlTextWithDepth).
 * UNCLOSABLE_DEPTH marks a quote whose depth is unknown: it never closes, so
 * its span runs to the end of the component.
 */
interface UrlQuote {
  quote: string;
  depth: number;
}

const UNCLOSABLE_DEPTH = -1;

/**
 * The one quote state machine that decides a quoted URL secret value. It reads
 * decoded text from start with the quote state open (undefined: no quote
 * open) and returns the state at its end (with stopAtFirstOpen, the first
 * quote it opens). A quote (' or ") opens only when none
 * is open, and closes only on the same character at the same escape depth; a
 * backslash escapes the character after it. Linear in the text length.
 */
function scanQuotes(
  text: DecodedUrlText,
  start: number,
  open: UrlQuote | undefined,
  stopAtFirstOpen = false,
): UrlQuote | undefined {
  const { characters, depths } = text;
  let state = open;
  for (let position = start; position < characters.length; position += 1) {
    const character = characters[position];
    if (character === "\\") {
      position += 1;
    } else if (state === undefined) {
      if (character !== '"' && character !== "'") continue;
      state = { quote: character, depth: depths[position] };
      if (stopAtFirstOpen) return state;
    } else if (character === state.quote && depths[position] === state.depth) {
      state = undefined;
    }
  }
  return state;
}

/**
 * The quote state after a later URL &-part of an open quoted value: the state
 * machine (see scanQuotes) carried into the part's decoded form. A part
 * without the open quote character cannot close it and is decoded once.
 */
function continueQuote(part: string, open: UrlQuote): UrlQuote | undefined {
  if (open.depth === UNCLOSABLE_DEPTH || !decodeUrlText(part).includes(open.quote)) return open;
  return scanQuotes(decodeUrlTextWithDepth(part), 0, open);
}

/**
 * The open quote of the secret value in one URL parameter, judged on its
 * decoded form from the start of that value: for a sensitive key, its decoded
 * value; otherwise the decoded text after the first sensitive key and its
 * separator, with the first quote the value opens. As a fail-closed fallback,
 * when the scan finds no open quote but
 * the string redactor leaves one open in the same decoded text, that quote
 * never closes (UNCLOSABLE_DEPTH).
 */
function secretValueQuote(param: string, separator: number, sensitiveKey: boolean): SecretValueQuote {
  const text = decodeUrlTextWithDepth(sensitiveKey ? param.slice(separator + 1) : param);
  const decoded = text.characters.join("");
  if (!QUOTE_CHARACTER.test(decoded)) return { open: undefined, first: undefined };
  let start = 0;
  if (!sensitiveKey) {
    SENSITIVE_KEY_SEPARATOR_FIND.lastIndex = 0;
    const match = SENSITIVE_KEY_SEPARATOR_FIND.exec(decoded);
    start = match === null ? decoded.length : match.index + match[0].length;
  }
  const first = scanQuotes(text, start, undefined, true);
  const scanned = scanQuotes(text, start, undefined);
  if (scanned !== undefined) return { open: scanned, first };
  return { open: stringRedactorOpenQuote(sensitiveKey ? `token=${decoded}` : decoded), first };
}

/**
 * The quote state of a secret's value in its own URL &-part: open, the quote
 * left open at the end of the part (see secretValueQuote); first, the first
 * quote the value opens, closed in the part or not.
 */
interface SecretValueQuote {
  open: UrlQuote | undefined;
  first: UrlQuote | undefined;
}

/**
 * The quote a URL &-part leaves open when it follows a closed quoted secret
 * value, if it is written in the same form (same character and escape depth)
 * as that value's quote. Such a part may continue the value: a URL serialiser
 * writes a query's literal ' as %27, so in token=%27a%27&b%27 the first close
 * may be an inner quote. Undefined otherwise.
 */
function strayQuote(part: string, form: UrlQuote): UrlQuote | undefined {
  if (!decodeUrlText(part).includes(form.quote)) return undefined;
  const state = scanQuotes(decodeUrlTextWithDepth(part), 0, undefined);
  return state?.quote === form.quote && state.depth === form.depth ? state : undefined;
}

/** The quote the string redactor leaves open in text, as an unclosable quote. */
function stringRedactorOpenQuote(text: string): UrlQuote | undefined {
  const redacted = redactSensitiveString(text);
  const quote = redacted === text ? undefined : UNCLOSED_QUOTED_MASK.exec(redacted)?.[1];
  return quote === undefined ? undefined : { quote, depth: UNCLOSABLE_DEPTH };
}

/**
 * The end of a sensitive key and its separator that the string redactor
 * recognises in param as written, when that separator is the first = or : of
 * param; -1 otherwise.
 */
function rawSensitiveKeyEnd(param: string): number {
  const separator = param.search(/[:=]/);
  if (separator === -1) return -1;
  SENSITIVE_KEY_SEPARATOR_FIND.lastIndex = 0;
  const match = SENSITIVE_KEY_SEPARATOR_FIND.exec(param);
  const end = match === null ? -1 : match.index + match[0].length;
  return end === separator + 1 ? end : -1;
}

/**
 * How maskQuotedUrlSpans prints a parameter whose quoted secret value spans
 * params[index] to params[last] (closed: the quote state is closed at the end
 * of params[last]).
 */
function maskedQuotedParam(
  params: string[],
  index: number,
  last: number,
  quote: string,
  closed: boolean,
  sensitiveKey: boolean,
): string {
  const param = params[index];
  const separator = param.indexOf("=");
  const key = separator === -1 ? param : param.slice(0, separator);
  // The string pass recognises the key as written: literal quotes make it read
  // a closed quoted value and keep the following parameters.
  const rawKeyEnd = rawSensitiveKeyEnd(param);
  if (rawKeyEnd !== -1) return `${param.slice(0, rawKeyEnd)}${quote}${REDACTED}${closed ? quote : ""}`;
  if (separator === -1 || holdsSecret(key, true)) return REDACTED;
  if (!sensitiveKey) return `${key}=${REDACTED}`;
  // An escaped sensitive key: keep the quotes as written when the value opens
  // with the quote and a closing quote token ends the span.
  const opening = quoteAt(param, separator + 1);
  const closeLength = closed ? closingQuoteLength(params[last], quote) : 0;
  const open = opening?.quote === quote ? param.slice(separator + 1, separator + 1 + opening.length) : "";
  const keepQuotes = open !== "" && (!closed || closeLength > 0);
  const close = closed && keepQuotes ? params[last].slice(-closeLength) : "";
  return `${key}=${keepQuotes ? open : ""}${REDACTED}${close}`;
}

/**
 * Judges every parameter of the original query (without ?) or fragment
 * (without #) on its fully decoded form (see decodeUrlText) before the string
 * pass can split or consume it. A parameter carries a secret when its key holds
 * a secret, its raw or decoded key is sensitive, or its decoded form holds a
 * secret. Such a parameter whose secret value, decoded and read from its own
 * start (quotes earlier in the part are ignored), leaves a quote open (see
 * secretValueQuote) masks its value as one value across &: one quote state
 * machine (see scanQuotes) is carried through the following &-parts, and the
 * span ends with the first part at whose end the quote is closed (closed only
 * by the same character at the same escape depth, not escaped by a
 * backslash), or at the end of the component (see maskedQuotedParam). A part
 * that leaves a quote of the same form open right after the span closes, or
 * after a secret value whose quote closes in its own part, continues the span
 * (see strayQuote). Otherwise, when its decoded form differs from the text as
 * written and holds a secret, it becomes [REDACTED] (its key holds a secret or
 * it has no =) or key=[REDACTED], so the string pass never sees its escaped
 * value. Every other parameter is left as written for the string pass. Each
 * &-part is decoded a bounded number of times, so this stays linear.
 */
function maskQuotedUrlSpans(component: string): string {
  const params = component.split(URL_PARAM_SEPARATOR);
  const output: string[] = [];
  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    const decoded = decodeUrlText(param);
    if (decoded === param && !QUOTE_CHARACTER.test(decoded)) {
      output.push(param);
      continue;
    }
    const separator = param.indexOf("=");
    const key = separator === -1 ? param : param.slice(0, separator);
    const sensitiveKey = separator !== -1 && isSensitiveKey(urlParamKey(key));
    if (!sensitiveKey && redactSensitiveString(decoded) === decoded && !holdsSecret(param, true)) {
      output.push(param);
      continue;
    }
    const value = secretValueQuote(param, separator, sensitiveKey);
    const form = value.open ?? value.first;
    // The state is carried into each later part, which is read once; the span
    // ends with the first part that leaves it closed, unless the next part
    // leaves a quote of the same form open (see strayQuote): fail closed.
    let state = value.open;
    let last = index;
    while (form !== undefined && last + 1 < params.length) {
      const next = state === undefined ? strayQuote(params[last + 1], form) : continueQuote(params[last + 1], state);
      if (state === undefined && next === undefined) break;
      last += 1;
      state = next;
    }
    if (form !== undefined && (value.open !== undefined || last > index)) {
      output.push(maskedQuotedParam(params, index, last, form.quote, state === undefined, sensitiveKey));
      index = last;
    } else if (decoded === param) {
      output.push(param);
    } else if (separator === -1 || holdsSecret(key, true)) {
      output.push(REDACTED);
    } else {
      output.push(`${key}=${REDACTED}`);
    }
  }
  return output.join(URL_PARAM_SEPARATOR);
}

/** Applies fn to the query (without ?) and fragment (without #) of a href. */
function mapUrlComponents(href: string, fn: (component: string) => string): string {
  const hashStart = href.indexOf("#");
  const beforeHash = hashStart === -1 ? href : href.slice(0, hashStart);
  const queryStart = beforeHash.indexOf("?");
  let output = queryStart === -1 ? beforeHash : beforeHash.slice(0, queryStart);
  if (queryStart !== -1) output += `?${fn(beforeHash.slice(queryStart + 1))}`;
  if (hashStart !== -1) output += `#${fn(href.slice(hashStart + 1))}`;
  return output;
}

function maskQuotedUrlComponents(href: string): string {
  return mapUrlComponents(href, maskQuotedUrlSpans);
}

/**
 * The one userinfo rule of both entry points (redactUrl and
 * redactSensitiveString), applied before the key/value pass so that pass never
 * splits userinfo. Only an authority's userinfo counts (USERINFO_CREDENTIALS
 * never crosses /, ?, #, whitespace or a double quote). Userinfo that holds no
 * secret becomes scheme[REDACTED]@ and its host is kept. Userinfo holds a
 * secret when the string redactor finds one in it as written or decoded, or
 * when a sensitive key and its separator appear in it as written or decoded
 * (its value then starts after the @, as in a.test&token=@abc). Such userinfo
 * fails closed: scheme[REDACTED] replaces it, its @ and the chunk after the @
 * (see STRING_USERINFO_CHUNK_END and URL_USERINFO_CHUNK_END), so no tail of
 * the secret's value is printed and the host is lost. When the secret's value,
 * decoded and read from its own start, leaves a quote open at the @ (see
 * scanQuotes), the span also covers each following chunk until a chunk
 * closes the quote (same character and escape depth), or, with no close, to
 * the end of the line (in a URL, the end of the text given). In a string the
 * span also never ends before the key/value pass would end a mask that starts
 * inside the userinfo (see keyValueMaskEnd), so this step never prints a
 * character that pass would mask. In a URL, & separates parameters, so a
 * value without an open quote ends at the next &. Matches never overlap and
 * each character is read a bounded number of times, so this stays linear.
 */
function maskUserinfo(input: string, inUrl = false): string {
  const chunkEnd = inUrl ? URL_USERINFO_CHUNK_END : STRING_USERINFO_CHUNK_END;
  let output = "";
  let position = 0;
  const pattern = USERINFO_CREDENTIALS;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(input); match !== null; match = pattern.exec(input)) {
    const [whole, scheme, userinfo] = match;
    const userinfoStart = match.index + scheme.length;
    let end = match.index + whole.length;
    output += input.slice(position, match.index);
    if (userinfoHoldsSecret(userinfo)) {
      let state = userinfoOpenQuote(userinfo);
      let chunkStart = end;
      for (;;) {
        end = runEnd(input, chunkStart, chunkEnd);
        if (state !== undefined) state = continueQuote(input.slice(chunkStart, end), state);
        const next = input[end];
        if (state === undefined || end >= input.length || next === "\r" || next === "\n") break;
        chunkStart = end + 1;
      }
      if (!inUrl) end = Math.max(end, keyValueMaskEnd(input, userinfoStart, userinfo));
      output += `${scheme}${REDACTED}`;
    } else {
      output += `${scheme}${REDACTED}@`;
    }
    position = end;
    // holdsSecret runs the string redactor, which resets this shared pattern.
    pattern.lastIndex = end;
  }
  return output + input.slice(position);
}

/**
 * Whether userinfo holds a secret: the string redactor finds one in it as
 * written or decoded, or a sensitive key and its separator appear in it as
 * written or decoded, with or without a value before the @.
 */
function userinfoHoldsSecret(userinfo: string): boolean {
  if (holdsSecret(userinfo, true)) return true;
  for (const form of [userinfo, decodeUrlText(userinfo)]) {
    SENSITIVE_KEY_SEPARATOR_FIND.lastIndex = 0;
    if (SENSITIVE_KEY_SEPARATOR_FIND.test(form)) return true;
  }
  return false;
}

/**
 * The end of the last key/value mask (see redactKeyValues) that starts inside
 * userinfo, which begins at start in input; start when none does. Every such
 * mask starts at a sensitive key whose key and separator lie inside the
 * userinfo (a key holds no @ or whitespace), so KEY_VALUE_SECRET is only tried
 * where SENSITIVE_KEY_SEPARATOR_FIND finds one in the userinfo, and the scan
 * resumes after each mask, as that pass does.
 */
function keyValueMaskEnd(input: string, start: number, userinfo: string): number {
  let maskEnd = start;
  let offset = 0;
  while (offset < userinfo.length) {
    SENSITIVE_KEY_SEPARATOR_FIND.lastIndex = offset;
    const key = SENSITIVE_KEY_SEPARATOR_FIND.exec(userinfo);
    if (key === null) break;
    KEY_VALUE_SECRET_AT.lastIndex = start + key.index;
    const match = KEY_VALUE_SECRET_AT.exec(input);
    if (match === null) {
      offset = key.index + 1;
      continue;
    }
    const end = keyValueMask(input, match).end;
    maskEnd = Math.max(maskEnd, end);
    offset = end - start;
  }
  return maskEnd;
}

/** The end of the run of text from position that ends before a stop match. */
function runEnd(input: string, position: number, stop: RegExp): number {
  stop.lastIndex = position;
  return stop.exec(input)?.index ?? input.length;
}

/**
 * The open quote of the secret value at the @ of masked userinfo, decoded and
 * read from after the first sensitive key and its separator (or from its start
 * when the key is only found as written).
 */
function userinfoOpenQuote(text: string): UrlQuote | undefined {
  const decoded = decodeUrlTextWithDepth(text);
  const joined = decoded.characters.join("");
  if (!QUOTE_CHARACTER.test(joined)) return undefined;
  SENSITIVE_KEY_SEPARATOR_FIND.lastIndex = 0;
  const match = SENSITIVE_KEY_SEPARATOR_FIND.exec(joined);
  const start = match === null ? 0 : match.index + match[0].length;
  return scanQuotes(decoded, start, undefined) ?? stringRedactorOpenQuote(joined);
}

/**
 * Redacts a URL and keeps every delimiter of its href, including an empty ?
 * or #. Its first step is the pin's step: the base URL's own userinfo (any
 * scheme) becomes [REDACTED]@, embedded URL and Postgres userinfo is masked
 * (see maskUserinfo; the text before the first # and the fragment are masked
 * separately, as URL text, where & ends a value) and the whole href goes
 * through the string
 * redactor, so key/value secrets are masked before any & split. Before that
 * pass, and after the userinfo masking, maskQuotedUrlSpans judges each
 * parameter of the original query and fragment on its decoded text: it masks
 * quoted secret values across & and escaped secret parameters, so the string
 * pass never splits or consumes them, and after it maskUrlComponent adds masks
 * to the redacted query and fragment. In a serialised href, ? and # outside the query and fragment are
 * percent-encoded, and redaction only removes text or inserts [REDACTED], so
 * the first # left starts the fragment and the first ? before it the query.
 */
function redactUrl(url: URL): string {
  const base = new URL(url.href);
  const hasUserinfo = base.username !== "" || base.password !== "";
  base.username = "";
  base.password = "";
  const href = hasUserinfo ? base.href.replace("//", `//${REDACTED}@`) : base.href;
  const hashStart = href.indexOf("#");
  const masked =
    hashStart === -1
      ? maskUserinfo(href, true)
      : `${maskUserinfo(href.slice(0, hashStart), true)}#${maskUserinfo(href.slice(hashStart + 1), true)}`;
  const redacted = redactSensitiveString(maskQuotedUrlComponents(masked));
  return mapUrlComponents(redacted, maskUrlComponent);
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
  return redactKeyValues(maskUserinfo(input))
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

function endOfLine(input: string, from: number): number {
  LINE_BREAK.lastIndex = from;
  const lineBreak = LINE_BREAK.exec(input);
  return lineBreak === null ? input.length : lineBreak.index;
}

/** The position after the blanks (whitespace but \r and \n) that start at from. */
function skipBlanks(input: string, from: number): number {
  BLANKS.lastIndex = from;
  BLANKS.test(input);
  return BLANKS.lastIndex;
}

/**
 * The end of the folded continuation lines that follow the line break at
 * lineEnd (RFC 7230 obs-fold): blank lines are skipped, and each non-blank
 * line that begins with a blank extends the redacted span to its end.
 * Returns lineEnd when the next non-blank line starts in column 0. Each line
 * is read once, so this stays linear.
 */
function foldedContinuationEnd(input: string, lineEnd: number): number {
  let end = lineEnd;
  let position = lineEnd;
  while (position < input.length) {
    position += input.startsWith("\r\n", position) ? 2 : 1;
    const contentStart = skipBlanks(input, position);
    if (contentStart >= input.length) break;
    const next = input[contentStart];
    if (next === "\r" || next === "\n") {
      // A blank line: skipped, not redacted.
      position = contentStart;
      continue;
    }
    // A line that starts in column 0 ends the credential.
    if (contentStart === position) break;
    end = endOfLine(input, contentStart);
    position = end;
  }
  return end;
}

/**
 * The end of a redacted span ending at end, extended over its folded
 * continuation lines when only blanks follow it on its line. Reads
 * only those blanks and the one character after them, so repeated calls on a
 * long line stay linear.
 */
function foldEnd(input: string, end: number): number {
  const lineEnd = skipBlanks(input, end);
  if (lineEnd < input.length && input[lineEnd] !== "\r" && input[lineEnd] !== "\n") return end;
  return foldedContinuationEnd(input, lineEnd);
}

/**
 * The mask of one KEY_VALUE_SECRET match: the end of the masked span (which
 * may extend past the match, see the rules above KEY_VALUE_SECRET) and its
 * replacement.
 */
function keyValueMask(input: string, match: RegExpExecArray): { end: number; replacement: string } {
  const [whole, key, keyQuote, separator, valueQuote, , openQuote, scheme, credential] = match;
  let end = match.index + whole.length;
  // The scheme word is followed by a new key or assignment, not a credential.
  const standsAlone = scheme !== undefined && schemeWordStandsAlone(input, end - credential.length, end);
  let replacement: string;
  if (valueQuote) {
    replacement = `${key}${keyQuote}${separator}${valueQuote}${REDACTED}${valueQuote}`;
  } else if (openQuote) {
    // An unclosed quoted authorization or scheme-labelled value may continue
    // on folded lines, as its unquoted form does.
    const quoted = input.slice(match.index + key.length + keyQuote.length + separator.length + 1, end);
    if (AUTHORIZATION_KEY.test(key) || QUOTED_SCHEME_START.test(quoted)) end = foldEnd(input, end);
    replacement = `${key}${keyQuote}${separator}${openQuote}${REDACTED}`;
  } else if (AUTHORIZATION_KEY.test(key)) {
    end = foldEnd(input, endOfLine(input, end));
    const label = scheme !== undefined && !standsAlone && CREDENTIAL_TOKEN.test(credential) ? scheme : "";
    replacement = `${key}${keyQuote}${separator}${label}${REDACTED}`;
  } else {
    // The word may begin a credential holding =, :, quotes or spaces; fail
    // closed and never resume scanning inside the text after it.
    if (scheme !== undefined && (standsAlone || !CREDENTIAL_TOKEN.test(credential))) end = endOfLine(input, end);
    // A scheme-labelled credential may continue on folded lines.
    if (scheme !== undefined || BARE_SCHEME_WORD.test(credential)) end = foldEnd(input, end);
    replacement = `${key}${keyQuote}${separator}${REDACTED}`;
  }
  return { end, replacement };
}

function redactKeyValues(input: string): string {
  // The shared global pattern is reset here; nothing below re-enters this
  // function, so its lastIndex is never shared between two scans.
  const pattern = KEY_VALUE_SECRET;
  pattern.lastIndex = 0;
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const { end, replacement } = keyValueMask(input, match);
    output += input.slice(cursor, match.index) + replacement;
    cursor = end;
    pattern.lastIndex = end;
  }
  return output + input.slice(cursor);
}
