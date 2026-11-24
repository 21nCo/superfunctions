#!/usr/bin/env node
// SFNS-311: Turbo replays a cached task only when nothing it hashes changed, so every file a cacheable task (build,
// typecheck, test, lint) reads from outside its own package must be in that task's hash: a declared input, a global
// input, or a file of a package whose task the task depends on. This guard finds such reads in each workspace package's
// tracked files and asks Turbo (`turbo run … --dry=json`) whether each target is hashed. It never re-implements Turbo's
// globs. It finds a closed set of forms only:
//   1. relative `import`, `export … from`, `require()` and `import()` specifiers;
//   2. string-literal path segments given to path.join, path.resolve, fileURLToPath(new URL(…, import.meta.url)) or
//      new URL(…, import.meta.url): on a base it can resolve (__dirname, __filename, import.meta.dirname/filename/url,
//      process.cwd() or a const bound in the same file to one of these forms), or on none, which is relative to the
//      package directory, where Turbo runs the task;
//   3. `alias` values (and `replacement` entries) in vitest.config.*, vite.config.* and suffixed variants such as
//      vitest.workerd.config.ts, as string literals or form 2;
//   4. relative paths (`./…`, `../…`) in the package.json script that runs a cacheable task and in its npm `pre` and
//      `post` hooks, as module reads of that task only, so a root script a hook runs has its own reads checked.
// It reads JavaScript and TypeScript files, the scripts and markup expressions of Svelte, Vue and Astro components, and
// the import and export blocks and `{…}` expressions of MDX files (see tokensOf).
// Paths built from other values are computed reads, deferred to SFNS-306, and so is a name bound to a path that is
// only ever the base of other paths. These targets are skipped: one with no tracked file (a file the task writes or
// generates, which no Turbo input can hash), and a path (form 2) of a directory that holds the reading package (an
// ancestor or the repository root, a base for other paths whose literal reads are found as their own). A read of
// another package's directory reads that package's files; a tracked symlink to a directory stands for the files of
// that directory. A module read names every file a resolver could load for it (see resolveTarget), and what a file
// outside the package that a module read names goes on to import or read is read too (see checkReads).
// A file the guard cannot tokenize (an unterminated comment, string, template, regular expression, JSX element, tag or
// HTML comment) is an error naming the file and line, never a silent skip of the code after it.
// Every read must be hashed by each of the package's four cacheable tasks that exists: the guard does not try to tell
// which task runs a file, and declaring an input a task does not read only costs cache hits.
//
// Usage: node scripts/turbo-inputs-guard.mjs [--root <dir>] [--package <name>]... [--turbo <bin>] [--list] [--json]
// Turbo comes from --turbo, then $TURBO_BIN, then <root>/node_modules/turbo/bin/turbo. Exit 1 lists each undeclared
// read; declare it with "$TURBO_ROOT$/<path>" next to "$TURBO_DEFAULT$" in the task's inputs (the package's turbo.json).
// Exit 2 reports an error, such as a file the guard cannot tokenize.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const posix = path.posix;
export const CACHEABLE_TASKS = ["build", "typecheck", "test", "lint"];
const SCANNED_FILE = /\.(?:[cm]?[jt]sx?|svelte|vue|astro|mdx)$/;
// Files that may hold JSX. TypeScript's `<Type>value` assertions are valid only in .ts, .mts and .cts files.
const JSX_FILE = /\.(?:[cm]?jsx?|tsx)$/;
const CONFIG_FILE = /(?:^|\/)(?:vitest|vite)(?:\.[\w-]+)?\.config\.[cm]?[jt]s$/;
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".svelte", ".vue", ".d.ts", ".d.mts", ".d.cts"];
const TYPE_VARIANTS = [".ts", ".tsx", ".d.ts", ".mts", ".d.mts", ".cts", ".d.cts"];
const PATH_MODULES = new Set(["path", "node:path", "path/posix", "node:path/posix"]);
const URL_MODULES = new Set(["url", "node:url"]);
const PATH_FUNCTIONS = new Set(["join", "resolve", "dirname", "normalize"]);
const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "default"]);
const MULTI_CHAR_PUNCTUATION = ["===", "!==", "...", "=>", "++", "--", "==", "!=", "?.", "??", "&&", "||", "<=", ">="];
const STATEMENT_END = new Set([",", ")", "]", "}", ";"]);
const IDENTIFIER_START = /[\p{ID_Start}_$]/u;
const IDENTIFIER = /^#?[\p{ID_Continue}$‌‍]+/u;
const JSX_NAME = /^[\p{ID_Start}_$][\p{ID_Continue}$.:-]*/u;

// Thrown when a file holds code the tokenizer cannot read: rather than skip what follows, the guard stops.
export class SourceError extends Error {
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };

// JavaScript tokens: strings (`str`, with the decoded value; a template that has no substitution is one too), templates
// with substitutions (`tpl`, whose expressions follow as ordinary tokens), identifiers, numbers, punctuation and, in JSX
// files, one `jsx` token after each JSX element (whose `{…}` expressions come before it as ordinary tokens). Comments,
// regular expressions and JSX text are dropped. Code it cannot read (an unterminated comment, string, template, regular
// expression or JSX element) throws a SourceError, so a misread never hides the code after it.
// With `at`, the index of a `{`, it reads only the expression that brace opens and returns { tokens, end } where end is
// the index after its `}`; `line` is the line number of the first character read.
export function tokenize(source, { jsx = false, at, line: firstLine = 1 } = {}) {
  const tokens = [];
  let i = at === undefined ? 0 : at + 1;
  let line = firstLine;
  const fail = (what, at) => {
    throw new SourceError(`cannot read ${what}`, at);
  };
  // Whether a `/` or `<` at the current position starts an operand. `start` is the token count where the enclosing
  // expression (the file, a `${…}` or a JSX `{…}`) began.
  const operandExpected = (start) => {
    if (tokens.length === start) return true;
    const previous = tokens.at(-1);
    if (previous.type === "id") {
      const member = tokens.at(-2)?.type === "punc" && tokens.at(-2).value === ".";
      return REGEX_AFTER.has(previous.value) && !member;
    }
    return previous.type === "punc" && ![")", "]", "}", "++", "--"].includes(previous.value);
  };
  const step = () => {
    line += source[i] === "\n" ? 1 : 0;
    i += 1;
  };
  // The value of the escape sequence whose backslash was just consumed.
  const readEscape = () => {
    const char = source[i];
    if (char === "\r" || char === "\n") {
      if (char === "\r" && source[i + 1] === "\n") step();
      step();
      return ""; // A line continuation.
    }
    const hex = /^(?:x([\da-f]{2})|u([\da-f]{4})|u\{([\da-f]{1,6})\})/i.exec(source.slice(i, i + 9));
    if (hex) {
      i += hex[0].length;
      const code = Number.parseInt(hex[1] ?? hex[2] ?? hex[3], 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    step();
    if (char === "0" && !/\d/.test(source[i] ?? "")) return "\0";
    return ESCAPES[char] ?? char ?? "";
  };
  // A JavaScript string from its quote: it ends at the same quote, and a line break before it is an error.
  const scanString = (quote) => {
    const start = line;
    let value = "";
    step();
    while (source[i] !== quote) {
      if (i >= source.length || source[i] === "\n" || source[i] === "\r") fail("an unterminated string", start);
      if (source[i] === "\\") {
        step();
        value += readEscape();
      } else {
        value += source[i];
        step();
      }
    }
    step();
    return value;
  };
  // A template from its backtick; `${…}` expressions are tokenized as code.
  const scanTemplate = () => {
    const start = line;
    const token = { type: "str", value: "", line };
    tokens.push(token);
    step();
    while (source[i] !== "`") {
      if (i >= source.length) fail("an unterminated template literal", start);
      if (source[i] === "\\") {
        step();
        token.value += readEscape();
      } else if (source[i] === "$" && source[i + 1] === "{") {
        token.type = "tpl";
        const open = line;
        i += 2;
        scanCode(open);
      } else {
        token.value += source[i];
        step();
      }
    }
    step();
    if (token.type === "tpl") token.value = "";
  };
  const skipBlockComment = () => {
    const end = source.indexOf("*/", i + 2);
    if (end === -1) fail("an unterminated block comment", line);
    for (let k = i; k < end; k += 1) line += source[k] === "\n" ? 1 : 0;
    i = end + 2;
  };
  // Whitespace and comments between the parts of a JSX tag.
  const skipJsxSpace = () => {
    for (;;) {
      if (/\s/.test(source[i] ?? "")) step();
      else if (source.startsWith("//", i)) while (i < source.length && source[i] !== "\n") i += 1;
      else if (source.startsWith("/*", i)) skipBlockComment();
      else return;
    }
  };

  // A JSX element from its `<`. Returns false, with nothing consumed, when the `<` opens the type parameters of a
  // generic arrow function (`<T,>(…) => …`, `<T extends U>(…) => …`, `<T = U,>`, `<const T,>`); throws when the
  // element is not closed or has a part it cannot read.
  const scanJsxElement = () => {
    const start = line;
    const saved = i;
    step();
    skipJsxSpace();
    if (source[i] === ">") {
      step();
      scanJsxChildren(start);
      tokens.push({ type: "jsx", value: "", line });
      return true;
    }
    const name = JSX_NAME.exec(source.slice(i, i + 256));
    if (!name) fail("a JSX element", start);
    i += name[0].length;
    const rest = source.slice(i, i + 256);
    const typeParameter = /^\s*(?:,|=(?!>)|extends\s)/;
    if (typeParameter.test(rest) || (name[0] === "const" && /^\s+[\p{ID_Start}_$][\p{ID_Continue}$]*\s*(?:,|=(?!>)|extends\s)/u.test(rest))) {
      i = saved;
      line = start;
      return false;
    }
    skipJsxSpace();
    if (source[i] === "<") {
      // Type arguments of a generic component: <List<string>>.
      let depth = 0;
      do {
        if (i >= source.length) fail("an unclosed JSX element", start);
        if (source[i] === "<") depth += 1;
        else if (source[i] === ">" && source[i - 1] !== "=") depth -= 1;
        step();
      } while (depth > 0);
    }
    for (;;) {
      skipJsxSpace();
      if (i >= source.length) fail("an unclosed JSX element", start);
      if (source.startsWith("/>", i)) {
        i += 2;
        break;
      }
      if (source[i] === ">") {
        step();
        scanJsxChildren(start);
        break;
      }
      if (source[i] === "{") {
        const open = line;
        step();
        scanCode(open);
        continue;
      }
      const attribute = JSX_NAME.exec(source.slice(i, i + 256));
      if (!attribute) fail("a JSX attribute", line);
      i += attribute[0].length;
      skipJsxSpace();
      if (source[i] !== "=") continue;
      step();
      skipJsxSpace();
      if (source[i] === '"' || source[i] === "'") {
        // JSX attribute strings have no escapes and may span lines.
        const quote = source[i];
        const open = line;
        step();
        while (source[i] !== quote) {
          if (i >= source.length) fail("an unterminated JSX attribute", open);
          step();
        }
        step();
      } else if (source[i] === "{") {
        const open = line;
        step();
        scanCode(open);
      } else if (source[i] !== "<" || !scanJsxElement()) {
        fail("a JSX attribute value", line);
      }
    }
    tokens.push({ type: "jsx", value: "", line });
    return true;
  };
  // Children up to and including the closing tag.
  const scanJsxChildren = (start) => {
    for (;;) {
      if (i >= source.length) fail("an unclosed JSX element", start);
      if (source[i] === "{") {
        const open = line;
        step();
        scanCode(open);
      } else if (source[i] === "<" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== ">") step();
        if (i >= source.length) fail("an unclosed JSX element", start);
        step();
        return;
      } else if (source[i] === "<") {
        if (!scanJsxElement()) fail("a JSX element", line);
      } else {
        step();
      }
    }
  };

  // Code up to the end of the source or, when `open` (the line of the enclosing `${` or JSX `{`) is given, up to the `}`
  // that closes it.
  const scanCode = (open) => {
    const nested = open !== undefined;
    const start = tokens.length;
    let depth = 0;
    while (i < source.length) {
      const char = source[i];
      const at = line;
      if (/\s/.test(char)) {
        step();
      } else if (char === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") i += 1;
      } else if (char === "/" && source[i + 1] === "*") {
        skipBlockComment();
      } else if (char === "#" && i === 0 && source[1] === "!") {
        while (i < source.length && source[i] !== "\n") i += 1;
      } else if (char === "'" || char === '"') {
        tokens.push({ type: "str", value: scanString(char), line: at });
      } else if (char === "`") {
        scanTemplate();
      } else if (char === "}" && depth === 0 && nested) {
        step();
        return;
      } else if (char === "<" && jsx && operandExpected(start) && /[\p{ID_Start}_$>]/u.test(source[i + 1] ?? "") && scanJsxElement()) {
        // A JSX element; its expressions are already tokens.
      } else if (char === "/" && operandExpected(start)) {
        let inClass = false;
        step();
        while (inClass || source[i] !== "/") {
          if (i >= source.length || source[i] === "\n") fail("an unterminated regular expression", at);
          if (source[i] === "\\") step();
          else if (source[i] === "[") inClass = true;
          else if (source[i] === "]") inClass = false;
          if (i >= source.length || source[i] === "\n") fail("an unterminated regular expression", at);
          step();
        }
        step();
        while (/[a-z]/i.test(source[i] ?? "")) step();
      } else if (IDENTIFIER_START.test(char) || (char === "#" && IDENTIFIER_START.test(source[i + 1] ?? ""))) {
        const match = IDENTIFIER.exec(source.slice(i, i + 256));
        tokens.push({ type: "id", value: match[0], line: at });
        i += match[0].length;
      } else if (/\d/.test(char)) {
        const match = /^[\w.]+/.exec(source.slice(i, i + 64));
        tokens.push({ type: "num", value: match[0], line: at });
        i += match[0].length;
      } else {
        const value = MULTI_CHAR_PUNCTUATION.find((op) => source.startsWith(op, i)) ?? char;
        if (value === "{") depth += 1;
        if (value === "}") depth -= 1;
        tokens.push({ type: "punc", value: value === "?." ? "." : value, line: at });
        i += value.length;
      }
    }
    if (nested) fail("an unterminated `${…}` or JSX `{…}` expression", open);
  };

  if (at !== undefined) {
    scanCode(firstLine);
    return { tokens, end: i };
  }
  scanCode();
  return tokens;
}

// The tokens of a file's code. Svelte, Vue and Astro components hold code in their <script> blocks (and an Astro
// component in its frontmatter), and in the expressions of their markup: Svelte and Astro `{…}` (text, attribute
// values, spreads and Svelte blocks), Vue `{{ … }}` and Vue directive values (v-*, :prop, @event, #slot). MDX holds code
// in top-level import and export blocks and in `{…}` expressions, including those in JSX attributes. HTML comments,
// <style> blocks, prose and fenced or inline code are not code. Each region's tokens end with a ";" so regions never
// join into one expression.
function tokensOf(file, source) {
  if (!/\.(?:svelte|vue|astro|mdx)$/.test(file)) return tokenize(source, { jsx: JSX_FILE.test(file) });
  const lineStarts = [0];
  for (let k = source.indexOf("\n"); k !== -1; k = source.indexOf("\n", k + 1)) lineStarts.push(k + 1);
  const lineAt = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const fail = (what, at) => {
    throw new SourceError(`cannot read ${what}`, lineAt(at));
  };
  const tokens = [];
  const add = (list, at) => {
    for (const token of list) tokens.push(token);
    tokens.push({ type: "punc", value: ";", line: lineAt(at) });
  };
  // Code between two offsets, and the `{…}` expression at an offset (returning the offset after it).
  const code = (from, to, jsx) => {
    if (to > from) add(tokenize(source.slice(from, to), { jsx, line: lineAt(from) }), to);
  };
  const expression = (at, jsx) => {
    const { tokens: list, end } = tokenize(source, { jsx, at, line: lineAt(at) });
    add(list, end);
    return end;
  };
  const skipPast = (text, from, what, at) => {
    const end = source.indexOf(text, from);
    if (end === -1) fail(what, at);
    return end + text.length;
  };

  if (file.endsWith(".mdx")) {
    mdxTokens(source, lineStarts, { code, expression, skipPast });
    return tokens;
  }
  const kind = file.slice(file.lastIndexOf(".") + 1);
  const braces = kind !== "vue";
  const jsx = kind === "astro";
  // A Svelte or Astro `{…}`; a Svelte block's closing tag ({/if}) holds no code.
  const brace = (at) => (kind === "svelte" && source[at + 1] === "/" ? skipPast("}", at, "a Svelte block tag", at) : expression(at, jsx));
  // A tag from its "<": its attributes' expressions and, for <script> and <style>, its contents.
  const tag = (at) => {
    const name = /^<([A-Za-z][\w:.-]*)/.exec(source.slice(at, at + 256));
    let k = at + name[0].length;
    let lang = "";
    for (;;) {
      while (/\s/.test(source[k] ?? "")) k += 1;
      if (k >= source.length) fail("an unclosed tag", at);
      if (source.startsWith("/>", k)) return k + 2;
      if (source[k] === ">") break;
      if (braces && source[k] === "{") {
        k = brace(k);
        continue;
      }
      const attribute = /^[^\s=>/"'{]+/.exec(source.slice(k, k + 256));
      if (!attribute) {
        k += 1;
        continue;
      }
      k += attribute[0].length;
      while (/\s/.test(source[k] ?? "")) k += 1;
      if (source[k] !== "=") continue;
      k += 1;
      while (/\s/.test(source[k] ?? "")) k += 1;
      const quote = source[k];
      if (quote === '"' || quote === "'") {
        const open = k;
        k += 1;
        if (!braces) {
          const end = skipPast(quote, k, "an unterminated attribute value", open) - 1;
          if (/^(?:v-|[:@#])/.test(attribute[0])) code(k, end, false);
          if (attribute[0] === "lang") lang = source.slice(k, end);
          k = end + 1;
          continue;
        }
        while (source[k] !== quote) {
          if (k >= source.length) fail("an unterminated attribute value", open);
          k = source[k] === "{" ? brace(k) : k + 1;
        }
        if (attribute[0] === "lang") lang = source.slice(open + 1, k);
        k += 1;
      } else if (braces && quote === "{") {
        k = brace(k);
      } else {
        while (k < source.length && !/[\s>]/.test(source[k]) && !source.startsWith("/>", k)) k += 1;
      }
    }
    k += 1;
    const element = name[1].toLowerCase();
    if (element === "script" || element === "style") {
      const close = source.toLowerCase().indexOf(`</${element}`, k);
      if (close === -1) fail(`an unclosed <${element}>`, at);
      if (element === "script") code(k, close, /^[jt]sx$/.test(lang));
      return skipPast(">", close, `an unclosed <${element}>`, at);
    }
    return k;
  };

  let i = 0;
  if (kind === "astro") {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (front) {
      code(front[0].indexOf("\n") + 1, front[0].length - 3, false);
      i = front[0].length;
    }
  }
  while (i < source.length) {
    if (source.startsWith("<!--", i)) i = skipPast("-->", i + 4, "an unterminated HTML comment", i);
    else if (source[i] === "<" && /[A-Za-z]/.test(source[i + 1] ?? "")) i = tag(i);
    else if (source[i] === "<" && source[i + 1] === "/") i = skipPast(">", i, "an unclosed tag", i);
    else if (braces && source[i] === "{") i = brace(i);
    else if (!braces && source.startsWith("{{", i)) i = expression(i, false);
    else i += 1;
  }
  return tokens;
}

// MDX: frontmatter and fenced code are skipped; a top-level import or export block is code (an import ends at its module specifier or a
// semicolon, an export at a blank line, as MDX reads them); in the rest, `{…}` is an expression unless it is escaped,
// in inline code or in an HTML comment.
function mdxTokens(source, lineStarts, { code, expression, skipPast }) {
  const lines = source.split("\n");
  const kinds = [];
  const blockEnds = new Map();
  let fenced = false;
  // YAML frontmatter is data, like fenced code.
  const frontEnd = /^---\r?$/.test(lines[0] ?? "") ? lines.findIndex((text, n) => n > 0 && /^---\r?$/.test(text)) : -1;
  for (let n = 0; n <= frontEnd; n += 1) kinds.push("fence");
  for (let n = frontEnd + 1; n < lines.length; n += 1) {
    if (/^\s*(?:```|~~~)/.test(lines[n])) {
      fenced = !fenced;
      kinds.push("fence");
    } else if (fenced) {
      kinds.push("fence");
    } else if (/^(?:import|export)\s/.test(lines[n])) {
      const isImport = lines[n].startsWith("import");
      let last = n;
      while (last < lines.length && lines[last].trim() !== "") {
        if (isImport && /\bfrom\s*['"]|^import\s*['"]|;\s*$/.test(lines[last])) break;
        last += 1;
      }
      last = Math.min(last, lines.length - 1);
      for (let k = n; k <= last; k += 1) kinds.push(k === n ? "code" : "inside");
      blockEnds.set(n, lineStarts[last] + lines[last].length);
      n = last;
    } else {
      kinds.push("prose");
    }
  }
  let i = 0;
  let line = 0;
  while (i < source.length) {
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= i) line += 1;
    if (i === lineStarts[line] && kinds[line] === "fence") {
      i = lineStarts[line + 1] ?? source.length;
    } else if (i === lineStarts[line] && kinds[line] === "code") {
      code(i, blockEnds.get(line), true);
      i = blockEnds.get(line);
    } else if (source[i] === "\\") {
      i += 2;
    } else if (source[i] === "`") {
      const run = /^`+/.exec(source.slice(i, i + 64))[0];
      const paragraphEnd = source.indexOf("\n\n", i);
      const pattern = new RegExp(`(?<!\`)${run}(?!\`)`, "g");
      pattern.lastIndex = i + run.length;
      const close = pattern.exec(source);
      i = close && (paragraphEnd === -1 || close.index < paragraphEnd) ? close.index + run.length : i + run.length;
    } else if (source.startsWith("<!--", i)) {
      i = skipPast("-->", i + 4, "an unterminated HTML comment", i);
    } else if (source[i] === "{") {
      i = expression(i, true);
    } else {
      i += 1;
    }
  }
}

const isId = (token, value) => token?.type === "id" && (value === undefined || token.value === value);
const isPunc = (token, value) => token?.type === "punc" && token.value === value;
// A property name written as an identifier or a string literal.
const isKey = (token, value) => (token?.type === "id" || token?.type === "str") && token.value === value;

// Finds the reads in one file. `file` is the repository-relative path, `packageDir` the package's. Path values are
// absolute in a virtual file system whose root "/" is the repository root. Returns [{ line, form, target }] where the
// target is "/"-rooted with no trailing slash, or [{ line, form, specifier }] for imports.
export function findReadsInSource(file, source, packageDir) {
  let tokens;
  try {
    tokens = tokensOf(file, source);
  } catch (error) {
    if (error instanceof SourceError) throw new SourceError(`${file}:${error.line}: ${error.message}`, error.line);
    throw error;
  }
  const fileAbs = `/${file}`;
  const fileDir = posix.dirname(fileAbs);
  const cwd = `/${packageDir}`;
  const isConfig = CONFIG_FILE.test(file);
  const reads = [];
  const namespaces = new Set();
  const functions = new Map([["fileURLToPath", "fileURLToPath"]]);
  const bindings = new Map();

  // Path and URL module bindings: default, namespace, named and CommonJS forms.
  const bindNamed = (list, module) => {
    for (const [name, local] of list) {
      if (PATH_MODULES.has(module) && (name === "posix" || name === "default")) namespaces.add(local);
      else if (PATH_MODULES.has(module) && PATH_FUNCTIONS.has(name)) functions.set(local, name);
      else if (URL_MODULES.has(module) && name === "fileURLToPath") functions.set(local, name);
    }
  };
  // Reads `{ a, b as c }` (or `{ a, b: c }` in a destructuring) starting at the `{`; returns [pairs, index after `}`].
  const readNameList = (start) => {
    const pairs = [];
    let k = start + 1;
    while (k < tokens.length && !isPunc(tokens[k], "}")) {
      if (isId(tokens[k])) {
        const name = tokens[k].value;
        const renamed = isId(tokens[k + 1], "as") || isPunc(tokens[k + 1], ":");
        pairs.push([name, renamed && isId(tokens[k + 2]) ? tokens[k + 2].value : name]);
        k += renamed ? 3 : 1;
      } else {
        k += 1;
      }
    }
    return [pairs, k + 1];
  };
  for (let k = 0; k < tokens.length; k += 1) {
    if (isId(tokens[k], "import") && !isPunc(tokens[k + 1], "(") && !isPunc(tokens[k + 1], ".")) {
      let j = k + 1;
      const defaults = [];
      let named = [];
      if (isId(tokens[j], "type")) j += 1;
      if (isId(tokens[j]) && !isId(tokens[j], "from")) defaults.push(tokens[j++].value);
      if (isPunc(tokens[j], ",")) j += 1;
      if (isPunc(tokens[j], "*") && isId(tokens[j + 1], "as")) {
        defaults.push(tokens[j + 2]?.value);
        j += 3;
      }
      if (isPunc(tokens[j], "{")) [named, j] = readNameList(j);
      if (isId(tokens[j], "from") && tokens[j + 1]?.type === "str") {
        const module = tokens[j + 1].value;
        if (PATH_MODULES.has(module)) defaults.forEach((name) => namespaces.add(name));
        bindNamed(named, module);
      }
    } else if (["const", "let", "var"].includes(tokens[k].value) && tokens[k].type === "id") {
      const target = tokens[k + 1];
      let names = [];
      let j = k + 2;
      if (isPunc(target, "{")) [names, j] = readNameList(k + 1);
      if (isPunc(tokens[j], "=") && isId(tokens[j + 1], "require") && isPunc(tokens[j + 2], "(")) {
        const module = tokens[j + 3]?.type === "str" ? tokens[j + 3].value : "";
        if (isId(target) && PATH_MODULES.has(module)) namespaces.add(target.value);
        bindNamed(names, module);
      }
    }
  }

  // The canonical path function a callee starting at k names, and the index of its "(".
  const callee = (k) => {
    const chain = [];
    let j = k;
    while (isId(tokens[j])) {
      chain.push(tokens[j].value);
      if (!isPunc(tokens[j + 1], ".")) break;
      j += 2;
    }
    if (chain.length === 0 || !isPunc(tokens[j + 1], "(")) return null;
    const last = chain.at(-1);
    if (chain.length === 1) return functions.has(last) && !bindings.has(last) ? { name: functions.get(last), open: j + 1 } : null;
    if (last === "fileURLToPath") return { name: last, open: j + 1 };
    const base = chain.slice(0, -1);
    const isPath = namespaces.has(base[0]) && base.slice(1).every((part) => part === "posix");
    return isPath && PATH_FUNCTIONS.has(last) ? { name: last, open: j + 1 } : null;
  };

  // Skips to the end of the expression starting at k: the index of the first terminator at depth 0.
  const skip = (k) => {
    let depth = 0;
    for (; k < tokens.length; k += 1) {
      const value = tokens[k].type === "punc" ? tokens[k].value : "";
      if (depth === 0 && STATEMENT_END.has(value)) return k;
      if (["(", "[", "{"].includes(value)) depth += 1;
      if ([")", "]", "}"].includes(value)) depth -= 1;
    }
    return k;
  };

  // Evaluates the expression at k. Returns { value, end } where value is { path }, { url }, { str } or null (unknown),
  // and end is the index just past the expression.
  const evaluate = (k, used) => {
    const primary = evaluatePrimary(k, used);
    let { value, end } = primary;
    if (value?.url && isPunc(tokens[end], ".") && ["pathname", "href"].includes(tokens[end + 1]?.value)) end += 2;
    const next = tokens[end];
    const ended = !next || (next.type === "punc" && STATEMENT_END.has(next.value)) || next.line > tokens[end - 1].line;
    return ended ? { value, end } : { value: null, end: skip(end) };
  };
  const evaluateArgs = (open, used) => {
    const values = [];
    let k = open + 1;
    while (k < tokens.length && !isPunc(tokens[k], ")")) {
      const { value, end } = evaluate(k, used);
      values.push(value);
      k = isPunc(tokens[end], ",") ? end + 1 : end;
      if (!isPunc(tokens[k], ")") && !isPunc(tokens[end], ",")) return { values: null, end: skip(k) + 1 };
    }
    return { values, end: k + 1 };
  };
  const evaluatePrimary = (k, used) => {
    const token = tokens[k];
    if (token?.type === "str") return { value: { str: token.value }, end: k + 1 };
    if (isId(token, "import") && isPunc(tokens[k + 1], ".") && isId(tokens[k + 2], "meta") && isPunc(tokens[k + 3], ".")) {
      const field = tokens[k + 4]?.value;
      const value = { url: { url: fileAbs }, dirname: { path: fileDir }, filename: { path: fileAbs } }[field] ?? null;
      return { value, end: k + 5 };
    }
    if (isId(token, "process") && isPunc(tokens[k + 1], ".") && isId(tokens[k + 2], "cwd") && isPunc(tokens[k + 3], "(") && isPunc(tokens[k + 4], ")")) {
      return { value: { path: cwd }, end: k + 5 };
    }
    if (isId(token, "new") && isId(tokens[k + 1], "URL") && isPunc(tokens[k + 2], "(")) {
      const { values, end } = evaluateArgs(k + 2, used);
      const [relative, base] = values ?? [];
      const ok = values?.length === 2 && relative?.str !== undefined && base?.url && !/^[a-z][\w+.-]*:/i.test(relative.str);
      const url = ok ? resolveUrl(base.url, relative.str) : null;
      return { value: url ? { url } : null, end };
    }
    const call = callee(k);
    if (call) {
      const { values, end } = evaluateArgs(call.open, used);
      return { value: values ? applyPathFunction(call.name, values, cwd) : null, end };
    }
    if (isId(token) && bindings.has(token.value) && !isPunc(tokens[k + 1], "(")) {
      used.add(token.value);
      return { value: bindings.get(token.value).value, end: k + 1 };
    }
    if (isId(token, "__dirname")) return { value: { path: fileDir }, end: k + 1 };
    if (isId(token, "__filename")) return { value: { path: fileAbs }, end: k + 1 };
    return { value: null, end: skip(k) };
  };
  const startsPathExpression = (k) =>
    callee(k) !== null || (isId(tokens[k], "new") && isId(tokens[k + 1], "URL") && isPunc(tokens[k + 2], "("));
  // The path a recorded expression reads: a relative string from a path function is relative to the task's cwd.
  const readPath = (value, fromCall) => {
    const target = value?.path ?? value?.url ?? (fromCall && value?.str !== undefined ? posix.resolve(cwd, value.str) : undefined);
    return target === undefined ? undefined : target.replace(/(.)\/+$/, "$1");
  };

  const candidates = [];
  const referencedOutside = new Set();
  const usedAsBase = new Set();
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k];
    // Form 1: import/export … from "x", import "x", import("x"), require("x").
    if (isId(token, "from") && tokens[k + 1]?.type === "str") {
      reads.push({ line: tokens[k + 1].line, form: "import", specifier: tokens[k + 1].value });
      continue;
    }
    if (isId(token, "import") && tokens[k + 1]?.type === "str") {
      reads.push({ line: token.line, form: "import", specifier: tokens[k + 1].value });
      continue;
    }
    if ((isId(token, "import") || isId(token, "require")) && isPunc(tokens[k + 1], "(") && tokens[k + 2]?.type === "str" && !isPunc(tokens[k - 1], ".")) {
      reads.push({ line: token.line, form: token.value === "require" ? "require" : "import()", specifier: tokens[k + 2].value });
      continue;
    }
    // Form 2 bound to a name: const X = <path expression>.
    if (["const", "let", "var"].includes(token.value) && token.type === "id" && isId(tokens[k + 1]) && isPunc(tokens[k + 2], "=")) {
      const used = new Set();
      const { value, end } = evaluate(k + 3, used);
      const target = readPath(value, startsPathExpression(k + 3));
      if (target) {
        used.forEach((name) => usedAsBase.add(name));
        bindings.set(tokens[k + 1].value, { value });
        candidates.push({ line: tokens[k + 3].line, form: "path", target, binding: tokens[k + 1].value });
        k = end - 1;
      } else {
        k += 2;
      }
      continue;
    }
    // Form 3: a string-literal alias value in a Vite or Vitest config.
    if (isConfig && token.type === "str" && /^\.\.?(?:\/|$)/.test(token.value) && isAliasValue(tokens, k)) {
      candidates.push({ line: token.line, form: "alias", target: readPath({ path: posix.join(fileDir, token.value) }) });
      continue;
    }
    // Form 2 unbound: path.join(…), path.resolve(…), fileURLToPath(new URL(…)), new URL(…, import.meta.url); an alias
    // value when it is one in a Vite or Vitest config.
    if (startsPathExpression(k)) {
      const used = new Set();
      const { value, end } = evaluate(k, used);
      const target = readPath(value, callee(k) !== null);
      if (target && callee(k)?.name !== "dirname") {
        used.forEach((name) => usedAsBase.add(name));
        candidates.push({ line: token.line, form: isConfig && isAliasValue(tokens, k) ? "alias" : "path", target });
        k = end - 1;
      }
      continue;
    }
    if (isId(token) && bindings.has(token.value) && !isPunc(tokens[k - 1], ".")) referencedOutside.add(token.value);
  }
  // A name only ever used as the base of other paths is not itself a read.
  for (const candidate of candidates) {
    if (candidate.binding && usedAsBase.has(candidate.binding) && !referencedOutside.has(candidate.binding)) continue;
    reads.push({ line: candidate.line, form: candidate.form, target: candidate.target });
  }
  return reads;
}

// True when the token at k starts a value inside an `alias` object or array (a value after `key:`, or an entry's
// `replacement:`), as Vite and Vitest configs write them, with the property names quoted or not.
function isAliasValue(tokens, k) {
  if (!isPunc(tokens[k - 1], ":")) return false;
  let depth = 0;
  for (let j = k - 1; j >= 0; j -= 1) {
    const value = tokens[j].type === "punc" ? tokens[j].value : "";
    if (value === "}" || value === "]" || value === ")") depth += 1;
    if (value === "{" || value === "[" || value === "(") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      // The enclosing container: alias: { … } or alias: [ { … } ].
      if (value === "{" && isPunc(tokens[j - 1], ":") && isKey(tokens[j - 2], "alias")) return true;
      if (value === "{" && (isPunc(tokens[j - 1], "[") || isPunc(tokens[j - 1], ","))) {
        // An entry of an array: find the array's `[` and check it is the alias value.
        let arrayDepth = 0;
        for (let a = j - 1; a >= 0; a -= 1) {
          const punctuation = tokens[a].type === "punc" ? tokens[a].value : "";
          if (punctuation === "}" || punctuation === "]" || punctuation === ")") arrayDepth += 1;
          else if (punctuation === "{" || punctuation === "(") arrayDepth -= 1;
          else if (punctuation === "[" && arrayDepth-- === 0) {
            return isPunc(tokens[a - 1], ":") && isKey(tokens[a - 2], "alias") && isKey(tokens[k - 2], "replacement");
          }
          if (arrayDepth < 0) return false;
        }
      }
      return false;
    }
  }
  return false;
}

// new URL(relative, base) for a file URL base, as a decoded path that keeps a directory's trailing slash, so a later
// new URL(name, directory) resolves inside it; null when the relative URL leaves the file scheme, is absolute (outside
// the repository) or does not decode. The WHATWG parser applies the URL rules: ".." segments, "?" and "#", and removing
// leading and trailing spaces, tabs and line breaks.
function resolveUrl(base, relative) {
  try {
    const url = new URL(relative, `file://${base.split("/").map(encodeURIComponent).join("/")}`);
    if (url.protocol !== "file:" || url.host !== "" || /^\s*[/\\]/.test(relative)) return null;
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

function applyPathFunction(name, values, cwd) {
  if (values.some((value) => value === null)) return null;
  const parts = values.map((value) => value.path ?? value.str);
  if (name === "fileURLToPath") return values[0]?.url ? { path: values[0].url } : null;
  if (parts.some((part) => part === undefined)) return null;
  if (name === "dirname") return values[0]?.path ? { path: posix.dirname(values[0].path) } : null;
  if (name === "normalize") return values[0]?.path ? { path: posix.normalize(values[0].path) } : null;
  if (name === "join") {
    return values[0]?.path ? { path: posix.join(...parts) } : { str: posix.join(...parts) };
  }
  // resolve: an absolute string literal would leave the repository's virtual root, so the result is unknown.
  if (values.some((value) => value.str !== undefined && posix.isAbsolute(value.str))) return null;
  return { path: posix.resolve(cwd, ...parts) };
}

// ---------------------------------------------------------------------------------------------------------------------

// The first working Git in a fixed system directory, never a PATH lookup (macOS /usr/bin/git can be a shim that fails
// without developer tools installed).
const GIT = ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"].find((candidate) => {
  try {
    return existsSync(candidate) && execFileSync(candidate, ["--version"], { stdio: ["ignore", "pipe", "ignore"] }).length > 0;
  } catch {
    return false;
  }
});

function git(root, args) {
  if (!GIT) throw new Error("git is not installed in /usr/bin, /usr/local/bin or /opt/homebrew/bin");
  return execFileSync(GIT, args, { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

function runTurbo(root, turboBin, args) {
  return execFileSync(process.execPath, [turboBin, ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", TURBO_NO_UPDATE_NOTIFIER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const within = (file, directory) => directory === "" || file === directory || file.startsWith(`${directory}/`);

// The deepest package directory holding a repository-relative path, or undefined.
function owningPackage(file, packageDirs) {
  let best;
  for (const directory of packageDirs) {
    if (within(file, directory) && (best === undefined || directory.length > best.length)) best = directory;
  }
  return best;
}

// Resolves a read to { target, files, module }: files are the tracked files it names, empty when nothing tracked is
// there. A path read names a file, or every tracked file under a directory. A module read (an import or an alias) names
// every tracked file a resolver could load for it, since TypeScript, Vite and Node differ: the file itself, its
// TypeScript sources and declarations (x.js also names x.ts, x.tsx and x.d.ts; x.mjs names x.mts and x.d.mts; x.cjs
// names x.cts and x.d.cts), the file with each extension added, and the directory's index files. A specifier ending in
// "/" (or "." or "..") names the directory's index files only. A package directory, an alias to a directory, and a
// directory with no index file name every tracked file under the directory.
export function resolveTarget(read, file, tracked, trackedDirs) {
  if (read.specifier !== undefined && !/^\.\.?(?:\/|$)/.test(read.specifier)) return null;
  const module = read.specifier !== undefined || read.form === "alias";
  // A path on a command line is a file name; an import specifier may carry a query (`?raw`).
  const specifier = read.form === "script" ? read.specifier : read.specifier?.split("?")[0];
  const target = (specifier === undefined ? read.target.slice(1) : posix.join(posix.dirname(file), specifier)).replace(/(.)\/+$/, "$1");
  if (target === "" || target === "." || target === ".." || target.startsWith("../")) return null;
  if (!module) return { target, files: tracked.has(target) ? [target] : trackedDirs.get(target) ?? [], module };
  const found = new Set();
  const add = (candidate) => tracked.has(candidate) && found.add(candidate);
  if (specifier === undefined || !/(?:^|\/)\.{0,2}$/.test(specifier)) {
    add(target);
    const stem = target.replace(/\.(?:[cm]?js|jsx)$/, "");
    if (stem !== target) TYPE_VARIANTS.forEach((ext) => add(stem + ext));
    RESOLVE_EXTENSIONS.forEach((ext) => add(target + ext));
  }
  RESOLVE_EXTENSIONS.forEach((ext) => add(`${target}/index${ext}`));
  const directory = trackedDirs.get(target);
  if (directory && (read.form === "alias" || tracked.has(`${target}/package.json`) || found.size === 0)) directory.forEach((entry) => found.add(entry));
  return { target, files: [...found], module };
}

// Every read in the selected packages whose target lies outside the package and holds tracked files, with the tracked
// files it names; packageDirs lists every workspace package directory, selected or not. Each read must be hashed by all
// four cacheable tasks of its package that exist: the guard does not try to tell which task runs a file. Returns
// { reads, edgesOf }: edgesOf(file) lists the reads of any tracked file as [{ files, module }], for following what a
// file outside the package goes on to read (see checkReads).
export function findOutsideReads(root, packages, packageDirs = packages.map((pkg) => pkg.path)) {
  const entries = git(root, ["ls-files", "-s", "-z"]).split("\0").filter(Boolean).map((entry) => [entry.slice(0, entry.indexOf("\t")), entry.slice(entry.indexOf("\t") + 1)]);
  const trackedList = entries.map(([, file]) => file);
  const tracked = new Set(trackedList);
  const trackedDirs = new Map();
  for (const file of trackedList) {
    for (let directory = posix.dirname(file); directory !== "."; directory = posix.dirname(directory)) {
      if (!trackedDirs.has(directory)) trackedDirs.set(directory, []);
      trackedDirs.get(directory).push(file);
    }
  }
  // Turbo hashes no symlink to a directory, so a tracked one stands for the tracked files of the directory it points to.
  const linkedDirs = new Map();
  for (const [mode, file] of entries.map(([info, file]) => [info.split(" ")[0], file])) {
    if (mode !== "120000") continue;
    try {
      const real = path.relative(root, realpathSync(path.join(root, file))).split(path.sep).join("/");
      if (statSync(path.join(root, file)).isDirectory() && !real.startsWith("..")) linkedDirs.set(file, trackedDirs.get(real) ?? []);
    } catch {
      // A broken link: the file itself.
    }
  }
  const packageDirSet = new Set(packageDirs);
  // The files a resolved read names: a package directory names that package's files, not those of packages nested in
  // it, and a symlink to a directory names the files of that directory.
  const filesOf = ({ target, files }) => {
    const owned = packageDirSet.has(target) ? files.filter((file) => !within(file, target) || owningPackage(file, packageDirs) === target) : files;
    return [...new Set(owned.flatMap((file) => linkedDirs.get(file) ?? [file]))];
  };
  const scanned = new Map();
  // The resolved reads of a tracked file; a file outside every package runs with its own directory as the cwd.
  const readsOf = (file) => {
    if (!scanned.has(file)) {
      let found = [];
      if (SCANNED_FILE.test(file) && tracked.has(file) && existsSync(path.join(root, file)) && statSync(path.join(root, file)).isFile()) {
        const owner = owningPackage(file, packageDirs) ?? posix.dirname(file);
        found = findReadsInSource(file, readFileSync(path.join(root, file), "utf8"), owner)
          .map((read) => ({ read, resolved: resolveTarget(read, file, tracked, trackedDirs) }))
          .filter(({ resolved }) => resolved && resolved.files.length > 0);
      }
      scanned.set(file, found);
    }
    return scanned.get(file);
  };
  const edges = new Map();
  // A path read of a directory that holds the file is a base for other paths, not a read of its files.
  const edgesOf = (file) => {
    if (!edges.has(file)) {
      edges.set(
        file,
        readsOf(file)
          .filter(({ resolved }) => resolved.module || !within(file, resolved.target))
          .map(({ resolved }) => ({ files: filesOf(resolved), module: resolved.module }))
      );
    }
    return edges.get(file);
  };
  const reads = [];
  const addRead = (pkg, file, read, resolved, tasks) => {
    // A target inside the package is the package's own. A path of a directory that holds the package (an ancestor or
    // the repository root) is a base for other paths, whose literal reads are found as their own; an import or alias
    // of one reads its files.
    if (within(resolved.target, pkg.path) || (!resolved.module && within(pkg.path, resolved.target))) return;
    const files = filesOf(resolved).filter((entry) => !within(entry, pkg.path));
    if (files.length === 0) return;
    reads.push({ package: pkg.name, file, line: read.line, form: read.form, target: resolved.target, module: resolved.module, files, tasks });
  };
  for (const pkg of packages) {
    for (const file of trackedDirs.get(pkg.path) ?? []) {
      if (owningPackage(file, packageDirs) !== pkg.path) continue;
      for (const { read, resolved } of readsOf(file)) addRead(pkg, file, read, resolved, CACHEABLE_TASKS);
    }
    // A relative path in the package.json script that runs a task, or in its npm `pre` or `post` hook (for example
    // "prebuild": "node ../../scripts/generate.mjs"), names a file that task runs: it is a module read of that task, so
    // what the file reads is checked too.
    const manifest = `${pkg.path}/package.json`;
    if (!tracked.has(manifest)) continue;
    const text = readFileSync(path.join(root, manifest), "utf8");
    const scripts = JSON.parse(text).scripts ?? {};
    for (const task of CACHEABLE_TASKS) {
      for (const name of [`pre${task}`, task, `post${task}`]) {
        if (typeof scripts[name] !== "string") continue;
        const at = text.indexOf(`${JSON.stringify(name)}:`, Math.max(0, text.indexOf('"scripts"')));
        const read = { line: at === -1 ? 1 : text.slice(0, at).split("\n").length, form: "script" };
        // Shell words, with quoted and backslash-escaped characters kept as part of the word.
        for (const [word] of scripts[name].matchAll(/(?:"(?:[^"\\]|\\.)*"|'[^']*'|\\.|[^\s;&|()<>"'\\])+/g)) {
          const specifier = word.replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'|\\(.)/g, (_, double, single, escaped) => escaped ?? single ?? double.replace(/\\(.)/g, "$1"));
          if (!/^\.\.?\//.test(specifier)) continue;
          const resolved = resolveTarget({ ...read, specifier }, manifest, tracked, trackedDirs);
          if (resolved && resolved.files.length > 0) addRead(pkg, manifest, read, resolved, [task]);
        }
      }
    }
  }
  return { reads, edgesOf };
}

// Checks each read against Turbo's dry run. A file a read names passes when it is a global input, in the task's hashed
// inputs, or in a package whose task the task depends on. What a file outside the reading package goes on to read is
// read too: the guard follows the imports and literal path reads (edgesOf) of each file that a module read names
// (a file a path read names is read, not run), up to a file of the reading package or of a dependency package, and
// checks each file it reaches. Returns { checked, undeclared: [{ taskId, read, missing }] }.
export function checkReads(reads, dryRun, packageDirs, edgesOf = () => []) {
  const tasks = new Map(dryRun.tasks.map((task) => [task.taskId, task]));
  const globalFiles = new Set(Object.keys(dryRun.globalCacheInputs?.files ?? {}));
  const hashed = new Map();
  const hashedFiles = (task) => {
    if (!hashed.has(task.taskId)) {
      hashed.set(task.taskId, new Set(Object.keys(task.inputs ?? {}).map((input) => posix.normalize(posix.join(task.directory, input)))));
    }
    return hashed.get(task.taskId);
  };
  const dependencyDirs = new Map();
  const dependencyPackages = (task) => {
    if (!dependencyDirs.has(task.taskId)) {
      const directories = new Set();
      const queue = [...(task.dependencies ?? [])];
      for (const seen = new Set(); queue.length > 0; ) {
        const id = queue.shift();
        if (seen.has(id) || !tasks.has(id)) continue;
        seen.add(id);
        directories.add(tasks.get(id).directory);
        queue.push(...(tasks.get(id).dependencies ?? []));
      }
      dependencyDirs.set(task.taskId, directories);
    }
    return dependencyDirs.get(task.taskId);
  };
  const missingFor = (task, read) => {
    const missing = [];
    const seen = new Map(); // file -> whether its reads were followed
    const queue = read.files.map((file) => [file, read.module === true]);
    while (queue.length > 0) {
      const [file, follow] = queue.shift();
      if (seen.has(file) && (seen.get(file) || !follow)) continue;
      const first = !seen.has(file);
      seen.set(file, follow);
      if (within(file, task.directory) || dependencyPackages(task).has(owningPackage(file, packageDirs))) continue;
      if (first && !globalFiles.has(file) && !hashedFiles(task).has(file)) missing.push(file);
      if (!follow) continue;
      for (const edge of edgesOf(file)) for (const next of edge.files) queue.push([next, edge.module]);
    }
    return missing;
  };
  const undeclared = [];
  let checked = 0;
  for (const read of reads) {
    for (const name of read.tasks) {
      const task = tasks.get(`${read.package}#${name}`);
      if (!task || task.command === "<NONEXISTENT>" || task.resolvedTaskDefinition?.cache === false) continue;
      checked += 1;
      const missing = missingFor(task, read);
      if (missing.length > 0) undeclared.push({ taskId: task.taskId, read, missing });
    }
  }
  return { checked, undeclared };
}

function parseArgs(argv) {
  const options = { root: fileURLToPath(new URL("..", import.meta.url)), packages: [], turbo: process.env.TURBO_BIN || "", list: false, json: false };
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    if (arg === "--root") options.root = path.resolve(argv[++k]);
    else if (arg === "--package") options.packages.push(argv[++k]);
    else if (arg === "--turbo") options.turbo = path.resolve(argv[++k]);
    else if (arg === "--list") options.list = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  options.turbo ||= path.join(options.root, "node_modules", "turbo", "bin", "turbo");
  return options;
}

export function runGuard(options) {
  if (!existsSync(options.turbo)) {
    throw new Error(`Turbo is not installed at ${options.turbo}; run npm ci, or pass --turbo or TURBO_BIN`);
  }
  // Turbo matches no "$TURBO_ROOT$/…" input when it runs in a root reached through a symlink.
  const root = realpathSync(options.root);
  const all = JSON.parse(runTurbo(root, options.turbo, ["ls", "--output=json"])).packages.items.filter((pkg) => pkg.path && pkg.path !== ".");
  const unknown = options.packages.filter((name) => !all.some((pkg) => pkg.name === name));
  if (unknown.length > 0) throw new Error(`no workspace package named ${unknown.join(", ")}`);
  const selected = options.packages.length > 0 ? all.filter((pkg) => options.packages.includes(pkg.name)) : all;
  const packageDirs = all.map((pkg) => pkg.path);
  const { reads, edgesOf } = findOutsideReads(root, selected, packageDirs);
  if (reads.length === 0) return { reads, checked: 0, undeclared: [] };
  const names = [...new Set(reads.map((read) => read.package))];
  const dryRun = JSON.parse(runTurbo(root, options.turbo, ["run", ...CACHEABLE_TASKS, "--dry=json", ...names.map((name) => `--filter=${name}`)]));
  return { reads, ...checkReads(reads, dryRun, packageDirs, edgesOf) };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = runGuard(options);
  if (options.json) {
    const undeclared = result.undeclared.map(({ taskId, read, missing }) => ({ taskId, file: read.file, line: read.line, form: read.form, target: read.target, missing }));
    process.stdout.write(`${JSON.stringify({ reads: result.reads.map(({ files, ...read }) => read), checked: result.checked, undeclared }, null, 2)}\n`);
  } else {
    if (options.list) {
      for (const read of result.reads) console.log(`${read.package}: ${read.file}:${read.line} (${read.form}) -> ${read.target}`);
    }
    for (const { taskId, read, missing } of result.undeclared) {
      let more = missing.length > 1 ? ` (${missing.length} files, e.g. ${missing[0]})` : "";
      if (missing.length === 1 && missing[0] !== read.target) more = ` (${missing[0]})`;
      console.log(`undeclared: ${taskId} reads ${read.target}${more} at ${read.file}:${read.line} (${read.form})`);
    }
    const summary = `${result.reads.length} outside reads, ${result.checked} task checks, ${result.undeclared.length} undeclared`;
    console.log(
      result.undeclared.length > 0
        ? `turbo-inputs-guard: FAILED: ${summary}. Declare each as "$TURBO_ROOT$/<path>" in the task's inputs, after "$TURBO_DEFAULT$".`
        : `turbo-inputs-guard: ok: ${summary}`
    );
  }
  process.exitCode = result.undeclared.length > 0 ? 1 : 0;
}

// Whether Node runs this file as its entry point. argv[1] keeps the path it was given (a symlinked checkout, or the name
// without its extension) while import.meta.url is the real path, so compare real paths.
function isEntryPoint() {
  if (import.meta.main !== undefined) return import.meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  const self = realpathSync(fileURLToPath(import.meta.url));
  return [entry, `${entry}.mjs`].some((candidate) => {
    try {
      return realpathSync(candidate) === self;
    } catch {
      return false;
    }
  });
}

if (isEntryPoint()) {
  try {
    main();
  } catch (error) {
    console.error(`turbo-inputs-guard: ${error.message}`);
    process.exitCode = 2;
  }
}
