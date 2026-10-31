#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { gitBinary } from "./verify-package-lockfiles.mjs";

const GRAPH_PATH = "uifn/package-graph.json";
const INPUTS_PATH = "uifn/version-bump-inputs.json";
const RELEASE_TARGETS_PATH = "release-packages.json";

// Shipped code is everything that feeds the tarball (`dist` is built from the
// package sources and configs) minus tests, fixtures, stories, harnesses and
// docs (Markdown anywhere, and the root docs/ directory), unless a build surface names them
// (see shippedClosure). Unknown paths count as shipped so new build inputs fail closed;
// data and helpers that never reach the tarball are declared "excluded", and the
// guard rejects an exclusion that `files` lists or that the shipped closure reaches.
const NON_SHIPPED_SEGMENTS = new Set(["__tests__", "__mocks__", "__fixtures__", "__snapshots__", "fixtures", "test", "tests"]);
const NON_SHIPPED_ROOT_DIRS = new Set(["browser", "docs", "stories", "type-tests", "workbenches"]);
const NON_SHIPPED_FILE = /(?:\.(?:test|spec|test-d|stories)\.[^/]+|\.mdx?|\.snap)$/i;
const NON_SHIPPED_ROOT_FILE = /^(?:vitest|playwright)(?:\.[^/]+)?\.config\.[^/]+$/;
// A root Vite config is a build input only when the package builds with Vite.
const VITE_ROOT_FILE = /^vite(?:\.[^/]+)?\.config\.[^/]+$/;
// Scripts that run when a package is packed or published, plus `build`, which prepack runs, and the
// scripts that run on a consumer's machine when it is installed. devDependencies and scripts these never
// reach do not affect consumers.
const PACK_SCRIPTS = ["build", "prepare", "prepack", "postpack", "prepublish", "prepublishOnly"];
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];
// Validation reached from pack-time scripts (`npm run typecheck && npm run test`, `generate:check`) can
// stop a pack but produces nothing in it, so a script named test, typecheck, lint, check or verify, alone
// or as a `:` part, is not followed from them. Everything an install script reaches runs for consumers.
const VALIDATION_SCRIPT_PART = new Set(["test", "typecheck", "lint", "check", "verify"]);
// Root build configs that tsup, tsc, svelte-package, vite and npm pack load without being named.
const IMPLICIT_CONFIG = /^(?:(?:tsup|vite|rollup|svelte|babel|postcss|tailwind)(?:\.[^/]+)?\.config\.[^/]+|tsconfig[^/]*\.json|\.npmignore|\.babelrc(?:\.[^/]+)?)$/;
// Extensions a bundler or tsc tries for an extensionless specifier or a directory index.
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".json", ".css"];
// npm's own aliases for scripts it runs without `run`; `npm restart` runs stop and start when no restart script exists.
const NPM_ALIASES = { t: ["test"], tst: ["test"], restart: ["restart", "stop", "start"] };
// Manifest fields that name the files consumers load.
const ENTRY_FIELDS = ["exports", "imports", "main", "module", "types", "typings", "bin", "browser", "svelte"];

// Strict semver, as in scripts/resolve-release-tag.mjs: no leading zeros in numeric parts.
const NUMBER = "(?:0|[1-9][0-9]*)";
const IDENTIFIER = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(`^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

// Files whose references count: relative specifiers and `".."` path segments everywhere; in build files
// (in-package scripts/ and root *.config.*, and declared inputs outside uifn/) also repo-root paths and bare
// package-relative strings such as tsup entries; in a tsconfig, its include and files entries. Other JSON is
// data. Runtime reads through computed paths are not detected. A file a shipped script runs, and a local module a
// build file imports, is a build file too, wherever it lives; a shell build file is read like a lifecycle script.
const SCANNED_FILE = /(?:\.(?:[cm]?[jt]sx?|svelte|css)|(?:^|\/)[tj]sconfig[^/]*\.json)$/;
const SPECIFIER = /(['"`])(\.\.?(?:\/[^'"`\n]*?)?)(?:\1|\$\{)/g;
const LITERAL_ARGUMENT = /\s*,\s*(['"`])([^'"`\n]*)\1/y;
// A specifier in module position (import, export from, import(), require(), CSS @import or url()), which a bundler inlines.
const MODULE_CONTEXT = /(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\(|@import(?:\s+url\()?|\burl\()\s*$/;
const REPO_PATH = /(['"`])((?:uifn|scripts)\/[^'"`\s]*?)(?:\1|\$\{)/g;
const BARE_LITERAL = /(['"`])([^'"`\s$\\:]+)\1/g;
const TSCONFIG = /(?:^|\/)tsconfig[^/]*\.json$/;
const TSCONFIG_LIST = /"(?:include|files)"\s*:\s*\[([^\]]*)\]/g;
const GLOB = /[*?[{]/;
const TSC_PROJECT_FLAG = /^(?:-p|--project|-b|--build)$/;
// Any build-file tsc word is a tsc run (`npx -p typescript tsc`, `bun x tsc`, a message) that names every tsconfig in its package.
// `--noEmit false` on a command line, `--noEmit=false`, or across argv elements (`"--noEmit", "false"`).
const EMIT_OVERRIDE = /--noEmit['"`\s,=]+false\b/;
const COMMAND_SEPARATOR = /&&|\|\||[;|\n]/;
// Commands that run a file with the package root as the working directory, which makes the file a build file.
const RUNNER = /^(?:node|tsx|ts-node(?:-esm)?|esno|vite-node|jiti|bun|deno|sh|bash|zsh|dash|zx)$/;
const RUNNABLE = /\.(?:[cm]?[jt]sx?|sh)$/;

// Code-unit order, as the default sort, with an explicit comparator.
const byCodeUnit = (a, b) => (a < b ? -1 : Number(a > b));

const isWithin = (file, root) => root === "." || file === root || file.startsWith(`${root}/`);

const coversPath = (pattern, file) => file.split("/").some((_, index, parts) => globToRegExp(pattern).test(parts.slice(0, index + 1).join("/")));

function enclosingBracket(text, index) {
  for (let position = index - 1, depth = 0; position >= Math.max(0, index - 4096); position -= 1) {
    if (")]}".includes(text[position])) depth += 1;
    else if ("([{".includes(text[position]) && (depth -= 1) < 0) return position;
  }
  return -1;
}

/** Classifies a path relative to the package root as "manifest", "shipped" or "excluded". */
export function classifyPath(relative, { buildUsesVite = true } = {}) {
  if (relative === "package.json") return "manifest";
  const segments = relative.split("/");
  const file = segments.at(-1);
  if (segments.length > 1 && NON_SHIPPED_ROOT_DIRS.has(segments[0])) return "excluded";
  if (segments.slice(0, -1).some((segment) => NON_SHIPPED_SEGMENTS.has(segment))) return "excluded";
  if (NON_SHIPPED_FILE.test(file)) return "excluded";
  if (segments.length === 1 && NON_SHIPPED_ROOT_FILE.test(file)) return "excluded";
  if (segments.length === 1 && !buildUsesVite && VITE_ROOT_FILE.test(file)) return "excluded";
  return "shipped";
}

const isValidationScript = (name) => name.split(":").some((part) => VALIDATION_SCRIPT_PART.has(part));

/**
 * The manifest scripts one script can invoke. The traversal fails closed rather than parsing each runner's
 * syntax: every word of every command (split on && || ; | & and newlines) that names a script in this
 * manifest is followed, so `npm --silent run x`, `pnpm run x`, `yarn x`, `bun run x` and `run-s x` all
 * reach x. Concurrently's `npm:x` prefix is dropped, a `*` word (npm-run-all) matches script names, and
 * npm's own aliases apply in commands that run npm.
 */
export function invokedScripts(command, scripts) {
  const names = Object.keys(scripts);
  const found = new Set();
  for (const part of command.split(/&&|\|\||[;|&\n]/)) {
    const words = part.split(/[\s()<>]+/).map((word) => word.replace(/^['"`]+|['"`]+$/g, "").replace(/^(?:npm|pnpm|yarn|bun):/, "")).filter(Boolean);
    const npm = words.includes("npm");
    for (const word of words) {
      if (Object.hasOwn(scripts, word)) found.add(word);
      if (npm && Object.hasOwn(NPM_ALIASES, word)) for (const alias of NPM_ALIASES[word]) if (Object.hasOwn(scripts, alias)) found.add(alias);
      if (word.includes("*")) {
        const pattern = new RegExp(`^${word.split("*").map(escapeRegExp).join(".*")}$`);
        for (const name of names) if (pattern.test(name)) found.add(name);
      }
    }
  }
  return found;
}

/**
 * Shipped lifecycle scripts, their pre/post hooks, and the scripts they invoke: every script an install
 * script reaches, and the non-validation scripts a pack-time script reaches.
 */
export function shippedScriptNames(scripts = {}) {
  const names = new Set();
  const visited = new Set();
  const pending = [...PACK_SCRIPTS.map((name) => [name, false]), ...INSTALL_SCRIPTS.map((name) => [name, true])];
  while (pending.length > 0) {
    const [name, install] = pending.pop();
    const key = `${install}\0${name}`;
    if (visited.has(key) || (!install && isValidationScript(name)) || !Object.hasOwn(scripts, name) || typeof scripts[name] !== "string") continue;
    visited.add(key);
    names.add(name);
    pending.push([`pre${name}`, install], [`post${name}`, install]);
    for (const target of invokedScripts(scripts[name], scripts)) pending.push([target, install]);
  }
  return names;
}

/** Returns the manifest fields that reach consumers, without the version itself. */
export function publishedManifest(manifest) {
  const { version: _version, devDependencies: _devDependencies, scripts, ...published } = manifest;
  const names = [...shippedScriptNames(scripts ?? {})].sort(byCodeUnit);
  if (names.length > 0) published.scripts = Object.fromEntries(names.map((name) => [name, scripts[name]]));
  return published;
}

// Resolution tries these fields' keys in order (export conditions, typesVersions ranges); elsewhere in a manifest key order means nothing.
const ORDERED_FIELDS = new Set(["exports", "imports", "typesVersions"]);

/** A manifest value as JSON with object keys sorted, so that reordering keys changes nothing. */
function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort(byCodeUnit).map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(",")}}`;
}

/** Validates the declarations document against the stable packages (name -> path). */
export function parseInputDeclarations(document, stable) {
  const declarations = new Map([...stable.keys()].map((name) => [name, { inputs: [], references: [], excluded: [] }]));
  const errors = [];
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (document === null) return { declarations, errors };
  if (!isObject(document) || !isObject(document.packages)) return { declarations, errors: [`${INPUTS_PATH} must be an object with a "packages" object`] };
  for (const [name, entry] of Object.entries(document.packages)) {
    const packagePath = stable.get(name);
    if (!packagePath) {
      errors.push(`${INPUTS_PATH}: ${name} is not a stable package`);
      continue;
    }
    if (!isObject(entry)) {
      errors.push(`${INPUTS_PATH}: ${name} must be an object`);
      continue;
    }
    const declaration = declarations.get(name);
    for (const [kind, targets] of Object.entries(entry)) {
      if (!(kind in declaration) || !isObject(targets)) {
        errors.push(`${INPUTS_PATH}: ${name}.${kind} must be one of inputs, references or excluded, mapping paths to reasons`);
        continue;
      }
      for (const [target, reason] of Object.entries(targets)) {
        const where = `${INPUTS_PATH}: ${name}.${kind} ${JSON.stringify(target)}`;
        if (typeof reason !== "string" || !reason.trim()) errors.push(`${where} needs a reason`);
        else if (!target || target === "." || target !== path.posix.normalize(target) || target.startsWith("../") || path.posix.isAbsolute(target) || target.endsWith("/")) errors.push(`${where} must be a normalized relative path`);
        else if (kind !== "excluded" && isWithin(target, packagePath)) errors.push(`${where} is inside ${packagePath}, which already counts`);
        else declaration[kind].push(target);
      }
    }
  }
  return { declarations, errors };
}

function parseSemver(version) {
  const match = typeof version === "string" ? version.match(SEMVER) : null;
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? [] };
}

/** Semver precedence: negative when a < b, zero when equal, positive when a > b. */
export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) throw new Error(`Invalid semver: ${left ? b : a}`);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const l = left.prerelease[index];
    const r = right.prerelease[index];
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Number(l) - Number(r);
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/** True when the changelog has a heading for `version` followed by at least one content line. */
export function changelogHasEntry(text, version) {
  if (typeof text !== "string") return false;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^(#{1,6})\\s+\\[?v?${escaped}\\]?(?:\\s|$)`);
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return false;
  const level = lines[start].match(/^#+/)[0].length;
  for (const line of lines.slice(start + 1)) {
    const nested = line.match(/^(#{1,6})\s/);
    if (nested && nested[1].length <= level) return false;
    if (!nested && line.trim()) return true;
  }
  return false;
}

function classifyOptions(manifest) {
  const buildScripts = Object.values(publishedManifest(manifest ?? {}).scripts ?? {});
  return { buildUsesVite: buildScripts.some((script) => /\bvite\b/.test(script)) };
}

/**
 * Default class of a repo path for one package: "shipped", "excluded" (tests, fixtures, docs),
 * "declared" (a declared exclusion), "manifest" or "outside". Inside a declared input directory,
 * tests and docs are "excluded" too.
 */
export function pathKind(file, { packagePath, inputs = [], excluded = [], options = {} }) {
  if (file.startsWith(`${packagePath}/`)) {
    const relative = file.slice(packagePath.length + 1);
    if (excluded.some((entry) => isWithin(relative, entry))) return "declared";
    return classifyPath(relative, options);
  }
  const input = inputs.find((entry) => isWithin(file, entry));
  if (!input) return "outside";
  return file === input || classifyPath(file.slice(input.length + 1)) !== "excluded" ? "shipped" : "excluded";
}

/**
 * Pure per-package decision shared by the PR gate and the since-published report. `shippedFiles` are
 * the changed paths that ship at either end; `stable` is false for a package the head demoted or removed.
 */
export function evaluatePackage({ name, packagePath, baseManifest, headManifest, shippedFiles: shipped, headChangelog, stable = true }) {
  const prefix = `${packagePath}/`;
  const shippedFiles = [...shipped].sort(byCodeUnit);
  const result = { name, packagePath, shippedFiles, manifestChanged: false, baseVersion: baseManifest?.version, headVersion: headManifest?.version, bumped: false, errors: [] };
  if (!headManifest) {
    // A package removed from the graph and the tree has nothing left to publish.
    if (stable) result.errors.push(`${name}: ${packagePath}/package.json is missing`);
    return result;
  }
  if (!baseManifest) return result;
  const comparable = (manifest) => sortedJson(Object.fromEntries(Object.entries(publishedManifest(manifest)).map(([key, value]) => [key, ORDERED_FIELDS.has(key) ? JSON.stringify(value) : value])));
  result.manifestChanged = comparable(baseManifest) !== comparable(headManifest);
  const changed = shippedFiles.length > 0 || result.manifestChanged;
  if (result.baseVersion !== result.headVersion) {
    if (!parseSemver(result.headVersion)) {
      result.errors.push(`${name}: version ${JSON.stringify(result.headVersion)} is not valid semver`);
      return result;
    }
    if (parseSemver(result.baseVersion) && compareSemver(result.headVersion, result.baseVersion) <= 0) {
      result.errors.push(`${name}: version ${result.headVersion} must be greater than ${result.baseVersion}`);
      return result;
    }
    result.bumped = true;
    if (!changelogHasEntry(headChangelog, result.headVersion)) {
      result.errors.push(`${name}: version bumped to ${result.headVersion} but ${packagePath}/CHANGELOG.md has no "## ${result.headVersion}" entry with content`);
    }
  } else if (changed) {
    const reasons = [...shippedFiles.map((file) => (file.startsWith(prefix) ? file.slice(prefix.length) : file)), ...(result.manifestChanged ? ["package.json (published fields)"] : [])];
    const listed = reasons.slice(0, 5).join(", ") + (reasons.length > 5 ? `, and ${reasons.length - 5} more` : "");
    result.errors.push(`${name}: shipped code changed (${listed}) but version is still ${result.headVersion}; bump ${packagePath}/package.json and add a "## <new version>" entry to ${packagePath}/CHANGELOG.md. For an in-package path that never reaches the tarball, declare it under "excluded" in ${INPUTS_PATH}: a new path can be excluded in the same change, but a path that already exists counts until its exclusion is on the base branch`);
  }
  return result;
}

/** Paths a tsconfig compiles: its `include` and `files` entries, relative to its directory, globs kept. */
export function tsconfigEntries(file, text) {
  const entries = [];
  for (const [, list] of text.matchAll(TSCONFIG_LIST)) {
    for (const [, entry] of list.matchAll(/"([^"]*)"/g)) if (entry) entries.push(path.posix.join(path.posix.dirname(file), entry).replace(/\/+$/, ""));
  }
  return entries;
}

/**
 * Every path a file names, as `{ target, soft, tsconfig, bundled }` with globs kept: each relative
 * specifier itself and, outside JSON and arrays, also joined with the string literals that follow it, since
 * `path.join(here, "..", "x")` names x while `["./a", "./b"]` names a and b; in build files, repo-root
 * paths and bare strings resolved from the package root and the file's directory; in a tsconfig, its
 * include and files entries, marked with the tsconfig. Soft targets (bare strings) are ambiguous with
 * package names and options and cannot leave the package without `..`, so the out-of-root guard skips
 * them. A specifier in module position in a source file is marked bundled.
 * A `!` glob is marked negated, a reference keeps its enclosing bracket as `list`, and a tsconfig's own specifiers are overridden.
 */
export function fileReferences(file, text, { root = path.posix.dirname(file), base = path.posix.dirname(file), buildFile = false } = {}) {
  // A build-file tsc run sweeps every tsconfig: its arguments, quoting, --noEmit, project and cwd are not read. A noEmit tsconfig emits only if the file has a --noEmit false.
  const sweep = buildFile && /\btsc\b/.test(text) ? [{ target: path.posix.join(root, "**/tsconfig*.json"), soft: false, emit: EMIT_OVERRIDE.test(text), tsc: true }] : [];
  if (buildFile && file.endsWith(".sh")) return [...scriptReferences({ build: text }, root), ...sweep];
  const dir = path.posix.dirname(file);
  const found = [];
  const add = (target, extra = {}) => found.push({ target: path.posix.normalize(target).replace(/\/+$/, ""), soft: false, ...extra });
  const entries = TSCONFIG.test(file) ? tsconfigEntries(file, text) : [];
  for (const target of entries) add(target, { tsconfig: file });
  const isEntry = (target) => entries.includes(path.posix.normalize(target).replace(/\/+$/, ""));
  for (const match of text.matchAll(SPECIFIER)) {
    const segments = [match[2]];
    LITERAL_ARGUMENT.lastIndex = match.index + match[0].length;
    if (!file.endsWith(".json")) for (let argument = LITERAL_ARGUMENT.exec(text); argument; argument = LITERAL_ARGUMENT.exec(text)) segments.push(argument[2]);
    const module = !file.endsWith(".json") && MODULE_CONTEXT.test(text.slice(Math.max(0, match.index - 32), match.index));
    const bundled = !buildFile && module;
    const list = enclosingBracket(text, match.index);
    // A module a build file imports runs in the build, so it is a build file too.
    if (!isEntry(path.posix.join(dir, match[2]))) add(path.posix.join(dir, match[2]), bundled ? { bundled } : TSCONFIG.test(file) ? { overridden: true } : { list, ...(module ? { runs: true } : {}) });
    if (segments.length === 1 || text[list] === "[") continue;
    // A joined path is an extra candidate. For `path.resolve(packageRoot, "..", "x")` the base expression is unknown, so also try the package root.
    for (const from of match[2].startsWith("..") ? [dir, base] : [dir]) if (!isEntry(path.posix.join(from, ...segments))) add(path.posix.join(from, ...segments));
  }
  if (buildFile) {
    for (const match of text.matchAll(REPO_PATH)) add(match[2]);
    found.push(...sweep);
    // The sweep is additive: a `..` tsconfig or project path, in string or argv form, from the package root (tsc's cwd) and this file's directory, stays guarded where it exists.
    const words = sweep.length > 0 ? text.split(/[\s'"`,()[\]=;]+/) : [];
    for (const [index, word] of words.entries()) if (/(?:^|\/)\.\.(?:\/|$)/.test(word) && (TSCONFIG.test(word) || TSC_PROJECT_FLAG.test(words[index - 1]))) for (const from of new Set([root, dir])) add(path.posix.join(from, word.endsWith(".json") ? word : `${word}/tsconfig.json`), { emit: sweep[0].emit, candidate: true });
    // Tools such as tsup resolve `./src/x` from the working directory, the package root, as well as from this file's directory.
    for (const { 2: value, index } of text.matchAll(BARE_LITERAL)) {
      const negated = /^!./.test(value);
      if (!negated && /^(?:\/|\.\.?$|\.\.\/)/.test(value)) continue;
      for (const from of new Set([root, dir])) add(path.posix.join(from, value.slice(Number(negated))), { soft: true, list: enclosingBracket(text, index), ...(negated ? { negated } : {}) });
    }
  }
  const unique = new Map(found.map((reference) => [`${reference.target}\0${reference.soft}\0${reference.tsconfig ?? ""}\0${reference.bundled ?? ""}\0${reference.negated ?? ""}\0${reference.list ?? ""}\0${reference.emit ?? ""}\0${reference.runs ?? ""}`, reference]));
  return [...unique.values()];
}

/**
 * The tsconfigs, relative to the working directory, that a tsc command emits from: the -p/--project path, every -b/--build
 * path, or ./tsconfig.json; a path that is not a .json file is a directory holding tsconfig.json. Null when the command
 * does not run tsc, and none with --noEmit.
 */
export function tscProjects(command) {
  const words = command.replace(/\d*>>?&?\s*[^\s&|;]+|<\s*\S+/g, " ").split(/[\s()<>=]+/).map((word) => word.replace(/^['"`]+|['"`]+$/g, "")).filter(Boolean);
  const start = words.findIndex((word) => /(?:^|\/)tsc$/.test(word));
  if (start < 0) return null;
  const args = words.slice(start + 1);
  if (args.some((word, index) => word === "--noEmit" && args[index + 1] !== "false")) return [];
  const flag = args.findIndex((word) => TSC_PROJECT_FLAG.test(word));
  const projects = flag < 0 ? [] : /^--?b/.test(args[flag]) ? args.slice(flag + 1).filter((word) => !/^(?:-|true$|false$)/.test(word)) : args.slice(flag + 1, flag + 2);
  return (projects.length > 0 ? projects : ["."]).map((project) => (project.endsWith(".json") ? project : path.posix.join(project, "tsconfig.json")));
}

/**
 * Paths that shipped lifecycle scripts name, each token resolved from the package root, globs kept and `!` globs marked
 * negated, with the command they are in, plus the tsconfigs each tsc command emits from. Outside tsc commands a token is
 * marked `tree`, since a tool given a directory (`svelte-package -i lib`) reads every file under it; a tsc --noEmit
 * command names nothing. Every word after a runner (`node x.mjs`, `tsx x.ts`, `sh x.sh`), a leading `./x`, and a config the tool
 * loads (`-c x`, `--config x`, `--config=x`, any named *.config.* file) is marked `runs`.
 */
export function scriptReferences(scripts, packagePath) {
  const found = [];
  for (const name of shippedScriptNames(scripts ?? {})) {
    const from = `package.json scripts.${name}`;
    for (const [list, command] of scripts[name].split(COMMAND_SEPARATOR).entries()) {
      const projects = tscProjects(command);
      if (projects?.length === 0) continue;
      for (const project of projects ?? []) found.push({ from, target: path.posix.join(packagePath, project), soft: false, emit: EMIT_OVERRIDE.test(command) });
      let runs = false;
      let config = false;
      for (const [index, token] of command.trim().split(/[\s&<>()]+/).entries()) {
        const value = token.replace(/^['"]+|['"]+$/g, "").replace(/^-{1,2}[\w-]+=/, "");
        const negated = /^!./.test(value);
        if (value) found.push({ from, target: path.posix.join(packagePath, value.slice(Number(negated))).replace(/\/+$/, ""), soft: negated, list, ...(negated ? { negated } : projects ? {} : { tree: true }), ...(runs || config || /(?:^['"]?--config=)|\.config\./.test(token) || (index === 0 && value.startsWith("./")) ? { runs: true } : {}) });
        runs ||= RUNNER.test(path.posix.basename(value));
        config = /^(?:-c|--config)$/.test(value);
      }
    }
  }
  return found;
}

/** Paths that manifest entry fields name, every condition included, from the package root; a `*` pattern matches across directories, as in Node. */
export function entryReferences(manifest, packagePath) {
  const found = [];
  const visit = (field, value) => {
    if (typeof value === "string") found.push({ from: `package.json ${field}`, target: path.posix.join(packagePath, value.replaceAll("*", "**")).replace(/\/+$/, ""), soft: false });
    else if (value !== null && typeof value === "object") for (const nested of Object.values(value)) visit(field, nested);
  };
  for (const field of ENTRY_FIELDS) visit(field, manifest?.[field]);
  return found;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function closingBrace(pattern, start) {
  for (let index = start, depth = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "{") depth += 1;
    else if (pattern[index] === "}" && (depth -= 1) === 0) return index;
  }
  return -1;
}

function alternatives(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "{") depth += 1;
    else if (body[index] === "}") depth -= 1;
    else if (body[index] === "," && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  return [...parts, body.slice(start)];
}

function globSource(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      const slash = pattern[index + 2] === "/";
      source += slash ? "(?:[^/]+/)*" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[" && pattern.indexOf("]", index + 2) > 0) {
      const end = pattern.indexOf("]", index + 2);
      source += `[${pattern.slice(index + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
      index = end;
    } else if (char === "{" && closingBrace(pattern, index) > 0) {
      const end = closingBrace(pattern, index);
      source += `(?:${alternatives(pattern.slice(index + 1, end)).map(globSource).join("|")})`;
      index = end;
    } else source += escapeRegExp(char);
  }
  return source;
}

/** A glob (`*`, `**`, `?`, `[...]`, `{a,b}`) as a RegExp over whole repo paths; Node 20 has no path.matchesGlob. */
export function globToRegExp(pattern) {
  return new RegExp(`^${globSource(pattern)}$`);
}

/** The files at one end of a range, indexed for resolveReference. */
export function fileInventory(files) {
  const dirs = new Set();
  for (const file of files) for (let dir = path.posix.dirname(file); dir !== "." && !dirs.has(dir); dir = path.posix.dirname(dir)) dirs.add(dir);
  return { files: [...files], set: new Set(files), dirs };
}

/**
 * Files a reference names in the inventory. `direct` is true when it names a file: the path itself, with
 * an implied extension or index file, or a `.js` specifier's TypeScript source. Otherwise a glob names
 * the files it matches and a directory names every file under it.
 */
export function resolveReference(target, inventory) {
  if (GLOB.test(target)) {
    const pattern = globToRegExp(target);
    return { files: inventory.files.filter((file) => pattern.test(file)), direct: false };
  }
  const candidates = [target, ...RESOLVE_EXTENSIONS.flatMap((extension) => [`${target}${extension}`, `${target}/index${extension}`])];
  const compiled = target.match(/^(.*)\.([mc]?)js(x?)$/);
  if (compiled) candidates.push(`${compiled[1]}.${compiled[2]}ts${compiled[3]}`);
  const named = candidates.filter((candidate) => inventory.set.has(candidate));
  if (named.length > 0) return { files: named, direct: true };
  if (inventory.dirs.has(target)) return { files: inventory.files.filter((file) => file.startsWith(`${target}/`)), direct: false };
  return { files: [], direct: false };
}

/**
 * Every package or declared-input file that can reach the tarball, from one reference extractor and one
 * resolver over the files at that end. Seeds are the default-shipped and packed (packlist) files, shipped lifecycle scripts and
 * manifest entry fields; each scanned file adds its references (fileReferences). A resolved file is promoted
 * (counted as shipped, and scanned in turn) when it is a declared exclusion, which the guard then rejects,
 * or a test, fixture or docs path that the reference consumes: a file it names, a file a glob matches unless
 * a `!` glob in the same array or script command negates it (so `src/hooks/*.ts` builds every match), or a file under a
 * directory that is itself such a path, so `path.join(root, "src")` does not pull in src/__tests__. A tsconfig a shipped
 * script or build file names consumes its `tsconfigRoots` (with `--noEmit false`, emitting), or everything under it if null; its own include entries, a
 * directory meaning everything under it, promote only declared exclusions. References to the package root, a declared input root, or their ancestors are base paths, not reads, unless a bundled
 * import names a file there, such as a directory's index.
 */
export function shippedClosure({ packagePath, manifest, files, inputs = [], excluded = [], read, tsconfigRoots = () => null }) {
  const scope = { packagePath, inputs, excluded, options: classifyOptions(manifest) };
  const inventory = fileInventory(files);
  const roots = [packagePath, ...inputs];
  // Files a shipped script or shell build file runs, and local modules build files import (references marked `runs`).
  const runs = new Set();
  const describe = (file) => {
    if (file.startsWith(`${packagePath}/`)) {
      const relative = file.slice(packagePath.length + 1);
      return { root: packagePath, base: packagePath, buildFile: runs.has(file) || relative.startsWith("scripts/") || /^[^/]+\.config\.[^/]+$/.test(relative) };
    }
    const input = inputs.find((entry) => isWithin(file, entry));
    return { root: packagePath, base: file === input ? path.posix.dirname(file) : input, buildFile: runs.has(file) || !file.startsWith("uifn/") };
  };
  const references = [...scriptReferences(manifest?.scripts, packagePath), ...entryReferences(manifest, packagePath)];
  const promoted = new Map();
  const named = new Set();
  const scanned = new Set();
  const resolved = new Map();
  const compiled = new Set();
  const emitting = new Set();
  const packed = packlist(manifest, packagePath);
  let wave = files.filter((file) => pathKind(file, scope) === "shipped" || packed(file));
  for (let changed = true; changed; ) {
    const unread = wave.filter((file) => (SCANNED_FILE.test(file) || (file.endsWith(".sh") && describe(file).buildFile)) && !scanned.has(file));
    for (const [file, text] of read(unread)) references.push(...fileReferences(file, text, describe(file)).map((reference) => ({ ...reference, from: file })));
    for (const file of unread) scanned.add(file);
    wave = [];
    changed = false;
    for (const config of [...named].filter((file) => TSCONFIG.test(file) && !compiled.has(`${file}\0${emitting.has(file)}`))) {
      compiled.add(`${config}\0${emitting.has(config)}`);
      for (const target of tsconfigRoots(config, emitting.has(config)) ?? [`${path.posix.dirname(config)}/**`]) references.push({ from: config, target, soft: false });
    }
    for (const reference of references) {
      // A tsconfig include directory, or any directory argument of a script (the package root or a declared input root too), means every file under it.
      const tree = reference.tsconfig || reference.tree;
      const target = tree && inventory.dirs.has(reference.target) ? `${reference.target}/**` : reference.target;
      if (!resolved.has(target)) resolved.set(target, resolveReference(target, inventory));
      const { files: matches, direct } = resolved.get(target);
      if (reference.negated || (roots.some((root) => isWithin(root, target)) && !(reference.bundled && direct))) continue;
      // A file that starts running in the build is read again as a build file.
      for (const file of reference.runs && direct ? matches.filter((match) => RUNNABLE.test(match) && !runs.has(match)) : []) {
        runs.add(file);
        scanned.delete(file);
        wave.push(file);
        changed = true;
      }
      for (const file of (direct || reference.tsc) && !reference.tsconfig && !reference.overridden ? matches : []) {
        if (named.has(file) && (!reference.emit || emitting.has(file))) continue;
        named.add(file);
        if (reference.emit) emitting.add(file);
        changed = true;
      }
      const glob = GLOB.test(target);
      const negations = glob ? references.filter((other) => other.negated && other.from === reference.from && other.list === reference.list) : [];
      const consumes = !reference.tsconfig && (direct || glob || pathKind(`${target}/_`, scope) !== "shipped");
      for (const file of matches) {
        const kind = pathKind(file, scope);
        if (promoted.has(file) || negations.some((other) => coversPath(other.target, file)) || !(kind === "declared" || (kind === "excluded" && consumes))) continue;
        promoted.set(file, reference);
        wave.push(file);
        changed = true;
      }
    }
  }
  return { promoted, references, packed };
}

/**
 * What tsc compiles from the tsconfig `file` as TypeScript computes it over `inventory` (extends, include, exclude, files, allowJs), plus
 * the tsconfigs it references (which `tsc -b` builds; counted for `tsc -p` too); null on any error but TS18003, no inputs.
 * A config whose effective options set noEmit compiles none of its own files unless `emit` (a command-line `--noEmit false`) overrides it.
 */
export function tsconfigRoots(file, inventory, readFile, emit = false) {
  const ts = createRequire(import.meta.url)("typescript");
  const repoPath = (entry) => entry.replace(/^\/+|\/+$/g, "");
  const read = (entry) => (inventory.set.has(repoPath(entry)) ? (readFile(repoPath(entry)) ?? undefined) : undefined);
  const within = (dir, entries) => entries.filter((entry) => path.posix.dirname(entry) === (repoPath(dir) || ".")).map((entry) => path.posix.basename(entry));
  const entries = (dir) => ({ files: within(dir, inventory.files), directories: within(dir, [...inventory.dirs]) });
  const host = { useCaseSensitiveFileNames: true, fileExists: (entry) => inventory.set.has(repoPath(entry)), readFile: read, readDirectory: (root, extensions, excludes, includes, depth) => ts.matchFiles(root, extensions, excludes, includes, true, "/", depth, entries, (entry) => entry) };
  const { config, error } = ts.readConfigFile(`/${file}`, read);
  const parsed = error ? null : ts.parseJsonConfigFileContent(config, host, `/${path.posix.dirname(file)}`, undefined, `/${file}`);
  if (!parsed || parsed.errors.some((diagnostic) => diagnostic.code !== 18003)) return null;
  return [...(parsed.options.noEmit && !emit ? [] : parsed.fileNames), ...(parsed.projectReferences ?? []).map((reference) => ts.resolveProjectReferencePath(reference))].map(repoPath);
}

/**
 * Fails closed on build inputs outside a stable package: every path its shipped files, declared inputs,
 * shipped scripts or entry fields name outside its root must be a declared input or reference, and a
 * module a shipped source imports, which a bundler inlines, must be a declared input. Each reference is
 * judged by the files it resolves to in `inventory` (the whole tree at that end), as in shippedClosure:
 * a bundled import is covered only when every file it resolves to, or its own path if none, lies within a declared input.
 */
export function findUndeclaredReferences({ name, packagePath, references, declaration, inventory }) {
  const declared = [...declaration.inputs, ...declaration.references];
  const covers = (entries, files) => files.length > 0 && files.every((file) => entries.some((entry) => isWithin(file, entry)));
  const resolved = new Map();
  const errors = [];
  for (const { from, target, soft, bundled, tree, candidate } of references) {
    if (soft || isWithin(target, packagePath)) continue;
    const lookup = tree && inventory.dirs.has(target) ? `${target}/**` : target;
    if (!resolved.has(lookup)) resolved.set(lookup, resolveReference(lookup, inventory).files);
    const files = resolved.get(lookup);
    if (candidate && files.length === 0) continue;
    if (bundled) {
      // A specifier that resolves to nothing cannot be inlined (such as one inside generated code strings), so its own path is judged.
      const named = files.length > 0 ? files : [target];
      if (covers(declaration.inputs, named)) continue;
      if (covers(declared, named)) {
        errors.push(`${name}: ${from} imports ${target}, which ${INPUTS_PATH} declares only under "references"; the bundler can inline it, so declare it under "inputs"`);
        continue;
      }
    } else {
      if (declared.some((entry) => isWithin(target, entry)) || covers(declared, files)) continue;
      // An ancestor directory such as `path.resolve(here, "..")` is a base path, not a read.
      if ([packagePath, ...declaration.inputs].some((root) => isWithin(root, target))) continue;
    }
    errors.push(`${name}: ${from} refers to ${target}, outside ${packagePath}; declare it in ${INPUTS_PATH} under "inputs" if it feeds the tarball or "references" if it does not, with a reason`);
  }
  return [...new Set(errors)];
}

/** What npm packs for `files`, Markdown aside as documentation: an entry with no inner slash matches at any depth, a directory includes everything under it, and no list packs the whole package. */
export function packlist(manifest, packagePath) {
  const listed = Array.isArray(manifest?.files) ? manifest.files.filter((entry) => typeof entry === "string" && !entry.startsWith("!")) : ["**"];
  const patterns = listed.map((entry) => path.posix.join(packagePath, /\/./.test(entry) ? "" : "**", entry).replace(/\/+$/, ""));
  return (file) => !/\.mdx?$/i.test(file) && patterns.some((pattern) => coversPath(pattern, file));
}

/**
 * An "excluded" path must not reach the tarball: no manifest `files` entry may match it or a file in it, it may not cover a
 * build config that tools load implicitly, and the shipped closure may not reach any file in it.
 */
export function findConsumedExclusions({ name, packagePath, manifest, excluded, packageFiles = [], promoted }) {
  const packed = packlist(manifest, packagePath);
  const options = classifyOptions(manifest);
  const errors = [];
  for (const entry of excluded) {
    const absolute = `${packagePath}/${entry}`;
    const config = [entry, ...packageFiles.filter((file) => isWithin(file, absolute)).map((file) => file.slice(packagePath.length + 1))]
      .find((relative) => !relative.includes("/") && IMPLICIT_CONFIG.test(relative) && classifyPath(relative, options) === "shipped");
    if (config) {
      errors.push(`${INPUTS_PATH}: ${name} excludes ${entry}, but the build loads ${config} implicitly; it shapes the tarball, so remove the exclusion`);
      continue;
    }
    const listedFile = [absolute, ...packageFiles.filter((file) => isWithin(file, absolute))].find(packed);
    const reached = [...promoted].find(([file]) => isWithin(file, absolute));
    const user = listedFile ? `package.json ${Array.isArray(manifest?.files) ? "files includes" : "has no files list, so npm packs"} ${listedFile}` : reached && `${reached[1].from} refers to ${reached[0]}`;
    if (user) errors.push(`${INPUTS_PATH}: ${name} excludes ${entry}, but ${user}; it reaches the tarball, so remove the exclusion`);
  }
  return errors;
}

function git(cwd, args) {
  return execFileSync(gitBinary(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

// A user's ref reaches git on stdin, never as an argument git could read as an option; only the commit id it names is used.
function resolveCommit(cwd, ref) {
  const resolved = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) commit \d+\n$/.exec(execFileSync(gitBinary(), ["cat-file", "--batch-check"], { cwd, input: `${ref}^{commit}\n`, encoding: "utf8" }));
  if (!resolved) throw new Error(`Cannot resolve ${ref} to a commit; fetch it first (CI needs fetch-depth: 0)`);
  return resolved[1];
}

function readAt(cwd, commit, file) {
  try {
    git(cwd, ["cat-file", "-e", `${commit}:${file}`]);
  } catch {
    return null;
  }
  return git(cwd, ["show", `${commit}:${file}`]);
}

function readJsonAt(cwd, commit, file) {
  const text = readAt(cwd, commit, file);
  return text === null ? null : JSON.parse(text);
}

/**
 * Stable packages at `commit` with their declarations, and where every graph package lives. The head
 * must have a stable list; an earlier commit is read leniently, so a missing or malformed graph or
 * declarations file there declares nothing.
 */
function loadPackages(cwd, commit, { required = true } = {}) {
  let graph = null;
  try {
    graph = readJsonAt(cwd, commit, GRAPH_PATH);
  } catch (error) {
    if (required) throw error;
  }
  if (!Array.isArray(graph?.stable)) {
    if (required) throw new Error(`${GRAPH_PATH} at ${commit} has no stable package list`);
    return { packages: new Map(), locations: new Map(), errors: [] };
  }
  const entries = (list) =>
    (Array.isArray(list) ? list : []).flatMap((entry) => {
      if (typeof entry?.name === "string" && typeof entry?.path === "string") return [[entry.name, entry.path]];
      if (required) throw new Error(`${GRAPH_PATH} at ${commit} has an entry without a name and path: ${JSON.stringify(entry)}`);
      return [];
    });
  const stable = new Map(entries(graph.stable));
  let parsed;
  try {
    parsed = parseInputDeclarations(readJsonAt(cwd, commit, INPUTS_PATH), stable);
  } catch (error) {
    if (required) throw error;
    parsed = parseInputDeclarations(null, stable);
  }
  return {
    packages: new Map([...stable].map(([name, packagePath]) => [name, { name, packagePath, ...parsed.declarations.get(name) }])),
    locations: new Map([...entries(graph.experimental), ...stable]),
    errors: required ? parsed.errors : [],
  };
}

function listFiles(cwd, commit, pathspecs) {
  return git(cwd, ["ls-tree", "-r", "-z", "--name-only", commit, "--", ...pathspecs]).split("\0").filter(Boolean);
}

function readBlobs(cwd, commit, files) {
  if (files.length === 0) return new Map();
  const output = execFileSync(gitBinary(), ["cat-file", "--batch"], { cwd, input: files.map((file) => `${commit}:${file}\n`).join(""), maxBuffer: 512 * 1024 * 1024 });
  const blobs = new Map();
  let offset = 0;
  for (const file of files) {
    const newline = output.indexOf(10, offset);
    const [, type, size] = output.toString("utf8", offset, newline).split(" ");
    offset = newline + 1;
    if (type === "missing") continue;
    blobs.set(file, output.toString("utf8", offset, offset + Number(size)));
    offset += Number(size) + 1;
  }
  return blobs;
}

/** One end of a range: a package as declared at `commit`, and which paths ship from it there. */
function packageState(cwd, commit, pkg) {
  const manifest = readJsonAt(cwd, commit, `${pkg.packagePath}/package.json`);
  const packageFiles = listFiles(cwd, commit, [pkg.packagePath]);
  const files = [...packageFiles, ...(pkg.inputs.length > 0 ? listFiles(cwd, commit, pkg.inputs) : [])];
  let tree;
  const { promoted, references, packed } = shippedClosure({ ...pkg, manifest, files, read: (paths) => readBlobs(cwd, commit, paths), tsconfigRoots: (file, emit) => tsconfigRoots(file, (tree ??= fileInventory(listFiles(cwd, commit, ["."]))), (entry) => readAt(cwd, commit, entry), emit) });
  const present = new Set(files);
  const scope = { packagePath: pkg.packagePath, inputs: pkg.inputs, excluded: pkg.excluded, options: classifyOptions(manifest) };
  // A file the packlist matches ships, tests included. package.json always packs, so it counts only through publishedManifest.
  const ownManifest = `${pkg.packagePath}/package.json`;
  return { manifest, packageFiles, promoted, references, ships: (file) => present.has(file) && (promoted.has(file) || (file !== ownManifest && (packed(file) || pathKind(file, scope) === "shipped"))) };
}

function stateCache(cwd) {
  const cache = new Map();
  return (commit, pkg) => {
    const key = `${commit}\0${JSON.stringify(pkg)}`;
    if (!cache.has(key)) cache.set(key, packageState(cwd, commit, pkg));
    return cache.get(key);
  };
}

/** Runs the out-of-root and exclusion guard for every stable package at `commit`, with that commit's own declarations. */
function guardReferences(cwd, commit, packages, stateAt) {
  const inventory = fileInventory(listFiles(cwd, commit, ["."]));
  const errors = [];
  for (const pkg of packages) {
    const { name, packagePath, inputs, references, excluded } = pkg;
    for (const target of [...inputs, ...references]) {
      if (listFiles(cwd, commit, [target]).length === 0) errors.push(`${INPUTS_PATH}: ${name} declares ${target}, which does not exist`);
    }
    for (const entry of excluded) {
      if (listFiles(cwd, commit, [`${packagePath}/${entry}`]).length === 0) errors.push(`${INPUTS_PATH}: ${name} excludes ${entry}, which does not exist in ${packagePath}`);
    }
    const { manifest, packageFiles, promoted, references: used } = stateAt(commit, pkg);
    errors.push(...findUndeclaredReferences({ name, packagePath, references: used, declaration: pkg, inventory }));
    errors.push(...findConsumedExclusions({ name, packagePath, manifest, excluded, packageFiles, promoted }));
  }
  return errors;
}

function changedFiles(cwd, from, to, pathspecs) {
  return git(cwd, ["diff", "--name-only", "-z", "--no-renames", from, to, "--", ...pathspecs]).split("\0").filter(Boolean);
}

/**
 * Judges each package across `from..to`. `base` and `head` are the package as declared at each end
 * (null where it is not stable); `basePath` and `headPath` locate its manifest. A changed path counts
 * when it ships at an end where it exists, by that end's own path, declarations and manifest: a path
 * present at the base keeps the base's classification, a new path takes the head's (which the guard
 * checks), and a deleted one is judged only at the base.
 */
function evaluateRange(cwd, from, to, entries, stateAt) {
  const roots = entries.flatMap(({ base, head }) => [base, head].filter(Boolean).flatMap(({ packagePath, inputs }) => [packagePath, ...inputs]));
  const files = changedFiles(cwd, from, to, [...new Set(roots)]);
  return entries.map(({ name, base, head, basePath, headPath }) => {
    const ends = [base && stateAt(from, base), head && stateAt(to, head)].filter(Boolean);
    return evaluatePackage({
      name,
      packagePath: headPath,
      baseManifest: readJsonAt(cwd, from, `${basePath}/package.json`),
      headManifest: readJsonAt(cwd, to, `${headPath}/package.json`),
      shippedFiles: files.filter((file) => ends.some((state) => state.ships(file))),
      headChangelog: readAt(cwd, to, `${headPath}/CHANGELOG.md`),
      stable: Boolean(head) && !head.demoted,
    });
  });
}

/**
 * PR gate: every package stable at the merge base or the head whose shipped code, declared inputs or
 * published manifest changed must bump and log it, and no package may use an undeclared out-of-root input.
 */
export function verifyVersionBumps({ cwd = process.cwd(), base, head = "HEAD" }) {
  const headCommit = resolveCommit(cwd, head);
  const baseCommit = resolveCommit(cwd, base);
  let mergeBase;
  try {
    mergeBase = git(cwd, ["merge-base", baseCommit, headCommit]).trim();
  } catch {
    throw new Error(`${base} and ${head} share no history; fetch full history before running this check`);
  }
  const atHead = loadPackages(cwd, headCommit);
  const atBase = loadPackages(cwd, mergeBase, { required: false });
  // A package the head demotes, moves or drops is still judged at its merge-base path, and one it keeps at the head too, with its base declarations.
  const names = [...new Set([...atBase.packages.keys(), ...atHead.packages.keys()])];
  const entries = names.map((name) => {
    const basePackage = atBase.packages.get(name) ?? null;
    const headPackage = atHead.packages.get(name) ?? null;
    const basePath = atBase.locations.get(name) ?? headPackage?.packagePath ?? atHead.locations.get(name);
    const headPath = atHead.locations.get(name) ?? basePath;
    return { name, base: basePackage, head: headPackage ?? (basePackage && { ...basePackage, packagePath: headPath, demoted: true }), basePath, headPath };
  });
  const stateAt = stateCache(cwd);
  const results = evaluateRange(cwd, mergeBase, headCommit, entries, stateAt);
  const errors = [...atHead.errors, ...guardReferences(cwd, headCommit, [...atHead.packages.values()], stateAt), ...results.flatMap((result) => result.errors)];
  return { mergeBase, head: headCommit, results, errors };
}

/** Informational: shipped changes on `head` since each stable package's highest published tag. */
export function reportSincePublished({ cwd = process.cwd(), head = "HEAD" }) {
  const headCommit = resolveCommit(cwd, head);
  const targets = readJsonAt(cwd, headCommit, RELEASE_TARGETS_PATH) ?? [];
  const stateAt = stateCache(cwd);
  return [...loadPackages(cwd, headCommit).packages.values()].map((pkg) => {
    const slug = targets.find((target) => target.name === pkg.name)?.slug ?? `uifn-${path.posix.basename(pkg.packagePath)}`;
    const tags = git(cwd, ["tag", "--list", `${slug}-v*`])
      .split("\n")
      .map((tag) => ({ tag, version: tag.slice(slug.length + 2) }))
      .filter(({ tag, version }) => tag && parseSemver(version))
      .sort((a, b) => compareSemver(b.version, a.version));
    if (tags.length === 0) return { name: pkg.name, packagePath: pkg.packagePath, tag: null };
    const tagCommit = resolveCommit(cwd, tags[0].tag);
    // Published tags predate the declarations file, so the tag end uses the head's path and declarations, plus any inputs the tag declared.
    const earlier = loadPackages(cwd, tagCommit, { required: false }).packages.get(pkg.name);
    const tagPackage = { ...pkg, inputs: [...new Set([...(earlier?.inputs ?? []), ...pkg.inputs])] };
    const [result] = evaluateRange(cwd, tagCommit, headCommit, [{ name: pkg.name, base: tagPackage, head: pkg, basePath: pkg.packagePath, headPath: pkg.packagePath }], stateAt);
    return { ...result, tag: tags[0].tag };
  });
}

function formatReport(entries) {
  const lines = ["uifn stable packages: shipped changes since the last published tag (informational)"];
  let changed = 0;
  for (const entry of entries) {
    if (!entry.tag) {
      lines.push(`  ${entry.name}: no published tag`);
      continue;
    }
    const drift = entry.shippedFiles.length > 0 || entry.manifestChanged;
    if (drift) changed += 1;
    const what = drift
      ? `${entry.shippedFiles.length} shipped file(s) changed${entry.manifestChanged ? " + published manifest fields" : ""}`
      : "no shipped changes";
    const version = entry.bumped ? `version ${entry.baseVersion} -> ${entry.headVersion} (unpublished)` : `version ${entry.headVersion}`;
    lines.push(`  ${entry.name}: ${entry.tag} -> HEAD: ${what}; ${version}`);
  }
  lines.push(`${changed} of ${entries.length} stable packages have shipped changes since their last published tag.`);
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { base: { type: "string" }, head: { type: "string", default: "HEAD" }, "since-published": { type: "boolean", default: false } },
    });
    if (values["since-published"]) {
      // The report is informational, so a failure to build it warns instead of failing CI.
      try {
        console.log(formatReport(reportSincePublished({ head: values.head })));
      } catch (error) {
        console.warn(`warning: could not report changes since the last published tags: ${error.message}`);
      }
    } else {
      if (!values.base) throw new Error("Usage: verify-uifn-version-bump.mjs --base <ref> [--head <ref>] | --since-published [--head <ref>]");
      const { mergeBase, head, results, errors } = verifyVersionBumps({ base: values.base, head: values.head });
      console.log(`uifn version bump check: ${mergeBase.slice(0, 12)}...${head.slice(0, 12)}`);
      for (const result of results.filter((entry) => entry.errors.length === 0 && entry.bumped)) {
        console.log(`  ok ${result.name}: ${result.baseVersion} -> ${result.headVersion} with changelog entry`);
      }
      if (errors.length > 0) {
        for (const error of errors) console.error(`  error: ${error}`);
        process.exitCode = 1;
      } else {
        console.log("  ok: no stable package ships changed code under an unchanged version");
      }
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
