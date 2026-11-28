import { ReviewFnError } from "../errors.js";

/**
 * A compiled policy glob over repository-relative `/`-separated paths. The grammar is a closed set: `*` matches any
 * characters within one path segment, `?` matches one character within a segment, and a segment that is exactly `**`
 * matches zero or more whole segments (at the end of a pattern, one or more, so `dir/**` is everything inside `dir`).
 * Every other character is literal.
 */
export interface CompiledGlob {
  readonly pattern: string;
  matches(path: string): boolean;
}

/** Characters outside the grammar: braces, character classes, negation and escapes. */
const UNSUPPORTED_CHARACTERS = /[{}[\]!\\]/u;

/** Why `pattern` is outside the policy glob grammar, or `undefined` when it is supported. */
export function globGrammarIssue(pattern: unknown): string | undefined {
  if (typeof pattern !== "string" || pattern === "") return "A glob must be a nonempty string.";
  const unsupported = UNSUPPORTED_CHARACTERS.exec(pattern);
  if (unsupported) return `Glob ${JSON.stringify(pattern)} uses ${JSON.stringify(unsupported[0])}; only **, * and ? are supported (no braces, character classes, negation or escapes).`;
  if (pattern.startsWith("/")) return `Glob ${JSON.stringify(pattern)} must be repository-relative.`;
  for (const segment of pattern.split("/")) {
    if (segment === "") return `Glob ${JSON.stringify(pattern)} has an empty path segment.`;
    if (segment === "." || segment === "..") return `Glob ${JSON.stringify(pattern)} has a ${segment} segment.`;
    if (segment !== "**" && segment.includes("**")) return `Glob ${JSON.stringify(pattern)} uses ** inside a segment; ** must be a whole path segment.`;
  }
  return undefined;
}

/**
 * One pattern segment: a run of zero or more whole path segments (`**` inside a pattern), any one nonempty segment
 * (with the run after it, a trailing `**`), or the code points of a segment pattern, where `*` and `?` are wildcards.
 */
type GlobSegment = { kind: "run" } | { kind: "nonempty" } | { kind: "segment"; units: readonly string[] };
const RUN: GlobSegment = Object.freeze({ kind: "run" });
const NONEMPTY: GlobSegment = Object.freeze({ kind: "nonempty" });

/**
 * Whether `pattern` matches `items`, where a `wildcard` item matches any run of items and every other item matches one
 * item when `matchesOne` says so. The greedy scan restarts after the last wildcard on a mismatch and never backtracks
 * further, so it makes at most `items × pattern` calls of `matchesOne` whatever the pattern holds.
 */
function wildcardMatch<P, T>(pattern: readonly P[], items: readonly T[], wildcard: (item: P) => boolean, matchesOne: (item: P, value: T) => boolean): boolean {
  let at = 0;
  let item = 0;
  let star = -1;
  let restart = 0;
  while (item < items.length) {
    if (at < pattern.length && wildcard(pattern[at])) {
      star = at;
      restart = item;
      at += 1;
    } else if (at < pattern.length && matchesOne(pattern[at], items[item])) {
      at += 1;
      item += 1;
    } else if (star !== -1) {
      at = star + 1;
      restart += 1;
      item = restart;
    } else return false;
  }
  while (at < pattern.length && wildcard(pattern[at])) at += 1;
  return at === pattern.length;
}

function segmentMatches(segment: GlobSegment, value: readonly string[]): boolean {
  if (segment.kind === "nonempty") return value.length > 0;
  if (segment.kind === "run") return false;
  return wildcardMatch(segment.units, value, unit => unit === "*", (unit, character) => unit === "?" || unit === character);
}

/** Compile a policy glob; a pattern outside the grammar is `REVIEWFN_GLOB_UNSUPPORTED`. */
export function compileGlob(pattern: string): CompiledGlob {
  const issue = globGrammarIssue(pattern);
  if (issue) throw new ReviewFnError("REVIEWFN_GLOB_UNSUPPORTED", issue, { pattern });
  const parts = pattern.split("/");
  const segments: GlobSegment[] = parts.flatMap((part, index): GlobSegment[] => {
    if (part !== "**") return [{ kind: "segment", units: Array.from(part) }];
    // A trailing `**` is one or more segments, so `dir/**` is everything inside `dir` but not `dir` itself.
    return index === parts.length - 1 ? [NONEMPTY, RUN] : [RUN];
  });
  // Matching needs no regular expression: a backtracking one costs a power of the path length per `*` in a segment.
  const matches = (path: string) => wildcardMatch(segments, path.split("/").map(part => Array.from(part)), segment => segment.kind === "run", segmentMatches);
  return Object.freeze({ pattern, matches });
}

/** Compile every glob of a list, reporting the first unsupported one as `REVIEWFN_GLOB_UNSUPPORTED`. */
export function compileGlobs(patterns: readonly string[]): CompiledGlob[] {
  return patterns.map(compileGlob);
}

/** Whether any of `globs` matches `path`. */
export function matchesAnyGlob(globs: readonly CompiledGlob[], path: string): boolean {
  return globs.some(glob => glob.matches(path));
}
