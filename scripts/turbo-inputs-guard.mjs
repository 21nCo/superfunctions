#!/usr/bin/env node
// SFNS-311: Turbo replays a cached task only when nothing it hashes changed, so every file a cacheable task (build,
// typecheck, test, lint) reads from outside its own package must be in that task's hash: a declared input, a global
// input, or a file of a package whose task the task depends on. This guard finds such reads in each workspace package's
// tracked files and asks Turbo (`turbo run … --dry=json`) whether each target is hashed. It never re-implements Turbo's
// globs. It finds a closed set of forms only:
//   1. relative `import`, `export … from`, `require()` and `import()` specifiers;
//   2. string-literal path segments given to path.join, path.resolve, fileURLToPath(new URL(…, import.meta.url)) or
//      new URL(…, import.meta.url), on a base it can resolve (__dirname, import.meta.dirname/url, process.cwd() or a
//      const bound to one of these forms in the same file);
//   3. string-literal `alias` values (and `replacement` entries) in vitest.config.* and vite.config.*; alias values
//      built with form 2 are found as form 2.
// Paths built from other values are computed reads, deferred to SFNS-306. These targets are skipped: one with no
// tracked file (a file the task writes or generates, which no Turbo input can hash), and a directory that holds the
// package itself or any workspace package (a repository, product or package root, used as a base for other paths or
// for module resolution; the files a task reads under it by literal path are found as their own reads).
// A read in a test file (a *.test.* or *.spec.* file, a file under a __tests__, test, tests, e2e, test-support or
// fixtures directory, or a Vitest or Playwright config) must be hashed by the package's test, typecheck and lint
// tasks; any other read by all four cacheable tasks, since the guard cannot tell which task runs the file.
//
// Usage: node scripts/turbo-inputs-guard.mjs [--root <dir>] [--package <name>]... [--turbo <bin>] [--list] [--json]
// Turbo comes from --turbo, then $TURBO_BIN, then <root>/node_modules/turbo/bin/turbo. Exit 1 lists each undeclared
// read; declare it with "$TURBO_ROOT$/<path>" next to "$TURBO_DEFAULT$" in the task's inputs (the package's turbo.json).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const posix = path.posix;
export const CACHEABLE_TASKS = ["build", "typecheck", "test", "lint"];
const SCANNED_FILE = /\.(?:[cm]?[jt]sx?|svelte|vue|astro|mdx)$/;
const CONFIG_FILE = /(?:^|\/)(?:vitest|vite)\.config\.[cm]?[jt]s$/;
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".svelte", ".vue", ".d.ts"];
const PATH_MODULES = new Set(["path", "node:path", "path/posix", "node:path/posix"]);
const URL_MODULES = new Set(["url", "node:url"]);
const PATH_FUNCTIONS = new Set(["join", "resolve", "dirname", "normalize"]);
const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const MULTI_CHAR_PUNCTUATION = ["===", "!==", "...", "=>", "==", "!=", "?.", "??", "&&", "||", "<=", ">="];
const STATEMENT_END = new Set([",", ")", "]", "}", ";"]);
const TEST_FILE =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|e2e|test-support|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:vitest|playwright)(?:\.[\w-]+)?\.config\.[cm]?[jt]s$/;
const TEST_TASKS = ["test", "typecheck", "lint"];

// JavaScript tokens: strings (`str`, with the value of a template that has no substitution), templates with
// substitutions (`tpl`, whose expressions follow as ordinary tokens), identifiers, numbers and punctuation. Comments and
// regular expressions are dropped. A quote string ends at a line break, so a stray apostrophe (JSX text) stays local.
export function tokenize(source) {
  const tokens = [];
  const braces = [];
  let i = 0;
  let line = 1;
  const regexAllowed = () => {
    const previous = tokens.at(-1);
    if (!previous) {
      return true;
    }
    if (previous.type === "id") {
      return REGEX_AFTER.has(previous.value);
    }
    return previous.type === "punc" && ![")", "]", "}"].includes(previous.value);
  };
  // Reads template text from i to its closing backtick or next substitution; true when the template ended.
  const readTemplate = () => {
    let text = "";
    while (i < source.length) {
      const char = source[i];
      if (char === "\\") {
        text += source[i + 1] ?? "";
        line += source[i + 1] === "\n" ? 1 : 0;
        i += 2;
      } else if (char === "`") {
        i += 1;
        return { ended: true, text };
      } else if (char === "$" && source[i + 1] === "{") {
        i += 2;
        braces.push("template");
        return { ended: false, text };
      } else {
        line += char === "\n" ? 1 : 0;
        text += char;
        i += 1;
      }
    }
    return { ended: true, text };
  };
  while (i < source.length) {
    const char = source[i];
    const start = line;
    if (char === "\n") {
      line += 1;
      i += 1;
    } else if (/\s/.test(char)) {
      i += 1;
    } else if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let k = i; k < stop; k += 1) line += source[k] === "\n" ? 1 : 0;
      i = stop;
    } else if (char === "'" || char === '"') {
      let value = "";
      i += 1;
      while (i < source.length && source[i] !== char && source[i] !== "\n") {
        value += source[i] === "\\" ? source[(i += 1)] ?? "" : source[i];
        i += 1;
      }
      i += source[i] === char ? 1 : 0;
      tokens.push({ type: "str", value, line: start });
    } else if (char === "`") {
      i += 1;
      const { ended, text } = readTemplate();
      tokens.push(ended ? { type: "str", value: text, line: start } : { type: "tpl", value: "", line: start });
    } else if (char === "}" && braces.at(-1) === "template") {
      braces.pop();
      i += 1;
      readTemplate();
    } else if (char === "/" && regexAllowed()) {
      let inClass = false;
      i += 1;
      while (i < source.length && source[i] !== "\n" && (inClass || source[i] !== "/")) {
        if (source[i] === "\\") i += 1;
        else if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        i += 1;
      }
      i += 1;
      while (/[a-z]/i.test(source[i] ?? "")) i += 1;
    } else if (char === "#" && i === 0 && source[1] === "!") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (/[\p{ID_Start}_$]/u.test(char) || (char === "#" && /[\p{ID_Start}_$]/u.test(source[i + 1] ?? ""))) {
      const match = /^#?[\p{ID_Continue}$\u200c\u200d]+/u.exec(source.slice(i, i + 256));
      tokens.push({ type: "id", value: match[0], line: start });
      i += match[0].length;
    } else if (/\d/.test(char)) {
      const match = /^[\w.]+/.exec(source.slice(i, i + 64));
      tokens.push({ type: "num", value: match[0], line: start });
      i += match[0].length;
    } else {
      const value = MULTI_CHAR_PUNCTUATION.find((op) => source.startsWith(op, i)) ?? char;
      if (value === "{") braces.push("brace");
      if (value === "}") braces.pop();
      tokens.push({ type: "punc", value: value === "?." ? "." : value, line: start });
      i += value.length;
    }
  }
  return tokens;
}

// The parts of a file that hold code, with every other character blanked so line numbers stay true.
function codeOf(file, source) {
  const blank = (text) => text.replace(/[^\n]/g, " ");
  if (/\.(?:svelte|vue)$/.test(file)) {
    return source.replace(/<script\b[^>]*>([\s\S]*?)<\/script>|[\s\S]/g, (match, script) =>
      script === undefined ? blank(match) : blank(match.slice(0, match.indexOf(">") + 1)) + script + blank("</script>")
    );
  }
  if (file.endsWith(".astro")) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    return front ? `   \n${front[1]}${blank(source.slice(front[0].length - 4))}` : blank(source);
  }
  if (file.endsWith(".mdx")) {
    // Only top-level import and export lines; fenced code blocks are examples, not reads.
    let fenced = false;
    return source
      .split("\n")
      .map((text) => {
        if (/^\s*(?:```|~~~)/.test(text)) {
          fenced = !fenced;
          return "";
        }
        return !fenced && /^(?:import|export)\s/.test(text) ? text : "";
      })
      .join("\n");
  }
  return source;
}

const isId = (token, value) => token?.type === "id" && (value === undefined || token.value === value);
const isPunc = (token, value) => token?.type === "punc" && token.value === value;

// Finds the reads in one file. `file` is the repository-relative path, `packageDir` the package's. Path values are
// absolute in a virtual file system whose root "/" is the repository root. Returns [{ line, form, target }] where the
// target is "/"-rooted; imports also carry `specifier`.
export function findReadsInSource(file, source, packageDir) {
  const tokens = tokenize(codeOf(file, source));
  const fileAbs = `/${file}`;
  const fileDir = posix.dirname(fileAbs);
  const cwd = `/${packageDir}`;
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
      return { value: ok ? { url: resolveUrl(base.url, relative.str) } : null, end };
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
      const target = value?.path ?? value?.url;
      if (target) {
        used.forEach((name) => usedAsBase.add(name));
        bindings.set(tokens[k + 1].value, { value: { path: target } });
        candidates.push({ line: tokens[k + 3].line, form: "path", target, binding: tokens[k + 1].value });
        k = end - 1;
      } else {
        k += 2;
      }
      continue;
    }
    // Form 3: a string-literal alias value in a Vite or Vitest config.
    if (CONFIG_FILE.test(file) && token.type === "str" && /^\.\.?\//.test(token.value) && isAliasValue(tokens, k)) {
      candidates.push({ line: token.line, form: "alias", target: posix.join(fileDir, token.value) });
      continue;
    }
    // Form 2 unbound: path.join(…), path.resolve(…), fileURLToPath(new URL(…)), new URL(…, import.meta.url).
    if (startsPathExpression(k)) {
      const used = new Set();
      const { value, end } = evaluate(k, used);
      const target = value?.path ?? value?.url;
      if (target && !["dirname"].includes(callee(k)?.name)) {
        used.forEach((name) => usedAsBase.add(name));
        candidates.push({ line: token.line, form: "path", target });
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

// True when the string token at k is a value inside an `alias` object or array (a value after `key:`, or an entry's
// `replacement:`), as Vite and Vitest configs write them.
function isAliasValue(tokens, k) {
  if (!isPunc(tokens[k - 1], ":")) return false;
  let depth = 0;
  for (let j = k - 1; j >= 0; j -= 1) {
    const value = tokens[j].type === "punc" ? tokens[j].value : "";
    if (value === "}" || value === "]") depth += 1;
    if (value === "{" || value === "[") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      // The enclosing container: alias: { … } or alias: [ { … } ].
      if (isPunc(tokens[j - 1], ":") && isId(tokens[j - 2], "alias")) return true;
      if (value === "{" && isPunc(tokens[j - 1], "[") && isPunc(tokens[j - 2], ":") && isId(tokens[j - 3], "alias")) {
        return isId(tokens[k - 2], "replacement");
      }
      if (value === "{" && isPunc(tokens[j - 1], ",")) continue; // A later entry of an alias array; keep looking.
      return false;
    }
  }
  return false;
}

// new URL(relative, base) for a file URL base, as a path.
function resolveUrl(base, relative) {
  return posix.resolve(posix.dirname(base), relative.split(/[?#]/)[0]);
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

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
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

// Resolves a read to { target, files } where files are the tracked files it names (a file, or every tracked file under a
// directory); files is empty when nothing tracked is there.
function resolveTarget(read, file, tracked, trackedDirs) {
  let target;
  if (read.specifier !== undefined) {
    if (!/^\.\.?(?:\/|$)/.test(read.specifier)) return null;
    target = posix.join(posix.dirname(file), read.specifier.split("?")[0]);
    const swapped = target.replace(/\.([cm]?)js(x?)$/, ".$1ts$2");
    const candidates = [target, swapped, ...RESOLVE_EXTENSIONS.map((ext) => target + ext), ...RESOLVE_EXTENSIONS.map((ext) => `${target}/index${ext}`)];
    const found = candidates.find((candidate) => tracked.has(candidate));
    if (found && !(trackedDirs.has(target) && tracked.has(`${target}/package.json`))) return { target: found, files: [found] };
  } else {
    target = read.target.slice(1);
  }
  if (target === ".." || target.startsWith("../")) return null;
  if (tracked.has(target)) return { target, files: [target] };
  return { target, files: trackedDirs.get(target) ?? [] };
}

// Every read in the selected packages whose target lies outside the package and holds tracked files.
export function findOutsideReads(root, packages) {
  const trackedList = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const tracked = new Set(trackedList);
  const trackedDirs = new Map();
  for (const file of trackedList) {
    for (let directory = posix.dirname(file); directory !== "."; directory = posix.dirname(directory)) {
      if (!trackedDirs.has(directory)) trackedDirs.set(directory, []);
      trackedDirs.get(directory).push(file);
    }
  }
  const packageDirs = packages.map((pkg) => pkg.path);
  const reads = [];
  for (const pkg of packages) {
    for (const file of trackedDirs.get(pkg.path) ?? []) {
      if (!SCANNED_FILE.test(file) || owningPackage(file, packageDirs) !== pkg.path || !existsSync(path.join(root, file))) continue;
      for (const read of findReadsInSource(file, readFileSync(path.join(root, file), "utf8"), pkg.path)) {
        const resolved = resolveTarget(read, file, tracked, trackedDirs);
        if (!resolved || resolved.files.length === 0 || within(resolved.target, pkg.path)) continue;
        if (packageDirs.some((directory) => within(directory, resolved.target))) continue;
        // A read reaches files of the target that belong to another package; nested packages keep their own files.
        const tasks = TEST_FILE.test(file.slice(pkg.path.length + 1)) ? TEST_TASKS : CACHEABLE_TASKS;
        reads.push({ package: pkg.name, file, line: read.line, form: read.form, target: resolved.target, files: resolved.files, tasks });
      }
    }
  }
  return reads;
}

// Checks each read against Turbo's dry run. Returns { checked, undeclared: [{ taskId, read, missing }] }.
export function checkReads(reads, dryRun, packageDirs) {
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
  const undeclared = [];
  let checked = 0;
  for (const read of reads) {
    for (const name of read.tasks) {
      const task = tasks.get(`${read.package}#${name}`);
      if (!task || task.command === "<NONEXISTENT>" || task.resolvedTaskDefinition?.cache === false) continue;
      checked += 1;
      const missing = read.files.filter(
        (file) => !globalFiles.has(file) && !hashedFiles(task).has(file) && !dependencyPackages(task).has(owningPackage(file, packageDirs))
      );
      if (missing.length > 0) undeclared.push({ taskId: task.taskId, read, missing });
    }
  }
  return { checked, undeclared };
}

function parseArgs(argv) {
  const options = { root: path.resolve(fileURLToPath(new URL("..", import.meta.url))), packages: [], turbo: process.env.TURBO_BIN || "", list: false, json: false };
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
  const all = JSON.parse(runTurbo(options.root, options.turbo, ["ls", "--output=json"])).packages.items;
  const unknown = options.packages.filter((name) => !all.some((pkg) => pkg.name === name));
  if (unknown.length > 0) throw new Error(`no workspace package named ${unknown.join(", ")}`);
  const selected = options.packages.length > 0 ? all.filter((pkg) => options.packages.includes(pkg.name)) : all;
  const reads = findOutsideReads(options.root, selected.filter((pkg) => pkg.path && pkg.path !== "."));
  if (reads.length === 0) return { reads, checked: 0, undeclared: [] };
  const names = [...new Set(reads.map((read) => read.package))];
  const dryRun = JSON.parse(
    runTurbo(options.root, options.turbo, ["run", ...CACHEABLE_TASKS, "--dry=json", ...names.map((name) => `--filter=${name}`)])
  );
  return { reads, ...checkReads(reads, dryRun, all.map((pkg) => pkg.path)) };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = runGuard(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ reads: result.reads.map(({ files, ...read }) => read), checked: result.checked, undeclared: result.undeclared.map(({ taskId, read, missing }) => ({ taskId, file: read.file, line: read.line, form: read.form, target: read.target, missing })) }, null, 2)}\n`);
  } else {
    if (options.list) {
      for (const read of result.reads) console.log(`${read.package}: ${read.file}:${read.line} (${read.form}) -> ${read.target}`);
    }
    for (const { taskId, read, missing } of result.undeclared) {
      const more = missing.length > 1 ? ` (${missing.length} files, e.g. ${missing[0]})` : "";
      console.log(`undeclared: ${taskId} reads ${read.target}${more} at ${read.file}:${read.line} (${read.form})`);
    }
    const summary = `${result.reads.length} outside reads, ${result.checked} task checks, ${result.undeclared.length} undeclared`;
    console.log(result.undeclared.length > 0 ? `turbo-inputs-guard: FAILED: ${summary}. Declare each as "$TURBO_ROOT$/<path>" in the task's inputs, after "$TURBO_DEFAULT$".` : `turbo-inputs-guard: ok: ${summary}`);
  }
  process.exitCode = result.undeclared.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`turbo-inputs-guard: ${error.message}`);
    process.exitCode = 2;
  }
}
