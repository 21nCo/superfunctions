/**
 * Line-level symbol extraction for the closed set of languages and declaration forms the code-references context
 * recognizes. Recognition is textual, one line at a time, never type-aware: a declaration split across lines or written
 * in another form is not recognized. Files in other languages contribute their paths only.
 */

export type SymbolLanguage = "typescript" | "python" | "swift" | "go" | "rust";

export type SymbolKind =
  | "function" | "class" | "interface" | "type" | "enum" | "const" | "let" | "method"
  | "struct" | "protocol" | "extension" | "trait" | "impl";

/** A symbol declared on one head line of a changed file. */
export interface DeclaredSymbol {
  name: string;
  kind: SymbolKind;
  language: SymbolLanguage;
  path: string;
  /** One-based head line. */
  line: number;
}

const EXTENSIONS: Readonly<Record<string, SymbolLanguage>> = Object.freeze({
  ts: "typescript", tsx: "typescript", js: "typescript", jsx: "typescript", mjs: "typescript", cjs: "typescript",
  py: "python", swift: "swift", go: "go", rs: "rust",
});

/** The recognized language of a path by its extension, or `undefined` for a path-only file. */
export function symbolLanguage(path: string): SymbolLanguage | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const extension = name.slice(dot + 1);
  return Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : undefined;
}

const JS_ID = "[A-Za-z_$][\\w$]*";
const ID = "[A-Za-z_]\\w*";
/** A Rust identifier, including a raw identifier such as `r#type`, which is how its references are written. */
const RUST_ID = "(?:r#)?[A-Za-z_]\\w*";
/** One level of nested parentheses, enough for callback parameter types. Its alternatives never share a character. */
const PARAMETERS = "\\((?:[^()]|\\([^()]*\\))*\\)";
const JS_MEMBER_MODIFIERS = "(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set|declare|accessor)\\s+)*";
/** Statements and keywords that a call-and-block or assignment line can start with; never a method name. */
const JS_RESERVED = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "with", "do", "else", "try", "finally", "typeof", "new", "await",
  "yield", "constructor", "super", "import", "export", "const", "let", "var", "throw", "delete", "void", "in", "of", "case", "default",
]);
const SWIFT_MODIFIERS = "(?:@[A-Za-z_]\\w*(?:\\([^)]*\\))?\\s+)*(?:(?:public|private|fileprivate|internal|open|package|static|class|final|override|mutating|nonmutating|convenience|required|indirect|dynamic|lazy|nonisolated|distributed|optional)(?:\\([^)]*\\))?\\s+)*";
const RUST_VISIBILITY = "(?:pub(?:\\([^)]*\\))?\\s+)?";

/**
 * Lines longer than this many characters are not matched: no declaration form needs more, and it keeps matching cheap
 * whatever a changed line holds. `extractSymbols` reports each skipped line.
 */
export const SYMBOL_LINE_CHARACTER_LIMIT = 1000;

interface SymbolRule {
  kind: SymbolKind | "binding";
  /** Capture group 1 is the symbol name; for a `binding` rule, group 1 is the `const` or `let` keyword. */
  pattern: RegExp;
  /** Names the form never declares, such as keywords a method-shaped line starts with. */
  reserved?: ReadonlySet<string>;
  /** Reads the declared names from the rest of the line after the pattern, for forms that declare several. */
  names?: (rest: string) => string[];
  /** Reads the declared name from the whole line, for forms a pattern alone cannot resolve. */
  name?: (text: string) => string | undefined;
}

// Every pattern is anchored and keeps adjacent repetitions from sharing characters (a whitespace run is always followed
// by a character it cannot match), so matching is linear in the line length; `test/code-references.test.ts` times it.
const RULES: Readonly<Record<SymbolLanguage, readonly SymbolRule[]>> = Object.freeze({
  typescript: [
    { kind: "function", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function(?:\\s*\\*\\s*|\\s+)(${JS_ID})\\s*[<(]`, "u") },
    { kind: "class", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${JS_ID})`, "u") },
    { kind: "interface", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?interface\\s+(${JS_ID})`, "u") },
    { kind: "type", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+(${JS_ID})\\s*[<=]`, "u") },
    { kind: "enum", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${JS_ID})`, "u") },
    // Every name an exported `const` or `let` declares: `a = 1, b = 2`, `{ a, b: c, ...d }` and `[x, , y = 1]`.
    { kind: "binding", pattern: /^\s*export\s+(?:declare\s+)?(const|let)\s+/u, names: jsDeclaredNames },
    // Class and object method shorthand: `name(params) {`, optionally with modifiers, type parameters and a return type.
    { kind: "method", reserved: JS_RESERVED, pattern: new RegExp(`^\\s*${JS_MEMBER_MODIFIERS}(?:\\*\\s*)?#?(${JS_ID})\\s*(?:<[^()]*>\\s*)?${PARAMETERS}\\s*(?::[^;{}]*)?\\{`, "u") },
    // A method assigned as a property or class field: `name: function`, `name: (params) =>` or `name = async x =>`.
    { kind: "method", reserved: JS_RESERVED, pattern: new RegExp(`^\\s*${JS_MEMBER_MODIFIERS}#?(${JS_ID})\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|(?:${PARAMETERS}|${JS_ID})\\s*(?::[^=;{}]*)?=>)`, "u") },
  ],
  python: [
    { kind: "function", pattern: new RegExp(`^\\s*(?:async\\s+)?def\\s+(${ID})\\s*\\(`, "u") },
    { kind: "class", pattern: new RegExp(`^\\s*class\\s+(${ID})\\s*[(:]`, "u") },
  ],
  swift: [
    { kind: "function", pattern: new RegExp(`^\\s*${SWIFT_MODIFIERS}func\\s+(${ID})`, "u") },
    { kind: "class", pattern: new RegExp(`^\\s*${SWIFT_MODIFIERS}class\\s+(?!(?:func|var|let|subscript|init|deinit)\\b)(${ID})`, "u") },
    { kind: "struct", pattern: new RegExp(`^\\s*${SWIFT_MODIFIERS}struct\\s+(${ID})`, "u") },
    { kind: "enum", pattern: new RegExp(`^\\s*${SWIFT_MODIFIERS}enum\\s+(${ID})`, "u") },
    { kind: "protocol", pattern: new RegExp(`^\\s*${SWIFT_MODIFIERS}protocol\\s+(${ID})`, "u") },
    { kind: "extension", pattern: new RegExp(`^\\s*${SWIFT_MODIFIERS}extension\\s+(${ID})`, "u") },
  ],
  go: [
    // Functions and methods: `func Name(` or `func (receiver) Name(`, with optional type parameters. Go declares
    // functions only at the top level, so the keyword starts the line.
    { kind: "function", pattern: new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?(${ID})\\s*[[(]`, "u") },
    { kind: "type", pattern: new RegExp(`^\\s*type\\s+(${ID})\\s*(?:\\[[^\\]]*\\]\\s*)?(?:=\\s*)?[A-Za-z_*[(]`, "u") },
  ],
  rust: [
    { kind: "function", pattern: new RegExp(`^\\s*${RUST_VISIBILITY}(?:(?:const|async|unsafe|default)\\s+)*(?:extern\\s+(?:"[^"]*"\\s+)?)?fn\\s+(${RUST_ID})`, "u") },
    { kind: "struct", pattern: new RegExp(`^\\s*${RUST_VISIBILITY}struct\\s+(${RUST_ID})`, "u") },
    { kind: "enum", pattern: new RegExp(`^\\s*${RUST_VISIBILITY}enum\\s+(${RUST_ID})`, "u") },
    { kind: "trait", pattern: new RegExp(`^\\s*${RUST_VISIBILITY}(?:unsafe\\s+)?(?:auto\\s+)?trait\\s+(${RUST_ID})`, "u") },
    // The implemented type: `impl Type`, `impl<T> Trait for Type<T>`, `impl<'a> Trait for &'a mut path::Type`.
    { kind: "impl", pattern: /^\s*(?:unsafe\s+)?impl(?![\w#])/u, name: rustImplTarget },
  ],
});

/**
 * Every symbol one line declares in `language`, by the first form that matches: usually one, several for a `const` or
 * `let` with more than one declarator or a destructuring pattern, none for a line that declares nothing.
 */
export function lineSymbols(language: SymbolLanguage, text: string): Array<{ name: string; kind: SymbolKind }> {
  for (const rule of RULES[language]) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    if (rule.names) {
      const kind = match[1] as SymbolKind;
      const names = [...new Set(rule.names(text.slice(match[0].length)))];
      if (names.length) return names.map(name => ({ name, kind }));
      continue;
    }
    const name = rule.name ? rule.name(text) : match[1];
    if (name !== undefined && !rule.reserved?.has(name)) return [{ name, kind: rule.kind as SymbolKind }];
  }
  return [];
}

/** The first symbol one line declares in `language`, or `undefined`. */
export function lineSymbol(language: SymbolLanguage, text: string): { name: string; kind: SymbolKind } | undefined {
  return lineSymbols(language, text)[0];
}

/** Options of `symbolDeclarations` and `extractSymbols`. */
export interface ExtractSymbolOptions {
  /** Called for each line longer than `SYMBOL_LINE_CHARACTER_LIMIT`, which is skipped. */
  onLongLine?: (line: number) => void;
}

/**
 * Symbols declared on the given head lines of `path`, in line order, one at a time so a caller can stop at a bound. A
 * path outside the recognized languages declares none.
 */
export function* symbolDeclarations(path: string, lines: Iterable<{ line: number; text: string }>, options: ExtractSymbolOptions = {}): Generator<DeclaredSymbol> {
  const language = symbolLanguage(path);
  if (!language) return;
  for (const { line, text } of lines) {
    if (text.length > SYMBOL_LINE_CHARACTER_LIMIT) { options.onLongLine?.(line); continue; }
    for (const symbol of lineSymbols(language, text)) yield { ...symbol, language, path, line };
  }
}

/** Symbols declared on the given head lines of `path`, in line order. */
export function extractSymbols(path: string, lines: Iterable<{ line: number; text: string }>, options: ExtractSymbolOptions = {}): DeclaredSymbol[] {
  const symbols: DeclaredSymbol[] = [];
  for (const symbol of symbolDeclarations(path, lines, options)) symbols.push(symbol);
  return symbols;
}

// A small single-pass scanner for the declarator forms a pattern cannot express. Every loop advances, so the scan is
// linear in the line length; nesting deeper than MAX_PATTERN_DEPTH stops it.

const MAX_PATTERN_DEPTH = 16;
const JS_IDENTIFIER = /[A-Za-z_$][\w$]*/uy;
const RUST_IDENTIFIER = new RegExp(RUST_ID, "uy");
/** In Rust a single quote starts a lifetime such as `'a`, not a string. */
const RUST_QUOTES = "\"";
const CLOSERS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };

function skipSpace(text: string, index: number): number {
  while (index < text.length && /\s/u.test(text[index])) index += 1;
  return index;
}

function readWith(pattern: RegExp, text: string, index: number): { name: string; end: number } | undefined {
  pattern.lastIndex = index;
  const match = pattern.exec(text);
  return match ? { name: match[0], end: index + match[0].length } : undefined;
}

/** The index just past the string literal that starts at `index`, or the line's end when it does not close. */
function skipString(text: string, index: number): number {
  const quote = text[index];
  for (let at = index + 1; at < text.length; at += 1) {
    if (text[at] === "\\") at += 1;
    else if (text[at] === quote) return at + 1;
  }
  return text.length;
}

/**
 * The index of the first `stops` character outside brackets and strings, of an unmatched closing bracket, or of a line
 * comment; the line's length when none occurs. `angles` also nests `<` and `>` (a type annotation or Rust generics),
 * and then the arrows `=>` and `->` are neither stops nor brackets. `quotes` are the characters that open a string.
 */
function skipExpression(text: string, index: number, stops: string, angles = false, quotes = "\"'`"): number {
  const open: string[] = [];
  let at = index;
  while (at < text.length) {
    const character = text[at];
    if (quotes.includes(character)) { at = skipString(text, at); continue; }
    if (character === "/" && text[at + 1] === "/") return at;
    if (angles && (character === "=" || character === "-") && text[at + 1] === ">") { at += 2; continue; }
    if (!open.length && stops.includes(character)) return at;
    if (Object.hasOwn(CLOSERS, character)) open.push(CLOSERS[character]);
    else if (angles && character === "<") open.push(">");
    else if (character === ")" || character === "]" || character === "}" || (angles && character === ">")) {
      if (open.at(-1) === character) open.pop();
      else if (character !== ">") return at;
    }
    at += 1;
  }
  return at;
}

/** Whether a declarator's name ends where a type annotation, initializer, next declarator or the line's end follows. */
function endsDeclarator(text: string, index: number): boolean {
  const at = skipSpace(text, index);
  return at === text.length || "!:=,;".includes(text[at]) || text.startsWith("//", at);
}

/** Reads the binding target at `index`, a name or a nested pattern, into `names`; the index after it, or `undefined`. */
function bindingTarget(text: string, index: number, names: string[], depth: number): number | undefined {
  const at = skipSpace(text, index);
  if (text[at] === "{" || text[at] === "[") return patternNames(text, at, names, depth + 1);
  const identifier = readWith(JS_IDENTIFIER, text, at);
  if (!identifier) return undefined;
  names.push(identifier.name);
  return identifier.end;
}

/**
 * Reads the names an object (`{`) or array (`[`) destructuring pattern at `start` binds into `names`. Returns the index
 * after the pattern, or `undefined` where the line ends or the pattern is not one the scanner reads; the names read
 * before that point stay.
 */
function patternNames(text: string, start: number, names: string[], depth: number): number | undefined {
  if (depth > MAX_PATTERN_DEPTH) return undefined;
  const object = text[start] === "{";
  const close = object ? "}" : "]";
  let at: number | undefined = start + 1;
  for (;;) {
    at = skipSpace(text, at);
    if (text[at] === close) return at + 1;
    if (!object && text[at] === ",") { at += 1; continue; }
    if (text.startsWith("...", at)) at = bindingTarget(text, at + 3, names, depth);
    else if (!object) at = bindingTarget(text, at, names, depth);
    else {
      let key: string | undefined;
      if (text[at] === "[") {
        at = skipExpression(text, at + 1, "]");
        if (text[at] !== "]") return undefined;
        at += 1;
      } else if (text[at] === "\"" || text[at] === "'") at = skipString(text, at);
      else {
        const identifier = readWith(/[\w$]+/uy, text, at);
        if (!identifier) return undefined;
        key = identifier.name;
        at = identifier.end;
      }
      at = skipSpace(text, at);
      if (text[at] === ":") at = bindingTarget(text, at + 1, names, depth);
      else if (key !== undefined && readWith(JS_IDENTIFIER, key, 0)?.end === key.length) names.push(key);
      else return undefined;
    }
    if (at === undefined) return undefined;
    at = skipSpace(text, at);
    if (text[at] === "=") at = skipExpression(text, at + 1, `,${close}`);
    if (text[at] === ",") { at += 1; continue; }
    if (text[at] === close) return at + 1;
    return undefined;
  }
}

/** Every name the declarators after `export const` or `export let` bind on this line. */
function jsDeclaredNames(rest: string): string[] {
  const names: string[] = [];
  let at = 0;
  for (;;) {
    at = skipSpace(rest, at);
    if (rest[at] === "{" || rest[at] === "[") {
      const end = patternNames(rest, at, names, 0);
      if (end === undefined || !endsDeclarator(rest, end)) return names;
      at = end;
    } else {
      const identifier = readWith(JS_IDENTIFIER, rest, at);
      if (!identifier || !endsDeclarator(rest, identifier.end)) return names;
      names.push(identifier.name);
      at = identifier.end;
    }
    at = skipSpace(rest, at);
    if (rest[at] === "!") at += 1;
    if (rest[at] === ":") at = skipExpression(rest, at + 1, ",;=", true);
    if (rest[at] === "=") at = skipExpression(rest, at + 1, ",;");
    if (rest[at] !== ",") return names;
    at += 1;
  }
}

/**
 * The type a Rust `impl` line implements: after the impl's own generic parameters, the type after a top-level `for`
 * when there is one (otherwise the whole header), without references, lifetimes, `mut`, `dyn` and path segments.
 */
function rustImplTarget(text: string): string | undefined {
  let at = skipSpace(text, (/^\s*(?:unsafe\s+)?impl/u.exec(text) as RegExpExecArray)[0].length);
  if (text[at] === "<") {
    at = skipExpression(text, at + 1, ">", true, RUST_QUOTES);
    if (text[at] !== ">") return undefined;
    at += 1;
  }
  // The header ends at its body, a `where` clause or a comment; `for` at the top level separates trait and type.
  const end = skipExpression(text, at, "{", true, RUST_QUOTES);
  let header = text.slice(at, end);
  const where = /(?:^|\s)where(?![\w#])/u.exec(header);
  if (where) header = header.slice(0, where.index);
  for (let index = 0; index < header.length;) {
    const next = skipExpression(header, index, " \t", true, RUST_QUOTES);
    if (next >= header.length) break;
    // An unmatched closing bracket stops the scan where it started; step over it so the loop always advances.
    index = skipSpace(header, Math.max(next, index + 1));
    if (header.startsWith("for", index) && /\s/u.test(header[index + 3] ?? "")) { header = header.slice(index + 3); break; }
  }
  let target = skipSpace(header, 0);
  for (;;) {
    const prefix = /^(?:&|'[A-Za-z_]\w*|mut(?![\w#])|dyn(?![\w#])|::)\s*/u.exec(header.slice(target));
    if (!prefix) break;
    target += prefix[0].length;
  }
  let name: string | undefined;
  for (;;) {
    const identifier = readWith(RUST_IDENTIFIER, header, target);
    if (!identifier) break;
    name = identifier.name;
    if (!header.startsWith("::", identifier.end)) break;
    target = identifier.end + 2;
  }
  return name;
}
