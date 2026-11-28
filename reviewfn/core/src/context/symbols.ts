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

interface SymbolRule {
  kind: SymbolKind;
  /** Capture group 1 is the symbol name. */
  pattern: RegExp;
  /** Names the form never declares, such as keywords a method-shaped line starts with. */
  reserved?: ReadonlySet<string>;
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
/** One level of nested parentheses, enough for callback parameter types. */
const PARAMETERS = "\\((?:[^()]|\\([^()]*\\))*\\)";
const JS_MEMBER_MODIFIERS = "(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set|declare|accessor)\\s+)*";
/** Statements and keywords that a call-and-block or assignment line can start with; never a method name. */
const JS_RESERVED = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "with", "do", "else", "try", "finally", "typeof", "new", "await",
  "yield", "constructor", "super", "import", "export", "const", "let", "var", "throw", "delete", "void", "in", "of", "case", "default",
]);
const SWIFT_MODIFIERS = "(?:@[A-Za-z_]\\w*(?:\\([^)]*\\))?\\s+)*(?:(?:public|private|fileprivate|internal|open|package|static|class|final|override|mutating|nonmutating|convenience|required|indirect|dynamic|lazy|nonisolated|distributed|optional)(?:\\([^)]*\\))?\\s+)*";
const RUST_VISIBILITY = "(?:pub(?:\\([^)]*\\))?\\s+)?";

const RULES: Readonly<Record<SymbolLanguage, readonly SymbolRule[]>> = Object.freeze({
  typescript: [
    { kind: "function", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${JS_ID})\\s*[<(]`, "u") },
    { kind: "class", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${JS_ID})`, "u") },
    { kind: "interface", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?interface\\s+(${JS_ID})`, "u") },
    { kind: "type", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+(${JS_ID})\\s*(?:<.*>)?\\s*=`, "u") },
    { kind: "enum", pattern: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${JS_ID})`, "u") },
    { kind: "const", pattern: new RegExp(`^\\s*export\\s+(?:declare\\s+)?const\\s+(${JS_ID})\\s*[:=;]`, "u") },
    { kind: "let", pattern: new RegExp(`^\\s*export\\s+(?:declare\\s+)?let\\s+(${JS_ID})\\s*[:=;]`, "u") },
    // Class and object method shorthand: `name(params) {`, optionally with modifiers, type parameters and a return type.
    { kind: "method", reserved: JS_RESERVED, pattern: new RegExp(`^\\s*${JS_MEMBER_MODIFIERS}\\*?\\s*#?(${JS_ID})\\s*(?:<[^()]*>)?\\s*${PARAMETERS}\\s*(?::\\s*[^;{}]+?)?\\s*\\{`, "u") },
    // A method assigned as a property or class field: `name: function`, `name: (params) =>` or `name = async x =>`.
    { kind: "method", reserved: JS_RESERVED, pattern: new RegExp(`^\\s*${JS_MEMBER_MODIFIERS}#?(${JS_ID})\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|(?:${PARAMETERS}|${JS_ID})\\s*(?::\\s*[^=;{}]+)?\\s*=>)`, "u") },
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
    // Functions and methods: `func Name(` or `func (receiver) Name(`, with optional type parameters.
    { kind: "function", pattern: new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?(${ID})\\s*[[(]`, "u") },
    { kind: "type", pattern: new RegExp(`^\\s*type\\s+(${ID})\\s*(?:\\[[^\\]]*\\]\\s*)?(?:=\\s*)?[A-Za-z_*[(]`, "u") },
  ],
  rust: [
    { kind: "function", pattern: new RegExp(`^\\s*${RUST_VISIBILITY}(?:(?:const|async|unsafe|default)\\s+)*(?:extern\\s+(?:"[^"]*"\\s+)?)?fn\\s+(${ID})`, "u") },
    { kind: "struct", pattern: new RegExp(`^\\s*${RUST_VISIBILITY}struct\\s+(${ID})`, "u") },
    { kind: "enum", pattern: new RegExp(`^\\s*${RUST_VISIBILITY}enum\\s+(${ID})`, "u") },
    { kind: "trait", pattern: new RegExp(`^\\s*${RUST_VISIBILITY}(?:unsafe\\s+)?(?:auto\\s+)?trait\\s+(${ID})`, "u") },
    // The implemented type: `impl Type`, `impl<T> Trait for Type<T>`, `impl Trait for path::Type`.
    { kind: "impl", pattern: new RegExp(`^\\s*(?:unsafe\\s+)?impl(?:\\s*<.*?>)?\\s+(?:!?[\\w:]+(?:<.*?>)?\\s+for\\s+)?(?:dyn\\s+)?(?:\\w+::)*(${ID})`, "u") },
  ],
});

/** The symbol one line declares in `language`: the first matching form, or `undefined`. */
export function lineSymbol(language: SymbolLanguage, text: string): { name: string; kind: SymbolKind } | undefined {
  for (const rule of RULES[language]) {
    const name = rule.pattern.exec(text)?.[1];
    if (name !== undefined && !rule.reserved?.has(name)) return { name, kind: rule.kind };
  }
  return undefined;
}

/**
 * Symbols declared on the given head lines of `path`, in line order. A path outside the recognized languages declares
 * none.
 */
export function extractSymbols(path: string, lines: Iterable<{ line: number; text: string }>): DeclaredSymbol[] {
  const language = symbolLanguage(path);
  if (!language) return [];
  const symbols: DeclaredSymbol[] = [];
  for (const { line, text } of lines) {
    const symbol = lineSymbol(language, text);
    if (symbol) symbols.push({ ...symbol, language, path, line });
  }
  return symbols;
}
