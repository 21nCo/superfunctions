#!/usr/bin/env node
// Public boundary (leak guard, SFNS-125): fails when the public repository's tree holds something the public
// manifest does not allow. Every finding names the file and the rule it breaks:
//   top-level-path     every tracked top-level directory and root file is listed in superfunctions.owners.json.
//   public-release     every release-packages.json entry and every Python project is public-owned: its slug or
//                      project is listed as public and its path lies under a listed top-level directory.
//   workspace-package  every root workspace package has a name, the name belongs to exactly one workspace, and its
//                      directory lies under a listed top-level directory.
//   fn-dependency      no source file imports, and no package.json depends on, a `*fn` package (`@<name>fn/<pkg>` or
//                      bare `<name>fn`) that is neither a public workspace package nor pinned in
//                      scripts/public-boundary.allow.json.
// Imports are read from module code only (TypeScript's import scanner on JS/TS modules, `<script>` blocks of
// .svelte and .html files, ESM blocks of .mdx files); comments, strings and prose are not checked. Python imports
// are not checked: Python projects are covered by public-release.
// Usage: node scripts/verify-public-boundary.mjs [--root <checkout>]

import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OwnersError, PUBLIC_MANIFEST, REPO_ROOT, createOwners, readManifest } from "./owners.mjs";
import { RELEASE_FILES, readPythonProjects, readReleaseEntries, trackedFiles } from "./verify-owners.mjs";

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
 * relative, absolute, protocol (`node:`, `npm:`, URL) or package-internal (`#x`) specifier.
 * @param {string} specifier
 */
export function packageNameOf(specifier) {
  if (typeof specifier !== "string" || specifier === "") return null;
  if (/^[./#]/.test(specifier) || specifier.includes(":") || specifier.includes("\\")) return null;
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) return segments.length >= 2 && segments[1] !== "" ? `${segments[0]}/${segments[1]}` : null;
  return segments[0];
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
    if (/[!?{}[\]\\]|\*\*/.test(pattern) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
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

let typescript;
function loadTypescript(root) {
  if (typescript) return typescript;
  for (const base of [root, REPO_ROOT]) {
    try {
      typescript = createRequire(path.join(base, "package.json"))("typescript");
      return typescript;
    } catch {
      // try the next base
    }
  }
  throw new BoundaryError("typescript is not installed; run npm ci before this check");
}

const MODULE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const SCRIPT_BLOCK_EXTENSIONS = new Set([".svelte", ".html"]);

/** True for a file whose imports this check reads. */
export function isSourceFile(file) {
  const extension = path.posix.extname(file).toLowerCase();
  return MODULE_EXTENSIONS.has(extension) || SCRIPT_BLOCK_EXTENSIONS.has(extension) || extension === ".mdx";
}

/** `<script>` element bodies of an .svelte or .html file, with their offsets. JSON and other data scripts are skipped. */
function scriptBlocks(source) {
  const blocks = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of source.matchAll(pattern)) {
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(match[1])?.[1]?.toLowerCase();
    if (type && !["module", "text/javascript", "application/javascript", "text/typescript", "ts"].includes(type)) continue;
    blocks.push({ code: match[2], offset: match.index + match[0].indexOf(">") + 1 });
  }
  return blocks;
}

/**
 * ESM blocks of an .mdx file: paragraphs outside fenced code that start with `import` or `export`, each running to
 * the next blank line, as MDX reads them.
 */
function mdxEsmBlocks(source) {
  const blocks = [];
  const lines = source.split("\n");
  let offset = 0;
  let fence = null;
  let current = null;
  let previousBlank = true;
  for (const line of lines) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && line.trim() === fenceMatch[1]) fence = null;
    } else if (current) {
      if (line.trim() === "") {
        blocks.push(current);
        current = null;
      } else current.code += `${line}\n`;
    } else if (fenceMatch) {
      fence = fenceMatch[1];
    } else if (previousBlank && /^(?:import|export)\b/.test(line)) {
      current = { code: `${line}\n`, offset };
    }
    previousBlank = line.trim() === "";
    offset += line.length + 1;
  }
  if (current) blocks.push(current);
  return blocks;
}

function lineAt(source, offset) {
  let line = 1;
  for (let index = source.indexOf("\n"); index !== -1 && index < offset; index = source.indexOf("\n", index + 1)) line += 1;
  return line;
}

/**
 * Module specifiers a source file imports (static and dynamic `import`, `export ... from`, `require`,
 * `import x = require()` and `/// <reference types>`), each with its 1-based line.
 * @param {string} file repository-relative path, used to pick how the file is read
 * @param {string} source
 * @param {{ ts?: typeof import("typescript") }} [options]
 */
export function importSpecifiers(file, source, { ts = loadTypescript(REPO_ROOT) } = {}) {
  const extension = path.posix.extname(file).toLowerCase();
  let blocks;
  if (MODULE_EXTENSIONS.has(extension)) blocks = [{ code: source, offset: 0 }];
  else if (SCRIPT_BLOCK_EXTENSIONS.has(extension)) blocks = scriptBlocks(source);
  else if (extension === ".mdx") blocks = mdxEsmBlocks(source);
  else return [];
  const found = [];
  for (const { code, offset } of blocks) {
    const info = ts.preProcessFile(code, true, true);
    for (const reference of [...info.importedFiles, ...info.typeReferenceDirectives]) {
      found.push({ specifier: reference.fileName, line: lineAt(source, offset + reference.pos) });
    }
  }
  return found;
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

function topLevelPathFindings(publicManifest, files) {
  const dirs = new Set();
  const rootFiles = new Set();
  for (const file of files) {
    const slash = file.indexOf("/");
    if (slash === -1) rootFiles.add(file);
    else dirs.add(file.slice(0, slash));
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
function workspaceFindings(publicManifest, directories, readJson) {
  const findings = [];
  const byName = new Map();
  for (const directory of directories) {
    const file = `${directory}/package.json`;
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

function notAllowed(name) {
  return `${JSON.stringify(name)}, which is neither a public workspace package nor allowed here by ${ALLOW_FILE}`;
}

function fnDependencyFindings({ files, publicPackages, allowed, readText, readJson, ts }) {
  const isAllowed = (name, file) =>
    !isFnPackage(name) || publicPackages.has(name) || (allowed.has(name) && allowEntryApplies(allowed.get(name), file));
  const findings = [];
  for (const file of files) {
    if (path.posix.basename(file) === "package.json") {
      for (const { name, field } of dependencyNames(readJson(file))) {
        if (!isAllowed(name, file)) findings.push(finding(file, RULES.fnDependency, `${field} depends on ${notAllowed(name)}`));
      }
      continue;
    }
    if (!isSourceFile(file)) continue;
    const source = readText(file);
    if (source === null) continue;
    for (const { specifier, line } of importSpecifiers(file, source, { ts })) {
      const name = packageNameOf(specifier);
      if (name !== null && !isAllowed(name, file)) {
        findings.push(finding(`${file}:${line}`, RULES.fnDependency, `imports ${JSON.stringify(specifier)}: package ${notAllowed(name)}`));
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

/**
 * Checks a checkout against the public boundary and returns its findings (empty when it passes).
 * @param {{ root?: string }} [options]
 */
export function verifyPublicBoundary({ root = REPO_ROOT } = {}) {
  const ts = loadTypescript(root);
  // Public semantics only: superfunctions.owners.next.json is never read here (tracked, it is an unlisted root file).
  const owners = createOwners(readManifest(path.join(root, PUBLIC_MANIFEST), { kind: "public" }));
  const files = trackedFiles(root).filter((file) => {
    try {
      return lstatSync(path.join(root, file)).isFile();
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  });
  const readText = (file) => readFileSync(path.join(root, file), "utf8");
  const readJson = (file) => {
    try {
      return JSON.parse(readText(file));
    } catch (error) {
      throw new BoundaryError(`${file}: invalid JSON: ${error.message}`);
    }
  };
  const allowed = readAllowFile(root);
  const rootPackage = readJson("package.json");
  const { findings: workspace, publicPackages } = workspaceFindings(
    owners.publicManifest,
    workspaceDirectories(workspacePatterns(rootPackage), files),
    readJson,
  );
  return [
    ...topLevelPathFindings(owners.publicManifest, files),
    ...publicReleaseFindings(owners, readReleaseEntries(root, "public"), readPythonProjects(root, files)),
    ...workspace,
    ...allowFileFindings(allowed, publicPackages),
    ...fnDependencyFindings({ files, publicPackages, allowed, readText, readJson, ts }),
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
    findings = verifyPublicBoundary(parseArgs(process.argv.slice(2)));
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
