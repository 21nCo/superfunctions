/**
 * RFC 3986 URI references, for JSON Schema resource identity (`$id`, anchors)
 * and `$vocabulary` keys. Parsing follows the RFC grammar, never WHATWG URL
 * host parsing (`0x7f.1` is a name, not 127.0.0.1).
 */

export interface UriReference {
  scheme?: string;
  authority?: string;
  path: string;
  query?: string;
  fragment?: string;
}

// Appendix B splits any string; each part is then checked against its section 3 grammar.
const SPLIT = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const CHARS = (extra: string) => new RegExp(`^(?:[A-Za-z0-9\\-._~!$&'()*+,;=${extra}]|%[0-9A-Fa-f]{2})*$`);
const USERINFO = CHARS(":");
const REG_NAME = CHARS("");
const PATH = CHARS(":@/");
const QUERY = CHARS(":@/?");
const PORT = /^[0-9]*$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV_FUTURE = /^[vV][0-9A-Fa-f]+\.[A-Za-z0-9\-._~!$&'()*+,;=:]+$/;
const UNRESERVED = /[A-Za-z0-9\-._~]/;

function isIpv6(text: string): boolean {
  const halves = text.split("::");
  if (halves.length > 2) return false;
  const groups = halves.map((half) => (half === "" ? [] : half.split(":")));
  // An IPv4 tail is only allowed as the last group.
  const last = groups[groups.length - 1];
  let count = 0;
  if (last.length > 0 && last[last.length - 1].includes(".")) {
    if (!IPV4.test(last.pop()!)) return false;
    count = 2;
  }
  const hex = groups.flat();
  if (!hex.every((group) => /^[0-9A-Fa-f]{1,4}$/.test(group))) return false;
  count += hex.length;
  return halves.length === 2 ? count <= 7 : count === 8;
}

/** The authority's host, from after any user info to before any port. */
function hostSpan(authority: string): { start: number; end: number } {
  const start = authority.lastIndexOf("@") + 1;
  if (authority[start] === "[") {
    const close = authority.indexOf("]", start);
    return { start, end: close === -1 ? authority.length : close + 1 };
  }
  const colon = authority.indexOf(":", start);
  return { start, end: colon === -1 ? authority.length : colon };
}

function isAuthority(authority: string): boolean {
  const { start, end } = hostSpan(authority);
  if (start > 0 && !USERINFO.test(authority.slice(0, start - 1))) return false;
  const host = authority.slice(start, end);
  const rest = authority.slice(end);
  if (rest !== "" && !(rest[0] === ":" && PORT.test(rest.slice(1)))) return false;
  if (host.startsWith("[")) {
    if (!host.endsWith("]") || host.length < 2) return false;
    const literal = host.slice(1, -1);
    return isIpv6(literal) || IPV_FUTURE.test(literal);
  }
  return REG_NAME.test(host);
}

/** `text` split into its RFC 3986 components, or null when it is not a URI-reference (or, with `absolute`, not a URI). */
export function parseUriReference(text: string, absolute = false): UriReference | null {
  const match = SPLIT.exec(text);
  if (!match) return null;
  const [, scheme, authority, path, query, fragment] = match;
  if (scheme !== undefined ? !SCHEME.test(scheme) : absolute) return null;
  if (authority !== undefined && !isAuthority(authority)) return null;
  if (!PATH.test(path) || (query !== undefined && !QUERY.test(query)) || (fragment !== undefined && !QUERY.test(fragment))) return null;
  return { scheme, authority, path, query, fragment };
}

/** RFC 3986 section 6.2.2.2: unreserved characters decoded, other escapes in upper case. */
function normalizeEscapes(text: string): string {
  if (!text.includes("%")) return text;
  return text.replace(/%[0-9A-Fa-f]{2}/g, (escape) => {
    const character = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return UNRESERVED.test(character) ? character : escape.toUpperCase();
  });
}

/** A resolved URI held as interned parts; `key` is equal exactly for URIs equal after normalization. */
export interface UriKey {
  scheme: number;
  authority: number;
  /** A node of {@link UriTable}'s path trie: one interned segment and its parent. */
  path: number;
  query: number;
  key: string;
}

/**
 * Resolves references (RFC 3986 section 5.2) and compares the results after
 * syntax-based normalization (section 6.2.2: scheme and host case, percent
 * escapes, dot segments), with no scheme-based rules such as default ports.
 * Paths are interned segment by segment, so resolving a reference costs its
 * own length, never its base's: a long base `$id` with many relative children
 * stays linear.
 */
export class UriTable {
  private readonly strings = new Map<string, number>();
  /** Path trie nodes: node 0 is the path with no segments; `parents[n]` is node n without its last segment. */
  private readonly parents: number[] = [-1];
  private readonly segments: string[] = [""];
  private readonly children = new Map<string, number>();
  /** The base of a document without `$id`: an empty relative reference. */
  readonly document: UriKey;

  constructor() {
    this.document = this.uri(-1, -1, this.child(0, ""), -1);
  }

  private intern(text: string | undefined): number {
    if (text === undefined) return -1;
    let id = this.strings.get(text);
    if (id === undefined) this.strings.set(text, (id = this.strings.size));
    return id;
  }

  private child(parent: number, segment: string): number {
    const key = `${parent}/${segment}`;
    let node = this.children.get(key);
    if (node === undefined) {
      node = this.parents.length;
      this.parents.push(parent);
      this.segments.push(segment);
      this.children.set(key, node);
    }
    return node;
  }

  /** The leading empty segment of an absolute path (or the empty path) is never removed by `..`. */
  private isRoot(node: number): boolean {
    return node === 0 || (this.parents[node] === 0 && this.segments[node] === "");
  }

  /** Appends `path`'s segments to `node`, removing dot segments (section 5.2.4). */
  private walk(node: number, path: string): number {
    const parts = path.split("/");
    parts.forEach((raw, index) => {
      const segment = normalizeEscapes(raw);
      if (segment === "." || segment === "..") {
        if (segment === ".." && !this.isRoot(node)) node = this.parents[node];
        if (index === parts.length - 1) node = this.child(node, "");
      } else {
        node = this.child(node, segment);
      }
    });
    return node;
  }

  private uri(scheme: number, authority: number, path: number, query: number): UriKey {
    return { scheme, authority, path, query, key: `${scheme},${authority},${path},${query}` };
  }

  private authority(authority: string | undefined): number {
    if (authority === undefined) return -1;
    const { start, end } = hostSpan(authority);
    // The host is compared case-insensitively, escapes decoded first so that %41 is "a"; the second pass restores upper-case hex.
    const host = normalizeEscapes(normalizeEscapes(authority.slice(start, end)).toLowerCase());
    return this.intern(normalizeEscapes(authority.slice(0, start)) + host + authority.slice(end));
  }

  /** `reference` (from {@link parseUriReference}) resolved against `base`, without its fragment. */
  resolve(base: UriKey, reference: UriReference): UriKey {
    const query = this.intern(reference.query === undefined ? undefined : normalizeEscapes(reference.query));
    if (reference.scheme !== undefined) {
      return this.uri(this.intern(reference.scheme.toLowerCase()), this.authority(reference.authority), this.walk(0, reference.path), query);
    }
    if (reference.authority !== undefined) return this.uri(base.scheme, this.authority(reference.authority), this.walk(0, reference.path), query);
    if (reference.path === "") return this.uri(base.scheme, base.authority, base.path, reference.query === undefined ? base.query : query);
    if (reference.path.startsWith("/")) return this.uri(base.scheme, base.authority, this.walk(0, reference.path), query);
    // Merge (section 5.2.3): an authority with an empty path merges as "/"; otherwise the base's last segment goes.
    const directory = base.authority !== -1 && this.parents[base.path] === 0 && this.segments[base.path] === "" ? base.path : this.parents[base.path];
    return this.uri(base.scheme, base.authority, this.walk(directory, reference.path), query);
  }
}
