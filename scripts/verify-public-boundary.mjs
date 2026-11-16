#!/usr/bin/env node
// Public boundary (leak guard, SFNS-125): fails when the public repository's tree holds something the public
// manifest does not allow. Every finding names the file and the rule it breaks:
//   top-level-path     every tracked top-level directory and root file is listed in superfunctions.owners.json.
//   public-release     every release-packages.json entry and every Python project is public-owned: its slug or
//                      project is listed as public and its path lies under a listed top-level directory.
//   workspace-package  every root workspace package has a name, the name belongs to exactly one workspace, and its
//                      directory lies under a listed top-level directory. A tracked submodule at a workspace match
//                      or an ancestor of one fails; a tracked symlink there passes only when it points to a file, or
//                      to an in-repository directory whose tracked subtree has no package.json that is a workspace
//                      match through the link and no tracked symlink or submodule at all (nothing is followed
//                      recursively), so npm cannot read a package this check does not inventory.
//   fn-dependency      no source file imports, and no package.json depends on (including npm aliases in
//                      dependency fields and overrides), a `*fn` package (`@<name>fn/<pkg>` or bare `<name>fn`) that
//                      is neither a public workspace package nor pinned in scripts/public-boundary.allow.json.
// Every tracked path counts, including symlinks and submodules (gitlinks); a symlinked file is read through its link
// when it resolves to a regular file inside the repository, and is otherwise a finding, as is a source file that does
// not parse. Imports are read from each file's syntax tree (TypeScript for JS/TS modules, svelte/compiler for
// .svelte, parse5 for .html, micromark's MDX extension for .mdx), so comments, strings, Markdown prose and fenced
// code are not checked; the module loader calls read are listed under "Module loaders" below. Python files are read
// with Python's ast module: an absolute `import <name>fn`, `from <name>fn import`, or a literal absolute dynamic import
// (`__import__` or importlib's import_module, through the closed set of bindings listed at PYTHON_IMPORTS) must name a
// public Python project or an allowed package.
// Usage: node scripts/verify-public-boundary.mjs [--root <checkout>]

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OwnersError, PUBLIC_MANIFEST, REPO_ROOT, createOwners, readManifest } from "./owners.mjs";
import { gitBinary } from "./verify-package-lockfiles.mjs";
import { RELEASE_FILES, readPythonProjects, readReleaseEntries } from "./verify-owners.mjs";

export const ALLOW_FILE = "scripts/public-boundary.allow.json";
export const RULES = Object.freeze({
  topLevelPath: "top-level-path",
  publicRelease: "public-release",
  workspacePackage: "workspace-package",
  fnDependency: "fn-dependency",
});

export class BoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = "BoundaryError";
  }
}

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const finding = (file, rule, message) => ({ file, rule, message });

/** The `file: [rule] message` line a finding prints as. */
export const formatFinding = ({ file, rule, message }) => `${file}: [${rule}] ${message}`;

function compareStrings(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// `*fn` package names

const SCOPED_FN = /^@[a-z0-9][a-z0-9._~-]*fn\/[a-z0-9._~-]+$/i;
const BARE_FN = /^[a-z0-9][a-z0-9._~-]*fn$/i;

/**
 * Package name of a module specifier (`@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`), or null for a
 * relative, absolute, URL, other protocol (`node:`, `https:`) or package-internal (`#x`) specifier. `npm:` and `jsr:`
 * specifiers name a package: the prefix and any `@<version>` are dropped (`npm:@scope/name@1/sub` -> `@scope/name`).
 * A bundler query or fragment (`name?raw`, `name#hash`) is dropped, and a loader request (`loader!name`) names the
 * module after its last `!` (see packageNamesOf for the loaders themselves).
 * @param {string} specifier
 */
export function packageNameOf(specifier) {
  if (typeof specifier !== "string") return null;
  const request = specifier.slice(specifier.lastIndexOf("!") + 1);
  const registry = /^(?:npm|jsr):\/?/i.exec(request);
  const unprefixed = registry ? request.slice(registry[0].length) : request;
  if (/^[./#]/.test(unprefixed)) return null;
  const spec = unprefixed.replace(/[?#][\s\S]*$/, "");
  if (spec === "" || spec.includes(":") || spec.includes("\\")) return null;
  const segments = spec.split("/");
  const withoutVersion = (segment) => segment.split("@")[0];
  if (spec.startsWith("@")) {
    const name = segments.length >= 2 ? withoutVersion(segments[1]) : "";
    return name === "" || segments[0] === "@" ? null : `${segments[0]}/${name}`;
  }
  const name = withoutVersion(segments[0]);
  return name === "" ? null : name;
}

/**
 * Every package a specifier loads: the module and, for a loader request (`a-loader?x!b-loader!name`), each loader.
 * @param {string} specifier
 */
export function packageNamesOf(specifier) {
  if (typeof specifier !== "string") return [];
  // `-!`, `!!` and `!` prefixes only choose which configured loaders run.
  const request = specifier.replace(/^(?:-!|!!?)/, "");
  const names = request.split("!").map((part) => packageNameOf(part)).filter((name) => name !== null);
  return [...new Set(names)];
}

/** True for a scoped `@<name>fn/<pkg>` or bare `<name>fn` package name (matched case-insensitively). */
export function isFnPackage(name) {
  return typeof name === "string" && (SCOPED_FN.test(name) || BARE_FN.test(name));
}

// ---------------------------------------------------------------------------------------------------------------
// Allow file

/**
 * Parses scripts/public-boundary.allow.json:
 * `{ "version": 1, "packages": { "<*fn package>": { "reason": "...", "paths"?: ["<dir>", ...] } } }`.
 * Each entry is an external `*fn` package public code may depend on, with the reason it is allowed. `paths`, when
 * present, limits the entry to files under those repository-relative directories (for a name that is only a local
 * alias there, such as a bundler alias or an npm alias).
 * @returns {Map<string, { reason: string, paths: string[] | null }>}
 */
export function parseAllowFile(data, file = ALLOW_FILE) {
  const fail = (message) => new BoundaryError(`${file}: ${message}`);
  if (!isPlainObject(data)) throw fail("must be a JSON object");
  for (const key of Object.keys(data)) {
    if (key !== "version" && key !== "packages") throw fail(`unknown key ${JSON.stringify(key)}`);
  }
  if (data.version !== 1) throw fail(`version must be 1, not ${JSON.stringify(data.version)}`);
  if (!isPlainObject(data.packages)) throw fail("packages must be an object");
  const allowed = new Map();
  for (const [name, entry] of Object.entries(data.packages)) {
    if (!isFnPackage(name)) throw fail(`packages.${name} is not a *fn package name (@<name>fn/<pkg> or <name>fn)`);
    if (!isPlainObject(entry)) throw fail(`packages.${name} must be an object with a reason`);
    for (const key of Object.keys(entry)) {
      if (key !== "reason" && key !== "paths") throw fail(`unknown key ${JSON.stringify(key)} in packages.${name}`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") throw fail(`packages.${name} needs a non-empty reason`);
    let paths = null;
    if (entry.paths !== undefined) {
      if (!Array.isArray(entry.paths) || entry.paths.length === 0) throw fail(`packages.${name}.paths must be a non-empty array`);
      paths = entry.paths.map((dir) => {
        const valid =
          typeof dir === "string" && dir !== "" && !dir.includes("\\") && !dir.endsWith("/") && path.posix.normalize(dir) === dir && !dir.startsWith("/") && dir !== "." && dir !== ".." && !dir.startsWith("../");
        if (!valid) throw fail(`packages.${name}.paths entry ${JSON.stringify(dir)} must be a normalized repository-relative directory`);
        return dir;
      });
    }
    allowed.set(name, { reason: entry.reason, paths });
  }
  return allowed;
}

/** True when an allow entry applies to a file: it has no paths, or the file lies under one of them. */
export function allowEntryApplies(entry, file) {
  return entry.paths === null || entry.paths.some((dir) => file.startsWith(`${dir}/`));
}

export function readAllowFile(root) {
  let source;
  try {
    source = readFileSync(path.join(root, ALLOW_FILE), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new BoundaryError(`${ALLOW_FILE} not found`);
    throw error;
  }
  let data;
  try {
    data = JSON.parse(source);
  } catch (error) {
    throw new BoundaryError(`${ALLOW_FILE}: invalid JSON: ${error.message}`);
  }
  return parseAllowFile(data);
}

// ---------------------------------------------------------------------------------------------------------------
// Workspaces

/** Root `workspaces` patterns (array or `{ packages }` form). */
export function workspacePatterns(rootPackage) {
  const value = rootPackage?.workspaces;
  if (value === undefined) return [];
  const patterns = Array.isArray(value) ? value : value?.packages;
  if (!Array.isArray(patterns) || !patterns.every((pattern) => typeof pattern === "string" && pattern !== "")) {
    throw new BoundaryError("package.json: workspaces must be an array of non-empty patterns");
  }
  for (const pattern of patterns) {
    // Only literal segments and `*` within a segment are used; anything else is refused rather than misread.
    const segments = pattern.split("/");
    if (/[!?{}[\]()|+@\\]|\*\*/.test(pattern) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new BoundaryError(`package.json: workspace pattern ${JSON.stringify(pattern)} uses syntax this check does not read`);
    }
  }
  return patterns;
}

function segmentPattern(segment) {
  const body = segment.split("*").map((part) => part.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  return new RegExp(`^${segment.startsWith("*") ? "(?!\\.)" : ""}${body}$`);
}

/** True when an npm workspace pattern (literal segments and `*`) matches a directory. */
export function matchesWorkspace(pattern, directory) {
  const patternSegments = pattern.split("/");
  const segments = directory.split("/");
  return patternSegments.length === segments.length && patternSegments.every((segment, index) => segmentPattern(segment).test(segments[index]));
}

/**
 * True when a directory is a workspace match of a pattern or an ancestor of one: it matches the pattern's first
 * segments (all of them, or fewer when the pattern goes deeper). npm expands a pattern through such a directory.
 */
export function reachesWorkspace(pattern, directory) {
  const patternSegments = pattern.split("/");
  const segments = directory.split("/");
  return segments.length <= patternSegments.length && segments.every((segment, index) => segmentPattern(patternSegments[index]).test(segment));
}

/** Workspace package directories: directories of tracked package.json files (outside node_modules) a pattern matches. */
export function workspaceDirectories(patterns, files) {
  return files
    .filter((file) => file.endsWith("/package.json"))
    .map((file) => file.slice(0, -"/package.json".length))
    .filter((directory) => !directory.split("/").includes("node_modules"))
    .filter((directory) => patterns.some((pattern) => matchesWorkspace(pattern, directory)))
    .sort(compareStrings);
}

// ---------------------------------------------------------------------------------------------------------------
// Imports

let parsers;
/**
 * The syntax parsers imports are read with, each a pinned root devDependency: TypeScript (JS/TS modules),
 * svelte/compiler (.svelte), parse5 (.html) and micromark's MDX extension with its mdast utilities (.mdx).
 */
export async function loadParsers() {
  if (parsers) return parsers;
  const load = async (specifier) => {
    try {
      return await import(specifier);
    } catch (error) {
      throw new BoundaryError(`${specifier} is not installed (${error.code ?? error.message}); run npm ci before this check`);
    }
  };
  const [ts, svelte, parse5, markdown, mdxjs, mdxMarkdown] = await Promise.all([
    load("typescript"),
    load("svelte/compiler"),
    load("parse5"),
    load("mdast-util-from-markdown"),
    load("micromark-extension-mdxjs"),
    load("mdast-util-mdx"),
  ]);
  parsers = {
    ts: ts.default ?? ts,
    svelte,
    parse5,
    mdx: (source) => markdown.fromMarkdown(source, { extensions: [mdxjs.mdxjs()], mdastExtensions: [mdxMarkdown.mdxFromMarkdown()] }),
  };
  return parsers;
}

const MODULE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const SOURCE_EXTENSIONS = new Set([...MODULE_EXTENSIONS, ".svelte", ".html", ".mdx"]);

/** True for a file whose imports this check reads. */
export function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(path.posix.extname(file).toLowerCase());
}

/** A file this check cannot parse; reported as a finding, never skipped. */
export class SourceParseError extends Error {
  constructor(message, line) {
    super(message);
    this.name = "SourceParseError";
    this.line = line;
  }
}

function lineAt(source, offset) {
  let line = 1;
  for (let index = source.indexOf("\n"); index !== -1 && index < offset; index = source.indexOf("\n", index + 1)) line += 1;
  return line;
}

function scriptKind(ts, extension) {
  switch (extension) {
    case ".ts":
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}

// Module loaders (the complete set of call forms whose literal first argument is read as a module specifier):
//   import("x")                       dynamic import
//   require("x"), require.resolve("x")
//   import.meta.resolve("x")
//   createRequire(...)("x"), createRequire(...).resolve("x"), and the same through module.createRequire(...) or any
//                                     `<expr>.createRequire(...)`, or a name imported as createRequire from "module" or
//                                     "node:module"
//   module.require("x"), require.main.require("x") (Module#require), and their .resolve
//   r("x"), r.resolve("x"), res("x") where an identifier r (or res) is bound anywhere in the same file to one of the
//                                     loaders above (require, Module#require, a createRequire(...) result, or such a
//                                     loader's .resolve), by a const/let/var declarator or a plain `=` assignment, or
//                                     by object destructuring: { require: r } from module or require.main,
//                                     { main: m } from require, { resolve: res } from a require loader, { createRequire: c } from the "module" /
//                                     "node:module" namespace (a namespace or default import, require("module"),
//                                     import("module") with or without await, or a name bound to one of those)
// A callee is read through parentheses, `as`, `satisfies`, `<T>` assertions and `!`, and `x["resolve"]` reads as
// `x.resolve`. Bindings are file-wide, not scoped, so a shadowed name still counts. Not read: computed specifiers;
// loaders passed across functions, objects or files, or reached through other names (`globalThis.require`,
// `process.mainModule`, `Module._load`); test-runner module helpers (vi.importActual, vi.importMock, vi.mock,
// jest.requireActual, jest.requireMock, jest.mock), which load modules the test's package already depends on.
// package.json dependencies stay the backstop for everything not read.
const LOADER_MODULES = new Set(["module", "node:module"]);

/**
 * Recognises loader callees for one file, given an adapter over its syntax tree (TypeScript or ESTree): the adapter
 * strips transparent wrappers and exposes identifiers, member accesses, calls, `import.meta` and bindings.
 */
function loaderRecognizer(adapter) {
  const requireNames = new Set(["require"]);
  const resolveNames = new Set();
  const createRequireNames = new Set(["createRequire"]);
  const moduleObjectNames = new Set(["module"]);
  const namespaceNames = new Set();
  const isCreateRequire = (node) => {
    const expression = adapter.unwrap(node);
    const name = adapter.identifier(expression);
    if (name !== null) return createRequireNames.has(name);
    return adapter.member(expression)?.name === "createRequire";
  };
  // A CommonJS module object: `module`, `require.main`, or a name bound to one.
  const isModuleObject = (node) => {
    const expression = adapter.unwrap(node);
    const name = adapter.identifier(expression);
    if (name !== null) return moduleObjectNames.has(name);
    const member = adapter.member(expression);
    return member?.name === "main" && isRequire(member.object);
  };
  const isRequire = (node) => {
    const expression = adapter.unwrap(node);
    const name = adapter.identifier(expression);
    if (name !== null) return requireNames.has(name);
    const member = adapter.member(expression);
    if (member) return member.name === "require" && isModuleObject(member.object);
    const call = adapter.call(expression);
    return call !== null && isCreateRequire(call.callee);
  };
  // The "module" / "node:module" namespace: require("module"), import("module") (awaited or not), `.default` of one,
  // or a name bound to one (including namespace and default imports).
  const isModuleNamespace = (node) => {
    const expression = adapter.unwrap(adapter.awaited(adapter.unwrap(node)));
    const name = adapter.identifier(expression);
    if (name !== null) return namespaceNames.has(name);
    const member = adapter.member(expression);
    if (member) return member.name === "default" && isModuleNamespace(member.object);
    const imported = adapter.dynamicImport(expression);
    if (imported !== null) return LOADER_MODULES.has(imported);
    const call = adapter.call(expression);
    return call !== null && isRequire(call.callee) && LOADER_MODULES.has(call.specifier);
  };
  const isResolve = (node) => {
    const expression = adapter.unwrap(node);
    const name = adapter.identifier(expression);
    if (name !== null) return resolveNames.has(name);
    const member = adapter.member(expression);
    return member?.name === "resolve" && (isRequire(member.object) || adapter.isImportMeta(adapter.unwrap(member.object)));
  };
  return {
    /**
     * Learns the file's loader bindings: `{ name, init }` for `name = init`, `{ name, init, key }` for
     * `{ key: name } = init`, `{ alias }` for a createRequire import alias and `{ namespace }` for a namespace or
     * default import of "module" / "node:module".
     */
    learn(bindings) {
      for (const binding of bindings) {
        if (binding.alias !== undefined) createRequireNames.add(binding.alias);
        if (binding.namespace !== undefined) namespaceNames.add(binding.namespace);
      }
      const values = bindings.filter((binding) => binding.init !== undefined);
      // What a destructured key binds, given the value it is read from.
      const keyed = {
        require: [[requireNames, isModuleObject]],
        resolve: [[resolveNames, isRequire]],
        createRequire: [[createRequireNames, isModuleNamespace]],
        main: [[moduleObjectNames, isRequire]],
      };
      const plain = [
        [requireNames, isRequire],
        [resolveNames, isResolve],
        [createRequireNames, isCreateRequire],
        [moduleObjectNames, isModuleObject],
        [namespaceNames, isModuleNamespace],
      ];
      // Repeat until stable, so a binding to an earlier binding (`const a = createRequire(u); const b = a;`) counts.
      for (let changed = true; changed; ) {
        changed = false;
        for (const { name, init, key } of values) {
          const sets = key === undefined ? plain : Object.hasOwn(keyed, key) ? keyed[key] : [];
          for (const [names, test] of sets) {
            if (!names.has(name) && test(init)) {
              names.add(name);
              changed = true;
            }
          }
        }
      }
    },
    isLoaderCallee: (callee) => adapter.isImportKeyword(callee) || isRequire(callee) || isResolve(callee),
  };
}

function tsUnwrap(ts, node) {
  let expression = node;
  while (
    expression &&
    (ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression))
  ) {
    expression = expression.expression;
  }
  return expression;
}

function tsLoaderAdapter(ts) {
  const unwrap = (node) => tsUnwrap(ts, node);
  return {
    unwrap,
    identifier: (node) => (node && ts.isIdentifier(node) ? node.text : null),
    member(node) {
      if (!node) return null;
      if (ts.isPropertyAccessExpression(node)) return { object: node.expression, name: node.name.text };
      if (ts.isElementAccessExpression(node)) {
        const key = unwrap(node.argumentExpression);
        return key && ts.isStringLiteralLike(key) ? { object: node.expression, name: key.text } : null;
      }
      return null;
    },
    call(node) {
      if (!node || !ts.isCallExpression(node)) return null;
      const argument = unwrap(node.arguments[0]);
      return { callee: node.expression, specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : null };
    },
    awaited: (node) => (node && ts.isAwaitExpression(node) ? node.expression : node),
    dynamicImport(node) {
      if (!node || !ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
      const argument = unwrap(node.arguments[0]);
      return argument && ts.isStringLiteralLike(argument) ? argument.text : null;
    },
    isImportMeta: (node) => Boolean(node) && ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "meta",
    isImportKeyword: (node) => node?.kind === ts.SyntaxKind.ImportKeyword,
  };
}

/** Static text of a TypeScript property name (identifier, string literal or computed string literal), or null. */
function tsPropertyKey(ts, name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const key = tsUnwrap(ts, name.expression);
    return key && ts.isStringLiteralLike(key) ? key.text : null;
  }
  return null;
}

/** Loader bindings (plain and destructured) and "module" import aliases of a TypeScript syntax tree. */
function tsLoaderBindings(ts, sourceFile) {
  const bindings = [];
  const keyed = (key, local, init) => {
    const target = local && ts.isBinaryExpression(local) && local.operatorToken.kind === ts.SyntaxKind.EqualsToken ? local.left : local;
    const name = tsUnwrap(ts, target);
    if (key !== null && name && ts.isIdentifier(name)) bindings.push({ name: name.text, init, key });
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) bindings.push({ name: node.name.text, init: node.initializer });
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!element.dotDotDotToken) keyed(tsPropertyKey(ts, element.propertyName ?? element.name), element.name, node.initializer);
        }
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = tsUnwrap(ts, node.left);
      if (ts.isIdentifier(left)) bindings.push({ name: left.text, init: node.right });
      else if (ts.isObjectLiteralExpression(left)) {
        for (const property of left.properties) {
          if (ts.isShorthandPropertyAssignment(property)) keyed(property.name.text, property.name, node.right);
          else if (ts.isPropertyAssignment(property)) keyed(tsPropertyKey(ts, property.name), property.initializer, node.right);
        }
      }
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && LOADER_MODULES.has(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) bindings.push({ namespace: clause.name.text });
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) bindings.push({ namespace: named.name.text });
      else if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) if ((element.propertyName ?? element.name).text === "createRequire") bindings.push({ alias: element.name.text });
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      LOADER_MODULES.has(node.moduleReference.expression.text)
    ) {
      bindings.push({ namespace: node.name.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

/**
 * Module specifiers of JS/TS code, from TypeScript's syntax tree: `import`/`export ... from`, `import()` types,
 * `import x = require()`, `/// <reference types>` and calls to the module loaders listed above. Offsets are into
 * `code`.
 */
function tsSpecifiers(ts, file, code, kind) {
  const sourceFile = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
  const [diagnostic] = sourceFile.parseDiagnostics ?? [];
  if (diagnostic) {
    throw new SourceParseError(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "), lineAt(code, diagnostic.start ?? 0));
  }
  const found = [];
  const add = (node) => {
    // Parentheses, `as`, `satisfies`, `<T>` assertions and `!` do not change the module a literal names.
    const literal = tsUnwrap(ts, node);
    if (literal && ts.isStringLiteralLike(literal)) found.push({ specifier: literal.text, offset: literal.getStart(sourceFile) });
  };
  const loaders = loaderRecognizer(tsLoaderAdapter(ts));
  loaders.learn(tsLoaderBindings(ts, sourceFile));
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ts.isCallExpression(node) && loaders.isLoaderCallee(node.expression)) add(node.arguments[0]);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const reference of sourceFile.typeReferenceDirectives) found.push({ specifier: reference.fileName, offset: reference.pos });
  return found;
}

const ESTREE_WRAPPERS = new Set(["ParenthesizedExpression", "TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion", "TSNonNullExpression", "ChainExpression"]);

function estreeUnwrap(node) {
  let expression = node;
  while (ESTREE_WRAPPERS.has(expression?.type)) expression = expression.expression;
  return expression;
}

function stringLiteral(node) {
  if (ESTREE_WRAPPERS.has(node?.type)) return stringLiteral(node.expression);
  if (node?.type === "Literal" && typeof node.value === "string") return node;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return { value: node.quasis[0].value.cooked, start: node.start, loc: node.loc };
  if (node?.type === "TSLiteralType") return stringLiteral(node.literal);
  return null;
}

const ESTREE_LOADER_ADAPTER = {
  unwrap: estreeUnwrap,
  identifier: (node) => (node?.type === "Identifier" ? node.name : null),
  member(node) {
    if (node?.type !== "MemberExpression") return null;
    if (!node.computed) return node.property?.type === "Identifier" || node.property?.type === "PrivateIdentifier" ? { object: node.object, name: node.property.name } : null;
    const key = stringLiteral(node.property);
    return key ? { object: node.object, name: key.value } : null;
  },
  call: (node) => (node?.type === "CallExpression" ? { callee: node.callee, specifier: stringLiteral(node.arguments[0])?.value ?? null } : null),
  awaited: (node) => (node?.type === "AwaitExpression" ? node.argument : node),
  dynamicImport: (node) => (node?.type === "ImportExpression" ? (stringLiteral(node.source)?.value ?? null) : null),
  isImportMeta: (node) => node?.type === "MetaProperty" && node.meta?.name === "import" && node.property?.name === "meta",
  isImportKeyword: () => false,
};

/** Every ESTree node of a tree (skipping parent links and nodes already visited), depth first. */
function walkEstree(tree, callback) {
  const seen = new WeakSet();
  const visit = (node) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node.type === "string") callback(node);
    for (const [key, child] of Object.entries(node)) if (key !== "parent") visit(child);
  };
  visit(tree);
}

/** Loader bindings (plain and destructured) and "module" import aliases of an ESTree tree. */
function estreeLoaderBindings(tree) {
  const bindings = [];
  const bind = (target, init) => {
    const pattern = estreeUnwrap(target);
    if (pattern?.type === "Identifier") bindings.push({ name: pattern.name, init });
    else if (pattern?.type === "ObjectPattern") {
      for (const property of pattern.properties ?? []) {
        if (property.type !== "Property") continue;
        const key = property.computed ? stringLiteral(property.key)?.value : (property.key?.name ?? stringLiteral(property.key)?.value);
        const value = property.value?.type === "AssignmentPattern" ? property.value.left : property.value;
        if (typeof key === "string" && value?.type === "Identifier") bindings.push({ name: value.name, init, key });
      }
    }
  };
  walkEstree(tree, (node) => {
    if (node.type === "VariableDeclarator" && node.init) bind(node.id, node.init);
    else if (node.type === "AssignmentExpression" && node.operator === "=") bind(node.left, node.right);
    else if (node.type === "ImportDeclaration" && LOADER_MODULES.has(stringLiteral(node.source)?.value)) {
      for (const specifier of node.specifiers ?? []) {
        const imported = specifier.imported?.name ?? specifier.imported?.value;
        if (specifier.type === "ImportSpecifier" && imported === "createRequire") bindings.push({ alias: specifier.local.name });
        else if (specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ImportDefaultSpecifier") bindings.push({ namespace: specifier.local.name });
      }
    }
  });
  return bindings;
}

/** Module specifiers of every ESTree node in a tree (Svelte and MDX syntax trees carry their code as ESTree). */
function estreeSpecifiers(tree) {
  const found = [];
  const loaders = loaderRecognizer(ESTREE_LOADER_ADAPTER);
  loaders.learn(estreeLoaderBindings(tree));
  const seen = new WeakSet();
  const add = (node) => {
    const literal = stringLiteral(node);
    if (literal) found.push({ specifier: literal.value, offset: literal.start, line: literal.loc?.start?.line });
  };
  const visit = (node) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration":
      case "ImportExpression":
        add(node.source);
        break;
      case "CallExpression":
        if (loaders.isLoaderCallee(node.callee)) add(node.arguments[0]);
        break;
      case "TSImportType":
        add(node.argument ?? node.parameter);
        break;
      case "TSExternalModuleReference":
        add(node.expression);
        break;
      default:
    }
    for (const [key, child] of Object.entries(node)) if (key !== "parent") visit(child);
  };
  visit(tree);
  return found;
}

/** Specifiers of code embedded in a larger file at `offset`, with offsets and parse error lines into the file. */
function embeddedSpecifiers(ts, file, source, code, offset, kind) {
  try {
    return tsSpecifiers(ts, file, code, kind).map((item) => ({ specifier: item.specifier, offset: offset + item.offset }));
  } catch (error) {
    if (error instanceof SourceParseError) throw new SourceParseError(error.message, lineAt(source, offset) + (error.line ?? 1) - 1);
    throw error;
  }
}

// The JavaScript MIME type essences of the WHATWG HTML standard, plus the TypeScript types tooling compiles.
const JAVASCRIPT_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);
const TYPESCRIPT_TYPES = new Set(["text/typescript", "application/typescript", "ts"]);

/**
 * How a `<script>` element's body is read, from its `type` and legacy `language` attributes as the HTML standard
 * defines its type string (case-insensitive, parameters ignored): a TypeScript ScriptKind for script, or null for a
 * data block (JSON, templates and other non-script types).
 * @param {{ name: string, value: string }[]} attributes
 */
function scriptElementKind(ts, attributes) {
  const value = (name) => attributes.find((attribute) => attribute.name.toLowerCase() === name)?.value;
  const type = value("type");
  const language = value("language");
  let typeString;
  if (type === "" || (type === undefined && (language === undefined || language === ""))) typeString = "text/javascript";
  else if (type !== undefined) typeString = type;
  else typeString = `text/${language}`;
  const essence = typeString.split(";")[0].trim().toLowerCase();
  if (essence === "module" || JAVASCRIPT_TYPES.has(essence)) return ts.ScriptKind.JS;
  if (TYPESCRIPT_TYPES.has(essence)) return ts.ScriptKind.TS;
  return null;
}

/** `<script>` bodies and inline `on*` handlers of an HTML document, from parse5's tree (comments are not code). */
function htmlSpecifiers({ ts, parse5 }, file, source) {
  const found = [];
  const fromCode = (code, offset, kind) => found.push(...embeddedSpecifiers(ts, file, source, code, offset, kind));
  // HTML has no parse failure: parse5 recovers from malformed markup the way a browser does.
  const document = parse5.parse(source, { sourceCodeLocationInfo: true });
  const visit = (node) => {
    for (const attribute of node.attrs ?? []) {
      if (/^on/i.test(attribute.name)) fromCode(attribute.value, node.sourceCodeLocation?.attrs?.[attribute.name]?.startOffset ?? 0, ts.ScriptKind.JS);
    }
    if (node.nodeName === "script") {
      const kind = scriptElementKind(ts, node.attrs);
      const text = node.childNodes?.[0];
      if (kind !== null && text?.nodeName === "#text") fromCode(text.value, text.sourceCodeLocation.startOffset, kind);
    }
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content) visit(node.content);
  };
  visit(document);
  return found;
}

/**
 * Module specifiers of a Svelte component: its instance and module scripts and template expressions (ESTree), and
 * the bodies of `<script>` elements inside the markup (such as in `<svelte:head>`), which Svelte keeps as raw text.
 */
function svelteSpecifiers({ ts, svelte }, file, source) {
  let tree;
  try {
    tree = svelte.parse(source, { modern: true });
  } catch (error) {
    throw new SourceParseError(String(error.message).split("\n")[0], error.start?.line ?? error.position?.[0]?.line);
  }
  const found = estreeSpecifiers(tree);
  const seen = new WeakSet();
  const visit = (node) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    // A static `on*` attribute is rendered as written, so the browser runs it as an inline handler (as in .html).
    if (node.type === "RegularElement" || node.type === "SvelteElement") {
      for (const attribute of node.attributes ?? []) {
        const parts = Array.isArray(attribute.value) ? attribute.value : [];
        if (attribute.type !== "Attribute" || !/^on/i.test(attribute.name) || parts.length === 0 || !parts.every((part) => part.type === "Text")) continue;
        found.push(...embeddedSpecifiers(ts, file, source, parts.map((part) => part.data).join(""), parts[0].start, ts.ScriptKind.JS));
      }
    }
    if (node.type === "RegularElement" && node.name === "script") {
      const attributes = node.attributes
        .filter((attribute) => attribute.type === "Attribute")
        .map((attribute) => ({
          name: attribute.name,
          value: attribute.value === true ? "" : [attribute.value].flat().map((part) => (part.type === "Text" ? part.data : "")).join(""),
        }));
      const kind = scriptElementKind(ts, attributes);
      const text = node.fragment?.nodes?.[0];
      if (kind !== null && text?.type === "Text") {
        found.push(...embeddedSpecifiers(ts, file, source, text.data, text.start, kind));
      }
    }
    for (const [key, child] of Object.entries(node)) if (key !== "parent") visit(child);
  };
  visit(tree.fragment);
  return found;
}

/** Blanks a leading YAML frontmatter block (keeping offsets and lines), which MDX itself would read as Markdown. */
function blankFrontmatter(source) {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  return match ? match[0].replaceAll(/[^\n]/g, " ") + source.slice(match[0].length) : source;
}

function mdxSpecifiers({ mdx }, source) {
  let tree;
  try {
    tree = mdx(blankFrontmatter(source));
  } catch (error) {
    throw new SourceParseError(String(error.reason ?? error.message).split("\n")[0], error.line ?? error.place?.line ?? error.place?.start?.line);
  }
  return estreeSpecifiers(tree);
}

/**
 * Module specifiers a source file imports, each with its 1-based line, read from the file's syntax tree: module code
 * of JS/TS files, script and template expressions of .svelte files, `<script>` elements and inline handlers of .html
 * files, and ESM blocks and expressions of .mdx files. Comments, strings, Markdown prose and fenced code are not code.
 * Throws a SourceParseError when the file cannot be parsed.
 * @param {string} file repository-relative path, used to pick how the file is read
 * @param {string} source
 * @param {Awaited<ReturnType<typeof loadParsers>>} parsed parsers from loadParsers()
 */
export function importSpecifiers(file, source, parsed) {
  const extension = path.posix.extname(file).toLowerCase();
  let found;
  if (MODULE_EXTENSIONS.has(extension)) found = tsSpecifiers(parsed.ts, file, source, scriptKind(parsed.ts, extension));
  else if (extension === ".svelte") found = svelteSpecifiers(parsed, file, source);
  else if (extension === ".html") found = htmlSpecifiers(parsed, file, source);
  else if (extension === ".mdx") found = mdxSpecifiers(parsed, source);
  else return [];
  return found
    .map(({ specifier, offset, line }) => ({ specifier, line: line ?? lineAt(source, offset) }))
    .sort((left, right) => left.line - right.line);
}

// ---------------------------------------------------------------------------------------------------------------
// Python imports

// Reads absolute paths (NUL-separated) on stdin and prints, per file, its absolute `import x` / `from x import`
// modules and literal dynamic imports with their lines, or the syntax error that stopped it. Relative imports name no
// package. Dynamic imports are a closed set; bindings are file-wide and learned to a fixpoint:
//   loaders   `__import__`; `<m>.import_module` for a namespace m; a name bound by `from importlib import
//             import_module [as f]` or `from importlib import *` (binds import_module); and a name bound by a simple
//             assignment (`f = <loader>`, also annotated or `:=`) to any loader, `<m>.import_module` included.
//   namespace `import importlib`, `import importlib.<sub>`, `import importlib as m`, or `m = <namespace>`.
//   name      the first positional argument or `name=`, a non-empty string literal; one starting with "." is relative.
//   level     `__import__` only (5th positional or `level=`): the call is relative, and not checked, only when its
//             level is a literal (`ast.literal_eval`: `1`, `True`, `+2`) whose value is an int > 0. Every other call
//             is checked as absolute: no level, a zero level (`0`, `False`, `-0`), and a level that is not a literal
//             or may come from *args/**kwargs.
// Not read: computed names, loaders passed across functions, objects or modules, `getattr(importlib, ...)`,
// `builtins.__import__`, `importlib.__import__`, tuple-unpacking assignments and a loader rebound to something else
// (a name once bound to a loader stays one for the whole file).
const PYTHON_IMPORTS = String.raw`
import ast, json, sys

def literal_name(node):
    return isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value and not node.value.startswith(".")

def keyword(call, name):
    return next((item.value for item in call.keywords if item.arg == name), None)

def dunder_level_relative(call):
    level = call.args[4] if len(call.args) > 4 and not any(isinstance(arg, ast.Starred) for arg in call.args[:5]) else keyword(call, "level")
    if level is None:
        return False
    try:
        value = ast.literal_eval(level)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        return False
    return isinstance(value, int) and value > 0

def assignments(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    yield target.id, node.value
        elif isinstance(node, (ast.AnnAssign, ast.NamedExpr)) and isinstance(node.target, ast.Name) and node.value is not None:
            yield node.target.id, node.value

results = []
for path in sys.stdin.read().split("\0"):
    if not path:
        continue
    try:
        with open(path, "rb") as handle:
            tree = ast.parse(handle.read(), filename=path)
    except (SyntaxError, ValueError) as error:
        results.append({"error": getattr(error, "msg", None) or str(error), "line": getattr(error, "lineno", None)})
        continue
    found = []
    modules, loaders = set(), {"__import__": {"__import__"}}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.extend({"module": alias.name, "line": node.lineno} for alias in node.names)
            for alias in node.names:
                if alias.name == "importlib":
                    modules.add(alias.asname or "importlib")
                elif alias.name.startswith("importlib.") and not alias.asname:
                    modules.add("importlib")
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            found.append({"module": node.module, "line": node.lineno})
            if node.module == "importlib":
                for alias in node.names:
                    if alias.name in ("import_module", "*"):
                        loaders.setdefault(alias.asname or "import_module", set()).add("import_module")

    def kinds_of(value):
        if isinstance(value, ast.Name):
            return loaders.get(value.id, set())
        if isinstance(value, ast.Attribute) and value.attr == "import_module" and isinstance(value.value, ast.Name) and value.value.id in modules:
            return {"import_module"}
        return set()

    pairs = list(assignments(tree))
    changed = True
    while changed:
        changed = False
        for name, value in pairs:
            if isinstance(value, ast.Name) and value.id in modules and name not in modules:
                modules.add(name)
                changed = True
            kinds = kinds_of(value) - loaders.get(name, set())
            if kinds:
                loaders.setdefault(name, set()).update(kinds)
                changed = True

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        kinds = kinds_of(node.func)
        if not kinds:
            continue
        arg = node.args[0] if node.args else keyword(node, "name")
        if not literal_name(arg):
            continue
        if "import_module" in kinds or not dunder_level_relative(node):
            found.append({"module": arg.value, "line": node.lineno})
    results.append({"imports": found})
json.dump(results, sys.stdout)
`;

/**
 * Absolute imports of Python files, read with Python's own `ast` module (so docstrings, comments and strings are not
 * code). Returns one result per path: `{ imports: [{ module, line }] }` or `{ error, line }`.
 * @param {string[]} paths absolute paths
 */
export function pythonImports(paths, { python = process.env.PYTHON || "python3" } = {}) {
  if (paths.length === 0) return [];
  let output;
  try {
    output = execFileSync(python, ["-I", "-c", PYTHON_IMPORTS], {
      input: paths.join("\0"),
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new BoundaryError(`${python} could not read Python imports (${error.code ?? String(error.stderr ?? error.message).trim().split("\n").pop()}); Python 3 is needed for this check`);
  }
  const results = JSON.parse(output);
  if (!Array.isArray(results) || results.length !== paths.length) throw new BoundaryError(`${python} returned an unexpected result for Python imports`);
  return results;
}

// ---------------------------------------------------------------------------------------------------------------
// package.json dependencies

const DEPENDENCY_FIELDS = Object.freeze(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]);
const BUNDLED_FIELDS = Object.freeze(["bundleDependencies", "bundledDependencies"]);

/** `npm:<name>@<range>` alias target name, or null. */
function aliasTarget(range) {
  if (typeof range !== "string" || !range.startsWith("npm:")) return null;
  const spec = range.slice(4);
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at === -1 ? spec : spec.slice(0, at);
}

/** Package names a package.json depends on, each with the field naming it (aliases count by both names). */
export function dependencyNames(manifest) {
  const found = [];
  if (!isPlainObject(manifest)) return found;
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field];
    if (!isPlainObject(value)) continue;
    for (const [name, range] of Object.entries(value)) {
      found.push({ name, field });
      const target = aliasTarget(range);
      if (target && target !== name) found.push({ name: target, field: `${field}.${name} (npm alias)` });
    }
  }
  for (const field of BUNDLED_FIELDS) {
    if (!Array.isArray(manifest[field])) continue;
    for (const name of manifest[field]) if (typeof name === "string") found.push({ name, field });
  }
  // An override whose value is an npm alias installs its target wherever the overridden package resolves.
  const overrides = (value, at) => {
    if (!isPlainObject(value)) return;
    for (const [key, range] of Object.entries(value)) {
      const target = aliasTarget(range);
      if (target) found.push({ name: target, field: `${at}.${key} (npm alias)` });
      else overrides(range, `${at}.${key}`);
    }
  };
  overrides(manifest.overrides, "overrides");
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// Rules

function tryOwner(lookup) {
  try {
    return lookup();
  } catch (error) {
    if (error instanceof OwnersError) return null;
    throw error;
  }
}

/** True for a top-level entry that is a directory: a submodule (gitlink) or a symlink to a directory. */
function isDirectoryEntry(root, file, mode) {
  if (mode === GITLINK) return true;
  if (mode !== SYMLINK) return false;
  try {
    return statSync(path.join(root, file)).isDirectory();
  } catch {
    return false;
  }
}

function topLevelPathFindings(publicManifest, files, modes, root) {
  const dirs = new Set();
  const rootFiles = new Set();
  for (const file of files) {
    const slash = file.indexOf("/");
    if (slash !== -1) dirs.add(file.slice(0, slash));
    else if (isDirectoryEntry(root, file, modes.get(file))) dirs.add(file);
    else rootFiles.add(file);
  }
  const findings = [];
  for (const dir of [...dirs].sort(compareStrings)) {
    if (!publicManifest.paths.has(dir)) {
      findings.push(finding(`${dir}/`, RULES.topLevelPath, `top-level directory is not listed in ${PUBLIC_MANIFEST} paths`));
    }
  }
  for (const file of [...rootFiles].sort(compareStrings)) {
    if (!publicManifest.rootFiles.has(file)) {
      findings.push(finding(file, RULES.topLevelPath, `root file is not listed in ${PUBLIC_MANIFEST} rootFiles`));
    }
  }
  return findings;
}

/** Owner of a path's top-level directory under public semantics, or null when it is unlisted or not a directory path. */
function directoryOwner(publicManifest, target) {
  const normalized = path.posix.normalize(String(target).replaceAll("\\", "/"));
  if (normalized.startsWith("/") || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  const slash = normalized.indexOf("/");
  const top = slash === -1 ? normalized : normalized.slice(0, slash);
  return publicManifest.paths.get(top) ?? null;
}

function publicReleaseFindings(owners, releases, python) {
  const { publicManifest } = owners;
  const findings = [];
  for (const entry of releases) {
    const release = `release ${JSON.stringify(entry.slug)} (${entry.path})`;
    const owner = tryOwner(() => owners.ownerOfRelease(entry.slug, { repo: "public" }));
    if (owner !== "public") {
      findings.push(finding(entry.source, RULES.publicRelease, `${release} is not listed as public in ${PUBLIC_MANIFEST} releases`));
    }
    if (directoryOwner(publicManifest, entry.path) !== "public") {
      findings.push(finding(entry.source, RULES.publicRelease, `${release} is not under a top-level directory listed in ${PUBLIC_MANIFEST} paths`));
    }
  }
  for (const project of python) {
    const label = `Python project ${JSON.stringify(project.name)}`;
    const owner = tryOwner(() => owners.ownerOfPython(project.name, { repo: "public" }));
    if (owner !== "public") {
      findings.push(finding(project.file, RULES.publicRelease, `${label} is not listed as public in ${PUBLIC_MANIFEST} python`));
    }
    if (directoryOwner(publicManifest, project.file) !== "public") {
      findings.push(finding(project.file, RULES.publicRelease, `${label} is not under a top-level directory listed in ${PUBLIC_MANIFEST} paths`));
    }
  }
  return findings;
}

/**
 * Workspace packages and their findings. Returns the names of public workspace packages: named, unique and under a
 * listed top-level directory.
 */
function workspaceFindings(publicManifest, { directories, linked, patterns, files, root, modes, resolve, readJson }) {
  const findings = [];
  for (const entry of linked) {
    const message = linkedWorkspaceProblem({ entry, patterns, files, root, modes });
    if (message) findings.push(finding(entry, RULES.workspacePackage, message));
  }
  const byName = new Map();
  for (const directory of directories) {
    const file = `${directory}/package.json`;
    const content = resolve(file);
    if (content === null) continue;
    if (content.problem) {
      findings.push(finding(file, RULES.workspacePackage, `${content.problem}; its package name cannot be read`));
      continue;
    }
    const manifest = readJson(file);
    const name = manifest?.name;
    if (typeof name !== "string" || name === "") {
      findings.push(finding(file, RULES.workspacePackage, "workspace package has no name"));
      continue;
    }
    const entries = byName.get(name) ?? [];
    entries.push(directory);
    byName.set(name, entries);
  }
  const publicPackages = new Set();
  for (const [name, dirs] of [...byName].sort(([a], [b]) => compareStrings(a, b))) {
    if (dirs.length > 1) {
      for (const directory of dirs) {
        findings.push(finding(`${directory}/package.json`, RULES.workspacePackage, `workspace package ${JSON.stringify(name)} is also defined by ${dirs.filter((other) => other !== directory).map((other) => `${other}/package.json`).join(", ")}; a name must resolve to one directory`));
      }
      continue;
    }
    if (directoryOwner(publicManifest, dirs[0]) !== "public") {
      findings.push(finding(`${dirs[0]}/package.json`, RULES.workspacePackage, `workspace package ${JSON.stringify(name)} is not under a top-level directory listed in ${PUBLIC_MANIFEST} paths`));
      continue;
    }
    publicPackages.add(name);
  }
  return { findings, publicPackages };
}

/**
 * Why npm would read a workspace package through a tracked symlink or submodule (gitlink), or null. A linked entry
 * matters when it is a workspace match or an ancestor of one, since npm expands patterns through links. Closed rule,
 * with nothing followed recursively: a submodule there always fails (its packages are not tracked in this tree). A
 * symlink there passes only when it points to a file, or to a directory inside the repository whose tracked subtree
 * holds no package.json that is a workspace match through the link's path (that package would be read under a path
 * this check does not inventory) and no tracked symlink or submodule at all (npm could follow it further). Anything
 * else (a dangling link, a link leaving the repository, a matching package.json, any nested link) fails, naming the
 * nested link when there is one.
 */
function linkedWorkspaceProblem({ entry, patterns, files, root, modes }) {
  const reached = patterns.filter((pattern) => reachesWorkspace(pattern, entry));
  if (reached.length === 0) return null;
  const via = `workspace pattern${reached.length > 1 ? "s" : ""} ${reached.map((pattern) => JSON.stringify(pattern)).join(", ")}`;
  if (modes.get(entry) === GITLINK) return `is a submodule (gitlink) that npm expands ${via} through; packages read through it are not tracked in this tree`;
  const absolute = path.join(root, entry);
  const link = `is a symlink to ${JSON.stringify(readlinkSync(absolute))}`;
  let target;
  try {
    target = realpathSync(absolute);
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) return `${link}, which does not exist, where npm expands ${via}`;
    throw error;
  }
  const relative = path.relative(realpathSync(root), target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return `${link}, outside the repository, where npm expands ${via}`;
  }
  if (!statSync(target).isDirectory()) return null;
  const prefix = relative === "" ? "" : `${relative.split(path.sep).join("/")}/`;
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const mode = modes.get(file);
    if (mode === SYMLINK || mode === GITLINK) {
      const kind = mode === GITLINK ? "submodule (gitlink)" : "symlink";
      return `${link}, whose target holds the tracked ${kind} ${file}, which npm could follow where it expands ${via}; a linked workspace directory may not hold links`;
    }
    if (path.posix.basename(file) !== "package.json") continue;
    const directory = path.posix.dirname(`${entry}/${file.slice(prefix.length)}`);
    if (directory.split("/").includes("node_modules")) continue;
    if (reached.some((pattern) => matchesWorkspace(pattern, directory))) {
      return `${link}; npm reads workspace ${JSON.stringify(directory)} through it from ${file}, so that package is not checked at the path npm uses`;
    }
  }
  return null;
}

function notAllowed(name) {
  return `${JSON.stringify(name)}, which is neither a public workspace package nor allowed here by ${ALLOW_FILE}`;
}

function fnDependencyFindings({ files, publicPackages, publicPython, allowed, resolve, readJson, parsed }) {
  const isAllowed = (name, file) =>
    !isFnPackage(name) || publicPackages.has(name) || (allowed.has(name) && allowEntryApplies(allowed.get(name), file));
  const findings = [];
  const python = [];
  for (const file of files) {
    const isManifest = path.posix.basename(file) === "package.json";
    const isPython = path.posix.extname(file).toLowerCase() === ".py";
    if (!isManifest && !isPython && !isSourceFile(file)) continue;
    const content = resolve(file);
    if (content === null) continue;
    if (content.problem) {
      findings.push(finding(file, RULES.fnDependency, `${content.problem}; its ${isManifest ? "dependencies" : "imports"} cannot be checked`));
      continue;
    }
    if (isPython) {
      python.push({ file, absolute: content.absolute });
      continue;
    }
    if (isManifest) {
      for (const { name, field } of dependencyNames(readJson(file))) {
        if (!isAllowed(name, file)) findings.push(finding(file, RULES.fnDependency, `${field} depends on ${notAllowed(name)}`));
      }
      continue;
    }
    let imports;
    try {
      imports = importSpecifiers(file, readFileSync(content.absolute, "utf8"), parsed);
    } catch (error) {
      if (!(error instanceof SourceParseError)) throw error;
      const at = Number.isInteger(error.line) ? `${file}:${error.line}` : file;
      findings.push(finding(at, RULES.fnDependency, `cannot be parsed (${error.message}); its imports cannot be checked`));
      continue;
    }
    for (const { specifier, line } of imports) {
      for (const name of packageNamesOf(specifier)) {
        if (!isAllowed(name, file)) {
          findings.push(finding(`${file}:${line}`, RULES.fnDependency, `imports ${JSON.stringify(specifier)}: package ${notAllowed(name)}`));
        }
      }
    }
  }
  // A Python module is allowed when a public Python project provides it or the allow file pins it.
  const results = pythonImports(python.map(({ absolute }) => absolute));
  for (const [index, { file }] of python.entries()) {
    const result = results[index];
    if (result.error !== undefined) {
      const at = Number.isInteger(result.line) ? `${file}:${result.line}` : file;
      findings.push(finding(at, RULES.fnDependency, `cannot be parsed (${result.error}); its imports cannot be checked`));
      continue;
    }
    for (const { module, line } of result.imports) {
      const name = module.split(".")[0];
      if (isFnPackage(name) && !publicPython.has(name.toLowerCase()) && !(allowed.has(name) && allowEntryApplies(allowed.get(name), file))) {
        findings.push(finding(`${file}:${line}`, RULES.fnDependency, `imports Python module ${JSON.stringify(module)}: ${JSON.stringify(name)} is neither a public Python project nor allowed here by ${ALLOW_FILE}`));
      }
    }
  }
  return findings;
}

/** Allow entries that name a public workspace package are redundant and refused, so the file lists only external packages. */
function allowFileFindings(allowed, publicPackages) {
  return [...allowed.keys()]
    .filter((name) => publicPackages.has(name))
    .map((name) => finding(ALLOW_FILE, RULES.fnDependency, `${JSON.stringify(name)} is a public workspace package; remove it from the allow file`));
}

// ---------------------------------------------------------------------------------------------------------------
// Tracked inventory

const GITLINK = "160000";
const SYMLINK = "120000";

/**
 * Every tracked path with its index mode (`git ls-files -s`): regular files, symlinks (120000) and gitlinks (160000)
 * alike, so no tracked entry escapes the path rules.
 * @returns {Map<string, string>} path -> mode
 */
export function trackedEntries(root) {
  const output = execFileSync(gitBinary(), ["ls-files", "-s", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entries = new Map();
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    entries.set(record.slice(tab + 1), record.slice(0, record.indexOf(" ")));
  }
  return entries;
}

/**
 * Where a tracked path's content is read from: `{ absolute }` for a regular file or for a symlink to a regular file
 * inside the repository (read under the link's own path), `{ problem }` for an entry whose content cannot be read as
 * a file of this tree (a gitlink, a directory, or a symlink that dangles, leaves the repository or names a
 * directory), and null for a tracked file deleted from the working tree.
 */
function contentResolver(root, modes) {
  const realRoot = realpathSync(root);
  const cache = new Map();
  const resolveContent = (file) => {
    if (modes.get(file) === GITLINK) return { problem: "is a submodule (gitlink) whose content is not in this tree" };
    const absolute = path.join(root, file);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    }
    if (stat.isFile()) return { absolute };
    if (!stat.isSymbolicLink()) return { problem: "is not a regular file" };
    const link = `is a symlink to ${JSON.stringify(readlinkSync(absolute))}`;
    let target;
    try {
      target = realpathSync(absolute);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) return { problem: `${link}, which does not exist` };
      throw error;
    }
    const relative = path.relative(realRoot, target);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { problem: `${link}, outside the repository` };
    }
    if (!statSync(target).isFile()) return { problem: `${link}, which is not a regular file` };
    return { absolute: target };
  };
  return (file) => {
    if (!cache.has(file)) cache.set(file, resolveContent(file));
    return cache.get(file);
  };
}

/**
 * Checks a checkout against the public boundary and returns its findings (empty when it passes).
 * @param {{ root?: string }} [options]
 */
export async function verifyPublicBoundary({ root = REPO_ROOT } = {}) {
  const parsed = await loadParsers();
  // Public semantics only: superfunctions.owners.next.json is never read here (tracked, it is an unlisted root file).
  const owners = createOwners(readManifest(path.join(root, PUBLIC_MANIFEST), { kind: "public" }));
  const modes = trackedEntries(root);
  const files = [...modes.keys()].sort(compareStrings);
  const resolve = contentResolver(root, modes);
  const readJson = (file) => {
    const content = resolve(file);
    if (content === null || content.problem) throw new BoundaryError(`${file} ${content?.problem ?? "is not in the working tree"}`);
    try {
      return JSON.parse(readFileSync(content.absolute, "utf8"));
    } catch (error) {
      throw new BoundaryError(`${file}: invalid JSON: ${error.message}`);
    }
  };
  const allowed = readAllowFile(root);
  const patterns = workspacePatterns(readJson("package.json"));
  const { findings: workspace, publicPackages } = workspaceFindings(owners.publicManifest, {
    directories: workspaceDirectories(patterns, files),
    linked: files.filter((file) => modes.get(file) === GITLINK || modes.get(file) === SYMLINK),
    patterns,
    files,
    root,
    modes,
    resolve,
    readJson,
  });
  const pyprojects = files.filter((file) => path.posix.basename(file) === "pyproject.toml");
  const unreadablePython = pyprojects
    .filter((file) => resolve(file)?.problem)
    .map((file) => finding(file, RULES.publicRelease, `${resolve(file).problem}; its Python project cannot be checked`));
  const python = readPythonProjects(root, pyprojects.filter((file) => resolve(file)?.absolute));
  // Import names of public Python projects (PEP 503 normalized, as a module: `datafn-agent` -> `datafn_agent`).
  const publicPython = new Set(
    python
      .filter((project) => tryOwner(() => owners.ownerOfPython(project.name, { repo: "public" })) === "public" && directoryOwner(owners.publicManifest, project.file) === "public")
      .map((project) => project.name.toLowerCase().replaceAll(/[-_.]+/g, "_")),
  );
  return [
    ...topLevelPathFindings(owners.publicManifest, files, modes, root),
    ...publicReleaseFindings(owners, readReleaseEntries(root, "public"), python),
    ...unreadablePython,
    ...workspace,
    ...allowFileFindings(allowed, publicPackages),
    ...fnDependencyFindings({ files, publicPackages, publicPython, allowed, resolve, readJson, parsed }),
  ];
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split(/=(.*)/s, 2);
    if (flag !== "--root") throw new Error(`unknown argument ${argv[index]}`);
    const value = inline ?? argv[++index];
    if (value === undefined || value === "") throw new Error(`${flag} needs a value`);
    options.root = path.resolve(value);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let findings;
  try {
    findings = await verifyPublicBoundary(parseArgs(process.argv.slice(2)));
  } catch (error) {
    const code = error instanceof OwnersError ? ` (${error.code})` : "";
    console.error(`error${code}: ${error.message}`);
    process.exit(1);
  }
  if (findings.length > 0) {
    console.error(`Public boundary check failed (${findings.length}):`);
    for (const item of findings) console.error(`  ${formatFinding(item)}`);
    process.exit(1);
  }
  console.log(`Public boundary holds: paths, ${RELEASE_FILES.public}, Python projects, workspaces and *fn imports match ${PUBLIC_MANIFEST} and ${ALLOW_FILE}.`);
}
