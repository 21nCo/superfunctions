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

function segmentExpression(segment: string): string {
  let expression = "";
  for (const character of segment) {
    if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[.+^$()|]/gu, "\\$&");
  }
  return expression;
}

/** Compile a policy glob; a pattern outside the grammar is `REVIEWFN_GLOB_UNSUPPORTED`. */
export function compileGlob(pattern: string): CompiledGlob {
  const issue = globGrammarIssue(pattern);
  if (issue) throw new ReviewFnError("REVIEWFN_GLOB_UNSUPPORTED", issue, { pattern });
  const segments = pattern.split("/");
  let expression = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") expression += last ? "[^]+" : "(?:[^/]+/)*";
    else expression += segmentExpression(segment) + (last ? "" : "/");
  });
  const compiled = new RegExp(`^${expression}$`, "u");
  return Object.freeze({ pattern, matches: (path: string) => compiled.test(path) });
}

/** Compile every glob of a list, reporting the first unsupported one as `REVIEWFN_GLOB_UNSUPPORTED`. */
export function compileGlobs(patterns: readonly string[]): CompiledGlob[] {
  return patterns.map(compileGlob);
}

/** Whether any of `globs` matches `path`. */
export function matchesAnyGlob(globs: readonly CompiledGlob[], path: string): boolean {
  return globs.some(glob => glob.matches(path));
}

/**
 * The Git pathspec equivalent of a supported glob, anchored at the repository top. Git's `glob` magic treats `*`, `?`
 * and whole-segment `**` the same way, and the grammar excludes the characters Git would read differently.
 */
export function globPathspec(glob: CompiledGlob, exclude = false): string {
  return `:(top,${exclude ? "exclude," : ""}glob)${glob.pattern}`;
}
