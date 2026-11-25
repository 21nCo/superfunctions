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

// CI_PLAN_MODE=full plans every job whatever changed: ci.yml sets it for pushes, the nightly schedule and manual runs,
// so only pull requests run the affected selection below.
const PLAN_MODE = process.env.CI_PLAN_MODE === "full" ? "full" : "affected";

// The root lockfile. A change that only touches workspace packages' own entries (a version bump or an internal pin)
// selects those packages; any other change (an external package, the root entry, a top-level field) is global.
const LOCKFILE = "package-lock.json";

const JS_GLOBAL_PATTERNS = [
  /^package\.json$/,
  /^turbo\.json$/,
  /^vitest\.config\.[cm]?[jt]s$/,
  /^tsconfig(?:\..+)?\.json$/,
  /^\.github\/workflows\/ci\.yml$/,
];

// Root scripts that no workspace package uses and that no Turbo task runs (SFNS-307); scripts/turbo-cache-merge.mjs
// runs only after the tasks of the JavaScript and DevFn tests jobs, on Turbo's cache and the checkout (SFNS-312).
// A change to one neither forces a full JavaScript run nor, since turbo.json's globalDependencies exclude exactly
// these globs, invalidates Turbo's task cache; every other scripts/ path does both. A `*` stays inside one path
// segment, as in Turbo's globs. scripts/turbo-cache-config.test.mjs fails if a tracked file outside scripts/ and
// .github/workflows/, Markdown and turbo.json aside, names one of them by file name, or names a script that reaches one
// through other scripts (the root package.json and the data files the test lists may name those), so the list cannot
// grow to cover a script a package uses.
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
  "scripts/assert-release-owner.*",
  "scripts/assert-release-ci.*",
  "scripts/release-gate-workflows.*",
  "scripts/notify-next-sync-workflow.*",
  "scripts/turbo-cache-merge.*",
  "scripts/workflow-pins.test.mjs",
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

const PRODUCT_CONFIG = /^([^/]+)\/(?:tsconfig[^/]*\.json|vitest\.config\.[^/]+)$/;

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

// JSON with object keys sorted, so a reordered entry compares equal.
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function readLockfileAt(commitish) {
  try {
    // git() trims its output. npm ends the file with one newline; any other trimmed whitespace makes the file
    // unreadable here (a full run) rather than letting trimming turn malformed JSON into valid JSON.
    const source = git(["show", `${commitish}:${LOCKFILE}`], { maxBuffer: 256 * 1024 * 1024 });
    const size = Number(git(["cat-file", "-s", `${commitish}:${LOCKFILE}`]));
    if (Buffer.byteLength(source, "utf8") + 1 !== size) {
      return null;
    }
    return JSON.parse(source);
  } catch {
    return null;
  }
}

const HOISTED_ENTRY = /^node_modules\/(?:@[^/]+\/)?[^/]+$/;

// Which workspace packages a lockfile change touches, or global when it touches anything else. A workspace's own
// entry is keyed by its directory, published copies of workspace packages installed for it alone by
// <dir>/node_modules/<workspace package>, and its hoisted link entry (node_modules/<name>, link: true) resolves to that
// directory. External packages, hoisted or nested, are global.
function classifyLockfileChange(before, after, workspaceDirs, workspaceNames) {
  const dirs = new Set();
  const global = (reason) => ({ global: true, reason, dirs });
  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

  if (!isObject(before) || !isObject(after)) {
    return global("the lockfile is missing or unreadable on one side");
  }
  if (!isObject(before.packages) || !isObject(after.packages)) {
    return global("the lockfile has no packages map on one side");
  }

  const { packages: beforePackages, ...beforeTop } = before;
  const { packages: afterPackages, ...afterTop } = after;
  if (canonicalJson(beforeTop) !== canonicalJson(afterTop)) {
    return global("a top-level lockfile field changed");
  }

  const keys = new Set([...Object.keys(beforePackages), ...Object.keys(afterPackages)]);
  for (const key of [...keys].sort(compareStrings)) {
    const previous = beforePackages[key];
    const next = afterPackages[key];
    if (canonicalJson(previous) === canonicalJson(next)) {
      continue;
    }

    if (key === "") {
      return global("the root package entry changed");
    }

    if (workspaceDirs.has(key)) {
      dirs.add(key);
      continue;
    }

    // A published copy of a workspace package installed under one workspace's node_modules (a pin to an older
    // version) resolves for code inside that directory, which includes any workspace nested in it; dependents reach it
    // through those workspaces. Every node_modules segment must name a workspace package: a third-party package there
    // is global, because other packages can borrow it by a computed path (docs builds copy tools from a sibling's
    // node_modules) that neither the package graph nor the reference scan sees.
    const nestedAt = key.indexOf("/node_modules/");
    const nestedIn = nestedAt > 0 && !key.startsWith("node_modules/") ? key.slice(0, nestedAt) : "";
    const nestedNames = nestedIn ? key.slice(nestedAt + "/node_modules/".length).split("/node_modules/") : [];
    if (nestedIn && workspaceDirs.has(nestedIn) && nestedNames.every((name) => workspaceNames.has(name))) {
      for (const dir of workspaceDirs) {
        if (dir === nestedIn || dir.startsWith(`${nestedIn}/`)) {
          dirs.add(dir);
        }
      }
      continue;
    }

    // A new workspace's link selects it. A link that is removed or that changes target (a workspace renamed or moved)
    // can leave consumers of the old name that HEAD's dependency graph no longer shows, so it is global, as is a new
    // @types/ link, which TypeScript loads into every package without a dependency.
    if (
      HOISTED_ENTRY.test(key) &&
      !key.startsWith("node_modules/@types/") &&
      previous === undefined &&
      next?.link === true &&
      workspaceDirs.has(next.resolved)
    ) {
      dirs.add(next.resolved);
      continue;
    }

    return global(`${key} changed`);
  }

  return { global: false, reason: "", dirs };
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
// Code files whose relative paths can reach into another package: a test importing a sibling package's source, a
// vitest or tsconfig file pointing at shared fixtures, a probe loading another package's build.
const SOURCE_REFERENCE_FILES = [
  "*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.json", "*.svelte", "*.vue", "*.astro",
  "*.css", "*.scss", "*.sass", "*.less", "*.pcss",
];
// A "../" path in quotes (spaces allowed), or in an unquoted CSS url(...). A template literal's path ends at its first
// `${`; its literal part is then a prefix (`../components-${framework}` names every components-* directory).
const QUOTED_PARENT_PATH = /(["'`])(\.\.\/(?:(?!\1)[^\n$])*)(\1|\$\{)/g;
const CSS_URL_PARENT_PATH = /url\(\s*(\.\.\/[^)\s"'`]+)\s*\)/g;

// Test files and test configuration: a reference from one of these affects only the referencing package's tests. Any
// other file (fixtures included, which a build may bundle) counts as a build input.
const TEST_FILE = /(?:^|\/)(?:__tests__|tests?|e2e)\/|\.(?:test|spec)\.[^/]+$|(?:^|\/)vitest(?:\.[^/]+)?\.config\.[^/]+$/;

// Turbo tasks that only check a package; inputs of any other task (build, generate, ...) can feed its build.
const CHECK_TASK = /^(?:test|lint|typecheck)(?::|$)/;

// Edges Turbo's package graph cannot see: package A's tracked code names a "../" path inside package B, so a change
// to B can break A without A depending on B. A reference from A's test files ("test") affects only A's tests; any
// other reference ("build": source, build config, tsconfig) can change what A builds, so A's dependents are affected
// too. Returns `packages[kind]` (referenced package dir -> the package dirs that reference it) and `files[kind]` (a
// referenced file outside every package -> the package dirs that reference it).
function collectSourceReferences(packageDirs) {
  const references = {
    packages: { test: new Map(), build: new Map() },
    files: { test: new Map(), build: new Map() },
  };
  let files = [];
  try {
    // Each path carries a "|" prefix, so trimming the output cannot shorten the first or last path.
    files = git(["ls-files", "-z", "--format=|%(path)", "--", ...SOURCE_REFERENCE_FILES], { maxBuffer: 256 * 1024 * 1024 })
      .split("\0")
      .filter((record) => record.startsWith("|"))
      .map((record) => record.slice(1));
  } catch {
    return references;
  }

  for (const file of files) {
    const owner = findNearestManifestDir(file, packageDirs);
    if (!owner) {
      continue;
    }
    const kind = TEST_FILE.test(file.slice(owner.length + 1)) ? "test" : "build";
    let source;
    try {
      source = readFileSync(path.join(repoRoot, file), "utf8");
    } catch {
      continue;
    }
    const specifiers = [
      ...[...source.matchAll(QUOTED_PARENT_PATH)].map((match) => [match[2], match[3] === "${"]),
      ...[...source.matchAll(CSS_URL_PARENT_PATH)].map((match) => [match[1], false]),
    ];
    for (const [specifier, interpolated] of specifiers) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (target.startsWith("../")) {
        continue;
      }
      if (interpolated) {
        // Only the literal part is known: the package holding it and every package directory that starts with it
        // (`../devfn/${name}` names every devfn package; a prefix at the repository root names every package).
        const prefix = target === "./" || target === "." ? "" : target;
        const holder = prefix === "" ? "" : findNearestManifestDir(prefix.endsWith("/") ? `${prefix}-` : `${path.posix.dirname(prefix)}/-`, packageDirs);
        for (const dir of [holder, ...[...packageDirs].filter((candidate) => candidate.startsWith(prefix))]) {
          if (dir && dir !== owner) {
            addReference(references.packages[kind], dir, owner);
          }
        }
        continue;
      }
      // A path naming a package directory itself (`../viewer`) belongs to that package, as does anything inside it.
      const trimmed = target.replace(/\/+$/, "");
      const referenced = findNearestManifestDir(`${trimmed}/-`, packageDirs);
      if (referenced && referenced !== owner) {
        addReference(references.packages[kind], referenced, owner);
      } else if (!referenced && /^[^.][^/]*\.[^/]+$/.test(path.posix.basename(trimmed))) {
        // A file outside every package (a product's shared tsconfig, release-packages.json). Directories outside
        // packages are mostly product or repository roots used to resolve other paths, and would select far too much.
        addReference(references.files[kind], trimmed, owner);
      }
    }
  }

  return references;
}

function addReference(map, key, owner) {
  if (!map.has(key)) {
    map.set(key, new Set());
  }
  map.get(key).add(owner);
}

// Each seed and every package that depends on it by name (whatever version it pins), transitively. The plan passes
// every one to Turbo as a filter, so dependents Turbo's own graph cannot reach (through a published package or an
// older pin) still run.
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
    const dir = queue.shift();
    for (const next of dependents.get(dir) || []) {
      if (!selected.has(next)) {
        selected.add(next);
        queue.push(next);
      }
    }
  }

  return selected;
}

// The tasks `start` runs first in the same package, following dependsOn entries without `^` (which name tasks of
// dependencies) or another package's `pkg#task`.
function tasksReachableFrom(start, tasks) {
  const reached = new Set();
  const queue = [start];
  while (queue.length > 0) {
    const name = queue.shift();
    if (reached.has(name)) {
      continue;
    }
    reached.add(name);
    const dependsOn = tasks[name]?.dependsOn;
    for (const dependency of Array.isArray(dependsOn) ? dependsOn : []) {
      if (typeof dependency === "string" && !dependency.startsWith("^") && !dependency.includes("#")) {
        queue.push(dependency);
      }
    }
  }
  return reached;
}

// Package turbo.json files can name inputs in other packages ("$TURBO_ROOT$/extfn/cli/**/*.ts" in clifn/core, whose
// contract test scans those CLIs). Returns [owner package dir, path prefix, kind] entries: a changed file under a prefix
// selects the owner, with its dependents unless the task only checks the package (test, lint or typecheck by name, and
// not something its build depends on). The prefix is the glob's literal part, so it can only over-select.
function collectTurboRootInputs(packageDirs) {
  const inputs = [];
  let rootTasks = {};
  try {
    const rootConfig = JSON.parse(readFileSync(path.join(repoRoot, "turbo.json"), "utf8"));
    rootTasks = rootConfig?.tasks || rootConfig?.pipeline || {};
  } catch {
    rootTasks = {};
  }
  // A root task's input applies to every package, so a change under it is global (owner "*").
  for (const task of Object.values(rootTasks)) {
    for (const input of Array.isArray(task?.inputs) ? task.inputs : []) {
      if (typeof input === "string" && input.startsWith("$TURBO_ROOT$/")) {
        inputs.push(["*", input.slice("$TURBO_ROOT$/".length).split(/[*?{[!]/, 1)[0], "build"]);
      }
    }
  }
  let files = [];
  try {
    files = git(["ls-files", "-z", "--format=|%(path)", "--", "*/turbo.json"])
      .split("\0")
      .filter((record) => record.startsWith("|"))
      .map((record) => record.slice(1));
  } catch {
    return inputs;
  }

  for (const file of files) {
    const owner = findNearestManifestDir(path.posix.dirname(file), packageDirs);
    if (!owner) {
      continue;
    }
    let config;
    try {
      config = JSON.parse(readFileSync(path.join(repoRoot, file), "utf8"));
    } catch {
      continue;
    }
    // Turbo merges a package task over the root task field by field, so an omitted dependsOn keeps the root's.
    const packageTasks = config?.tasks || config?.pipeline || {};
    const tasks = { ...rootTasks };
    for (const [name, task] of Object.entries(packageTasks)) {
      tasks[name] = { ...rootTasks[name], ...task };
    }
    const feedsBuild = tasksReachableFrom("build", tasks);
    for (const [taskName, task] of Object.entries(tasks)) {
      const name = taskName.replace(/^.*#/, "");
      const checkOnly = CHECK_TASK.test(name) && !feedsBuild.has(name);
      for (const input of Array.isArray(task?.inputs) ? task.inputs : []) {
        if (typeof input !== "string" || !input.startsWith("$TURBO_ROOT$/")) {
          continue;
        }
        const glob = input.slice("$TURBO_ROOT$/".length);
        const literal = glob.split(/[*?{[!]/, 1)[0];
        inputs.push([owner, literal, checkOnly ? "test" : "build"]);
      }
    }
  }

  return inputs;
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  appendFileSync(outputPath, `${name}<<__CI_EOF__\n${value}\n__CI_EOF__\n`);
}

// A short table of what this plan runs, for the run's summary page.
function writeStepSummary(rows) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }

  const lines = [
    `### CI plan (${PLAN_MODE})`,
    "",
    "| Job | Runs | Scope |",
    "| --- | --- | --- |",
    ...rows.map(([job, runs, scope]) => `| ${job} | ${runs ? "yes" : "skipped"} | ${scope.replaceAll("|", "\\|")} |`),
    "",
  ];
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
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
// Packages whose tests or builds read a changed file without depending on it: they run, but their dependents do not.
const consumerJsDirs = new Set();
const changedPythonNames = new Set();
const fullPlan = PLAN_MODE === "full";
const runMcpfn = fullPlan || changedPaths.some((changedPath) => matchesAny(MCPFN_PATTERNS, changedPath));
let lockfile = null;

const turboRootInputs = fullPlan ? [] : collectTurboRootInputs(jsDirs);
const sourceReferences = fullPlan
  ? { packages: { test: new Map(), build: new Map() }, files: { test: new Map(), build: new Map() } }
  : collectSourceReferences(jsDirs);

for (const entry of changedEntries) {
  for (const changedPath of entry.paths) {
    for (const [owner, prefix, kind] of turboRootInputs) {
      if (!changedPath.startsWith(prefix)) {
        continue;
      }
      if (owner === "*") {
        fullJs = true;
      } else {
        (kind === "build" ? changedJsDirs : consumerJsDirs).add(owner);
      }
    }

    for (const kind of ["test", "build"]) {
      for (const [target, owners] of sourceReferences.files[kind]) {
        if (changedPath === target || changedPath.startsWith(`${target}/`)) {
          for (const owner of owners) {
            (kind === "build" ? changedJsDirs : consumerJsDirs).add(owner);
          }
        }
      }
    }

    // A product-level tsconfig or Vitest config (Turbo's "*/tsconfig*.json" and "*/vitest.config.*" global inputs)
    // is inherited by the packages under that product directory.
    const productConfig = PRODUCT_CONFIG.exec(changedPath);
    if (productConfig) {
      for (const dir of jsDirs) {
        if (dir === productConfig[1] || dir.startsWith(`${productConfig[1]}/`)) {
          changedJsDirs.add(dir);
        }
      }
    }

    if (changedPath === LOCKFILE) {
      // The diff compares HEAD with the merge base (base...HEAD), so the lockfile is read at the same two commits.
      const lockfileBase = mergeBaseWith(baseRef) || baseRef;
      lockfile = classifyLockfileChange(
        readLockfileAt(lockfileBase),
        readLockfileAt("HEAD"),
        jsDirs,
        new Set(jsPackages.map((manifest) => manifest.name))
      );
      if (lockfile.global) {
        fullJs = true;
      }
      for (const dir of lockfile.dirs) {
        changedJsDirs.add(dir);
      }
    } else if (isJsGlobal(changedPath)) {
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

if (fullPlan) {
  fullJs = true;
  fullPython = true;
}

const selectedJsPackages = fullJs
  ? jsPackages
  : [...changedJsDirs].map((dir) => jsByDir.get(dir)).filter(Boolean);

const selectedPythonPackages = fullPython
  ? pythonPackages
  : [...collectPythonDependents(changedPythonNames, pythonByName)]
      .map((packageName) => pythonByName.get(packageName))
      .filter(Boolean);

// Every changed package and each of its dependents becomes a `..../<dir>` filter, whatever scripts it has, so a
// package without a task still selects its dependents' runs of it. Packages that only read files of a selected package
// (a relative-path reference) or a changed file (a reference or a turbo.json root input) run with an exact `./<dir>`
// filter: their own code did not change, so their dependents need nothing.
const jsChangedDirs = new Set(selectedJsPackages.map((manifest) => manifest.dir));
// A package whose build reads a selected package's files changes with it, so it joins the changed packages, with its
// dependents, until nothing new is added.
let jsAffectedDirs = new Set();
if (!fullJs) {
  for (let grew = true; grew; ) {
    jsAffectedDirs = collectJsDependents(jsChangedDirs, jsPackages);
    grew = false;
    for (const dir of jsAffectedDirs) {
      for (const consumer of sourceReferences.packages.build.get(dir) || []) {
        if (!jsAffectedDirs.has(consumer)) {
          jsChangedDirs.add(consumer);
          grew = true;
        }
      }
    }
  }
}
const jsConsumerDirs = new Set();
if (!fullJs) {
  const testConsumers = [...jsAffectedDirs].flatMap((dir) => [...(sourceReferences.packages.test.get(dir) || [])]);
  for (const dir of [...consumerJsDirs, ...testConsumers]) {
    if (!jsAffectedDirs.has(dir) && jsByDir.has(dir)) {
      jsConsumerDirs.add(dir);
    }
  }
}
const jsSelection = fullJs
  ? new Set(jsPackages.map((manifest) => manifest.dir))
  : new Set([...jsAffectedDirs, ...jsConsumerDirs]);
const jsSeedDirs = jsSelection;

// McpFn-only changes skip the JavaScript, DevFn and Python jobs, so every package they affect (changed, dependent or
// consumer) must be McpFn's.
const mcpfnOnly =
  !fullPlan &&
  !fullJs &&
  runMcpfn &&
  [...jsSelection].every((dir) => dir.startsWith("mcpfn/")) &&
  changedPaths.every((changedPath) =>
    matchesAny(MCPFN_PATTERNS, changedPath) ||
    matchesAny(MCPFN_SUPPORT_PATTERNS, changedPath));

const selectionHas = (task) => [...jsSelection].some((dir) => jsByDir.get(dir)?.scripts[task]);
const jsSeedFilters = fullJs
  ? ""
  : [buildTurboFilters(jsAffectedDirs), buildExactTurboFilters(jsConsumerDirs)].filter(Boolean).join(" ");
const hasJsBuild = selectionHas("build");
const hasJsLint = selectionHas("lint");
const hasJsTypecheck = selectionHas("typecheck");

// The JavaScript test filters select each changed package and its dependents; DevFn tests take the DevFn part of that
// selection (on a full run, every DevFn package) and the JavaScript test step excludes every DevFn package.
const testableDirs = [...jsSelection].filter((dir) => jsByDir.get(dir)?.scripts.test);
const devfnTestPackages = new Set(testableDirs.filter(isDevfnDir));
const devfnExcludeFilters = buildExcludeTurboFilters(
  new Set(jsPackages.map((manifest) => manifest.dir).filter(isDevfnDir))
);
const hasJsTest = testableDirs.some((dir) => !isDevfnDir(dir));
const jsTestFilters = [jsSeedFilters, devfnExcludeFilters]
  .filter(Boolean)
  .join(" ");

const pythonMatrix = selectedPythonPackages
  .map((manifest) => ({ name: manifest.name, path: manifest.dir }))
  .sort((left, right) => left.path.localeCompare(right.path));

const runJs = fullJs || jsSelection.size > 0;

const summary = {
  mode: PLAN_MODE,
  baseRef,
  changedFiles: changedPaths,
  lockfile: lockfile && {
    global: lockfile.global,
    reason: lockfile.reason || undefined,
    workspaceDirs: [...lockfile.dirs].sort(compareStrings),
  },
  fullJs,
  fullPython,
  runMcpfn,
  mcpfnOnly,
  jsPackages: selectedJsPackages.map((manifest) => manifest.name).sort(),
  devfnTestPackages: [...devfnTestPackages].map((dir) => jsByDir.get(dir).name).sort(compareStrings),
  pythonPackages: pythonMatrix,
};

console.log(JSON.stringify(summary, null, 2));

// The workflow passes Turbo filters through the shell unquoted, and Turbo reads `...` and `{}` in a filter as
// selectors, so a directory that reaches a filter must be plain path segments: letters, digits, `_`, `@`, `-`, and
// single dots inside a segment or before it (`.github`). Every package directory qualifies today; the plan fails
// rather than emit a filter that splits or selects the wrong packages. Directories no filter names are not checked.
const SAFE_FILTER_DIR = /^\.?[A-Za-z0-9_@-]+(?:\.[A-Za-z0-9_@-]+)*(?:\/\.?[A-Za-z0-9_@-]+(?:\.[A-Za-z0-9_@-]+)*)*$/;
const filterDirs = new Set([
  ...(fullJs ? [] : jsSeedDirs),
  ...devfnTestPackages,
  ...jsPackages.map((manifest) => manifest.dir).filter(isDevfnDir),
]);
const unsafeDirs = [...filterDirs].filter((dir) => !SAFE_FILTER_DIR.test(dir)).sort(compareStrings);
if (unsafeDirs.length > 0) {
  console.error(
    `CI planner: these package directories cannot be passed to Turbo as filters; rename them: ${unsafeDirs.map((dir) => JSON.stringify(dir)).join(", ")}`
  );
  process.exit(1);
}

writeOutput("plan_mode", PLAN_MODE);
writeOutput("base_ref", baseRef);
writeOutput("changed_files_count", String(changedPaths.length));
writeOutput("run_js", String(runJs));
writeOutput("full_js", String(fullJs));
writeOutput("has_js_build", String(hasJsBuild));
writeOutput("has_js_test", String(hasJsTest));
writeOutput("has_js_lint", String(hasJsLint));
writeOutput("has_js_typecheck", String(hasJsTypecheck));
writeOutput("js_build_filters", jsSeedFilters);
writeOutput("js_test_filters", hasJsTest ? jsTestFilters : "");
writeOutput("js_lint_filters", jsSeedFilters);
writeOutput("js_typecheck_filters", jsSeedFilters);
writeOutput("run_devfn", String(devfnTestPackages.size > 0));
writeOutput("devfn_test_filters", buildExactTurboFilters(devfnTestPackages));
writeOutput("run_python", String(fullPython || pythonMatrix.length > 0));
writeOutput("full_python", String(fullPython));
writeOutput("python_matrix", JSON.stringify(pythonMatrix));
writeOutput("run_mcpfn", String(runMcpfn));
writeOutput("mcpfn_only", String(mcpfnOnly));

const scopeOf = (full, count, noun) => (full ? "everything" : `${count} ${noun}`);
writeStepSummary([
  ["JavaScript", runJs && !mcpfnOnly, scopeOf(fullJs, jsSelection.size, "affected package(s)")],
  ["DevFn tests", devfnTestPackages.size > 0 && !mcpfnOnly, `${devfnTestPackages.size} package(s)`],
  ["McpFn release gate, Node 18 and Node 20", runMcpfn, runMcpfn ? "McpFn" : "none"],
  ["Python package checks", (fullPython || pythonMatrix.length > 0) && !mcpfnOnly, scopeOf(fullPython, pythonMatrix.length, "package(s)")],
]);
