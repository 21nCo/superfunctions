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

// Every name is captured with its language's whole identifier class and must end where an identifier character cannot
// follow, so a reported name is never the prefix of a longer one.
const JS_ID_PART = "[\\p{ID_Continue}$\\u200C\\u200D]";
const JS_ID = `[\\p{ID_Start}$_]${JS_ID_PART}*(?!${JS_ID_PART})`;
const PYTHON_ID = "[\\p{XID_Start}_]\\p{XID_Continue}*(?!\\p{XID_Continue})";
const SWIFT_ID_PART = "[\\p{ID_Continue}\\u200C\\u200D]";
const SWIFT_ID = `[\\p{ID_Start}_]${SWIFT_ID_PART}*(?!${SWIFT_ID_PART})`;
const GO_ID = "[\\p{L}_][\\p{L}\\p{Nd}_]*(?![\\p{L}\\p{Nd}_])";
/** A Rust identifier, including a raw identifier such as `r#type`, which is how its references are written. */
const RUST_ID = "(?:r#)?[\\p{XID_Start}_]\\p{XID_Continue}*(?!\\p{XID_Continue})";
/** One level of nested parentheses, enough for callback parameter types. Its alternatives never share a character. */
const PARAMETERS = "\\((?:[^()]|\\([^()]*\\))*\\)";
const JS_MEMBER_MODIFIERS = "(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set|declare|accessor)\\s+)*";
/** Statements and keywords that a call-and-block or assignment line can start with; never a method name. */
const JS_RESERVED = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "with", "do", "else", "try", "finally", "typeof", "new", "await",
  "yield", "constructor", "super", "import", "export", "const", "let", "var", "throw", "delete", "void", "in", "of", "case", "default",
]);

/**
 * Reserved words of each language, which a declaration form never declares: a line that would capture one (such as
 * `export default class extends Base`, an anonymous class) declares nothing by that form. Rust raw identifiers such as
 * `r#type` keep their prefix, so they are never in this set.
 */
const KEYWORDS: Readonly<Record<SymbolLanguage, ReadonlySet<string>>> = Object.freeze({
  typescript: new Set([
    "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export", "extends",
    "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw",
    "true", "try", "typeof", "var", "void", "while", "with", "yield", "let", "static", "implements", "package", "protected", "interface",
    "private", "public", "await",
  ]),
  python: new Set([
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except",
    "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
    "while", "with", "yield",
  ]),
  swift: new Set([
    "associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import", "init", "inout", "internal", "let", "open",
    "operator", "private", "precedencegroup", "protocol", "public", "rethrows", "static", "struct", "subscript", "typealias", "var",
    "break", "case", "catch", "continue", "default", "defer", "do", "else", "fallthrough", "for", "guard", "if", "in", "repeat", "return",
    "throw", "switch", "where", "while", "Any", "as", "await", "false", "is", "nil", "self", "Self", "super", "throws", "true", "try",
    "final", "override", "mutating", "nonmutating", "convenience", "required", "indirect", "dynamic", "lazy", "nonisolated",
    "distributed", "optional", "package", "actor",
  ]),
  go: new Set([
    "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if", "import",
    "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
  ]),
  rust: new Set([
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in",
    "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true",
    "type", "unsafe", "use", "where", "while", "abstract", "become", "box", "do", "final", "macro", "override", "priv", "typeof", "unsized",
    "virtual", "yield", "try",
  ]),
});
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
  /** Reads the declared name from the whole line (and the head line after it), for forms a pattern cannot resolve. */
  name?: (text: string, next: string | undefined) => string | undefined;
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
    // A PEP 695 type parameter list (`def first[T](items)`, `class Box[T]:`) may follow the name.
    { kind: "function", pattern: new RegExp(`^\\s*(?:async\\s+)?def\\s+(${PYTHON_ID})\\s*[[(]`, "u") },
    { kind: "class", pattern: new RegExp(`^\\s*class\\s+(${PYTHON_ID})\\s*[[(:]`, "u") },
  ],
  swift: [
    { kind: "function", pattern: new RegExp(`^\\s*${SWIFT_MODIFIERS}func\\s+(${SWIFT_ID})`, "u") },
    // `class func`, `class var` and the like are class members, not classes: their keyword is never a name.
    { kind: "class", pattern: new RegExp(`^\\s*${SWIFT_MODIFIERS}class\\s+(${SWIFT_ID})`, "u") },
    { kind: "struct", pattern: new RegExp(`^\\s*${SWIFT_MODIFIERS}struct\\s+(${SWIFT_ID})`, "u") },
    { kind: "enum", pattern: new RegExp(`^\\s*${SWIFT_MODIFIERS}enum\\s+(${SWIFT_ID})`, "u") },
    { kind: "protocol", pattern: new RegExp(`^\\s*${SWIFT_MODIFIERS}protocol\\s+(${SWIFT_ID})`, "u") },
    { kind: "extension", pattern: new RegExp(`^\\s*${SWIFT_MODIFIERS}extension\\s+(${SWIFT_ID})`, "u") },
  ],
  go: [
    // Functions and methods: `func Name(` or `func (receiver) Name(`, with optional type parameters. Go declares
    // functions only at the top level, so the keyword starts the line.
    { kind: "function", pattern: new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?(${GO_ID})\\s*[[(]`, "u") },
    // The type that follows starts with a letter, `*`, `[`, `(` or the receive-only channel arrow `<-`.
    { kind: "type", pattern: new RegExp(`^\\s*type\\s+(${GO_ID})\\s*(?:\\[[^\\]]*\\]\\s*)?(?:=\\s*)?(?:[\\p{L}_*[(]|<-)`, "u") },
  ],
  rust: [
    { kind: "function", pattern: new RegExp(`^\\s*${RUST_VISIBILITY}(?:(?:const|async|unsafe|default)\\s+)*(?:extern\\s+(?:"[^"]*"\\s+)?)?fn\\s+(${RUST_ID})`, "u") },
    { kind: "struct", pattern: new RegExp(`^\\s*${RUST_VISIBILITY}struct\\s+(${RUST_ID})`, "u") },
    { kind: "enum", pattern: new RegExp(`^\\s*${RUST_VISIBILITY}enum\\s+(${RUST_ID})`, "u") },
    { kind: "trait", pattern: new RegExp(`^\\s*${RUST_VISIBILITY}(?:unsafe\\s+)?(?:auto\\s+)?trait\\s+(${RUST_ID})`, "u") },
    // The implemented type: `impl Type`, `impl<T> Trait for Type<T>`, `impl<'a> Trait for &'a mut path::Type`, and a
    // header rustfmt splits before `for Type`, `where` or `{`.
    { kind: "impl", pattern: /^\s*(?:unsafe\s+)?impl(?![\p{XID_Continue}#])/u, name: rustImplTarget },
  ],
});

/**
 * Every symbol one line declares in `language`, by the first form that matches: usually one, several for a `const` or
 * `let` with more than one declarator or a destructuring pattern, none for a line that declares nothing. A name is
 * never a reserved word of the language. `next` is the head line after `text`, which only a Rust `impl` header that
 * rustfmt split reads.
 */
export function lineSymbols(language: SymbolLanguage, text: string, next?: string): Array<{ name: string; kind: SymbolKind }> {
  const keywords = KEYWORDS[language];
  for (const rule of RULES[language]) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    if (rule.names) {
      const kind = match[1] as SymbolKind;
      const names = [...new Set(rule.names(text.slice(match[0].length)))].filter(name => !keywords.has(name));
      if (names.length) return names.map(name => ({ name, kind }));
      continue;
    }
    const name = rule.name ? rule.name(text, next) : match[1];
    if (name !== undefined && !keywords.has(name) && !rule.reserved?.has(name)) return [{ name, kind: rule.kind as SymbolKind }];
  }
  return [];
}

/** The first symbol one line declares in `language`, or `undefined`. */
export function lineSymbol(language: SymbolLanguage, text: string, next?: string): { name: string; kind: SymbolKind } | undefined {
  return lineSymbols(language, text, next)[0];
}

/** One head line to scan; `next` is the head line after it, when known, whatever its change status. */
export interface SymbolLine { line: number; text: string; next?: string }

/** Options of `symbolDeclarations` and `extractSymbols`. */
export interface ExtractSymbolOptions {
  /** Called for each line longer than `SYMBOL_LINE_CHARACTER_LIMIT`, which is skipped. */
  onLongLine?: (line: number) => void;
}

/**
 * Symbols declared on the given head lines of `path`, in line order, one at a time so a caller can stop at a bound. A
 * path outside the recognized languages declares none.
 */
export function* symbolDeclarations(path: string, lines: Iterable<SymbolLine>, options: ExtractSymbolOptions = {}): Generator<DeclaredSymbol> {
  const language = symbolLanguage(path);
  if (!language) return;
  for (const { line, text, next } of lines) {
    if (text.length > SYMBOL_LINE_CHARACTER_LIMIT) { options.onLongLine?.(line); continue; }
    // A next line over the limit is not read either; a split header then declares nothing.
    for (const symbol of lineSymbols(language, text, next !== undefined && next.length <= SYMBOL_LINE_CHARACTER_LIMIT ? next : undefined)) yield { ...symbol, language, path, line };
  }
}

/** Symbols declared on the given head lines of `path`, in line order. */
export function extractSymbols(path: string, lines: Iterable<SymbolLine>, options: ExtractSymbolOptions = {}): DeclaredSymbol[] {
  const symbols: DeclaredSymbol[] = [];
  for (const symbol of symbolDeclarations(path, lines, options)) symbols.push(symbol);
  return symbols;
}


// A small single-pass scanner for the declarator forms a pattern cannot express. Every loop advances, so the scan is
// linear in the line length; the look-ahead for call type arguments reads at most MAX_TYPE_ARGUMENT_CHARACTERS from
// each `<`, and nesting deeper than MAX_PATTERN_DEPTH stops the scan.

const MAX_PATTERN_DEPTH = 16;
/** Characters a call's type arguments may span on one line; a longer `<...>` is read as a comparison. */
const MAX_TYPE_ARGUMENT_CHARACTERS = 128;
const JS_IDENTIFIER = new RegExp(JS_ID, "uy");
/** An object pattern's property key: an identifier or a numeric key. */
const JS_PROPERTY_KEY = new RegExp(`${JS_ID_PART}+`, "uy");
const JS_IDENTIFIER_UNIT = new RegExp(`^${JS_ID_PART}$`, "u");
const RUST_IDENTIFIER = new RegExp(RUST_ID, "uy");
/** What may stand before the implemented type's path: references, lifetimes, `mut`, `dyn`, raw pointers and a leading `::`. */
const RUST_TARGET_PREFIX = /(?:&|\*|'[\p{XID_Start}_]\p{XID_Continue}*(?!\p{XID_Continue})|(?:mut|dyn|const)(?![\p{XID_Continue}#])|::)\s*/uy;
/** In Rust a single quote starts a lifetime such as `'a`, not a string. */
const RUST_QUOTES = "\"";
const CLOSERS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };
/** What can follow call type arguments, as in `make<string, number>()`; anything else makes `<` a comparison. */
const TYPE_ARGUMENT_FOLLOWERS = "(`,;)]}";

function skipSpace(text: string, index: number): number {
  while (index < text.length && /\s/u.test(text[index])) index += 1;
  return index;
}

function readWith(pattern: RegExp, text: string, index: number): { name: string; end: number } | undefined {
  pattern.lastIndex = index;
  const match = pattern.exec(text);
  return match ? { name: match[0], end: index + match[0].length } : undefined;
}

/** Whether the UTF-16 unit at `index` belongs to an identifier; any surrogate counts, as astral identifiers are rare. */
function identifierUnit(text: string, index: number): boolean {
  const unit = text.charCodeAt(index);
  return (unit >= 0xd800 && unit <= 0xdfff) || JS_IDENTIFIER_UNIT.test(text[index] ?? "");
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

/** The index just past the regular expression literal that starts at `index`, flags included, or the line's end. */
function skipRegularExpression(text: string, index: number): number {
  let inClass = false;
  for (let at = index + 1; at < text.length; at += 1) {
    const character = text[at];
    if (character === "\\") at += 1;
    else if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    else if (character === "/" && !inClass) {
      at += 1;
      while (at < text.length && identifierUnit(text, at)) at += 1;
      return at;
    }
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

/**
 * The index after the call type arguments that start with the `<` at `index` (`make<string, number>(`), or `undefined`
 * when the `<` is a comparison: the brackets do not close within a bounded span, hold an operator no type holds, or
 * are not followed by a call, a template or the end of an expression.
 */
function typeArguments(text: string, index: number): number | undefined {
  const open = [">"];
  const end = Math.min(text.length, index + MAX_TYPE_ARGUMENT_CHARACTERS);
  for (let at = index + 1; at < end; at += 1) {
    const character = text[at];
    switch (character) {
      case "\"": case "'": case "`": at = skipString(text, at) - 1; break;
      case "=": if (text[at + 1] !== ">") return undefined; at += 1; break;
      case ";": case "+": case "*": case "%": case "!": case "^": case "~": case "/": return undefined;
      case "&": case "|": if (text[at + 1] === character) return undefined; break;
      case "<": open.push(">"); break;
      case "(": open.push(")"); break;
      case "[": open.push("]"); break;
      case "{": open.push("}"); break;
      case ">": case ")": case "]": case "}": {
        if (open.pop() !== character) return undefined;
        if (!open.length) {
          const after = skipSpace(text, at + 1);
          return after === text.length || TYPE_ARGUMENT_FOLLOWERS.includes(text[after]) ? at + 1 : undefined;
        }
        break;
      }
      default: break;
    }
  }
  return undefined;
}

/**
 * Like `skipExpression` for a JavaScript initializer: also steps over regular expression literals (a `/` where no
 * value ends), block comments and call type arguments (`<` right after a name, as in `make<A, B>()`), so their commas
 * never end the declarator. `a < b, c = 1` still ends at its comma.
 */
function skipInitializer(text: string, index: number, stops: string): number {
  const open: string[] = [];
  /** Whether the last token ends a value, so a `/` that follows divides instead of starting a regular expression. */
  let value = false;
  let at = index;
  while (at < text.length) {
    const character = text[at];
    if (character === "\"" || character === "'" || character === "`") { at = skipString(text, at); value = true; continue; }
    if (character === "/") {
      if (text[at + 1] === "/") return at;
      if (text[at + 1] === "*") { const close = text.indexOf("*/", at + 2); at = close === -1 ? text.length : close + 2; continue; }
      if (!value) { at = skipRegularExpression(text, at); value = true; continue; }
    }
    if (/\s/u.test(character)) { at += 1; continue; }
    if (character === "<" && at > index && identifierUnit(text, at - 1)) {
      const end = typeArguments(text, at);
      if (end !== undefined) { at = end; value = true; continue; }
    }
    if (!open.length && stops.includes(character)) return at;
    if (Object.hasOwn(CLOSERS, character)) { open.push(CLOSERS[character]); value = false; }
    else if (character === ")" || character === "]" || character === "}") {
      if (open.at(-1) !== character) return at;
      open.pop();
      value = true;
    } else value = identifierUnit(text, at);
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
        const identifier = readWith(JS_PROPERTY_KEY, text, at);
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
    if (text[at] === "=") at = skipInitializer(text, at + 1, `,${close}`);
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
    if (rest[at] === "=") at = skipInitializer(rest, at + 1, ",;");
    if (rest[at] !== ",") return names;
    at += 1;
  }
}

/** The index just past a top-level `for` keyword of a Rust impl header, or `undefined` when it has none. */
function topLevelFor(header: string): number | undefined {
  for (let index = skipSpace(header, 0); index < header.length;) {
    if (header.startsWith("for", index) && (index + 3 === header.length || /\s/u.test(header[index + 3]))) return index + 3;
    // Step over one top-level token; an unmatched closing bracket stops the scan where it started, so always advance.
    index = skipSpace(header, Math.max(skipExpression(header, index, " \t", true, RUST_QUOTES), index + 1));
  }
  return undefined;
}

/** The last segment of the type path `text` starts with, after references, lifetimes, `mut` and `dyn`. */
function rustTypeName(text: string): string | undefined {
  let at = skipSpace(text, 0);
  for (let prefix = readWith(RUST_TARGET_PREFIX, text, at); prefix; prefix = readWith(RUST_TARGET_PREFIX, text, at)) at = prefix.end;
  let name: string | undefined;
  for (;;) {
    const identifier = readWith(RUST_IDENTIFIER, text, at);
    if (!identifier) break;
    name = identifier.name;
    // Path separators may have spaces around them: `crate :: model :: Ledger`.
    const separator = skipSpace(text, identifier.end);
    if (!text.startsWith("::", separator)) break;
    at = skipSpace(text, separator + 2);
  }
  return name;
}

/**
 * The type a Rust `impl` line implements: after the impl's own generic parameters, the type after a top-level `for`
 * when there is one (otherwise the header's type), without references, lifetimes, `mut`, `dyn` and path segments.
 * When neither the body nor a `where` clause starts on the line, rustfmt may have split the header: a `for Type` on the
 * next head line names the type (a trait impl), a next line starting with `where` or `{` makes this line's type the
 * implemented one (an inherent impl), and anything else declares nothing rather than mistake a trait for the type.
 */
function rustImplTarget(text: string, next: string | undefined): string | undefined {
  let at = skipSpace(text, (/^\s*(?:unsafe\s+)?impl/u.exec(text) as RegExpExecArray)[0].length);
  if (text[at] === "<") {
    at = skipExpression(text, at + 1, ">", true, RUST_QUOTES);
    if (text[at] !== ">") return undefined;
    at += 1;
  }
  // The header ends at its body or a comment; a `where` clause ends it too.
  const end = skipExpression(text, at, "{", true, RUST_QUOTES);
  let header = text.slice(at, end);
  const where = /(?:^|\s)where(?![\p{XID_Continue}#])/u.exec(header);
  if (where) header = header.slice(0, where.index);
  const continues = !where && text[end] !== "{";
  const following = next?.trimStart() ?? "";
  const forAt = topLevelFor(header);
  if (forAt !== undefined) {
    const type = header.slice(forAt);
    // `impl Trait for` with the type on the next line.
    return rustTypeName(!type.trim() && continues ? following : type);
  }
  if (!continues) return rustTypeName(header);
  if (/^for\s/u.test(following)) return rustTypeName(following.slice(3));
  if (/^(?:where(?![\p{XID_Continue}#])|\{)/u.test(following)) return rustTypeName(header);
  return undefined;
}
