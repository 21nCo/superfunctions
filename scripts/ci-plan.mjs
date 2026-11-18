#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  discoverJsPackages,
  discoverPythonPackages,
  findNearestManifestDir,
  manifestExists,
} from "./ci-utils.mjs";

const repoRoot = process.cwd();

const JS_GLOBAL_PATTERNS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^turbo\.json$/,
  /^vitest\.config\.[cm]?[jt]s$/,
  /^tsconfig(?:\..+)?\.json$/,
  /^\.github\/workflows\/ci\.yml$/,
];

// Root scripts that no workspace package uses and that run only in non-JavaScript jobs (SFNS-307). A change to one
// neither forces a full JavaScript run nor, since turbo.json's globalDependencies exclude exactly these globs,
// invalidates Turbo's task cache; every other scripts/ path does both. A `*` stays inside one path segment, as in
// Turbo's globs. scripts/turbo-cache-config.test.mjs fails if a tracked file outside scripts/ and .github/workflows/
// names one of them, so the list cannot grow to cover a script a package names directly. The check does not follow
// imports between scripts: a script that imports a standalone one must itself be one no package runs.
const STANDALONE_SCRIPTS = [
  "scripts/promote.*",
  "scripts/verify-public-boundary.*",
  "scripts/public-boundary.allow.json",
  "scripts/verify-owners.*",
  "scripts/owners.*",
  "scripts/workspaces.*",
  "scripts/verify-package-lockfiles.*",
  "scripts/resolve-release-tag.*",
  "scripts/uifn-docs-cli-resolution.*",
];

const STANDALONE_SCRIPT_PATTERNS = STANDALONE_SCRIPTS.map(
  (glob) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`)
);

const PYTHON_GLOBAL_PATTERNS = [
  /^\.github\/workflows\/ci\.yml$/,
  /^scripts\/ci-plan\.mjs$/,
  /^scripts\/ci-run-python-package\.mjs$/,
  /^scripts\/ci-utils\.mjs$/,
];

const MCPFN_PATTERNS = [
  /^mcpfn\//,
  /^datafn\/server\/src\/(?:executor|server|index)\.ts$/,
  /^datafn\/server\/src\/__tests__\/executor\.test\.ts$/,
  /^scripts\/(?:gate|test)-mcpfn.*\.mjs$/,
];

// Test support a product's packages share, outside any package, selects all of that product's packages.
const SHARED_TEST_SUPPORT = [
  { pattern: /^devfn\/test-support\//, packages: "devfn/" },
];

// DevFn's real-process tests run one package at a time in their own job, never in the shared JavaScript test step.
const DEVFN_PACKAGE_ROOT = "devfn/";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const MCPFN_SUPPORT_PATTERNS = [
  /^README\.md$/,
  /^release-packages\.json$/,
];

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function gitOk(args) {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}

function ensureRemoteBranch(branchName) {
  if (!branchName) {
    return false;
  }

  if (gitOk(["rev-parse", "--verify", `refs/remotes/origin/${branchName}`])) {
    return true;
  }

  try {
    git([
      "fetch",
      "--no-tags",
      "--depth=1",
      "origin",
      `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

function loadGitHubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) {
    return {};
  }

  return JSON.parse(readFileSync(eventPath, "utf8"));
}

function isRealCommit(value) {
  return Boolean(value) && !/^0+$/.test(value);
}

function ensureCommit(commitish) {
  return isRealCommit(commitish) && gitOk(["cat-file", "-e", `${commitish}^{commit}`]);
}

function mergeBaseWith(ref) {
  try {
    return git(["merge-base", "HEAD", ref]);
  } catch {
    return "";
  }
}

// The merge base of HEAD and the live origin/<baseRef>, deepening a shallow history when the boundary hides it.
// The tracking ref is always refreshed, because a cached one can predate base commits the pull request merged.
function resolveLiveMergeBase(baseRef) {
  if (!baseRef) {
    return "";
  }

  const remoteRef = `refs/remotes/origin/${baseRef}`;
  try {
    git(["fetch", "--no-tags", "origin", `+refs/heads/${baseRef}:${remoteRef}`]);
  } catch {
    return "";
  }

  const mergeBase = mergeBaseWith(remoteRef);
  if (mergeBase || git(["rev-parse", "--is-shallow-repository"]) !== "true") {
    return mergeBase;
  }

  try {
    git(["fetch", "--no-tags", "--unshallow", "origin", `+refs/heads/${baseRef}:${remoteRef}`]);
  } catch {
    return "";
  }
  return mergeBaseWith(remoteRef);
}

function resolveDiffBase(event) {
  const eventName = process.env.GITHUB_EVENT_NAME || "local";
  const defaultBranch = event.repository?.default_branch || "dev";

  if (eventName === "pull_request" || eventName === "pull_request_target") {
    // GitHub does not refresh base.sha when the base branch moves, so diffing against it would count
    // base-branch commits the pull request merged in as its own changes. Prefer the live merge base.
    const mergeBase = resolveLiveMergeBase(event.pull_request?.base?.ref);
    if (mergeBase) {
      return mergeBase;
    }

    const baseSha = event.pull_request?.base?.sha;
    if (ensureCommit(baseSha)) {
      return baseSha;
    }

    // Without a live ref or base.sha, a cached tracking ref for the target still beats the default branch.
    const baseRef = event.pull_request?.base?.ref;
    const cachedMergeBase = baseRef ? mergeBaseWith(`refs/remotes/origin/${baseRef}`) : "";
    if (cachedMergeBase) {
      return cachedMergeBase;
    }
  }

  if (eventName === "push") {
    const before = event.before;
    if (ensureCommit(before)) {
      return before;
    }
  }

  if (ensureRemoteBranch(defaultBranch)) {
    return git(["merge-base", "HEAD", `refs/remotes/origin/${defaultBranch}`]);
  }

  if (gitOk(["rev-parse", "--verify", "HEAD^"])) {
    return git(["rev-parse", "HEAD^"]);
  }

  return git(["rev-parse", "HEAD"]);
}

function parseChangedEntries(baseRef) {
  let output = "";

  if (baseRef !== "HEAD") {
    const range = gitOk(["merge-base", baseRef, "HEAD"])
      ? `${baseRef}...HEAD`
      : `${baseRef}..HEAD`;

    output = execFileSync(
      "git",
      ["diff", "--name-status", "--find-renames", "-z", range],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  }

  const tokens = output.split("\0").filter(Boolean);
  const entries = [];

  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index];
    index += 1;

    if (status.startsWith("R") || status.startsWith("C")) {
      const fromPath = tokens[index];
      const toPath = tokens[index + 1];
      index += 2;
      entries.push({ status, paths: [fromPath, toPath] });
      continue;
    }

    const filePath = tokens[index];
    index += 1;
    entries.push({ status, paths: [filePath] });
  }

  return entries;
}

function matchesAny(patterns, value) {
  return patterns.some((pattern) => pattern.test(value));
}

function isJsGlobal(changedPath) {
  return (
    matchesAny(JS_GLOBAL_PATTERNS, changedPath) ||
    (changedPath.startsWith("scripts/") && !matchesAny(STANDALONE_SCRIPT_PATTERNS, changedPath))
  );
}

// Code-unit order, the same order a bare sort() gives strings; localeCompare would reorder them.
function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function buildTurboFilters(packageDirs) {
  return [...packageDirs]
    .sort(compareStrings)
    .map((packageDir) => `--filter=..../${packageDir}`)
    .join(" ");
}

// Turbo filters for exactly these package directories, without their dependents or dependencies.
function buildExactTurboFilters(packageDirs) {
  return [...packageDirs]
    .sort(compareStrings)
    .map((packageDir) => `--filter=./${packageDir}`)
    .join(" ");
}

function buildExcludeTurboFilters(packageDirs) {
  return [...packageDirs]
    .sort(compareStrings)
    .map((packageDir) => `--filter=!./${packageDir}`)
    .join(" ");
}

function isDevfnDir(packageDir) {
  return packageDir.startsWith(DEVFN_PACKAGE_ROOT);
}

function readDependencyNames(manifest) {
  const source = JSON.parse(readFileSync(path.join(repoRoot, manifest.file), "utf8"));
  return new Set(DEPENDENCY_FIELDS.flatMap((field) => Object.keys(source[field] || {})));
}

// The packages turbo's `..../<dir>` filter selects: each seed and every package that depends on it, transitively.
function collectJsDependents(seedDirs, manifests) {
  const dirsByName = new Map();
  for (const manifest of manifests) {
    if (!dirsByName.has(manifest.name)) {
      dirsByName.set(manifest.name, []);
    }
    dirsByName.get(manifest.name).push(manifest.dir);
  }

  const dependents = new Map();
  for (const manifest of manifests) {
    for (const dependencyName of readDependencyNames(manifest)) {
      for (const dependencyDir of dirsByName.get(dependencyName) || []) {
        if (!dependents.has(dependencyDir)) {
          dependents.set(dependencyDir, new Set());
        }
        dependents.get(dependencyDir).add(manifest.dir);
      }
    }
  }

  const selected = new Set(seedDirs);
  const queue = [...seedDirs];
  while (queue.length > 0) {
    for (const dependent of dependents.get(queue.shift()) || []) {
      if (!selected.has(dependent)) {
        selected.add(dependent);
        queue.push(dependent);
      }
    }
  }

  return selected;
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  appendFileSync(outputPath, `${name}<<__CI_EOF__\n${value}\n__CI_EOF__\n`);
}

function collectPythonDependents(seedNames, manifestsByName) {
  const dependents = new Map();

  for (const manifest of manifestsByName.values()) {
    for (const dependency of manifest.dependencies) {
      if (!manifestsByName.has(dependency)) {
        continue;
      }

      if (!dependents.has(dependency)) {
        dependents.set(dependency, new Set());
      }

      dependents.get(dependency).add(manifest.name);
    }
  }

  const selected = new Set(seedNames);
  const queue = [...seedNames];

  while (queue.length > 0) {
    const packageName = queue.shift();
    const directDependents = dependents.get(packageName);
    if (!directDependents) {
      continue;
    }

    for (const dependent of directDependents) {
      if (selected.has(dependent)) {
        continue;
      }

      selected.add(dependent);
      queue.push(dependent);
    }
  }

  return selected;
}

// The standalone list for scripts/turbo-cache-config.test.mjs, which checks it against turbo.json.
if (process.argv.includes("--print-standalone-scripts")) {
  console.log(JSON.stringify(STANDALONE_SCRIPTS));
  process.exit(0);
}

const event = loadGitHubEvent();
const baseRef = resolveDiffBase(event);
const changedEntries = parseChangedEntries(baseRef);
const changedPaths = [...new Set(changedEntries.flatMap((entry) => entry.paths))].sort();

const jsPackages = discoverJsPackages(repoRoot);
const pythonPackages = discoverPythonPackages(repoRoot).map((manifest) => ({
  ...manifest,
  name: manifest.name.toLowerCase(),
}));

const jsByDir = new Map(jsPackages.map((manifest) => [manifest.dir, manifest]));
const pythonByDir = new Map(pythonPackages.map((manifest) => [manifest.dir, manifest]));
const pythonByName = new Map(pythonPackages.map((manifest) => [manifest.name, manifest]));

const jsDirs = new Set(jsByDir.keys());
const pythonDirs = new Set(pythonByDir.keys());

let fullJs = false;
let fullPython = false;

const changedJsDirs = new Set();
const changedPythonNames = new Set();
const runMcpfn = changedPaths.some((changedPath) => matchesAny(MCPFN_PATTERNS, changedPath));

for (const entry of changedEntries) {
  for (const changedPath of entry.paths) {
    if (isJsGlobal(changedPath)) {
      fullJs = true;
    }

    if (matchesAny(PYTHON_GLOBAL_PATTERNS, changedPath)) {
      fullPython = true;
    }

    const jsDir = findNearestManifestDir(changedPath, jsDirs);
    if (jsDir && jsByDir.has(jsDir)) {
      changedJsDirs.add(jsDir);
    }

    for (const support of SHARED_TEST_SUPPORT) {
      if (!support.pattern.test(changedPath)) {
        continue;
      }

      for (const dir of jsDirs) {
        if (dir.startsWith(support.packages)) {
          changedJsDirs.add(dir);
        }
      }
    }

    const pythonDir = findNearestManifestDir(changedPath, pythonDirs);
    if (pythonDir && pythonByDir.has(pythonDir)) {
      changedPythonNames.add(pythonByDir.get(pythonDir).name);
    }
  }

  if (entry.status.startsWith("D")) {
    const deletedPath = entry.paths[0];

    if (deletedPath.endsWith("/package.json") && !manifestExists(repoRoot, deletedPath)) {
      fullJs = true;
    }

    if (deletedPath.endsWith("/pyproject.toml") && !manifestExists(repoRoot, deletedPath)) {
      fullPython = true;
    }
  }
}

const mcpfnOnly =
  runMcpfn &&
  changedPaths.every((changedPath) =>
    matchesAny(MCPFN_PATTERNS, changedPath) ||
    matchesAny(MCPFN_SUPPORT_PATTERNS, changedPath));

const selectedJsPackages = fullJs
  ? jsPackages
  : [...changedJsDirs].map((dir) => jsByDir.get(dir)).filter(Boolean);

const selectedPythonPackages = fullPython
  ? pythonPackages
  : [...collectPythonDependents(changedPythonNames, pythonByName)]
      .map((packageName) => pythonByName.get(packageName))
      .filter(Boolean);

const jsBuildPackages = new Set(
  selectedJsPackages.filter((manifest) => manifest.scripts.build).map((manifest) => manifest.dir)
);
const jsTestPackages = new Set(
  selectedJsPackages.filter((manifest) => manifest.scripts.test).map((manifest) => manifest.dir)
);
const jsLintPackages = new Set(
  selectedJsPackages.filter((manifest) => manifest.scripts.lint).map((manifest) => manifest.dir)
);
const jsTypecheckPackages = new Set(
  selectedJsPackages.filter((manifest) => manifest.scripts.typecheck).map((manifest) => manifest.dir)
);

// The JavaScript test filters select each test package and its dependents; DevFn tests take the DevFn part of that
// selection (on a full run, every DevFn package) and the JavaScript test step excludes every DevFn package.
const jsTestSelection = fullJs
  ? new Set(jsPackages.map((manifest) => manifest.dir))
  : collectJsDependents(jsTestPackages, jsPackages);
const testableDirs = [...jsTestSelection].filter((dir) => jsByDir.get(dir)?.scripts.test);
const devfnTestPackages = new Set(testableDirs.filter(isDevfnDir));
const devfnExcludeFilters = buildExcludeTurboFilters(
  new Set(jsPackages.map((manifest) => manifest.dir).filter(isDevfnDir))
);
const hasJsTest = testableDirs.some((dir) => !isDevfnDir(dir));
const jsTestFilters = [fullJs ? "" : buildTurboFilters(jsTestPackages), devfnExcludeFilters]
  .filter(Boolean)
  .join(" ");

const pythonMatrix = selectedPythonPackages
  .map((manifest) => ({ name: manifest.name, path: manifest.dir }))
  .sort((left, right) => left.path.localeCompare(right.path));

const summary = {
  baseRef,
  changedFiles: changedPaths,
  fullJs,
  fullPython,
  runMcpfn,
  mcpfnOnly,
  jsPackages: selectedJsPackages.map((manifest) => manifest.name).sort(),
  devfnTestPackages: [...devfnTestPackages].map((dir) => jsByDir.get(dir).name).sort(compareStrings),
  pythonPackages: pythonMatrix,
};

console.log(JSON.stringify(summary, null, 2));

writeOutput("base_ref", baseRef);
writeOutput("changed_files_count", String(changedPaths.length));
writeOutput("run_js", String(fullJs || selectedJsPackages.length > 0));
writeOutput("full_js", String(fullJs));
writeOutput("has_js_build", String(fullJs || jsBuildPackages.size > 0));
writeOutput("has_js_test", String(hasJsTest));
writeOutput("has_js_lint", String(fullJs || jsLintPackages.size > 0));
writeOutput("has_js_typecheck", String(fullJs || jsTypecheckPackages.size > 0));
writeOutput("js_build_filters", fullJs ? "" : buildTurboFilters(jsBuildPackages));
writeOutput("js_test_filters", hasJsTest ? jsTestFilters : "");
writeOutput("js_lint_filters", fullJs ? "" : buildTurboFilters(jsLintPackages));
writeOutput("js_typecheck_filters", fullJs ? "" : buildTurboFilters(jsTypecheckPackages));
writeOutput("run_devfn", String(devfnTestPackages.size > 0));
writeOutput("devfn_test_filters", buildExactTurboFilters(devfnTestPackages));
writeOutput("run_python", String(fullPython || pythonMatrix.length > 0));
writeOutput("full_python", String(fullPython));
writeOutput("python_matrix", JSON.stringify(pythonMatrix));
writeOutput("run_mcpfn", String(runMcpfn));
writeOutput("mcpfn_only", String(mcpfnOnly));
