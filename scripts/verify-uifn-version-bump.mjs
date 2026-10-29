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

/** Shipped lifecycle scripts, their pre/post hooks, and every script they reach through `npm run`. */
export function shippedScriptNames(scripts = {}) {
  const names = new Set();
  const pending = [...LIFECYCLE_SCRIPTS];
  while (pending.length > 0) {
    const name = pending.pop();
    if (names.has(name) || !Object.hasOwn(scripts, name) || typeof scripts[name] !== "string") continue;
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

/** Pure per-package decision shared by the PR gate and the since-published report. */
export function evaluatePackage({ name, packagePath, baseManifest, headManifest, changedFiles, headChangelog, inputs = [], excluded = [] }) {
  const prefix = `${packagePath}/`;
  const options = classifyOptions(headManifest ?? baseManifest);
  const isShipped = (file) => {
    if (file.startsWith(prefix)) {
      const relative = file.slice(prefix.length);
      return !excluded.some((entry) => isWithin(relative, entry)) && classifyPath(relative, options) === "shipped";
    }
    // Declared out-of-package inputs count too; inside a declared directory, tests and docs still do not.
    const input = inputs.find((entry) => isWithin(file, entry));
    return Boolean(input) && (file === input || classifyPath(file.slice(input.length + 1)) !== "excluded");
  };
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
    result.errors.push(`${name}: shipped code changed (${listed}) but version is still ${result.headVersion}; bump ${packagePath}/package.json and add a "## <new version>" entry to ${packagePath}/CHANGELOG.md, or declare in-package paths that never reach the tarball under "excluded" in ${INPUTS_PATH}`);
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
      if (value) found.push({ from: `package.json scripts.${name}`, target: path.posix.join(packagePath, value).replace(/\/+$/, "") });
    }
  }
  return found;
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
 * tsconfig include, and no shipped file, declared input or shipped script may refer into it.
 */
export function findConsumedExclusions({ name, packagePath, manifest, files, excluded }) {
  const listed = Array.isArray(manifest?.files) ? manifest.files.filter((entry) => typeof entry === "string" && !entry.startsWith("!")) : [];
  const roots = [
    ...listed.map((entry) => ({ from: "package.json files", target: path.posix.join(packagePath, staticPrefix(entry)).replace(/\/+$/, "") })),
    ...files.filter(({ file }) => TSCONFIG.test(file)).flatMap(({ file, text }) => tsconfigRoots(file, text).map((target) => ({ from: `${file} include`, target }))),
  ];
  const references = collectReferences({ packagePath, manifest, files });
  const errors = [];
  for (const entry of excluded) {
    const absolute = `${packagePath}/${entry}`;
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
  return { packages: [...stable].map(([name, packagePath]) => ({ name, packagePath, ...declarations.get(name) })), errors };
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

/** Runs the out-of-root guard for every stable package at `commit`. */
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
    const prefix = `${packagePath}/`;
    const manifest = readJsonAt(cwd, commit, `${packagePath}/package.json`);
    const options = classifyOptions(manifest);
    const scanned = [];
    for (const file of listFiles(cwd, commit, [packagePath])) {
      const relative = file.slice(prefix.length);
      if (!SCANNED_FILE.test(file) || excluded.some((entry) => isWithin(relative, entry)) || classifyPath(relative, options) !== "shipped") continue;
      scanned.push({ file, base: packagePath, buildFile: relative.startsWith("scripts/") || /^[^/]+\.config\.[^/]+$/.test(relative) });
    }
    for (const input of inputs) {
      for (const file of listFiles(cwd, commit, [input])) {
        if (!SCANNED_FILE.test(file) || (file !== input && classifyPath(file.slice(input.length + 1)) === "excluded")) continue;
        scanned.push({ file, base: file === input ? path.posix.dirname(file) : input, buildFile: !file.startsWith("uifn/") });
      }
    }
    const blobs = readBlobs(cwd, commit, scanned.map(({ file }) => file));
    const files = scanned.filter(({ file }) => blobs.has(file)).map((entry) => ({ ...entry, text: blobs.get(entry.file) }));
    errors.push(...findUndeclaredReferences({ name, packagePath, manifest, files, declaration: pkg }));
    errors.push(...findConsumedExclusions({ name, packagePath, manifest, files, excluded }));
  }
  return errors;
}

function changedFiles(cwd, from, to, pathspecs) {
  return git(cwd, ["diff", "--name-only", "-z", "--no-renames", from, to, "--", ...pathspecs]).split("\0").filter(Boolean);
}

function evaluateRange(cwd, from, to, packages) {
  const files = changedFiles(cwd, from, to, [...new Set(packages.flatMap(({ packagePath, inputs }) => [packagePath, ...inputs]))]);
  return packages.map(({ name, packagePath, inputs, excluded }) =>
    evaluatePackage({
      name,
      packagePath,
      baseManifest: readJsonAt(cwd, from, `${packagePath}/package.json`),
      headManifest: readJsonAt(cwd, to, `${packagePath}/package.json`),
      changedFiles: files,
      headChangelog: readAt(cwd, to, `${packagePath}/CHANGELOG.md`),
      inputs,
      excluded,
    })
  );
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
  const { packages, errors: declarationErrors } = loadPackages(cwd, headCommit);
  const results = evaluateRange(cwd, mergeBase, headCommit, packages);
  const errors = [...declarationErrors, ...guardReferences(cwd, headCommit, packages), ...results.flatMap((result) => result.errors)];
  return { mergeBase, head: headCommit, results, errors };
}

/** Informational: shipped changes on `head` since each stable package's highest published tag. */
export function reportSincePublished({ cwd = process.cwd(), head = "HEAD" }) {
  const headCommit = resolveCommit(cwd, head);
  const targets = readJsonAt(cwd, headCommit, RELEASE_TARGETS_PATH) ?? [];
  return loadPackages(cwd, headCommit).packages.map((pkg) => {
    const slug = targets.find((target) => target.name === pkg.name)?.slug ?? `uifn-${path.posix.basename(pkg.packagePath)}`;
    const tags = git(cwd, ["tag", "--list", `${slug}-v*`])
      .split("\n")
      .map((tag) => ({ tag, version: tag.slice(slug.length + 2) }))
      .filter(({ tag, version }) => tag && parseSemver(version))
      .sort((a, b) => compareSemver(b.version, a.version));
    if (tags.length === 0) return { name: pkg.name, packagePath: pkg.packagePath, tag: null };
    const [result] = evaluateRange(cwd, resolveCommit(cwd, tags[0].tag), headCommit, [pkg]);
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
      console.log(formatReport(reportSincePublished({ head: values.head })));
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
