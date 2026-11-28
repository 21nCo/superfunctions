/**
 * Credential redaction for ApiFn run reports (API-41), shared by every
 * reporter: the collections runner, its JSON, JUnit and console reporters and
 * the LogFn integration. Every function is idempotent and never recurses, and
 * every scan is linear, because the inputs (collections, scripts, remote
 * responses) are untrusted.
 *
 * Layer 1 redacts structured data exactly: URLs through the WHATWG parser,
 * headers by name, JSON by member (including name/value objects in any member
 * order) and form bodies by key. Layer 2 redacts unstructured text in three
 * passes: credential values the run already knows (the registry), a
 * line-oriented keyword rule that fails closed, and URL tokens through the
 * Layer 1 URL function. Only Layer 2 may over-redact.
 */

export const REDACTED = "[REDACTED]";
export const WITHHELD = "[REDACTED: withheld because it could not be sanitized]";
const TOO_DEEP = "[REDACTED: nesting too deep]";
const MAX_JSON_DEPTH = 200;
const DEFAULT_BODY_LIMIT = 10 * 1024 * 1024;
/** Shortest value the registry collects; shorter ones are redacted only by key. */
const MIN_VALUE_LENGTH = 4;
const SCAN_BACK_LIMIT = 16_384;
const DUMMY_BASE = "https://redaction.invalid/";

export const DEFAULT_REDACT_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-refresh-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-amz-security-token",
  "x-goog-api-key",
  "dpop",
];
const DEFAULT_HEADER_SET = new Set(DEFAULT_REDACT_HEADERS);
const EXACT_KEYS = new Set(["bearer", "code", "devicecode", "handoffcode", "otp", "session", "sid", "usercode"]);
const KEY_SUFFIXES = [
  "accesskey", "apikey", "assertion", "authorization", "backupcode", "codeverifier", "cookie", "credential",
  "credentials", "jwt", "passphrase", "passwd", "password", "privatekey", "recoverycode", "secret", "secretkey",
  "sessionid", "sessionkey", "signature", "signingkey", "token",
];
const HEADER_WORDS = ["authorization", "cert", "cookie", "credential", "hmac", "jwt", "passwd", "password", "secret", "session", "signature", "token"];
const HEADER_PARTS = new Set(["auth", "csrf", "otp", "sig", "xsrf"]);
const URL_PARAM_EXTRA = new Set(["state", "key", "nonce", "sig", "auth"]);
const TEXT_WORDS = [
  "token", "secret", "passw", "passphrase", "apikey", "authoriz", "credential", "cookie", "session", "signature",
  "privatekey", "accesskey", "jwt", "assertion", "csrf", "xsrf", "bearer",
];
const TEXT_EXACT = new Set(["code", "codes", "sid", "state", "auth", "pwd"]);
/** Prose words that are credential keys but do not mark a quoted name in value position. */
const BARE_WORDS = new Set(["token", "tokens", "secret", "secrets", "key", "keys", "code", "codes", "state", "auth", "bearer"]);
const NAME_KEYS = new Set(["name", "key", "header", "field", "param", "parameter"]);
const VALUE_KEYS = new Set(["value", "values", "val", "content"]);
const URL_HEADERS = new Set(["location", "content-location", "referer"]);
const COOKIE_ATTRIBUTES = new Set(["path", "domain", "expires", "max-age", "secure", "httponly", "samesite", "priority", "partitioned"]);

export interface RedactionOptions {
  /** Extra header names whose values are credentials (the run's redactHeaders). */
  redactHeaders?: readonly string[];
  /** Credential values the run already knows; they are scrubbed wherever they appear. */
  registry?: CredentialRegistry;
}

interface Context {
  names: ReadonlySet<string>;
  registry: CredentialRegistry;
}

function contextOf(options: RedactionOptions = {}): Context {
  const names = new Set((options.redactHeaders ?? []).map((name) => name.trim().toLowerCase()));
  return { names, registry: options.registry ?? createCredentialRegistry(options.redactHeaders) };
}

// ---------------------------------------------------------------------------
// Key vocabulary
// ---------------------------------------------------------------------------

/** Decodes \uXXXX escapes and runs of %XX escapes (as UTF-8, per byte when a run is not UTF-8). */
function decodeEscapes(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+|\\+u([0-9a-f]{4})/gi, (match: string, unicode: string | undefined) => {
    if (unicode !== undefined) return String.fromCharCode(Number.parseInt(unicode, 16));
    try {
      return decodeURIComponent(match);
    } catch {
      return match.replace(/%([0-9a-f]{2})/gi, (_byte, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    }
  });
}

const normalize = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The decoded key and, for bracketed form keys such as user[password], its last segment. */
function keyCandidates(key: string): string[] {
  const decoded = decodeEscapes(key).replace(/\\/g, "");
  const segment = /\[([^[\]]*)\]\s*$/.exec(decoded)?.[1];
  return segment === undefined ? [decoded] : [decoded, segment];
}

export function isSensitiveKey(key: string): boolean {
  return keyCandidates(key).some((candidate) => {
    const n = normalize(candidate);
    const singular = n.endsWith("s") ? n.slice(0, -1) : n;
    return [n, singular].some((form) => EXACT_KEYS.has(form) || KEY_SUFFIXES.some((suffix) => form.endsWith(suffix)));
  });
}

/** A plural of "token" (max_tokens): a number under it is a count, kept and never collected. */
const isCountKey = (key: string): boolean => normalize(decodeEscapes(key)).endsWith("tokens");

function headerWordMatch(name: string): boolean {
  const n = normalize(name);
  const lower = name.trim().toLowerCase();
  return (
    DEFAULT_HEADER_SET.has(lower) ||
    HEADER_WORDS.some((word) => n.includes(word)) ||
    (n.endsWith("key") && lower.includes("-")) ||
    lower.split(/[-_\s]+/).some((part) => HEADER_PARTS.has(part))
  );
}

/** A JSON member, form key or name/value name whose value is a credential (header word rules need a header-shaped name). */
function isCredentialName(name: string, names: ReadonlySet<string>): boolean {
  return names.has(name.trim().toLowerCase()) || isSensitiveKey(name) || keyCandidates(name).some((candidate) => candidate.includes("-") && headerWordMatch(candidate));
}

function isUrlParamKey(key: string, names: ReadonlySet<string>): boolean {
  return isCredentialName(key, names) || keyCandidates(key).some((candidate) => URL_PARAM_EXTRA.has(normalize(candidate)));
}

/** Layer 2: a word that, followed by a separator, starts a credential value. */
function isTextKeyword(token: string, names: ReadonlySet<string>): boolean {
  const trimmed = token.replace(/^[!#$*+^`|~.]+|[!#$*+^`|~.]+$/g, "");
  return [token, trimmed].some((form) => {
    if (form === "") return false;
    if (isCredentialName(form, names)) return true;
    return keyCandidates(form).some((candidate) => {
      const n = normalize(candidate);
      return TEXT_WORDS.some((word) => n.includes(word)) || TEXT_EXACT.has(n) || n.endsWith("key") || n.endsWith("otp") || n.endsWith("otps");
    });
  });
}

/** A value shaped like a token: 8+ token68 characters, not a plain word. */
const isTokenShaped = (value: string): boolean =>
  /^[A-Za-z0-9\-._~+/]{8,}=*$/.test(value) && (/[^A-Za-z]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)));

// ---------------------------------------------------------------------------
// Registry: credential values the run knows
// ---------------------------------------------------------------------------

export interface CredentialRegistry {
  /** Records a credential value (and its JSON-escaped and percent-encoded forms). */
  add(value: unknown): void;
  collectRequest(request: { url?: unknown; headers?: unknown; body?: unknown }): void;
  collectResponse(response: { url?: unknown; headers?: unknown; body?: unknown; redirects?: unknown }): void;
  /** Records values held under credential-named keys (variables, environment). */
  collectNamed(values: Record<string, unknown> | undefined): void;
  /** Replaces every known value in text; short and numeric values only as whole words. */
  scrub(text: string): string;
  /** True for a string or number equal to a known value. */
  has(value: unknown): boolean;
}

interface Automaton {
  edges: Map<number, number>;
  fail: Int32Array;
  long: Int32Array;
  bounded: Int32Array;
  boundedLink: Int32Array;
}

class Registry implements CredentialRegistry {
  private readonly values = new Map<string, boolean>();
  private automaton: Automaton | undefined;
  private readonly names: ReadonlySet<string>;

  constructor(redactHeaders: readonly string[] = []) {
    this.names = new Set(redactHeaders.map((name) => name.trim().toLowerCase()));
  }

  has(value: unknown): boolean {
    return (typeof value === "string" || typeof value === "number" || typeof value === "bigint") && this.values.has(String(value));
  }

  add(value: unknown): void {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return;
    const text = String(value);
    if (text.length < MIN_VALUE_LENGTH || text.includes(REDACTED.slice(0, 9)) || text.length > 65_536) return;
    const forms = [text, JSON.stringify(text).slice(1, -1), safe(() => encodeURIComponent(text), text)];
    for (const form of forms) {
      if (!this.values.has(form)) {
        this.values.set(form, form.length < 8 || /^\d+$/.test(form) || typeof value !== "string");
        this.automaton = undefined;
      }
    }
  }

  collectNamed(values: Record<string, unknown> | undefined): void {
    for (const [key, value] of Object.entries(values ?? {})) {
      if (isCredentialName(key, this.names) && !isCount(key, value)) this.add(value);
    }
  }

  collectRequest(request: { url?: unknown; headers?: unknown; body?: unknown }): void {
    const headers = asHeaders(request.headers);
    if (typeof request.url === "string") this.collectUrl(request.url);
    this.collectHeaders(headers, typeof request.url === "string" ? request.url : undefined);
    if (typeof request.body === "string") this.collectBody(request.body, headerValue(headers, "content-type"));
  }

  collectResponse(response: { url?: unknown; headers?: unknown; body?: unknown; redirects?: unknown }): void {
    const headers = asHeaders(response.headers);
    const url = typeof response.url === "string" ? response.url : undefined;
    this.collectHeaders(headers, url);
    if (Array.isArray(response.redirects)) {
      for (const record of response.redirects as Array<Record<string, unknown>>) {
        if (typeof record?.url === "string") this.collectUrl(record.url);
        if (typeof record?.location === "string") this.collectUrl(record.location, typeof record.url === "string" ? record.url : undefined);
      }
    }
    if (typeof response.body === "string") this.collectBody(response.body, headerValue(headers, "content-type"));
  }

  private collectUrl(ref: string, base?: string): void {
    const url = safe(() => new URL(ref, base ?? DUMMY_BASE), undefined);
    if (!url) return;
    this.add(safeDecode(url.username));
    this.add(safeDecode(url.password));
    for (const part of [url.search.slice(1), url.hash.slice(1)]) {
      for (const [key, value] of splitParams(part)) if (isUrlParamKey(key, this.names)) this.add(value);
    }
  }

  private collectHeaders(headers: Array<[string, string]>, url: string | undefined): void {
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (lower === "cookie" || lower === "set-cookie") {
        for (const [cookie, cookieValue] of cookiePairs(value, lower === "set-cookie")) {
          if (isCredentialName(cookie, this.names) || (cookieValue.length >= 8 && /\d/.test(cookieValue))) this.add(cookieValue);
        }
      } else if (isCredentialHeader(name, this.names)) {
        this.add(value);
        const scheme = /^\s*(?:Bearer|Basic|Token|Digest|DPoP)\s+(\S+)\s*$/i.exec(value);
        if (scheme) {
          this.add(scheme[1]);
          const decoded = /^basic/i.test(value.trim()) ? safe(() => atob(scheme[1]), "") : "";
          if (decoded.includes(":")) this.add(decoded.slice(decoded.indexOf(":") + 1));
        }
      } else if (URL_HEADERS.has(lower)) {
        this.collectUrl(value, url);
      }
    }
  }

  private collectBody(body: string, contentType: string | undefined): void {
    const parsed = safe(() => ({ value: JSON.parse(body) as unknown }), undefined);
    if (parsed) {
      this.collectJson(parsed.value);
      // Members a JSON parser drops (earlier duplicates) are still on the wire.
      for (const match of body.matchAll(/"((?:[^"\\]|\\.){1,256})"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/g)) {
        const key = safe(() => JSON.parse(`"${match[1]}"`) as string, match[1]);
        if (isCredentialName(key, this.names) && !isCountKey(key)) this.add(safe(() => JSON.parse(match[2]) as unknown, undefined));
      }
    } else if (isFormBody(body, contentType)) {
      for (const [key, value] of splitParams(body)) if (isCredentialName(key, this.names)) this.add(value);
    }
  }

  private collectJson(root: unknown): void {
    const pending: Array<{ value: unknown; credential: boolean }> = [{ value: root, credential: false }];
    while (pending.length > 0) {
      const { value, credential } = pending.pop()!;
      if (value === null || typeof value !== "object") {
        if (credential && (typeof value !== "string" || value.length >= 8 || isTokenShaped(value))) this.add(value);
        continue;
      }
      if (Array.isArray(value)) {
        const pair = isCredentialPair(value, this.names);
        value.forEach((item, index) => {
          if (pair && index === 1 && (item === null || typeof item !== "object")) this.add(item);
          else pending.push({ value: item, credential });
        });
        continue;
      }
      const record = value as Record<string, unknown>;
      const container = hasCredentialName(record, this.names);
      for (const [key, item] of Object.entries(record)) {
        const member = isCredentialMember(key, container, this.names);
        if (member && !isCount(key, item) && (item === null || typeof item !== "object")) this.add(item);
        else pending.push({ value: item, credential: credential || (member && !isCount(key, item)) });
      }
    }
  }

  scrub(text: string): string {
    if (this.values.size === 0 || text.length < MIN_VALUE_LENGTH) return text;
    const automaton = (this.automaton ??= buildAutomaton(this.values));
    const intervals: Array<[number, number]> = [];
    let state = 0;
    let budget = 4 * text.length + 1_000_000;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      let next = automaton.edges.get(state * 65_536 + code);
      while (next === undefined && state !== 0) {
        state = automaton.fail[state];
        next = automaton.edges.get(state * 65_536 + code);
        if ((budget -= 1) < 0) throw new Error("credential scrub budget exceeded");
      }
      state = next ?? 0;
      let start = automaton.long[state] > 0 ? i - automaton.long[state] + 1 : i + 1;
      for (let node = automaton.bounded[state] > 0 ? state : automaton.boundedLink[state]; node > 0; node = automaton.boundedLink[node]) {
        if ((budget -= 1) < 0) throw new Error("credential scrub budget exceeded");
        const from = i - automaton.bounded[node] + 1;
        if (from < start && !isWordCode(text.charCodeAt(from - 1)) && !isWordCode(text.charCodeAt(i + 1))) start = from;
      }
      if (start > i) continue;
      while (intervals.length > 0 && intervals[intervals.length - 1][1] >= start - 1) {
        start = Math.min(start, intervals.pop()![0]);
      }
      intervals.push([start, i]);
    }
    if (intervals.length === 0) return text;
    let out = "";
    let last = 0;
    for (const [start, end] of intervals) {
      out += text.slice(last, start) + REDACTED;
      last = end + 1;
    }
    return out + text.slice(last);
  }
}

const isWordCode = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;

/** Aho-Corasick automaton: long[] is the longest unbounded match at a node, bounded[] its own whole-word-only length. */
function buildAutomaton(values: Map<string, boolean>): Automaton {
  const edges = new Map<number, number>();
  const ownLong: number[] = [0];
  const ownBounded: number[] = [0];
  for (const [value, bounded] of values) {
    let node = 0;
    for (let i = 0; i < value.length; i += 1) {
      const key = node * 65_536 + value.charCodeAt(i);
      let next = edges.get(key);
      if (next === undefined) {
        next = ownLong.length;
        ownLong.push(0);
        ownBounded.push(0);
        edges.set(key, next);
      }
      node = next;
    }
    if (bounded) ownBounded[node] = value.length;
    else ownLong[node] = value.length;
  }
  const size = ownLong.length;
  const fail = new Int32Array(size);
  const long = Int32Array.from(ownLong);
  const bounded = Int32Array.from(ownBounded);
  const boundedLink = new Int32Array(size);
  const children: number[][] = Array.from({ length: size }, () => []);
  for (const [key, child] of edges) children[Math.floor(key / 65_536)].push(key % 65_536, child);
  const queue: number[] = [];
  for (let k = 0; k < children[0].length; k += 2) queue.push(children[0][k + 1]);
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    const list = children[node];
    for (let k = 0; k < list.length; k += 2) {
      const code = list[k];
      const child = list[k + 1];
      let f = fail[node];
      let target = edges.get(f * 65_536 + code);
      while (target === undefined && f !== 0) {
        f = fail[f];
        target = edges.get(f * 65_536 + code);
      }
      fail[child] = target !== undefined && target !== child ? target : 0;
      long[child] = Math.max(long[child], long[fail[child]]);
      boundedLink[child] = bounded[fail[child]] > 0 ? fail[child] : boundedLink[fail[child]];
      queue.push(child);
    }
  }
  return { edges, fail, long, bounded, boundedLink };
}

export function createCredentialRegistry(redactHeaders: readonly string[] = []): CredentialRegistry {
  return new Registry(redactHeaders);
}

// ---------------------------------------------------------------------------
// Layer 1: URLs, headers, JSON and form bodies
// ---------------------------------------------------------------------------

function safe<T, F>(work: () => T, fallback: F): T | F {
  try {
    return work();
  } catch {
    return fallback;
  }
}

const safeDecode = (value: string): string => safe(() => decodeURIComponent(value.replace(/\+/g, " ")), value);

function splitParams(raw: string): Array<[string, string]> {
  if (!raw.includes("=")) return [];
  return raw.split(/[&;]/).flatMap((part): Array<[string, string]> => {
    const eq = part.indexOf("=");
    return eq <= 0 ? [] : [[safeDecode(part.slice(0, eq)), safeDecode(part.slice(eq + 1))]];
  });
}

function redactParams(raw: string, names: ReadonlySet<string>): string {
  return raw
    .split(/([&;])/)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0 || part.slice(eq + 1) === "" || part.slice(eq + 1) === REDACTED) return part;
      return isUrlParamKey(safeDecode(part.slice(0, eq)), names) ? `${part.slice(0, eq)}=${REDACTED}` : part;
    })
    .join("");
}

/** Keeps the scheme and slashes of a URL that does not parse; for a relative one, the text before @ ? #. */
function failClosedUrl(ref: string): string {
  const prefix = /^[A-Za-z][A-Za-z0-9+.-]*:[\\/\t\r\n]*|^[\\/][\t\r\n]*[\\/]/.exec(ref);
  if (prefix) return prefix[0] + REDACTED;
  const cut = ref.search(/[@?#]/);
  return cut < 0 ? ref : ref.slice(0, cut) + REDACTED;
}

/**
 * Removes userinfo and credential query and fragment parameters from a URL,
 * resolved against base by the WHATWG parser. A URL with nothing to redact is
 * returned as written; otherwise the serialized absolute URL is returned.
 */
export function redactUrl(ref: string, options: RedactionOptions & { base?: string } = {}): string {
  const names = contextOf(options).names;
  const url = safe(() => (options.base === undefined ? new URL(ref) : new URL(ref, options.base)), undefined);
  if (!url) return failClosedUrl(ref);
  let changed = false;
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
    changed = true;
  }
  const search = redactParams(url.search.slice(1), names);
  if (search !== url.search.slice(1)) {
    url.search = search;
    changed = true;
  }
  const hash = redactParams(url.hash.slice(1), names);
  if (hash !== url.hash.slice(1)) {
    url.hash = hash;
    changed = true;
  }
  return changed ? url.href : ref;
}

function asHeaders(headers: unknown): Array<[string, string]> {
  if (!headers || typeof headers !== "object") return [];
  return Object.entries(headers as Record<string, unknown>).map(([name, value]) => [name, String(value)]);
}

function headerValue(headers: Array<[string, string]>, name: string): string | undefined {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

function isCredentialHeader(name: string, names: ReadonlySet<string>): boolean {
  return isCredentialName(name, names) || headerWordMatch(name) || (normalize(name).endsWith("key") && normalize(name).length > 3);
}

/** The name/value pairs of a Cookie or Set-Cookie value (Set-Cookie attributes are skipped). */
function cookiePairs(value: string, setCookie: boolean): Array<[string, string]> {
  return value.split(setCookie ? /[;,]/ : /;/).flatMap((part): Array<[string, string]> => {
    const eq = part.indexOf("=");
    const name = part.slice(0, eq).trim();
    return eq <= 0 || (setCookie && COOKIE_ATTRIBUTES.has(name.toLowerCase())) ? [] : [[name, part.slice(eq + 1).trim()]];
  });
}

function redactCookie(value: string, setCookie: boolean): string {
  return value
    .split(setCookie ? /([;,])/ : /(;)/)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0 || (setCookie && COOKIE_ATTRIBUTES.has(part.slice(0, eq).trim().toLowerCase()))) return part;
      return `${part.slice(0, eq)}=${REDACTED}`;
    })
    .join("");
}

function redactHeaderMap(headers: unknown, ctx: Context, base: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of asHeaders(headers)) {
    const lower = name.toLowerCase();
    result[name] = safe(() => {
      if (lower === "cookie" || lower === "set-cookie") return redactCookie(value, lower === "set-cookie");
      if (isCredentialHeader(name, ctx.names)) return REDACTED;
      if (URL_HEADERS.has(lower)) return redactUrl(value, { base, redactHeaders: [...ctx.names] });
      return redactTextIn(value, ctx);
    }, WITHHELD);
  }
  return result;
}

export function redactHeaders(headers: Record<string, string>, options: RedactionOptions & { base?: string } = {}): Record<string, string> {
  return redactHeaderMap(headers, contextOf(options), options.base);
}

const hasCredentialName = (record: Record<string, unknown>, names: ReadonlySet<string>): boolean =>
  Object.entries(record).some(([key, value]) => NAME_KEYS.has(key.toLowerCase()) && typeof value === "string" && isCredentialName(value, names));

/** A [name, value] pair (header lists, form tuples) whose name is a credential name. */
const isCredentialPair = (items: unknown[], names: ReadonlySet<string>): boolean =>
  items.length === 2 && typeof items[0] === "string" && isCredentialName(items[0], names);

const isCredentialMember = (key: string, container: boolean, names: ReadonlySet<string>): boolean =>
  isCredentialName(key, names) || (container && VALUE_KEYS.has(key.toLowerCase()));

const isCount = (key: string, value: unknown): boolean => (typeof value === "number" || typeof value === "bigint") && isCountKey(key);

function setMember(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Redacts a parsed JSON value: credential members, value members of credential name/value objects, and text leaves. */
function walkJson(root: unknown, ctx: Context): unknown {
  const leaf = (value: unknown): unknown =>
    typeof value === "string" ? redactTextIn(value, ctx) : (typeof value === "number" || typeof value === "bigint") && ctx.registry.has(value) ? REDACTED : value;
  if (root === null || typeof root !== "object") return leaf(root);
  const output: unknown = Array.isArray(root) ? [] : {};
  const pending: Array<{ source: object; target: unknown; depth: number }> = [{ source: root, target: output, depth: 1 }];
  while (pending.length > 0) {
    const { source, target, depth } = pending.pop()!;
    const isArray = Array.isArray(source);
    const container = isArray ? isCredentialPair(source as unknown[], ctx.names) : hasCredentialName(source as Record<string, unknown>, ctx.names);
    const entries: Array<[string | number, unknown]> = isArray ? [...(source as unknown[]).entries()] : Object.entries(source);
    for (const [key, value] of entries) {
      let next: unknown;
      if (isArray ? container && key === 1 : isCredentialMember(key as string, container, ctx.names)) {
        next = value === null || typeof value === "boolean" || isCount(String(key), value) ? value : REDACTED;
      } else if (value !== null && typeof value === "object") {
        next = depth >= MAX_JSON_DEPTH ? TOO_DEEP : Array.isArray(value) ? [] : {};
        if (depth < MAX_JSON_DEPTH) pending.push({ source: value, target: next, depth: depth + 1 });
      } else {
        next = leaf(value);
      }
      if (isArray) (target as unknown[])[key as number] = next;
      else setMember(target as Record<string, unknown>, ctx.registry.scrub(key as string), next);
    }
  }
  return output;
}

export function redactJsonValue(value: unknown, options: RedactionOptions = {}): unknown {
  return walkJson(value, contextOf(options));
}

function isFormBody(body: string, contentType: string | undefined): boolean {
  if (contentType !== undefined) return /x-www-form-urlencoded/i.test(contentType);
  return /^[^\s=&]+=[^\s&]*(?:&[^\s=&]+=[^\s&]*)*$/.test(body);
}

function redactBodyIn(body: string, ctx: Context, contentType: string | undefined): string {
  const parsed = safe(() => ({ value: JSON.parse(body) as unknown }), undefined);
  if (parsed) return JSON.stringify(walkJson(parsed.value, ctx), null, 2) ?? REDACTED;
  if (isFormBody(body, contentType)) return ctx.registry.scrub(redactParams(body, ctx.names));
  return redactTextIn(body, ctx);
}

export function redactBody(body: string | undefined, options: RedactionOptions & { contentType?: string } = {}): string | undefined {
  return body === undefined ? undefined : redactBodyIn(body, contextOf(options), options.contentType);
}

// ---------------------------------------------------------------------------
// Layer 2: unstructured text
// ---------------------------------------------------------------------------

export function redactText(text: string, options: RedactionOptions = {}): string {
  return redactTextIn(text, contextOf(options));
}

function redactTextIn(text: string, ctx: Context): string {
  if (text.length === 0) return text;
  return redactUrlTokens(redactKeywords(ctx.registry.scrub(text), ctx.names), ctx.names);
}

function isKeyCode(c: number): boolean {
  return isWordCode(c) || c === 45 || c === 46 || c === 43 || c === 33 || c === 35 || c === 36 || c === 37 || c === 42 || c === 94 || c === 96 || c === 124 || c === 126;
}

const isLineBreak = (c: number): boolean => c === 10 || c === 13;
const OPENERS = "([{<";
const CLOSERS = ")]}>";

/** Length of a backslash run plus u+4 hex at i (an escaped character), or 0. */
function escapeLength(text: string, i: number): number {
  let j = i;
  while (text.charCodeAt(j) === 92) j += 1;
  return j > i && /^u[0-9a-fA-F]{4}/.test(text.slice(j, j + 5)) ? j - i + 5 : 0;
}

const escapedChar = (text: string, i: number, length: number): string =>
  String.fromCharCode(Number.parseInt(text.slice(i + length - 4, i + length), 16));

/** End of the key token starting at i: key characters, \uXXXX escapes of them and [segment] groups. */
function tokenEnd(text: string, i: number): number {
  let j = i;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === 37 && /^%(?:3d|3a|26|20|22|27)/i.test(text.slice(j, j + 3))) break;
    if (isKeyCode(c)) {
      j += 1;
      continue;
    }
    const escape = c === 92 ? escapeLength(text, j) : 0;
    if (escape > 0 && isKeyCode(escapedChar(text, j, escape).charCodeAt(0))) {
      j += escape;
      continue;
    }
    if (c === 91 && j > i) {
      const close = text.indexOf("]", j);
      if (close > j && close - j < 64 && /^\[[^\s[\]"']*\]$/.test(text.slice(j, close + 1))) {
        j = close + 1;
        continue;
      }
    }
    break;
  }
  return j;
}

/** End of the separator after a key (closing quotes and space, then : = => %3D %3A, or > of a tag), or -1. */
function separatorEnd(text: string, start: number, end: number): number {
  // A command-line flag (--password value) or a tab-separated pair (token<TAB>value).
  if (text[end] === "\t" || (text[start] === "-" && text[end] === " " && /[^\s-]/.test(text[end + 1] ?? ""))) return end + 1;
  let j = end;
  let lines = 0;
  const limit = end + 64;
  while (j < text.length && j < limit) {
    const c = text.charCodeAt(j);
    const escape = c === 92 ? escapeLength(text, j) : 0;
    if (c === 34 || c === 39 || c === 32 || c === 9) j += 1;
    else if (isLineBreak(c) && lines < 2) {
      lines += 1;
      j += 1;
    } else if (c === 92 && escape === 0) j += /[ntr]/.test(text[j + 1] ?? "") ? 2 : 1;
    else if (escape > 0 && /["' \t\n\r]/.test(escapedChar(text, j, escape))) j += escape;
    else if (c === 37 && /^%(?:22|27|20)/i.test(text.slice(j, j + 3))) j += 3;
    else break;
  }
  const c = text[j];
  if (c === ":" && text.slice(j, j + 3) !== "://") return j + 1;
  if (c === "=") {
    while (text[j] === "=") j += 1;
    return text[j] === ">" ? j + 1 : j;
  }
  if (/^%3[da]/i.test(text.slice(j, j + 3))) return j + 3;
  // An element named by the key (<password>, <ns:Password attr="x">): its content follows the start tag.
  let k = start - 2;
  while (k >= 0 && k > start - 64 && /[\w.-]/.test(text[k])) k -= 1;
  if (text[start - 1] === "<" || (text[start - 1] === ":" && text[k] === "<")) {
    const close = text.slice(end, end + 256).search(/\/?>/);
    if (close >= 0 && text[end + close] === ">") return end + close + 1;
  }
  return -1;
}

function lineStartOf(text: string, i: number): number {
  let j = i;
  while (j > 0 && !isLineBreak(text.charCodeAt(j - 1))) j -= 1;
  return j;
}

function lineEndOf(text: string, i: number): number {
  let j = i;
  while (j < text.length && !isLineBreak(text.charCodeAt(j))) j += 1;
  return j;
}

/** Marks characters inside quoted strings; strings end at a line break and an apostrophe between letters is not a quote. */
function quoteMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  let quote = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (quote !== 0) {
      mask[i] = 1;
      if (isLineBreak(c)) {
        quote = 0;
        mask[i] = 0;
      } else if (c === 92) {
        if (i + 1 < text.length && !isLineBreak(text.charCodeAt(i + 1))) mask[++i] = 1;
      } else if (c === quote) quote = 0;
    } else if (c === 34 || (c === 39 && !(isWordCode(text.charCodeAt(i - 1)) && isWordCode(text.charCodeAt(i + 1))))) {
      quote = c;
      mask[i] = 1;
    }
  }
  return mask;
}

const isOpenerAt = (text: string, i: number): boolean =>
  "([{".includes(text[i]) || (text[i] === "<" && /[A-Za-z/!?[]/.test(text[i + 1] ?? ""));

class Budget {
  constructor(public left: number) {}
  spend(): boolean {
    this.left -= 1;
    return this.left >= 0;
  }
}

/** The innermost unclosed opener before from, or -1 (none within the scan limit, or a mismatched pair). */
function openerBefore(text: string, from: number, mask: Uint8Array | null, budget: Budget): number {
  const stack: string[] = [];
  for (let i = from - 1; i >= 0 && i >= from - SCAN_BACK_LIMIT; i -= 1) {
    if (!budget.spend()) return -1;
    if (mask?.[i]) continue;
    const c = text[i];
    if (CLOSERS.includes(c)) stack.push(c);
    else if (isOpenerAt(text, i)) {
      if (stack.length === 0) return i;
      if (CLOSERS[OPENERS.indexOf(c)] !== stack.pop()) return -1;
    }
  }
  return -1;
}

/** The closer matching the opener at o, or the end of the text when it is unclosed or a closer mismatches. */
function closerAfter(text: string, o: number, mask: Uint8Array | null, budget: Budget): number {
  const stack = [text[o]];
  for (let i = o + 1; i < text.length; i += 1) {
    if (!budget.spend()) return text.length;
    if (mask?.[i]) continue;
    const c = text[i];
    if (isOpenerAt(text, i)) stack.push(c);
    else if (CLOSERS.includes(c)) {
      const expected = CLOSERS[OPENERS.indexOf(stack[stack.length - 1])];
      if (c === ">" && expected !== ">") continue;
      if (c !== expected) return text.length;
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return text.length;
}

/** Extends [start, end) line by line while ( [ { opened in it stay unclosed; a mismatched closer runs to the end of the text. */
function balancedEnd(text: string, start: number, end: number, mask: Uint8Array): number {
  const stacks: [string[], string[]] = [[], []];
  let from = start;
  let to = end;
  for (;;) {
    for (let i = from; i < to; i += 1) {
      const c = text[i];
      const opener = "([{".indexOf(c);
      const closer = ")]}".indexOf(c);
      if (opener < 0 && closer < 0) continue;
      for (const [index, stack] of stacks.entries()) {
        if (index === 0 && mask[i]) continue;
        if (opener >= 0) stack.push(c);
        else if (stack.length > 0) {
          if ("([{"[closer] !== stack.pop()) return text.length;
        }
      }
    }
    if ((stacks[0].length === 0 && stacks[1].length === 0) || to >= text.length) return to;
    from = to;
    to = lineEndOf(text, to + 1);
  }
}

/** Pass 2 spans: (a) keys with separators, (b) credential names in value position, (d) private keys, (e) Bearer/Basic. */
function keywordSpans(text: string, names: ReadonlySet<string>): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let mask: Uint8Array | undefined;
  const getMask = (): Uint8Array => (mask ??= quoteMask(text));
  const budget = new Budget(8 * text.length + 100_000);
  let covered = 0;
  let nameValueAt = -1;
  const memo = new Map<string, boolean>();
  const cached = (token: string, work: () => boolean): boolean => {
    let hit = memo.get(token);
    if (hit === undefined) {
      hit = work();
      if (memo.size < 10_000) memo.set(token, hit);
    }
    return hit;
  };

  const container = (nameStart: number, nameEnd: number): void => {
    if (nameStart < covered) return;
    const lineStart = lineStartOf(text, nameStart);
    const candidates = [openerBefore(text, nameStart, getMask(), budget), openerBefore(text, nameStart, null, budget)];
    const opener = Math.min(...candidates.map((o) => (o < 0 ? lineStart : o)));
    let start: number;
    let end: number;
    if (candidates.includes(opener) && opener >= 0) {
      start = opener + 1;
      end = Math.max(closerAfter(text, opener, getMask(), budget), closerAfter(text, opener, null, budget));
    } else {
      start = lineStart;
      const lineEnd = lineEndOf(text, nameEnd);
      end = /^[\s"';,]*$/.test(text.slice(nameEnd, lineEnd)) ? partEnd(text, lineStart, lineEnd) : balancedEnd(text, lineStart, lineEnd, getMask());
    }
    if (budget.left < 0) end = text.length;
    spans.push([start, nameStart], [nameEnd, end]);
    covered = Math.max(covered, end);
  };

  let i = 0;
  let keyCovered = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    const escape = c === 92 ? escapeLength(text, i) : 0;
    if (c === 92 && escape === 0 && /[ntr]/.test(text[i + 1] ?? "")) {
      i += 2;
      continue;
    }
    if (!isKeyCode(c) && !(escape > 0 && isKeyCode(escapedChar(text, i, escape).charCodeAt(0)))) {
      i += 1;
      continue;
    }
    const start = i;
    const end = tokenEnd(text, i);
    i = Math.max(end, start + 1);
    if (end - start > 256) continue;
    const token = text.slice(start, end);
    const keyword = cached(token, () => isTextKeyword(token, names));
    const nameKey = NAME_KEYS.has(normalize(decodeEscapes(token)));
    const separator = keyword || nameKey ? separatorEnd(text, start, end) : -1;
    if (keyword && separator >= 0 && start >= keyCovered) {
      let valueStart = separator;
      while (text[valueStart] === " " || text[valueStart] === "\t") valueStart += 1;
      let valueEnd = lineEndOf(text, valueStart);
      if (/^[\s"'{[(<\\]*$/.test(text.slice(valueStart, valueEnd))) {
        let next = valueEnd;
        while (next < text.length && /\s/.test(text[next])) next += 1;
        if (next < text.length) valueEnd = lineEndOf(text, next);
      }
      valueEnd = balancedEnd(text, valueStart, valueEnd, getMask());
      if (valueEnd > valueStart) spans.push([valueStart, valueEnd]);
      // Keep scanning inside the value for credential names in value position, but not for more keys.
      keyCovered = valueEnd;
      continue;
    }
    if (keyword && separator >= 0) continue;
    if (nameKey && separator >= 0) {
      nameValueAt = separator;
      continue;
    }
    if (!keyword || BARE_WORDS.has(normalize(decodeEscapes(token)))) continue;
    // A credential name as a whole quoted string, a whole element, or the value of a name/key member.
    let nameStart = start;
    let nameEnd = end;
    const quote = text[start - 1];
    let ahead = end;
    while (text[ahead] === "\\") ahead += 1;
    if ((quote === '"' || quote === "'") && text[ahead] === quote) {
      nameStart = start - 1;
      while (nameStart > 0 && text[nameStart - 1] === "\\") nameStart -= 1;
      nameEnd = ahead + 1;
    } else if (escapedQuoteBefore(text, start) > 0 && /^\\+u00(?:22|27)/i.test(text.slice(end, end + 12))) {
      nameStart = start - escapedQuoteBefore(text, start);
      nameEnd = end + /^\\+u00(?:22|27)/i.exec(text.slice(end, end + 12))![0].length;
    } else if (
      !(text[start - 1] === ">" && text[end] === "<") &&
      !(nameValueAt >= 0 && start - nameValueAt <= 8 && /^[\s"'\\]*$/.test(text.slice(nameValueAt, start)))
    ) {
      continue;
    }
    container(nameStart, nameEnd);
  }

  for (const match of text.matchAll(/-----BEGIN ([A-Z0-9 ]{0,40}PRIVATE KEY)-----/g)) {
    const from = match.index! + match[0].length;
    const close = text.indexOf(`-----END ${match[1]}-----`, from);
    spans.push([from, close < 0 ? text.length : close]);
  }
  for (const match of text.matchAll(/\b(?:Bearer|Basic)[ \t]+([A-Za-z0-9\-._~+/]+=*)/g)) {
    if (isTokenShaped(match[1])) spans.push([match.index! + match[0].length - match[1].length, match.index! + match[0].length]);
  }
  return spans;
}

/**
 * A name that ends its line names the lines that follow (a multipart part header): they are redacted up to the
 * part's own boundary line, found as the nearest earlier line starting with "--", or to the end of the text.
 */
function partEnd(text: string, lineStart: number, lineEnd: number): number {
  let boundary: string | undefined;
  for (let end = lineStart - 1, scanned = 0; end > 0 && scanned < SCAN_BACK_LIMIT && boundary === undefined; ) {
    while (end > 0 && isLineBreak(text.charCodeAt(end - 1))) end -= 1;
    const start = lineStartOf(text, end);
    const line = text.slice(start, end);
    if (/^--\S+$/.test(line)) boundary = line;
    scanned += end - start + 1;
    end = start;
  }
  if (boundary === undefined) return text.length;
  const blank = text.slice(lineEnd).search(/\r?\n\r?\n/);
  if (blank < 0) return text.length;
  for (let from = lineEnd + blank; from < text.length; ) {
    const start = text.indexOf(boundary, from);
    if (start < 0) return text.length;
    const end = lineEndOf(text, start);
    if (isLineBreak(text.charCodeAt(start - 1)) && (end === start + boundary.length || text.slice(start + boundary.length, end) === "--")) {
      return text.charCodeAt(start - 2) === 13 ? start - 2 : start - 1;
    }
    from = start + 1;
  }
  return text.length;
}

/** Length of an escaped quote (\\u0022 or \\u0027, any backslash run) ending at i, or 0. */
function escapedQuoteBefore(text: string, i: number): number {
  const from = Math.max(0, i - 12);
  const match = /\\+u00(?:22|27)$/i.exec(text.slice(from, i));
  return match ? match[0].length : 0;
}

function applySpans(text: string, spans: Array<[number, number]>): string {
  const sorted = spans.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) return text;
  let out = "";
  let last = 0;
  let current: [number, number] | undefined;
  const flush = (): void => {
    if (!current) return;
    out += text.slice(last, current[0]) + REDACTED;
    last = current[1];
  };
  for (const span of sorted) {
    if (current && span[0] <= current[1]) current[1] = Math.max(current[1], span[1]);
    else {
      flush();
      current = [span[0], span[1]];
    }
  }
  flush();
  return out + text.slice(last);
}

function redactKeywords(text: string, names: ReadonlySet<string>): string {
  return applySpans(text, keywordSpans(text, names));
}

const isSchemeCode = (c: number): boolean => (isWordCode(c) && c !== 95) || c === 43 || c === 46 || c === 45;
const isTokenStop = (c: number): boolean => c === 32 || isLineBreak(c);

/** Drops trailing punctuation from a URL token; a closing bracket stays when the token opened one (such as a marker). */
function trimUrlToken(token: string): string {
  let end = token.length;
  for (;;) {
    const c = token[end - 1];
    const opener = c === "]" ? "[" : c === ")" ? "(" : c === "}" ? "{" : undefined;
    if (!c || !`"'<>)]},.;`.includes(c)) break;
    if (opener && token.slice(0, end - 1).split(opener).length > token.slice(0, end - 1).split(c).length) break;
    end -= 1;
  }
  return token.slice(0, end);
}

/** Pass 3: URL tokens (from scheme: or a pair of slashes to a space or line break) through redactUrl. */
function redactUrlTokens(text: string, names: ReadonlySet<string>): string {
  if (!/[@?#]/.test(text)) return text;
  const redactHeaders = [...names];
  let out = "";
  let last = 0;
  let termAt = -1;
  let lastAt = -1;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    let prefixEnd = -1;
    let schemeLess = false;
    if (((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) && !isSchemeCode(text.charCodeAt(i - 1))) {
      let j = i + 1;
      while (j < text.length && isSchemeCode(text.charCodeAt(j))) j += 1;
      if (text[j] !== ":") {
        i = j;
        continue;
      }
      prefixEnd = j + 1;
    } else if ((c === 47 || c === 92) && /^[\\/][\t\r\n]*[\\/]/.test(text.slice(i, i + 8))) {
      prefixEnd = i + 1;
      schemeLess = true;
    } else {
      i += 1;
      continue;
    }
    // Slashes after the scheme, with tabs and (between two slashes) line breaks, which the parser removes.
    let authority = prefixEnd;
    for (let k = prefixEnd; k < text.length && /[\\/\t\r\n]/.test(text[k]); k += 1) {
      if (/[\\/\t]/.test(text[k]) || (/[\\/]/.test(text[k - 1] ?? "") || schemeLess) && /^[\t\r\n]*[\\/]/.test(text.slice(k, k + 8))) authority = k + 1;
      else break;
    }
    let end = authority;
    while (end < text.length && !isTokenStop(text.charCodeAt(end))) end += 1;
    if (termAt < authority) {
      lastAt = -1;
      termAt = authority;
      while (termAt < text.length && !/[/?#\r\n]/.test(text[termAt])) {
        if (text[termAt] === "@") lastAt = termAt;
        termAt += 1;
      }
    }
    if (lastAt >= authority && lastAt >= end) {
      end = lastAt;
      while (end < text.length && !isTokenStop(text.charCodeAt(end))) end += 1;
    }
    const token = trimUrlToken(text.slice(i, end));
    // An authority that runs to the end of the line, with the next line starting at @, is userinfo cut by a line break.
    const slashes = schemeLess || /[\\/]/.test(text.slice(prefixEnd, authority));
    if (slashes && isLineBreak(text.charCodeAt(termAt)) && lastAt < authority && /^[\r\n\t ]*@/.test(text.slice(termAt, termAt + 64))) {
      out += text.slice(last, i) + text.slice(i, authority) + REDACTED;
      last = termAt;
      i = termAt;
      continue;
    }
    let replacement = token;
    if (/[@?#]/.test(token)) {
      replacement = redactUrl(token, schemeLess ? { base: DUMMY_BASE, redactHeaders } : { redactHeaders });
      if (schemeLess && replacement !== token && replacement.startsWith("https:")) replacement = replacement.slice("https:".length);
    }
    if (replacement !== token) {
      out += text.slice(last, i) + replacement;
      last = i + token.length;
    }
    i = Math.max(end, i + 1);
  }
  return last === 0 ? text : out + text.slice(last);
}

// ---------------------------------------------------------------------------
// Run results and reports
// ---------------------------------------------------------------------------

/** The longest prefix of text whose UTF-8 encoding fits in maxBytes, never splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes > maxBytes) return text.slice(0, i);
    if (pair) i += 1;
  }
  return text;
}

export interface SanitizeOptions extends RedactionOptions {
  /** Largest response body kept, in UTF-8 bytes, after redaction (default 10 MiB). */
  bodyLimit?: number;
}

type Loose = Record<string, unknown>;

function field<T>(work: () => T): T | string {
  return safe(work, WITHHELD);
}

function sanitizeValue(value: unknown, ctx: Context): unknown {
  if (typeof value === "string") return redactTextIn(value, ctx);
  if (ctx.registry.has(value)) return REDACTED;
  return value !== null && typeof value === "object" ? walkJson(value, ctx) : value;
}

/**
 * Sanitizes one run result for reporting: URLs, headers and bodies by
 * structure, every text field by the Layer 2 passes, and every credential
 * value the result or the run registry knows wherever it appears. A field that
 * cannot be sanitized is withheld; this never throws.
 */
export function sanitizeRequestResult<T extends object>(result: T, options: SanitizeOptions = {}): T {
  const ctx = contextOf(options);
  const source = result as Loose;
  const request = (source.request ?? undefined) as Loose | undefined;
  const response = (source.response ?? undefined) as Loose | undefined;
  safe(() => request && ctx.registry.collectRequest(request), undefined);
  safe(() => response && ctx.registry.collectResponse({ ...response, url: request?.url }), undefined);
  const text = (value: unknown): unknown => (typeof value === "string" ? field(() => redactTextIn(value, ctx)) : value);
  const url = (value: unknown, base?: unknown): unknown =>
    typeof value === "string" ? field(() => redactUrl(value, { base: typeof base === "string" ? base : undefined, redactHeaders: [...ctx.names] })) : value;
  const out: Loose = { ...source };
  if ("name" in source) out.name = text(source.name);
  if ("url" in source) out.url = url(source.url);
  if ("error" in source) out.error = text(source.error);
  if (Array.isArray(source.warnings)) out.warnings = source.warnings.map(text);
  if (Array.isArray(source.attempts)) {
    out.attempts = source.attempts.map((attempt: Loose) =>
      attempt && typeof attempt === "object" && "error" in attempt ? { ...attempt, error: text(attempt.error) } : attempt,
    );
  }
  if (Array.isArray(source.assertions)) {
    out.assertions = source.assertions.map((assertion: Loose) => {
      if (!assertion || typeof assertion !== "object") return assertion;
      const next: Loose = { ...assertion, name: text(assertion.name) };
      for (const key of ["expected", "actual"] as const) if (key in assertion) next[key] = field(() => sanitizeValue(assertion[key], ctx));
      if ("error" in assertion) next.error = text(assertion.error);
      return next;
    });
  }
  if (request && typeof request === "object") {
    const headers = asHeaders(request.headers);
    out.request = {
      ...request,
      url: url(request.url),
      headers: field(() => redactHeaderMap(request.headers ?? {}, ctx, typeof request.url === "string" ? request.url : undefined)),
      ...(request.body === undefined ? {} : { body: typeof request.body === "string" ? field(() => redactBodyIn(request.body as string, ctx, headerValue(headers, "content-type"))) : request.body }),
    };
  }
  if (response && typeof response === "object") {
    const headers = asHeaders(response.headers);
    const base = typeof request?.url === "string" ? request.url : undefined;
    const limit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
    out.response = {
      ...response,
      headers: field(() => redactHeaderMap(response.headers ?? {}, ctx, base)),
      body: typeof response.body === "string" ? field(() => truncateUtf8(redactBodyIn(response.body as string, ctx, headerValue(headers, "content-type")), limit)) : response.body,
      ...(Array.isArray(response.redirects)
        ? {
            redirects: field(() =>
              (response.redirects as Loose[]).map((record) => ({ ...record, url: url(record.url), location: url(record.location, record.url) })),
            ),
          }
        : {}),
    };
  }
  return out as T;
}

/** Sanitizes every result of a run report (idempotent; reporters may apply it to an already sanitized report). */
export function sanitizeRunReport<T extends object>(report: T, options: SanitizeOptions = {}): T {
  const source = report as Loose;
  if (!Array.isArray(source.results)) return report;
  return { ...source, results: source.results.map((result: object) => sanitizeRequestResult(result, options)) } as T;
}
