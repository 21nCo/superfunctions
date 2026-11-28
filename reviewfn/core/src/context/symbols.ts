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
/** Modifiers a class member or object method may start with, each followed by its name or another modifier. */
const JS_MEMBER_MODIFIERS: ReadonlySet<string> = new Set([
  "public", "private", "protected", "static", "readonly", "abstract", "override", "async", "get", "set", "declare", "accessor",
]);
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
  names?: (rest: string, dialect: Dialect) => string[];
  /** Reads the declared name from the whole line (and the head line after it), for forms a pattern cannot resolve. */
  name?: (text: string, next: () => string | undefined, dialect: Dialect, match: RegExpExecArray) => string | undefined;
}

// Every pattern is anchored and keeps adjacent repetitions from sharing characters (a whitespace run is always followed
// by a character it cannot match), so matching is linear in the line length; the forms a pattern cannot express are
// read by the line scanner below. `test/code-references.test.ts` times both.
const RULES: Readonly<Record<SymbolLanguage, readonly SymbolRule[]>> = Object.freeze({
  typescript: [
    { kind: "function", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function(?:\\s*\\*\\s*|\\s+)(${JS_ID})\\s*[<(]`, "u") },
    { kind: "class", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${JS_ID})`, "u") },
    { kind: "interface", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?interface\\s+(${JS_ID})`, "u") },
    { kind: "type", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+(${JS_ID})\\s*[<=]`, "u") },
    { kind: "enum", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${JS_ID})`, "u") },
    // Every name an exported `const` or `let` declares: `a = 1, b = 2`, `{ a, b: c, ...d }` and `[x, , y = 1]`.
    { kind: "binding", pattern: /^\s*export\s+(?:declare\s+)?(const|let)(?![\p{ID_Continue}$\u200C\u200D])/u, names: jsDeclaredNames },
    // Class and object method shorthand: `name(params) {`, optionally with modifiers, type parameters and a return type.
    { kind: "method", reserved: JS_RESERVED, pattern: /^/u, name: jsMethodName },
    // A method assigned as a property or class field: `name: function`, `name: (params) =>` or `name = async x =>`.
    { kind: "method", reserved: JS_RESERVED, pattern: /^/u, name: jsArrowPropertyName },
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
    // The extended type is the last component of a qualified name: `extension Outer.Inner`, `extension Swift.Array where`.
    { kind: "extension", pattern: new RegExp(`^\\s*${SWIFT_MODIFIERS}extension(?!${SWIFT_ID_PART})`, "u"), name: swiftExtendedType },
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

/** Options of `lineSymbols` and `lineSymbol`. */
export interface LineSymbolOptions {
  /**
   * Whether a TypeScript or JavaScript line may hold JSX, as in `.tsx`, `.jsx` and `.js` files; then a `<` that starts
   * an expression is read as an element first. Default `false`, as in a `.ts` file.
   */
  jsx?: boolean;
}

/**
 * Every symbol one line declares in `language`, by the first form that matches: usually one, several for a `const` or
 * `let` with more than one declarator or a destructuring pattern, none for a line that declares nothing. A name is
 * never a reserved word of the language. `next` is the head line after `text`, which only a Rust `impl` header that
 * rustfmt split reads.
 */
export function lineSymbols(language: SymbolLanguage, text: string, next?: string, options: LineSymbolOptions = {}): Array<{ name: string; kind: SymbolKind }> {
  return symbolsOf(language, text, () => next, options.jsx ? JSX_DIALECT : language === "rust" ? RUST_DIALECT : JS_DIALECT);
}

function symbolsOf(language: SymbolLanguage, text: string, next: () => string | undefined, dialect: Dialect): Array<{ name: string; kind: SymbolKind }> {
  const keywords = KEYWORDS[language];
  for (const rule of RULES[language]) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    if (rule.names) {
      const kind = match[1] as SymbolKind;
      const names = [...new Set(rule.names(text.slice(match[0].length), dialect))].filter(name => !keywords.has(name));
      if (names.length) return names.map(name => ({ name, kind }));
      continue;
    }
    const name = rule.name ? rule.name(text, next, dialect, match) : match[1];
    if (name !== undefined && !keywords.has(name) && !rule.reserved?.has(name)) return [{ name, kind: rule.kind as SymbolKind }];
  }
  return [];
}

/** The first symbol one line declares in `language`, or `undefined`. */
export function lineSymbol(language: SymbolLanguage, text: string, next?: string, options: LineSymbolOptions = {}): { name: string; kind: SymbolKind } | undefined {
  return lineSymbols(language, text, next, options)[0];
}

/** One head line to scan; `next` is the head line after it, when known, whatever its change status. */
export interface SymbolLine { line: number; text: string; next?: string }

/** Options of `symbolDeclarations` and `extractSymbols`. */
export interface ExtractSymbolOptions {
  /**
   * Called once for each head line longer than `SYMBOL_LINE_CHARACTER_LIMIT` that was not read: a given line, which is
   * skipped, or the next line a split Rust `impl` header needed.
   */
  onLongLine?: (line: number) => void;
}

/**
 * Symbols declared on the given head lines of `path`, in line order, one at a time so a caller can stop at a bound. A
 * path outside the recognized languages declares none. JSX is read in every TypeScript and JavaScript file but `.ts`.
 */
export function* symbolDeclarations(path: string, lines: Iterable<SymbolLine>, options: ExtractSymbolOptions = {}): Generator<DeclaredSymbol> {
  const language = symbolLanguage(path);
  if (!language) return;
  const dialect = language === "rust" ? RUST_DIALECT : language === "typescript" && !path.endsWith(".ts") ? JSX_DIALECT : JS_DIALECT;
  const reported = new Set<number>();
  const report = (line: number) => {
    if (reported.has(line)) return;
    reported.add(line);
    options.onLongLine?.(line);
  };
  for (const { line, text, next } of lines) {
    if (text.length > SYMBOL_LINE_CHARACTER_LIMIT) { report(line); continue; }
    // A next line over the limit is not read; a header that needed it declares nothing and the line is reported.
    const readNext = () => {
      if (next === undefined || next.length <= SYMBOL_LINE_CHARACTER_LIMIT) return next;
      report(line + 1);
      return undefined;
    };
    for (const symbol of symbolsOf(language, text, readNext, dialect)) yield { ...symbol, language, path, line };
  }
}

/** Symbols declared on the given head lines of `path`, in line order. */
export function extractSymbols(path: string, lines: Iterable<SymbolLine>, options: ExtractSymbolOptions = {}): DeclaredSymbol[] {
  const symbols: DeclaredSymbol[] = [];
  for (const symbol of symbolDeclarations(path, lines, options)) symbols.push(symbol);
  return symbols;
}



// One line scanner reads every form a pattern cannot express: TypeScript declarators, method and arrow parameter lists
// and Rust impl headers. Whitespace and comments are trivia at every token boundary; (), [] and {} balance to any depth;
// `<` opens a group for type parameters, call type arguments and (in JSX files) elements; strings, templates and regular
// expression literals are single tokens. A form the scanner does not model stops the scan, and a caller then reports
// only the names it already proved, never a name from inside a group. Each token is read once and nesting deeper than
// MAX_GROUP_DEPTH stops the scan, so the work is linear in the line length; only call type arguments look ahead, at most
// MAX_TYPE_ARGUMENT_CHARACTERS from each `<`.

/** How the scanner reads a line: TypeScript or JavaScript, with or without JSX, or Rust. */
interface Dialect { readonly rust: boolean; readonly jsx: boolean }
const JS_DIALECT: Dialect = Object.freeze({ rust: false, jsx: false });
const JSX_DIALECT: Dialect = Object.freeze({ rust: false, jsx: true });
const RUST_DIALECT: Dialect = Object.freeze({ rust: true, jsx: false });

const MAX_GROUP_DEPTH = 32;
const MAX_PATTERN_DEPTH = 16;
/** Characters a call's type arguments may span on one line; a `<` not classified within them stops the scan. */
const MAX_TYPE_ARGUMENT_CHARACTERS = 256;
const JS_IDENTIFIER = new RegExp(JS_ID, "uy");
/** An object pattern's property key: an identifier or a numeric key. */
const JS_PROPERTY_KEY = new RegExp(`${JS_ID_PART}+`, "uy");
const JS_IDENTIFIER_UNIT = new RegExp(`^${JS_ID_PART}$`, "u");
const RUST_IDENTIFIER = new RegExp(RUST_ID, "uy");
const SWIFT_IDENTIFIER = new RegExp(SWIFT_ID, "uy");
/** A JSX tag or attribute name: identifiers joined by `.`, `-` or `:`. */
const JSX_NAME = new RegExp(`[\\p{ID_Start}$_][\\p{ID_Continue}$\\u200C\\u200D.:-]*`, "uy");
const CLOSERS: Readonly<Record<string, string>> = Object.freeze({ "(": ")", "[": "]", "{": "}", "<": ">" });
/** What can follow call type arguments, as in `make<string, number>()`; anything else makes `<` a comparison. */
const TYPE_ARGUMENT_FOLLOWERS = "(`,;)]}";

/** What the last token was: one that ends a value, so `/` divides and `<` opens call type arguments or compares. */
interface ScanState { value: boolean }

/** The scan cannot read the line any further. */
const STOP = undefined;

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

/**
 * The index of the next token at or after `index`: whitespace and block comments are skipped (Rust's nest), and a line
 * comment or a block comment that does not close on the line ends it.
 */
function skipTrivia(text: string, index: number, dialect: Dialect): number {
  let at = index;
  for (;;) {
    while (at < text.length && /\s/u.test(text[at])) at += 1;
    if (text[at] !== "/") return at;
    if (text[at + 1] === "/") return text.length;
    if (text[at + 1] !== "*") return at;
    at = dialect.rust ? skipNestedComment(text, at) : text.indexOf("*/", at + 2);
    at = at === -1 ? text.length : at + 2;
  }
}

/** The index of the `*` of the `*\/` that closes the Rust block comment at `index`, or -1. */
function skipNestedComment(text: string, index: number): number {
  let depth = 0;
  for (let at = index; at < text.length - 1; at += 1) {
    if (text[at] === "/" && text[at + 1] === "*") { depth += 1; at += 1; }
    else if (text[at] === "*" && text[at + 1] === "/") {
      depth -= 1;
      if (!depth) return at;
      at += 1;
    }
  }
  return -1;
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

/** The index just past the template literal that starts at `index`, reading each `${...}` as a group, or `STOP`. */
function skipTemplate(text: string, index: number, dialect: Dialect, depth: number): number | undefined {
  for (let at = index + 1; at < text.length; at += 1) {
    if (text[at] === "\\") at += 1;
    else if (text[at] === "`") return at + 1;
    else if (text[at] === "$" && text[at + 1] === "{") {
      const end = skipGroup(text, at + 1, dialect, false, depth + 1);
      if (end === STOP) return STOP;
      at = end - 1;
    }
  }
  return STOP;
}

/**
 * The index just past the group whose opener (`(`, `[`, `{` or `<`) is at `start`, or `STOP` when it does not close on
 * the line, nests too deep or holds a construct the scanner does not model. `types` reads type syntax, as does any `<`
 * group: there `<` always nests and the arrows `=>` and `->` are single tokens.
 */
function skipGroup(text: string, start: number, dialect: Dialect, types: boolean, depth: number): number | undefined {
  if (depth > MAX_GROUP_DEPTH) return STOP;
  const closer = CLOSERS[text[start]];
  const inner = types || text[start] === "<";
  const state: ScanState = { value: false };
  for (let at = start + 1; ;) {
    at = skipTrivia(text, at, dialect);
    if (at >= text.length) return STOP;
    if (text[at] === closer) return at + 1;
    const end = skipToken(text, at, dialect, inner, state, depth);
    if (end === STOP) return STOP;
    at = end;
  }
}

/** `typeArguments` proved the `<` a comparison (or the first half of a shift). */
const COMPARISON = -1;

/**
 * Classifies the `<` at `index` that follows a value. Returns the index after the call type arguments it opens
 * (`make<string, number>(`, `make<{ a: A; b: B }, C>()`); `COMPARISON` when no type arguments can start there: an
 * operator no type holds appears in the angle brackets (`=`, `;`, `+`, `*`, `/`, `&&`, ...), a bracket closes that
 * the `<` did not open, or the closing `>` is followed by something a call's type arguments never are; or `STOP` when
 * the bounded span ends (or the line does) before either is proved. Comments are trivia, strings single tokens, and
 * (), [] and {} nest, holding any `;` or `,`.
 */
function typeArguments(text: string, index: number, dialect: Dialect): number | undefined {
  const open = [">"];
  const end = Math.min(text.length, index + MAX_TYPE_ARGUMENT_CHARACTERS);
  for (let at = index + 1; at < end; at += 1) {
    const character = text[at];
    const angle = open[open.length - 1] === ">";
    switch (character) {
      case "\"": case "'": case "`": at = skipString(text, at) - 1; break;
      case "=": if (text[at + 1] !== ">") return COMPARISON; at += 1; break;
      case "/":
        if (text[at + 1] === "/" || text[at + 1] === "*") {
          at = skipTrivia(text, at, dialect) - 1;
          break;
        }
        return COMPARISON;
      case ";": case "+": case "*": case "%": case "!": case "^": case "~": if (angle) return COMPARISON; break;
      case "&": case "|": if (angle && text[at + 1] === character) return COMPARISON; break;
      case "<": open.push(">"); break;
      case "(": open.push(")"); break;
      case "[": open.push("]"); break;
      case "{": open.push("}"); break;
      case ">": case ")": case "]": case "}": {
        if (open.pop() !== character) return COMPARISON;
        if (!open.length) {
          const after = skipTrivia(text, at + 1, dialect);
          return after >= text.length || TYPE_ARGUMENT_FOLLOWERS.includes(text[after]) ? at + 1 : COMPARISON;
        }
        break;
      }
      default: break;
    }
  }
  return STOP;
}

/**
 * The index just past the JSX element or fragment that starts with the `<` at `index`; `undefined` when its opening tag
 * is not JSX (so the caller reads a type parameter list instead), or `STOP` when it is JSX that does not close on the line.
 */
function skipJsx(text: string, index: number, dialect: Dialect, depth: number): number | undefined | "stop" {
  if (depth > MAX_GROUP_DEPTH) return "stop";
  const first = openingTag(text, index, dialect, depth);
  if (first === undefined) return undefined;
  if (first === "stop") return "stop";
  if (first.selfClosing) return first.end;
  let open = 1;
  for (let at = first.end; at < text.length;) {
    const character = text[at];
    if (character === "{") {
      const end = skipGroup(text, at, dialect, false, depth + 1);
      if (end === STOP) return "stop";
      at = end;
    } else if (character === "<" && text[skipTrivia(text, at + 1, dialect)] === "/") {
      at = skipTrivia(text, skipTrivia(text, at + 1, dialect) + 1, dialect);
      const name = readWith(JSX_NAME, text, at);
      if (name) at = skipTrivia(text, name.end, dialect);
      if (text[at] !== ">") return "stop";
      at += 1;
      open -= 1;
      if (!open) return at;
    } else if (character === "<") {
      const tag = openingTag(text, at, dialect, depth);
      if (tag === undefined || tag === "stop") return "stop";
      at = tag.end;
      if (!tag.selfClosing) open += 1;
    } else at += 1;
  }
  return "stop";
}

/** The opening tag at `index`: `<>`, `<name attributes>` or `<name attributes />`; `undefined` when it is not JSX. */
function openingTag(text: string, index: number, dialect: Dialect, depth: number): { end: number; selfClosing: boolean } | undefined | "stop" {
  let at = skipTrivia(text, index + 1, dialect);
  if (text[at] === ">") return { end: at + 1, selfClosing: false };
  const name = readWith(JSX_NAME, text, at);
  if (!name) return undefined;
  at = name.end;
  for (;;) {
    at = skipTrivia(text, at, dialect);
    if (text.startsWith("/>", at)) return { end: at + 2, selfClosing: true };
    if (text[at] === ">") return { end: at + 1, selfClosing: false };
    if (text[at] === "{") {
      const end = skipGroup(text, at, dialect, false, depth + 1);
      if (end === STOP) return "stop";
      at = end;
      continue;
    }
    const attribute = readWith(JSX_NAME, text, at);
    if (!attribute) return at >= text.length ? "stop" : undefined;
    at = skipTrivia(text, attribute.end, dialect);
    if (text[at] !== "=") continue;
    at = skipTrivia(text, at + 1, dialect);
    if (text[at] === "\"" || text[at] === "'") at = skipString(text, at);
    else if (text[at] === "{") {
      const end = skipGroup(text, at, dialect, false, depth + 1);
      if (end === STOP) return "stop";
      at = end;
    } else if (text[at] === "<") {
      const end = skipJsx(text, at, dialect, depth + 1);
      if (end === undefined || end === "stop") return "stop";
      at = end;
    } else return at >= text.length ? "stop" : undefined;
  }
}

/**
 * The index after the one token at `at` (never trivia), updating `state`, or `STOP`. In `types` a `<` always opens a
 * group; in an expression it opens type parameters or JSX where a value starts, and after a value it opens call type
 * arguments or is a comparison, whichever `typeArguments` proves (the scan stops when it proves neither).
 */
function skipToken(text: string, at: number, dialect: Dialect, types: boolean, state: ScanState, depth: number): number | undefined {
  const character = text[at];
  const settle = (end: number | undefined, value: boolean) => {
    state.value = value;
    return end;
  };
  if (character === "\"" || (character === "'" && !dialect.rust)) return settle(skipString(text, at), true);
  if (character === "'") {
    // A Rust character literal (`'a'`, `'\n'`) or a lifetime (`'a`).
    if (text[at + 1] === "\\") return settle(skipString(text, at), true);
    if (text[at + 2] === "'") return settle(at + 3, true);
    let end = at + 1;
    while (end < text.length && identifierUnit(text, end)) end += 1;
    return settle(end, true);
  }
  if (character === "`" && !dialect.rust) return settle(skipTemplate(text, at, dialect, depth), true);
  if ((character === "=" || character === "-") && text[at + 1] === ">") return settle(at + 2, false);
  if (character === "/" && !dialect.rust && !types && !state.value) return settle(skipRegularExpression(text, at), true);
  if (character === "(" || character === "[" || character === "{") return settle(skipGroup(text, at, dialect, types, depth + 1), true);
  if (character === "<" && types) return settle(skipGroup(text, at, dialect, true, depth + 1), true);
  if (character === "<" && dialect.rust) return settle(at + 1, false);
  if (character === "<") {
    if (!state.value) {
      // Where a value starts: a JSX element, or type parameters (`<T>(x: T) => x`) or a type assertion (`<T>value`).
      if (dialect.jsx) {
        const end = skipJsx(text, at, dialect, depth + 1);
        if (end === "stop") return STOP;
        if (end !== undefined) return settle(end, true);
      }
      return settle(skipGroup(text, at, dialect, true, depth + 1), false);
    }
    // After a value `<` opens call type arguments or is a comparison (or shift); when the bounded look-ahead proves
    // neither, the scan stops, so commas inside unproved type arguments never separate declarators.
    const end = typeArguments(text, at, dialect);
    if (end === STOP) return STOP;
    if (end !== COMPARISON) return settle(end, true);
    return settle(text[at + 1] === "<" ? at + 2 : at + 1, false);
  }
  if (character === ")" || character === "]" || character === "}" || (types && character === ">")) return STOP;
  if (identifierUnit(text, at)) {
    let end = at + 1;
    while (end < text.length && identifierUnit(text, end)) end += 1;
    return settle(end, true);
  }
  return settle(at + 1, false);
}

/**
 * The index of the first token outside groups, at or after `index`, where `stop` holds; the line's end when none does;
 * or `STOP` where the scan cannot read on.
 */
function scanUntil(text: string, index: number, dialect: Dialect, types: boolean, stop: (at: number, state: ScanState) => boolean): number | undefined {
  const state: ScanState = { value: false };
  for (let at = index; ;) {
    at = skipTrivia(text, at, dialect);
    if (at >= text.length) return text.length;
    if (stop(at, state)) return at;
    const end = skipToken(text, at, dialect, types, state, 0);
    if (end === STOP) return STOP;
    at = end;
  }
}

/** A stop at any of `characters`, where `=` never stops at an arrow `=>`. */
function stopAt(text: string, characters: string): (at: number) => boolean {
  return at => characters.includes(text[at]) && !(text[at] === "=" && text[at + 1] === ">");
}

/** Whether a declarator's name ends where a type annotation, initializer, next declarator or the line's end follows. */
function endsDeclarator(text: string, index: number, dialect: Dialect): boolean {
  const at = skipTrivia(text, index, dialect);
  return at === text.length || "!:=,;".includes(text[at]);
}

/** Reads the binding target at `index`, a name or a nested pattern, into `names`; the index after it, or `undefined`. */
function bindingTarget(text: string, index: number, names: string[], dialect: Dialect, depth: number): number | undefined {
  const at = skipTrivia(text, index, dialect);
  if (text[at] === "{" || text[at] === "[") return patternNames(text, at, names, dialect, depth + 1);
  const identifier = readWith(JS_IDENTIFIER, text, at);
  if (!identifier) return undefined;
  names.push(identifier.name);
  return identifier.end;
}

/**
 * Reads the names an object (`{`) or array (`[`) destructuring pattern at `start` binds into `names`. Returns the index
 * after the pattern, or `undefined` where the line ends or the pattern is not one the scanner reads; the names read
 * before that point stay, so a pattern that continues on the next line still reports its first names.
 */
function patternNames(text: string, start: number, names: string[], dialect: Dialect, depth: number): number | undefined {
  if (depth > MAX_PATTERN_DEPTH) return undefined;
  const object = text[start] === "{";
  const close = object ? "}" : "]";
  let at: number | undefined = start + 1;
  for (;;) {
    at = skipTrivia(text, at, dialect);
    if (text[at] === close) return at + 1;
    if (!object && text[at] === ",") { at += 1; continue; }
    if (text.startsWith("...", at)) at = bindingTarget(text, at + 3, names, dialect, depth);
    else if (!object) at = bindingTarget(text, at, names, dialect, depth);
    else {
      let key: string | undefined;
      if (text[at] === "[") at = skipGroup(text, at, dialect, false, depth + 1);
      else if (text[at] === "\"" || text[at] === "'") at = skipString(text, at);
      else {
        const identifier = readWith(JS_PROPERTY_KEY, text, at);
        if (!identifier) return undefined;
        key = identifier.name;
        at = identifier.end;
      }
      if (at === undefined) return undefined;
      at = skipTrivia(text, at, dialect);
      if (text[at] === ":") at = bindingTarget(text, at + 1, names, dialect, depth);
      else if (key !== undefined && readWith(JS_IDENTIFIER, key, 0)?.end === key.length) names.push(key);
      else return undefined;
    }
    if (at === undefined) return undefined;
    at = skipTrivia(text, at, dialect);
    if (text[at] === "=") at = scanUntil(text, at + 1, dialect, false, stopAt(text, `,${close}`));
    if (at === undefined) return undefined;
    if (text[at] === ",") { at += 1; continue; }
    if (text[at] === close) return at + 1;
    return undefined;
  }
}

/** Every name the declarators after `export const` or `export let` bind on this line. */
function jsDeclaredNames(rest: string, dialect: Dialect): string[] {
  const names: string[] = [];
  let at: number | undefined = 0;
  for (;;) {
    at = skipTrivia(rest, at, dialect);
    if (rest[at] === "{" || rest[at] === "[") {
      const end = patternNames(rest, at, names, dialect, 0);
      if (end === undefined || !endsDeclarator(rest, end, dialect)) return names;
      at = end;
    } else {
      const identifier = readWith(JS_IDENTIFIER, rest, at);
      if (!identifier || !endsDeclarator(rest, identifier.end, dialect)) return names;
      names.push(identifier.name);
      at = identifier.end;
    }
    at = skipTrivia(rest, at, dialect);
    if (rest[at] === "!") at = skipTrivia(rest, at + 1, dialect);
    if (rest[at] === ":") at = scanUntil(rest, at + 1, dialect, true, stopAt(rest, ",;="));
    if (at !== undefined && rest[at] === "=") at = scanUntil(rest, at + 1, dialect, false, stopAt(rest, ",;"));
    if (at === undefined || rest[at] !== ",") return names;
    at += 1;
  }
}

/**
 * The member name a line starts with, after its modifiers (`static async *#name`), and the index of the token after it.
 * A modifier counts as one only when a name, `*` or `#` follows it, so `get(key) {` declares `get`.
 */
function jsMemberName(text: string, dialect: Dialect): { name: string; end: number } | undefined {
  let at = skipTrivia(text, 0, dialect);
  // A line that starts with `*` and whitespace continues a block comment (` * save(user) {` in JSDoc): it declares nothing.
  if (text[at] === "*" && (at + 1 >= text.length || /\s/u.test(text[at + 1]))) return undefined;
  for (;;) {
    if (text[at] === "*") at = skipTrivia(text, at + 1, dialect);
    if (text[at] === "#") at += 1;
    const identifier = readWith(JS_IDENTIFIER, text, at);
    if (!identifier) return undefined;
    const after = skipTrivia(text, identifier.end, dialect);
    const modifier = JS_MEMBER_MODIFIERS.has(identifier.name) && text[at - 1] !== "#"
      && (text[after] === "*" || text[after] === "#" || readWith(JS_IDENTIFIER, text, after) !== undefined);
    if (!modifier) return { name: identifier.name, end: after };
    at = after;
  }
}

/** The method a line declares in shorthand: `name(params) {`, with optional type parameters and return type. */
function jsMethodName(text: string, _next: () => string | undefined, dialect: Dialect): string | undefined {
  const member = jsMemberName(text, dialect);
  if (!member) return undefined;
  let at: number | undefined = member.end;
  if (text[at] === "<") {
    at = skipGroup(text, at, dialect, true, 1);
    if (at === STOP) return undefined;
    at = skipTrivia(text, at, dialect);
  }
  if (text[at] !== "(") return undefined;
  at = skipGroup(text, at, dialect, false, 1);
  if (at === STOP) return undefined;
  at = skipTrivia(text, at, dialect);
  // A return type ends at the body's `{`; a `{` where a type starts is an object type.
  if (text[at] === ":") {
    const ends = stopAt(text, ";,=");
    at = scanUntil(text, at + 1, dialect, true, (index, state) => (text[index] === "{" && state.value) || ends(index));
  }
  return at !== undefined && text[at] === "{" ? member.name : undefined;
}

/** Whether an arrow function or `function` expression starts at `index`: `async`, type parameters, parameters, return type and `=>`. */
function functionValueAt(text: string, index: number, dialect: Dialect, afterAsync = false): boolean {
  const word = readWith(JS_IDENTIFIER, text, index);
  if (word?.name === "function") return true;
  // `async` once, or an arrow whose only parameter is named `async`.
  if (word?.name === "async" && !afterAsync && functionValueAt(text, skipTrivia(text, word.end, dialect), dialect, true)) return true;
  let at: number | undefined = index;
  if (text[at] === "<") {
    at = skipGroup(text, at, dialect, true, 1);
    if (at === STOP) return false;
    at = skipTrivia(text, at, dialect);
  }
  if (text[at] === "(") at = skipGroup(text, at, dialect, false, 1);
  else if (at === index && word) at = word.end;
  else return false;
  if (at === STOP) return false;
  at = skipTrivia(text, at, dialect);
  // The return type ends at the first arrow that follows a whole type.
  if (text[at] === ":") {
    const ends = stopAt(text, ";,=");
    at = scanUntil(text, at + 1, dialect, true, (index, state) => (text.startsWith("=>", index) && state.value) || ends(index));
  }
  return at !== undefined && text.startsWith("=>", at);
}

/** The property or class field a line assigns a function to: `name: function`, `name: (params) =>` or `name = async x =>`. */
function jsArrowPropertyName(text: string, _next: () => string | undefined, dialect: Dialect): string | undefined {
  const member = jsMemberName(text, dialect);
  if (!member) return undefined;
  const at = member.end;
  if ((text[at] !== ":" && text[at] !== "=") || text[at + 1] === "=" || text[at + 1] === ">") return undefined;
  return functionValueAt(text, skipTrivia(text, at + 1, dialect), dialect) ? member.name : undefined;
}

/**
 * The type a Swift `extension` extends: the last component of its qualified name (`Outer.Inner` gives `Inner`), never a
 * module or outer-type qualifier. Whitespace and comments (which nest, as in Rust) are trivia between the keyword, the
 * path components, a generic clause and what follows. The name is reported only when a proven follower ends the path:
 * `{`, `:`, `where`, or the end of the line (a line comment included). A name whose generic arguments a further `.`
 * follows (`Outer<T>.Inner`), a path continued on the next line (`extension Outer.`) and anything else give nothing.
 */
function swiftExtendedType(text: string, _next: () => string | undefined, _dialect: Dialect, match: RegExpExecArray): string | undefined {
  let at = match.index + match[0].length;
  if (at < text.length && !/\s|\//u.test(text[at])) return undefined;
  let name: string | undefined;
  for (;;) {
    const start = swiftTrivia(text, at);
    const component = start === undefined ? undefined : readWith(SWIFT_IDENTIFIER, text, start);
    if (!component) return undefined;
    name = component.name;
    const after = swiftTrivia(text, component.end);
    if (after === undefined) return undefined;
    at = after;
    if (text[at] !== ".") break;
    at += 1;
  }
  if (text[at] === "<") {
    const end = swiftGenericEnd(text, at);
    const after = end === undefined ? undefined : swiftTrivia(text, end);
    if (after === undefined) return undefined;
    at = after;
  }
  const follower = at >= text.length || text[at] === "{" || text[at] === ":" || readWith(SWIFT_IDENTIFIER, text, at)?.name === "where";
  return follower ? name : undefined;
}

/**
 * The index of the next Swift token at or after `index`, skipping whitespace and block comments (which nest); the line's
 * end for a line comment; `undefined` for a block comment that does not close on the line, as the next line may go on.
 */
function swiftTrivia(text: string, index: number): number | undefined {
  let at = index;
  for (;;) {
    while (at < text.length && /\s/u.test(text[at])) at += 1;
    if (text[at] !== "/") return at;
    if (text[at + 1] === "/") return text.length;
    if (text[at + 1] !== "*") return at;
    const close = skipNestedComment(text, at);
    if (close === -1) return undefined;
    at = close + 2;
  }
}

/** The index just past the generic clause whose `<` is at `index`, skipping comments; `undefined` when the line ends first. */
function swiftGenericEnd(text: string, index: number): number | undefined {
  let depth = 0;
  for (let at = index; at < text.length;) {
    const char = text[at];
    if (char === "/" && (text[at + 1] === "*" || text[at + 1] === "/")) {
      const after = swiftTrivia(text, at);
      if (after === undefined || after >= text.length) return undefined;
      at = after;
      continue;
    }
    if (char === "<") depth += 1;
    else if (char === ">" && !(depth -= 1)) return at + 1;
    at += 1;
  }
  return undefined;
}

const RUST_TYPE_PREFIXES: ReadonlySet<string> = new Set(["mut", "dyn", "const"]);

/**
 * The Rust type path at `index`: its last segment, after references, raw pointers, lifetimes, `mut`, `dyn` and a leading
 * `::`, with generic arguments skipped; and the index of the token after it. `undefined` for a type that is not a path,
 * such as a tuple, slice or function pointer.
 */
function rustType(text: string, index: number): { name: string; end: number } | undefined {
  let at = skipTrivia(text, index, RUST_DIALECT);
  for (;;) {
    if (text[at] === "&" || text[at] === "*") at = skipTrivia(text, at + 1, RUST_DIALECT);
    else if (text.startsWith("::", at)) at = skipTrivia(text, at + 2, RUST_DIALECT);
    else if (text[at] === "'") {
      at += 1;
      while (at < text.length && identifierUnit(text, at)) at += 1;
      at = skipTrivia(text, at, RUST_DIALECT);
    } else {
      const word = readWith(RUST_IDENTIFIER, text, at);
      if (!word || !RUST_TYPE_PREFIXES.has(word.name)) break;
      at = skipTrivia(text, word.end, RUST_DIALECT);
    }
  }
  let name: string | undefined;
  for (;;) {
    const segment = readWith(RUST_IDENTIFIER, text, at);
    if (!segment) break;
    name = segment.name;
    at = skipTrivia(text, segment.end, RUST_DIALECT);
    // Generic arguments, also as a turbofish: `Ledger<T>`, `Ledger::<T>`.
    if (text.startsWith("::", at) && text[skipTrivia(text, at + 2, RUST_DIALECT)] === "<") at = skipTrivia(text, at + 2, RUST_DIALECT);
    if (text[at] === "<") {
      const end = skipGroup(text, at, RUST_DIALECT, true, 1);
      if (end === STOP) return undefined;
      at = skipTrivia(text, end, RUST_DIALECT);
    }
    if (!text.startsWith("::", at)) break;
    at = skipTrivia(text, at + 2, RUST_DIALECT);
  }
  return name === undefined ? undefined : { name, end: at };
}

/** Whether a header's implemented type is complete at `index`: the body, a `where` clause or the line's end follows. */
function endsImplType(text: string, index: number): boolean {
  return index >= text.length || text[index] === "{" || readWith(RUST_IDENTIFIER, text, index)?.name === "where";
}

/** The type after a top-level `for`, which ends where the header does, or `undefined`. */
function rustForType(text: string, index: number): string | undefined {
  const type = rustType(text, index);
  return type && endsImplType(text, type.end) ? type.name : undefined;
}

/**
 * The type a Rust `impl` line implements: after the impl's own generic parameters, the type after a top-level `for`
 * when there is one (otherwise the header's type), without references, lifetimes, `mut`, `dyn` and path segments.
 * When neither the body nor a `where` clause starts on the line, rustfmt may have split the header: a `for Type` on the
 * next head line names the type (a trait impl), a next line starting with `where` or `{` makes this line's type the
 * implemented one (an inherent impl), and anything else declares nothing rather than mistake a trait for the type.
 */
function rustImplTarget(text: string, next: () => string | undefined): string | undefined {
  let at = skipTrivia(text, (/^\s*(?:unsafe\s+)?impl/u.exec(text) as RegExpExecArray)[0].length, RUST_DIALECT);
  if (text[at] === "<") {
    const end = skipGroup(text, at, RUST_DIALECT, true, 1);
    if (end === STOP) return undefined;
    at = skipTrivia(text, end, RUST_DIALECT);
  }
  // A negative impl, `impl !Send for Type`.
  if (text[at] === "!") at = skipTrivia(text, at + 1, RUST_DIALECT);
  const first = rustType(text, at);
  if (!first) return undefined;
  const keyword = readWith(RUST_IDENTIFIER, text, first.end);
  if (keyword?.name === "for") {
    const typeAt = skipTrivia(text, keyword.end, RUST_DIALECT);
    if (typeAt < text.length) return rustForType(text, typeAt);
    // `impl Trait for` with the type on the next line.
    const following = next();
    return following === undefined ? undefined : rustForType(following, skipTrivia(following, 0, RUST_DIALECT));
  }
  if (first.end < text.length) return endsImplType(text, first.end) ? first.name : undefined;
  const following = next();
  if (following === undefined) return undefined;
  const lead = skipTrivia(following, 0, RUST_DIALECT);
  const word = readWith(RUST_IDENTIFIER, following, lead);
  if (word?.name === "for") return rustForType(following, skipTrivia(following, word.end, RUST_DIALECT));
  return word?.name === "where" || following[lead] === "{" ? first.name : undefined;
}
