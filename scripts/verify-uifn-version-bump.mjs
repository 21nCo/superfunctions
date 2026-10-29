#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { gitBinary } from "./verify-package-lockfiles.mjs";

const GRAPH_PATH = "uifn/package-graph.json";
const INPUTS_PATH = "uifn/version-bump-inputs.json";
const RELEASE_TARGETS_PATH = "release-packages.json";

// Shipped code is everything that feeds the tarball (`dist` is built from the
// package sources and configs) minus tests, fixtures, stories, harnesses and
// Markdown docs. Unknown paths count as shipped so new build inputs fail closed;
// data and helpers that never reach the tarball are declared "excluded", and the
// guard rejects an exclusion that `files`, a tsconfig include or a shipped file uses.
const NON_SHIPPED_SEGMENTS = new Set(["__tests__", "__mocks__", "__fixtures__", "__snapshots__", "fixtures", "test", "tests"]);
const NON_SHIPPED_ROOT_DIRS = new Set(["browser", "stories", "type-tests", "workbenches"]);
const NON_SHIPPED_FILE = /(?:\.(?:test|spec|test-d|stories)\.[^/]+|\.mdx?|\.snap)$/i;
const NON_SHIPPED_ROOT_FILE = /^(?:vitest|playwright)(?:\.[^/]+)?\.config\.[^/]+$/;
// A root Vite config is a build input only when the package builds with Vite.
const VITE_ROOT_FILE = /^vite(?:\.[^/]+)?\.config\.[^/]+$/;
// Scripts that run when a package is packed, published or installed, plus `build`, which
// prepack runs. devDependencies and scripts these never reach do not affect consumers.
const LIFECYCLE_SCRIPTS = ["build", "prepare", "prepack", "postpack", "prepublish", "prepublishOnly", "preinstall", "install", "postinstall"];
// Validation reached from prepack (`npm run typecheck && npm run test`, `generate:check`) can stop a
// pack but produces nothing in it, so a script named test, typecheck, lint, check or verify, alone or
// as a `:` part, is not followed.
const VALIDATION_SCRIPT_PART = new Set(["test", "typecheck", "lint", "check", "verify"]);
// Root build configs that tsup, tsc, svelte-package, vite and npm pack load without being named.
const IMPLICIT_CONFIG = /^(?:(?:tsup|vite|rollup|svelte|babel|postcss|tailwind)(?:\.[^/]+)?\.config\.[^/]+|tsconfig[^/]*\.json|\.npmignore|\.babelrc(?:\.[^/]+)?)$/;
// Extensions a bundler or tsc tries for an extensionless specifier or a directory index.
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".json", ".css"];
const NPM_RUN = /\bnpm\s+(?:run(?:-script)?|rum|urn)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*([^\s&|;<>()'"]+)/g;
const NPM_SHORTHAND = /\bnpm\s+(test|tst|t|start|stop|restart)\b/g;

// Strict semver, as in scripts/resolve-release-tag.mjs: no leading zeros in numeric parts.
const NUMBER = "(?:0|[1-9][0-9]*)";
const IDENTIFIER = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(`^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

// The out-of-root guard reads these files for relative specifiers, `".."` path segments and,
// in build files, repo-root paths. Other JSON is data. Runtime reads through computed paths are not detected.
const SCANNED_FILE = /(?:\.(?:[cm]?[jt]sx?|svelte|css)|(?:^|\/)[tj]sconfig[^/]*\.json)$/;
const SPECIFIER = /(['"`])(\.\.?(?:\/[^'"`\n]*?)?)(?:\1|\$\{)/g;
const LITERAL_ARGUMENT = /\s*,\s*(['"`])([^'"`\n]*)\1/y;
const REPO_PATH = /(['"`])((?:uifn|scripts)\/[^'"`\s]*?)(?:\1|\$\{)/g;
const TSCONFIG = /(?:^|\/)tsconfig[^/]*\.json$/;
const TSCONFIG_LIST = /"(?:include|files)"\s*:\s*\[([^\]]*)\]/g;

const isWithin = (file, root) => root === "." || file === root || file.startsWith(`${root}/`);

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

/** Shipped lifecycle scripts, their pre/post hooks, and every non-validation script they reach through `npm run`. */
export function shippedScriptNames(scripts = {}) {
  const names = new Set();
  const pending = [...LIFECYCLE_SCRIPTS];
  while (pending.length > 0) {
    const name = pending.pop();
    if (names.has(name) || isValidationScript(name) || !Object.hasOwn(scripts, name) || typeof scripts[name] !== "string") continue;
    names.add(name);
    pending.push(`pre${name}`, `post${name}`);
    for (const [, target] of scripts[name].matchAll(NPM_RUN)) pending.push(target);
    for (const [, alias] of scripts[name].matchAll(NPM_SHORTHAND)) pending.push(alias === "t" || alias === "tst" ? "test" : alias);
  }
  return names;
}

/** Returns the manifest fields that reach consumers, without the version itself. */
export function publishedManifest(manifest) {
  const { version: _version, devDependencies: _devDependencies, scripts, ...published } = manifest;
  const names = [...shippedScriptNames(scripts ?? {})].sort();
  if (names.length > 0) published.scripts = Object.fromEntries(names.map((name) => [name, scripts[name]]));
  return published;
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

/** Pure per-package decision shared by the PR gate and the since-published report. */
export function evaluatePackage({ name, packagePath, baseManifest, headManifest, changedFiles, headChangelog, inputs = [], excluded = [], promoted = new Set() }) {
  const prefix = `${packagePath}/`;
  const options = classifyOptions(headManifest ?? baseManifest);
  // `promoted` holds test, fixture or docs paths that a shipped file or lifecycle script uses.
  const isShipped = (file) => promoted.has(file) || pathKind(file, { packagePath, inputs, excluded, options }) === "shipped";
  const shippedFiles = changedFiles.filter(isShipped).sort();
  const result = { name, packagePath, shippedFiles, manifestChanged: false, baseVersion: baseManifest?.version, headVersion: headManifest?.version, bumped: false, errors: [] };
  if (!headManifest) {
    result.errors.push(`${name}: ${packagePath}/package.json is missing`);
    return result;
  }
  if (!baseManifest) return result;
  result.manifestChanged = JSON.stringify(publishedManifest(baseManifest)) !== JSON.stringify(publishedManifest(headManifest));
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
    result.errors.push(`${name}: shipped code changed (${listed}) but version is still ${result.headVersion}; bump ${packagePath}/package.json and add a "## <new version>" entry to ${packagePath}/CHANGELOG.md, or, for in-package paths that never reach the tarball, first land an "excluded" declaration in ${INPUTS_PATH} (the gate honors exclusions already on the base branch)`);
  }
  return result;
}

/** Repo paths a file refers to: relative specifiers, `".."` path segments and, in build files, repo-root paths. */
export function fileReferences(file, text, { base = path.posix.dirname(file), buildFile = false } = {}) {
  const dir = path.posix.dirname(file);
  const found = [];
  for (const match of text.matchAll(SPECIFIER)) {
    const segments = [match[2]];
    LITERAL_ARGUMENT.lastIndex = match.index + match[0].length;
    for (let argument = LITERAL_ARGUMENT.exec(text); argument; argument = LITERAL_ARGUMENT.exec(text)) segments.push(argument[2]);
    found.push(path.posix.join(dir, ...segments));
    // `path.resolve(packageRoot, "..", "x")`: the base expression is unknown, so also try the package root.
    if (segments.length > 1 && match[2].startsWith("..")) found.push(path.posix.join(base, ...segments));
  }
  if (buildFile) for (const match of text.matchAll(REPO_PATH)) found.push(path.posix.normalize(match[2]));
  return [...new Set(found.map((target) => target.replace(/\/+$/, "")))];
}

/** Repo paths that shipped lifecycle scripts name, each token resolved from the package root. */
export function scriptReferences(scripts, packagePath) {
  const found = [];
  for (const name of shippedScriptNames(scripts ?? {})) {
    for (const token of scripts[name].split(/[\s;&|<>()]+/)) {
      const value = token.replace(/^['"]+|['"]+$/g, "").replace(/^-{1,2}[\w-]+=/, "");
      // Bare words such as `tsup` or `test` are commands, not paths, so only path-like tokens promote files.
      if (value) found.push({ from: `package.json scripts.${name}`, target: path.posix.join(packagePath, value).replace(/\/+$/, ""), pathLike: /[/.]/.test(value) });
    }
  }
  return found;
}

/** Files a reference names: the path itself, with an implied extension or index file, or a `.js` specifier's TypeScript source. */
export function resolveTarget(target, files) {
  const candidates = [target, ...RESOLVE_EXTENSIONS.flatMap((extension) => [`${target}${extension}`, `${target}/index${extension}`])];
  const compiled = target.match(/^(.*)\.([mc]?)js(x?)$/);
  if (compiled) candidates.push(`${compiled[1]}.${compiled[2]}ts${compiled[3]}`);
  return candidates.filter((candidate) => files.has(candidate));
}

/**
 * Every package or declared-input file that can reach the tarball: the default-shipped files plus,
 * transitively, test, fixture or docs paths that a shipped file or lifecycle script refers to. A
 * directory reference promotes its files only when the directory itself is a test, fixture or docs
 * path, so `path.join(root, "src")` does not pull in src/__tests__. Declared exclusions are not
 * followed; findConsumedExclusions rejects a reference into one instead.
 */
export function shippedClosure({ packagePath, manifest, files, inputs = [], excluded = [], read }) {
  const scope = { packagePath, inputs, excluded, options: classifyOptions(manifest) };
  const fileSet = new Set(files);
  const promoted = new Set();
  const scanned = [];
  const describe = (file) => {
    if (file.startsWith(`${packagePath}/`)) {
      const relative = file.slice(packagePath.length + 1);
      return { file, base: packagePath, buildFile: relative.startsWith("scripts/") || /^[^/]+\.config\.[^/]+$/.test(relative) };
    }
    const input = inputs.find((entry) => isWithin(file, entry));
    return { file, base: file === input ? path.posix.dirname(file) : input, buildFile: !file.startsWith("uifn/") };
  };
  let targets = scriptReferences(manifest?.scripts, packagePath).filter(({ pathLike }) => pathLike).map(({ target }) => target);
  let wave = files.filter((file) => pathKind(file, scope) === "shipped");
  while (wave.length > 0 || targets.length > 0) {
    const blobs = read(wave.filter((file) => SCANNED_FILE.test(file)));
    for (const [file, text] of blobs) {
      const entry = { ...describe(file), text };
      scanned.push(entry);
      targets.push(...fileReferences(file, text, entry));
    }
    wave = [];
    for (const target of targets) {
      const named = resolveTarget(target, fileSet);
      if (pathKind(`${target}/_`, scope) === "excluded") named.push(...files.filter((file) => file.startsWith(`${target}/`)));
      for (const file of named) {
        if (promoted.has(file) || pathKind(file, scope) !== "excluded") continue;
        promoted.add(file);
        wave.push(file);
      }
    }
    targets = [];
  }
  return { promoted, scanned };
}

const staticPrefix = (pattern) => {
  const segments = pattern.replace(/^\.\//, "").split("/");
  const glob = segments.findIndex((segment) => /[*?[{]/.test(segment));
  return (glob < 0 ? segments : segments.slice(0, glob)).join("/");
};

/** Paths a tsconfig compiles: the static prefix of each `include` and `files` entry, from its directory. */
export function tsconfigRoots(file, text) {
  const roots = [];
  for (const [, list] of text.matchAll(TSCONFIG_LIST)) {
    for (const [, entry] of list.matchAll(/"([^"]*)"/g)) roots.push(path.posix.join(path.posix.dirname(file), staticPrefix(entry)));
  }
  return roots.map((target) => target.replace(/\/+$/, ""));
}

function collectReferences({ packagePath, manifest, files }) {
  return [
    ...scriptReferences(manifest?.scripts, packagePath),
    ...files.flatMap(({ file, text, base, buildFile }) => fileReferences(file, text, { base, buildFile }).map((target) => ({ from: file, target }))),
  ];
}

/**
 * Fails closed on build inputs outside a stable package: every path its shipped files, declared
 * inputs or shipped scripts refer to outside its root must be a declared input or reference.
 */
export function findUndeclaredReferences({ name, packagePath, manifest, files, declaration }) {
  const declared = [...declaration.inputs, ...declaration.references];
  const errors = [];
  for (const { from, target } of collectReferences({ packagePath, manifest, files })) {
    if (isWithin(target, packagePath) || declared.some((entry) => isWithin(target, entry))) continue;
    // An ancestor directory such as `path.resolve(here, "..")` is a base path, not a read.
    if ([packagePath, ...declaration.inputs].some((root) => isWithin(root, target))) continue;
    errors.push(`${name}: ${from} refers to ${target}, outside ${packagePath}; declare it in ${INPUTS_PATH} under "inputs" if it feeds the tarball or "references" if it does not, with a reason`);
  }
  return [...new Set(errors)];
}

/**
 * An "excluded" path must not reach the tarball: it may not overlap the manifest `files` list or a
 * tsconfig include, cover a build config that tools load implicitly, and no shipped file, declared
 * input or shipped script may refer into it.
 */
export function findConsumedExclusions({ name, packagePath, manifest, files, excluded, packageFiles = [] }) {
  const listed = Array.isArray(manifest?.files) ? manifest.files.filter((entry) => typeof entry === "string" && !entry.startsWith("!")) : [];
  const roots = [
    ...listed.map((entry) => ({ from: "package.json files", target: path.posix.join(packagePath, staticPrefix(entry)).replace(/\/+$/, "") })),
    ...files.filter(({ file }) => TSCONFIG.test(file)).flatMap(({ file, text }) => tsconfigRoots(file, text).map((target) => ({ from: `${file} include`, target }))),
  ];
  const references = collectReferences({ packagePath, manifest, files });
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
    const root = roots.find(({ target }) => isWithin(absolute, target) || isWithin(target, absolute));
    const reference = references.find(({ target }) => isWithin(target, absolute));
    const user = root ? `${root.from} includes ${root.target}` : reference && `${reference.from} refers to ${reference.target}`;
    if (user) errors.push(`${INPUTS_PATH}: ${name} excludes ${entry}, but ${user}; it reaches the tarball, so remove the exclusion`);
  }
  return errors;
}

function git(cwd, args) {
  return execFileSync(gitBinary(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function resolveCommit(cwd, ref) {
  try {
    return git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch {
    throw new Error(`Cannot resolve ${ref} to a commit; fetch it first (CI needs fetch-depth: 0)`);
  }
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

function loadPackages(cwd, commit) {
  const graph = readJsonAt(cwd, commit, GRAPH_PATH);
  if (!Array.isArray(graph?.stable)) throw new Error(`${GRAPH_PATH} at ${commit} has no stable package list`);
  const stable = new Map(graph.stable.map(({ name, path: packagePath }) => [name, packagePath]));
  const { declarations, errors } = parseInputDeclarations(readJsonAt(cwd, commit, INPUTS_PATH), stable);
  return { stable, packages: [...stable].map(([name, packagePath]) => ({ name, packagePath, ...declarations.get(name) })), errors };
}

/** Declarations at an older commit, read leniently: a missing or malformed file declares nothing. */
function loadEarlierDeclarations(cwd, commit, stable) {
  try {
    return parseInputDeclarations(readJsonAt(cwd, commit, INPUTS_PATH), stable).declarations;
  } catch {
    return new Map();
  }
}

/** Paths covered by an entry in both lists. */
function sharedPaths(left, right) {
  const covered = (entries, others) => entries.filter((entry) => others.some((other) => isWithin(entry, other)));
  return [...new Set([...covered(left, right), ...covered(right, left)])];
}

/**
 * The declarations a range is judged by, so a change cannot loosen its own check: inputs declared at
 * either end count, and in the PR gate only exclusions already declared at the merge base are honored.
 * The since-published report honors the head's exclusions, because published tags predate the file.
 */
export function effectiveDeclaration(earlier, head, { honorNewExclusions = false } = {}) {
  return {
    ...head,
    inputs: [...new Set([...(earlier?.inputs ?? []), ...head.inputs])],
    excluded: honorNewExclusions ? head.excluded : sharedPaths(earlier?.excluded ?? [], head.excluded),
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

/** Reads one package at `commit` and computes the files that can reach its tarball. */
function packageState(cwd, commit, pkg) {
  const manifest = readJsonAt(cwd, commit, `${pkg.packagePath}/package.json`);
  const packageFiles = listFiles(cwd, commit, [pkg.packagePath]);
  const files = [...packageFiles, ...(pkg.inputs.length > 0 ? listFiles(cwd, commit, pkg.inputs) : [])];
  return { manifest, packageFiles, ...shippedClosure({ ...pkg, manifest, files, read: (paths) => readBlobs(cwd, commit, paths) }) };
}

/** Runs the out-of-root and exclusion guard for every stable package at `commit`, with the head's own declarations. */
function guardReferences(cwd, commit, packages) {
  const errors = [];
  for (const pkg of packages) {
    const { name, packagePath, inputs, references, excluded } = pkg;
    for (const target of [...inputs, ...references]) {
      if (listFiles(cwd, commit, [target]).length === 0) errors.push(`${INPUTS_PATH}: ${name} declares ${target}, which does not exist`);
    }
    for (const entry of excluded) {
      if (listFiles(cwd, commit, [`${packagePath}/${entry}`]).length === 0) errors.push(`${INPUTS_PATH}: ${name} excludes ${entry}, which does not exist in ${packagePath}`);
    }
    const { manifest, packageFiles, scanned: files } = packageState(cwd, commit, pkg);
    errors.push(...findUndeclaredReferences({ name, packagePath, manifest, files, declaration: pkg }));
    errors.push(...findConsumedExclusions({ name, packagePath, manifest, files, excluded, packageFiles }));
  }
  return errors;
}

function changedFiles(cwd, from, to, pathspecs) {
  return git(cwd, ["diff", "--name-only", "-z", "--no-renames", from, to, "--", ...pathspecs]).split("\0").filter(Boolean);
}

/** Judges each package by its effective declarations; a path promoted at either end counts. */
function evaluateRange(cwd, from, to, packages) {
  const files = changedFiles(cwd, from, to, [...new Set(packages.flatMap(({ packagePath, inputs }) => [packagePath, ...inputs]))]);
  return packages.map((pkg) => {
    const { name, packagePath, inputs, excluded } = pkg;
    const promoted = new Set([...packageState(cwd, from, pkg).promoted, ...packageState(cwd, to, pkg).promoted]);
    return evaluatePackage({
      name,
      packagePath,
      baseManifest: readJsonAt(cwd, from, `${packagePath}/package.json`),
      headManifest: readJsonAt(cwd, to, `${packagePath}/package.json`),
      changedFiles: files,
      headChangelog: readAt(cwd, to, `${packagePath}/CHANGELOG.md`),
      inputs,
      excluded,
      promoted,
    });
  });
}

/**
 * PR gate: every stable package whose shipped code, declared inputs or published manifest changed
 * since the merge base must bump and log it, and no package may use an undeclared out-of-root input.
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
  const { stable, packages, errors: declarationErrors } = loadPackages(cwd, headCommit);
  const earlier = loadEarlierDeclarations(cwd, mergeBase, stable);
  const results = evaluateRange(cwd, mergeBase, headCommit, packages.map((pkg) => effectiveDeclaration(earlier.get(pkg.name), pkg)));
  const errors = [...declarationErrors, ...guardReferences(cwd, headCommit, packages), ...results.flatMap((result) => result.errors)];
  return { mergeBase, head: headCommit, results, errors };
}

/** Informational: shipped changes on `head` since each stable package's highest published tag. */
export function reportSincePublished({ cwd = process.cwd(), head = "HEAD" }) {
  const headCommit = resolveCommit(cwd, head);
  const targets = readJsonAt(cwd, headCommit, RELEASE_TARGETS_PATH) ?? [];
  const { stable, packages } = loadPackages(cwd, headCommit);
  return packages.map((pkg) => {
    const slug = targets.find((target) => target.name === pkg.name)?.slug ?? `uifn-${path.posix.basename(pkg.packagePath)}`;
    const tags = git(cwd, ["tag", "--list", `${slug}-v*`])
      .split("\n")
      .map((tag) => ({ tag, version: tag.slice(slug.length + 2) }))
      .filter(({ tag, version }) => tag && parseSemver(version))
      .sort((a, b) => compareSemver(b.version, a.version));
    if (tags.length === 0) return { name: pkg.name, packagePath: pkg.packagePath, tag: null };
    const tagCommit = resolveCommit(cwd, tags[0].tag);
    const declaration = effectiveDeclaration(loadEarlierDeclarations(cwd, tagCommit, stable).get(pkg.name), pkg, { honorNewExclusions: true });
    const [result] = evaluateRange(cwd, tagCommit, headCommit, [declaration]);
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
