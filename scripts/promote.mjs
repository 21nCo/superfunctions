#!/usr/bin/env node
// Promotion (SFNS-121 D9, D11; SFNS-127): imports paths from `next` at a pinned commit into a fresh branch of this
// public checkout with their history, makes them public-owned and moves their release entries out of `next`'s
// overlays. Method: fetch the pin into a temporary repository, keep only the paths with `git filter-repo` (and strip
// per-function `.conduct/` planning files from every imported commit, D1), fetch the result here and merge it with
// --allow-unrelated-histories on a new branch, then commit the manifest and release edits. It moves code only: the
// Linear moves it prints are an operator step.
//
// Usage:
//   node scripts/promote.mjs <fn> [--pin <next-sha>] [options]
//   node scripts/promote.mjs --path <path> [--path <path>...] --pin <next-sha> [options]
// Options:
//   --pin <rev>       next commit to import from (resolved in --source; <fn> defaults to the next/next ref)
//   --source <repo>   repository holding the pin (default: this checkout, so `git fetch next` first; another one needs --pin)
//   --base <ref>      ref the current branch must contain (default origin/dev)
//   --branch <name>   branch to create (default promote/<fn or first path>)
//   --reconcile       allow paths that already exist here with other content; merge conflicts are left for the operator
//   --root <dir>      checkout to promote into (default: this repository)
// Exit status: 0 promoted, 1 refused or failed (nothing changed), 2 promoted with merge conflicts left (--reconcile).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NEXT_MANIFEST, OwnersError, PUBLIC_MANIFEST, REPO_ROOT, canonicalPythonName, normalizePath, parseManifest } from "./owners.mjs";
import { gitBinary } from "./verify-package-lockfiles.mjs";
import { RELEASE_FILES, pyprojectName } from "./verify-owners.mjs";

export const PYTHON_OVERLAY = "python-release-packages.next.json";
export const PYTHON_RELEASE_SCRIPT = "scripts/python_release.py";
export const FILTER_REPO_HINT =
  "git-filter-repo is required: install it with `python3 -m pip install git-filter-repo` (or `brew install git-filter-repo`) and make sure it is on PATH";
/** Files promotion edits, and next-only files that must never reach the public repository. */
export const PROTECTED_PATHS = Object.freeze([
  PUBLIC_MANIFEST,
  RELEASE_FILES.public,
  PYTHON_RELEASE_SCRIPT,
  NEXT_MANIFEST,
  RELEASE_FILES.next,
  PYTHON_OVERLAY,
  "package-lock.json",
  "Package.resolved",
]);
const CONDUCT_SEGMENT = /(^|\/)\.conduct(\/|$)/;
const SOURCE_BRANCH = "promote-source";

export class PromoteError extends Error {
  /**
   * @param {"usage" | "missing-filter-repo" | "dirty-tree" | "wrong-base" | "branch-exists" | "pin-missing" | "path-missing" | "protected-path" | "conduct-path" | "unownable-path" | "path-conflict" | "release-conflict" | "malformed-file" | "git-failed"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "PromoteError";
    this.code = code;
  }
}

function git(cwd, args, { input, allowFailure = false, env } = {}) {
  const result = spawnSync(gitBinary(), args, { cwd, input, env, encoding: "utf8", maxBuffer: 1 << 30 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new PromoteError("git-failed", `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return allowFailure ? result : result.stdout;
}

const gitOk = (cwd, args) => git(cwd, args, { allowFailure: true }).status === 0;
const lines = (text) => text.split("\n").filter(Boolean);

/** True when `git filter-repo` runs. */
export function hasFilterRepo() {
  const result = spawnSync(gitBinary(), ["filter-repo", "--version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

const isUnder = (target, prefix) => target === prefix || target.startsWith(`${prefix}/`);
/** Code-unit order, the order of a plain sort(), spelled out. */
const compareText = (a, b) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/** Runs `fn`, turning an OwnersError (a malformed manifest or pyproject.toml) into a PromoteError. */
function ownersCheck(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof OwnersError) throw new PromoteError("malformed-file", error.message);
    throw error;
  }
}

/** Parsed JSON of a file in the working checkout. */
function readJsonFile(root, file) {
  const text = readFileSync(path.join(root, file), "utf8");
  try {
    return { text, data: JSON.parse(text) };
  } catch (error) {
    throw new PromoteError("malformed-file", `${file}: invalid JSON: ${error.message}`);
  }
}

const URL_SOURCE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_SOURCE = /^[^/\\]+:/;
const DRIVE_PATH = /^[a-z]:[/\\]/i;

/**
 * A URL or scp-style `host:path` source is kept as given; a local path is resolved against the caller's working
 * directory, since git fetches it from inside a temporary repository.
 */
export function resolveSource(source, cwd = process.cwd()) {
  if (source.startsWith("-")) throw new PromoteError("usage", `--source ${JSON.stringify(source)} must not start with "-"`);
  if (URL_SOURCE.test(source) || (SCP_SOURCE.test(source) && !DRIVE_PATH.test(source))) return source;
  return path.resolve(cwd, source);
}

const realPath = (target) => {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
};

/** Normalised, de-duplicated paths; a path inside another listed path is dropped. */
export function normalizePaths(paths) {
  if (paths.length === 0) throw new PromoteError("usage", "name a function or at least one --path");
  const normalized = [];
  for (const raw of paths) {
    let target;
    try {
      target = normalizePath(raw);
    } catch (error) {
      throw new PromoteError("usage", error.message);
    }
    for (const protectedPath of PROTECTED_PATHS) {
      if (isUnder(protectedPath, target) || isUnder(target, protectedPath)) {
        throw new PromoteError("protected-path", `${JSON.stringify(target)} holds ${protectedPath}, which promotion edits or which belongs to next only`);
      }
    }
    if (CONDUCT_SEGMENT.test(target)) {
      throw new PromoteError("conduct-path", `${JSON.stringify(target)} is a .conduct planning path, which is never promoted (D1)`);
    }
    normalized.push(target);
  }
  return [...new Set(normalized)].sort(compareText).filter((target, _, all) => !all.some((other) => other !== target && isUnder(target, other)));
}

export function parseArgs(argv) {
  const options = { paths: [], reconcile: false };
  const valueOf = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new PromoteError("usage", `${flag} needs a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--path":
        options.paths.push(valueOf(index, arg));
        index += 1;
        break;
      case "--pin":
      case "--source":
      case "--base":
      case "--branch":
      case "--root": {
        const key = arg.slice(2);
        if (options[key] !== undefined) throw new PromoteError("usage", `${arg} is given twice`);
        options[key] = valueOf(index, arg);
        index += 1;
        break;
      }
      case "--reconcile":
        options.reconcile = true;
        break;
      default:
        if (arg.startsWith("-")) throw new PromoteError("usage", `unknown option ${arg}`);
        if (options.fn !== undefined) throw new PromoteError("usage", `name one function, not ${JSON.stringify(options.fn)} and ${JSON.stringify(arg)}`);
        options.fn = arg;
    }
  }
  return checkArgs(options);
}

/** Checks that need every argument: a function or --path entries, and --path needs a pin. */
function checkArgs(options) {
  if (options.fn !== undefined && options.paths.length > 0) throw new PromoteError("usage", "name a function or --path entries, not both");
  if (options.fn !== undefined && (options.fn.includes("/") || options.fn.includes("\\"))) {
    throw new PromoteError("usage", `a function is a top-level directory; use --path for ${JSON.stringify(options.fn)}`);
  }
  if (options.paths.length > 0 && options.pin === undefined) throw new PromoteError("usage", "--path needs --pin <next-sha>");
  return options;
}

function readJsonAt(repo, rev, file) {
  const result = git(repo, ["show", `${rev}:${file}`], { allowFailure: true });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new PromoteError("malformed-file", `${file} at ${rev}: invalid JSON: ${error.message}`);
  }
}

function objectAt(repo, rev, target) {
  const result = git(repo, ["ls-tree", "--format=%(objectmode) %(objecttype) %(objectname)", rev, "--", target], { allowFailure: true });
  const [line] = lines(result.stdout ?? "");
  if (result.status !== 0 || !line) return null;
  const [mode, type, oid] = line.split(" ");
  return { mode, type, oid };
}

/** Same blob or tree with the same file mode (an executable bit is content too). */
const sameObject = (a, b) => a !== null && b !== null && a.mode === b.mode && a.oid === b.oid;

/** Files under `paths` (every file when none is given) at `rev`, NUL-separated so non-ASCII names stay unquoted. */
function filesAt(repo, rev, paths = []) {
  return git(repo, ["ls-tree", "-r", "-z", "--name-only", rev, "--", ...paths]).split("\0").filter(Boolean);
}

/** Python projects ({name, file}) declared by the pyproject.toml files among `files` at `rev`, as verify-owners reads them. */
function pythonProjectsAt(repo, rev, files) {
  return files
    .filter((file) => path.posix.basename(file) === "pyproject.toml")
    .sort(compareText)
    .flatMap((file) => {
      const name = ownersCheck(() => pyprojectName(git(repo, ["show", `${rev}:${file}`]), file));
      return name === null ? [] : [{ name, file }];
    });
}

/** Release entries of `file` at the pin whose path lies under an imported path. */
function releaseEntriesUnder(entries, file, paths) {
  if (entries === null) return [];
  if (!Array.isArray(entries)) throw new PromoteError("malformed-file", `${file} at the pin must be an array`);
  return entries.filter((entry) => {
    if (!["slug", "path", "name"].every((field) => typeof entry?.[field] === "string" && entry[field] !== "")) {
      throw new PromoteError("malformed-file", `${file} at the pin: entry ${JSON.stringify(entry)} needs a slug, path and name`);
    }
    return paths.some((target) => isUnder(path.posix.normalize(entry.path), target));
  });
}

/** Refuses two candidates that share a key: next's files are not validated before the first sync, so a pin may hold one. */
function refuseBatchDuplicates(candidates, keys, describe) {
  for (const [field, keyOf] of Object.entries(keys)) {
    const seen = new Map();
    for (const entry of candidates) {
      const key = keyOf(entry);
      if (seen.has(key)) {
        throw new PromoteError("release-conflict", `${describe(entry)} and ${describe(seen.get(key))} share the ${field} ${JSON.stringify(key)}; fix next first`);
      }
      seen.set(key, entry);
    }
  }
}

/**
 * npm release entries under the paths: next's overlay entries, or, for a pin from before the overlay existed, next's
 * release-packages.json entries. Returns `entries` (every one, for the manifest and next's clean-up) and `moves` (the
 * ones to append: an entry this checkout already lists identically is skipped). A slug or npm name listed here
 * differently, or shared by two imported entries, is a conflict.
 */
export function releaseMoves({ pinOverlay, pinBase, current, paths }) {
  const source = pinOverlay === null ? RELEASE_FILES.public : RELEASE_FILES.next;
  const candidates = releaseEntriesUnder(pinOverlay ?? pinBase, source, paths);
  refuseBatchDuplicates(candidates, { slug: (entry) => entry.slug, "npm name": (entry) => entry.name }, (entry) => `release ${JSON.stringify(entry.slug)} (${entry.name}, ${entry.path}) in next's ${source}`);
  const entries = candidates.map(({ slug, path: directory, name }) => ({ slug, path: directory, name, source }));
  const moves = entries.filter((entry) => {
    const sameSlug = current.find((existing) => existing?.slug === entry.slug);
    const sameName = current.find((existing) => existing?.name === entry.name);
    if (sameSlug && sameSlug.path === entry.path && sameSlug.name === entry.name) return false;
    if (sameSlug || sameName) {
      const other = sameSlug ?? sameName;
      throw new PromoteError(
        "release-conflict",
        `release ${JSON.stringify(entry.slug)} (${entry.name}, ${entry.path}) from next's ${source} conflicts with ${RELEASE_FILES.public} entry ${JSON.stringify(other)}`,
      );
    }
    return true;
  });
  return { entries, moves };
}

/** A normalised directory without its trailing slash (normalize leaves at most one); the root is ".". */
const directoryKey = (target) => {
  const normalized = path.posix.normalize(target);
  return (normalized.endsWith("/") ? normalized.slice(0, -1) : normalized) || ".";
};

/**
 * The imported Python projects and the overlay entries to move into TARGETS, checked as one identity invariant,
 * independent of order (verify-owners would reject anything else):
 * - the pyproject.toml files imported with the paths (`discovered`, {name, file}) have unique canonical names;
 * - next's Python overlay entries under the paths are unique by canonical name and by directory, and each names the
 *   imported pyproject.toml project in its own directory;
 * - this checkout's pyproject.toml files (`existing`) and TARGETS either lack each imported name or hold it in the
 *   same directory, and hold no other name in an imported project directory.
 * Anything else is a release-conflict. Returns `names` (every imported project, for the manifest), `entries` (every
 * overlay entry under the paths, for next's clean-up) and `moves` (the overlay entries TARGETS does not list yet).
 */
export function pythonMoves({ overlay = null, paths, targets = new Map(), discovered = [], existing = [] }) {
  const candidates = pythonOverlayUnder(overlay, paths);
  const imported = indexImportedProjects(discovered);
  checkOverlayEntries(candidates, imported);
  const here = [
    ...existing.map(({ name, file }) => pythonIdentity(name, path.posix.dirname(file), `${file} here`)),
    ...[...targets].map(([name, directory]) => pythonIdentity(name, directory, `TARGETS of ${PYTHON_RELEASE_SCRIPT} (${directory})`, { inTargets: true })),
  ];
  const inTargets = checkProjectsHere(here, imported);
  const entries = candidates.map(({ name, path: directory }) => ({ name, path: directory }));
  return {
    names: [...imported.byName.values()].map(({ name }) => name),
    entries,
    moves: entries.filter((entry) => !inTargets.has(canonicalPythonName(entry.name))),
  };
}

const pythonIdentity = (name, directory, where, extra = {}) => ({ name, id: canonicalPythonName(name), directory: directoryKey(directory), where, ...extra });
const describePython = ({ name, where }) => `Python project ${JSON.stringify(name)} in ${where}`;
const pythonConflict = (message) => {
  throw new PromoteError("release-conflict", message);
};

/** next's Python overlay entries under the paths; a malformed overlay or entry is refused. */
function pythonOverlayUnder(overlay, paths) {
  if (overlay === null) return [];
  if (!Array.isArray(overlay)) throw new PromoteError("malformed-file", `${PYTHON_OVERLAY} at the pin must be an array`);
  return overlay.filter((entry) => {
    if (typeof entry?.name !== "string" || entry.name === "" || typeof entry?.path !== "string" || entry.path === "") {
      throw new PromoteError("malformed-file", `${PYTHON_OVERLAY} at the pin: entry ${JSON.stringify(entry)} needs a name and a path`);
    }
    return paths.some((target) => isUnder(path.posix.normalize(entry.path), target));
  });
}

/** Name and directory indexes of the imported pyproject.toml projects, whose canonical names must be unique. */
function indexImportedProjects(discovered) {
  const byName = new Map();
  const byDirectory = new Map();
  for (const { name, file } of discovered) {
    const project = pythonIdentity(name, path.posix.dirname(file), `${file} at the pin`);
    const twin = byName.get(project.id);
    if (twin) pythonConflict(`${describePython(project)} and ${describePython(twin)} share the canonical name ${JSON.stringify(project.id)}; fix next first`);
    byName.set(project.id, project);
    byDirectory.set(project.directory, project);
  }
  return { byName, byDirectory };
}

/** Overlay entries are unique by canonical name and directory, and each names the imported project in its directory. */
function checkOverlayEntries(candidates, { byDirectory }) {
  const overlayNames = new Map();
  const overlayDirectories = new Map();
  for (const entry of candidates) {
    const listed = pythonIdentity(entry.name, entry.path, `next's ${PYTHON_OVERLAY} (${entry.path})`);
    const twin = overlayNames.get(listed.id) ?? overlayDirectories.get(listed.directory);
    if (twin) {
      const shared = twin.id === listed.id ? `the canonical name ${JSON.stringify(listed.id)}` : `the directory ${listed.directory}`;
      pythonConflict(`${describePython(listed)} and ${describePython(twin)} share ${shared}; fix next first`);
    }
    overlayNames.set(listed.id, listed);
    overlayDirectories.set(listed.directory, listed);
    const project = byDirectory.get(listed.directory);
    if (project?.id !== listed.id) {
      const found = project ? `the imported project there is ${describePython(project)}` : "no imported pyproject.toml declares a project there";
      pythonConflict(`${describePython(listed)} does not match its directory: ${found}; fix next first`);
    }
    // python_release.py takes the tag name as the TARGETS key and needs it to equal project.name exactly.
    requireReleaseSpelling(project, listed);
  }
}

/** A released Python project's TARGETS name (`listed`) must be canonical and exactly its pyproject.toml project.name. */
function requireReleaseSpelling(project, listed) {
  if (project.name !== project.id || listed.name !== project.name) {
    pythonConflict(`${describePython(project)} is released as ${describePython(listed)}: python_release.py needs both spelled exactly as the canonical name ${JSON.stringify(project.id)}; fix next first`);
  }
}

/**
 * This checkout's projects and TARGETS lack each imported name or hold it in the same directory, and hold no other
 * name in an imported project directory. Returns the imported canonical names TARGETS already lists.
 */
function checkProjectsHere(here, { byName, byDirectory }) {
  const inTargets = new Set();
  for (const other of here) {
    const named = byName.get(other.id);
    const located = byDirectory.get(other.directory);
    if (named && named.directory !== other.directory) pythonConflict(`${describePython(named)} conflicts with ${describePython(other)}`);
    if (located && located.id !== other.id) pythonConflict(`${describePython(located)} conflicts with ${describePython(other)}, which holds another name in that directory`);
    if (named && other.inTargets) {
      requireReleaseSpelling(named, other);
      inTargets.add(other.id);
    }
  }
  return inTargets;
}

const TARGETS_BLOCK = /^TARGETS = \{\n([\s\S]*?)^\}\n/m;

/** TARGETS of scripts/python_release.py as name → path; only the `"name": "path",` line form is read. */
export function readPythonTargets(source) {
  const block = TARGETS_BLOCK.exec(source);
  if (!block) throw new PromoteError("malformed-file", `${PYTHON_RELEASE_SCRIPT}: TARGETS = { ... } block not found`);
  const targets = new Map();
  for (const line of lines(block[1])) {
    const match = /^ {4}"([^"]+)": "([^"]+)",$/.exec(line);
    if (!match) throw new PromoteError("malformed-file", `${PYTHON_RELEASE_SCRIPT}: unexpected TARGETS line ${JSON.stringify(line)}`);
    targets.set(match[1], match[2]);
  }
  return targets;
}

export function addPythonTargets(source, moves) {
  if (moves.length === 0) return source;
  return source.replace(TARGETS_BLOCK, (block, body) => {
    const added = moves.map(({ name, path: directory }) => `    ${JSON.stringify(name)}: ${JSON.stringify(directory)},\n`).join("");
    return `TARGETS = {\n${body}${added}}\n`;
  });
}

/** Appends entries to release-packages.json text, leaving every existing line unchanged. */
export function appendReleaseEntries(text, moves) {
  if (moves.length === 0) return text;
  const close = text.lastIndexOf("]");
  const head = text.slice(0, close).trimEnd();
  const added = moves.map(({ slug, path: directory, name }) => `  { "slug": ${JSON.stringify(slug)}, "path": ${JSON.stringify(directory)}, "name": ${JSON.stringify(name)} }`);
  const updated = `${head}${head.endsWith("[") ? "" : ","}\n${added.join(",\n")}\n${text.slice(close)}`;
  const before = JSON.parse(text);
  const after = JSON.parse(updated);
  if (after.length !== before.length + moves.length) throw new PromoteError("malformed-file", `${RELEASE_FILES.public}: append did not round-trip`);
  return updated;
}

const isSorted = (keys) => keys.every((key, index) => index === 0 || keys[index - 1] < key);

/**
 * Sets `section[key]` to "public", keeping a sorted section sorted. Every key is written as an own data property, so a
 * key such as "__proto__" (a valid directory name) is kept rather than swallowed by the inherited accessor.
 */
function setOwner(section, key) {
  if (Object.hasOwn(section, key) && section[key] === "public") return false;
  const sorted = isSorted(Object.keys(section));
  const entries = Object.entries(section);
  const index = entries.findIndex(([name]) => name === key);
  if (index === -1) entries.push([key, "public"]);
  else entries[index] = [key, "public"];
  if (sorted) entries.sort(([a], [b]) => compareText(a, b));
  for (const name of Object.keys(section)) delete section[name];
  for (const [name, value] of entries) Object.defineProperty(section, name, { value, enumerable: true, writable: true, configurable: true });
  return true;
}

/**
 * Applies the ownership flip to the parsed public manifest: imported top-level directories and root files become
 * public, and so do the moved release slugs and the imported Python projects. Returns what changed.
 */
export function flipManifest(manifest, { topLevel, rootFiles, slugs, pythonNames }) {
  const changed = { paths: [], rootFiles: [], releases: [], python: [] };
  for (const name of topLevel) if (setOwner(manifest.paths, name)) changed.paths.push(name);
  for (const name of rootFiles) {
    if (Object.values(manifest.rootFiles ?? {}).some((list) => list.includes(name))) continue;
    manifest.rootFiles ??= {};
    manifest.rootFiles.public ??= [];
    manifest.rootFiles.public.push(name);
    if (isSorted(manifest.rootFiles.public.slice(0, -1))) manifest.rootFiles.public.sort(compareText);
    changed.rootFiles.push(name);
  }
  for (const slug of slugs) {
    manifest.releases ??= {};
    if (setOwner(manifest.releases, slug)) changed.releases.push(slug);
  }
  const listed = new Set(Object.keys(manifest.python ?? {}).map(canonicalPythonName));
  for (const name of pythonNames) {
    if (listed.has(canonicalPythonName(name))) continue;
    manifest.python ??= {};
    setOwner(manifest.python, name);
    listed.add(canonicalPythonName(name));
    changed.python.push(name);
  }
  ownersCheck(() => parseManifest(manifest, { kind: "public" }));
  return changed;
}

/** Entries of next's manifest at the pin that the promotion makes public; the operator removes them on next. */
function nextManifestEntries(nextManifest, { topLevel, rootFiles, slugs, pythonNames }) {
  if (nextManifest === null) return [];
  const listed = [];
  const has = (section, key) => section !== undefined && section !== null && Object.hasOwn(section, key);
  for (const name of topLevel) if (has(nextManifest.paths, name)) listed.push(`paths.${name}`);
  for (const name of rootFiles) if (nextManifest.rootFiles?.next?.includes(name)) listed.push(`rootFiles.next ${name}`);
  for (const slug of slugs) if (has(nextManifest.releases, slug)) listed.push(`releases.${slug}`);
  const python = new Set(pythonNames.map(canonicalPythonName));
  for (const name of Object.keys(nextManifest.python ?? {})) if (python.has(canonicalPythonName(name))) listed.push(`python.${name}`);
  return listed;
}

function checkWorkingRepo(root, { base, branch }) {
  if (git(root, ["status", "--porcelain", "--untracked-files=normal"]).trim() !== "") {
    throw new PromoteError("dirty-tree", "the working tree has uncommitted or untracked changes; commit or remove them first");
  }
  if (!gitOk(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`])) {
    throw new PromoteError("wrong-base", `${base} not found; fetch it first (git fetch origin dev)`);
  }
  if (!gitOk(root, ["merge-base", "--is-ancestor", base, "HEAD"])) {
    throw new PromoteError("wrong-base", `the current branch is not based on ${base}; start from an up-to-date ${base}`);
  }
  if (gitOk(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
    throw new PromoteError("branch-exists", `branch ${branch} already exists`);
  }
  if (!gitOk(root, ["check-ref-format", "--branch", branch])) throw new PromoteError("usage", `${JSON.stringify(branch)} is not a valid branch name`);
}

/** Fetches the pin into a new temporary repository and reads everything the promotion needs from it. */
function readPin(work, { source, pin, paths }) {
  git(work, ["init", "-q"]);
  const fetched = git(work, ["fetch", "-q", "--no-tags", "--", source, pin], { allowFailure: true });
  if (fetched.status !== 0 || !gitOk(work, ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"])) {
    throw new PromoteError("pin-missing", `pin ${pin} not found in ${source}: ${(fetched.stderr ?? "").trim()}`);
  }
  const sha = git(work, ["rev-parse", "FETCH_HEAD^{commit}"]).trim();
  git(work, ["update-ref", `refs/heads/${SOURCE_BRANCH}`, sha]);
  const objects = new Map();
  for (const target of paths) {
    const object = objectAt(work, sha, target);
    if (!object) throw new PromoteError("path-missing", `${target} does not exist in next at ${sha}`);
    objects.set(target, object);
  }
  const files = filesAt(work, sha, paths);
  const conduct = files.filter((file) => CONDUCT_SEGMENT.test(file));
  if (conduct.length > 0) {
    const more = conduct.length > 1 ? `, +${conduct.length - 1} more` : "";
    throw new PromoteError("conduct-path", `next at ${sha} still holds .conduct planning files (${conduct[0]}${more}); archive them on next first (D1)`);
  }
  return {
    sha,
    objects,
    files,
    pythonProjects: pythonProjectsAt(work, sha, files),
    overlay: readJsonAt(work, sha, RELEASE_FILES.next),
    base: readJsonAt(work, sha, RELEASE_FILES.public),
    pythonOverlay: readJsonAt(work, sha, PYTHON_OVERLAY),
    nextManifest: readJsonAt(work, sha, NEXT_MANIFEST),
  };
}

/** Keeps only the paths in the temporary repository's history and strips .conduct planning files from it (D1). */
function filterHistory(work, paths) {
  git(work, ["filter-repo", "--force", "--quiet", ...paths.flatMap((target) => ["--path", target])]);
  git(work, ["filter-repo", "--force", "--quiet", "--path-regex", CONDUCT_SEGMENT.source, "--invert-paths"]);
  const head = git(work, ["rev-parse", `refs/heads/${SOURCE_BRANCH}`]).trim();
  const log = git(work, ["log", "--format=%H%x00%s%x00%b%x1e", head]);
  const commits = log.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
    const [sha, subject, body] = record.split("\0");
    return { sha, subject, body };
  });
  return { head, commits };
}

/** SF Next issue identifiers named in the imported commits, for the Linear move list (D11). */
export function referencedIssues(commits) {
  const found = new Set();
  for (const { subject, body } of commits) for (const match of `${subject}\n${body}`.matchAll(/\bSFN-\d+\b/g)) found.add(match[0]);
  return [...found].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}

/** The commit and branch (null when detached) checked out now, to return to after a failed attempt. */
function currentCheckout(root) {
  const symbolic = git(root, ["symbolic-ref", "-q", "--short", "HEAD"], { allowFailure: true }).stdout.trim();
  return { sha: git(root, ["rev-parse", "HEAD"]).trim(), branch: symbolic || null };
}

function undoBranch(root, original, branch) {
  git(root, ["merge", "--abort"], { allowFailure: true });
  git(root, ["checkout", "-q", "-f", original.branch ?? original.sha], { allowFailure: true });
  git(root, ["branch", "-D", branch], { allowFailure: true });
}

/** Where the pin is fetched from: another repository needs an explicit pin; this checkout's is resolved later. */
function pinSource(root, { source, pin }) {
  if (pin?.startsWith("-")) throw new PromoteError("usage", `--pin ${JSON.stringify(pin)} must not start with "-"`);
  const resolved = source === undefined ? root : resolveSource(source);
  if (resolved === root || (path.isAbsolute(resolved) && realPath(resolved) === realPath(root))) return { source: root, pin, local: true };
  if (pin === undefined) throw new PromoteError("usage", `--source ${resolved} needs --pin <next-sha>: the next/next default exists only in this checkout`);
  return { source: resolved, pin, local: false };
}

/** The commit a pin names in this checkout (default: the next/next remote-tracking ref). */
function localPin(root, pin = "refs/remotes/next/next") {
  if (!gitOk(root, ["rev-parse", "--verify", "--quiet", `${pin}^{commit}`])) {
    throw new PromoteError("pin-missing", `pin ${pin} is not in this checkout; run git fetch next (or pass --source)`);
  }
  return git(root, ["rev-parse", `${pin}^{commit}`]).trim();
}

/**
 * Splits the paths into top-level directories and root files the promotion makes public. Refuses a sub-path of a
 * directory the public manifest does not list, and a path that exists here with other content (unless --reconcile).
 */
function classifyPaths(root, { paths, pinned, manifest, reconcile }) {
  const topLevel = [];
  const rootFiles = [];
  for (const target of paths) {
    const top = target.split("/")[0];
    const object = pinned.objects.get(target);
    if (target === top) {
      (object.type === "tree" ? topLevel : rootFiles).push(target);
    } else if (manifest.paths?.[top] !== "public") {
      throw new PromoteError("unownable-path", `${target} lies in ${top}, which ${PUBLIC_MANIFEST} does not list; promote the whole directory ${top}`);
    }
    const here = objectAt(root, "HEAD", target);
    if (here && !sameObject(here, object) && !reconcile) {
      throw new PromoteError("path-conflict", `${target} already exists on this branch with different content; pass --reconcile to merge it and resolve the conflicts`);
    }
  }
  return { topLevel, rootFiles };
}

/** The directories above a slash-separated path, outermost first. */
const ancestorsOf = (file) => {
  const parts = file.split("/");
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"));
};

/**
 * Untracked or ignored entries here that git may treat as one opaque path: every file or symlink git lists under the
 * paths (a nested repository is listed once as `dir/`; the slash is dropped), plus each untracked file, symlink or
 * nested repository above a selected sub-path, which a pathspec below it does not list.
 */
function localEntries(root, paths) {
  const listed = git(root, ["--literal-pathspecs", "ls-files", "-z", "--others", "--", ...paths]).split("\0").filter(Boolean);
  const entries = new Set(listed.map((entry) => (entry.endsWith("/") ? entry.slice(0, -1) : entry)));
  for (const target of paths) {
    // Outermost first, stopping at the first obstruction: nothing below a file, symlink or nested repository is
    // reachable (lstat would fail with ENOTDIR), and the obstruction alone already collides with the path.
    for (const directory of ancestorsOf(target)) {
      const tracked = objectAt(root, "HEAD", directory);
      if (tracked?.type === "tree") continue;
      if (tracked !== null) break; // a tracked file above the path: the merge itself reports that conflict
      const stat = lstatSync(path.join(root, directory), { throwIfNoEntry: false });
      if (!stat) break;
      if (!stat.isDirectory() || lstatSync(path.join(root, directory, ".git"), { throwIfNoEntry: false })) {
        entries.add(directory);
        break;
      }
    }
  }
  return [...entries];
}

/**
 * Refuses an untracked or ignored entry (file, symlink or nested repository) here that the merge would write over: one
 * at an imported file's path, one with an imported file inside it, or one inside an imported file's path. git merge
 * overwrites ignored content, and undoing a failed attempt would then delete it, so the check runs before the branch is
 * created. Other ignored content (node_modules, build output, a nested repository next writes nothing into) stays.
 */
function refuseLocalFiles(root, paths, files) {
  const importedFiles = new Set(files);
  const importedDirectories = new Set(files.flatMap(ancestorsOf));
  for (const entry of localEntries(root, paths)) {
    const clash = importedFiles.has(entry) || importedDirectories.has(entry) ? entry : ancestorsOf(entry).find((directory) => importedFiles.has(directory));
    if (clash !== undefined) {
      throw new PromoteError("path-conflict", `${entry} exists here as an untracked or ignored file or repository and next's ${clash} would replace it; move it out of the way first`);
    }
  }
}

/** The npm and Python release moves, checked before anything changes. */
function planReleases(root, { pinned, paths, current }) {
  const release = releaseMoves({ pinOverlay: pinned.overlay, pinBase: pinned.base, current, paths });
  const pythonScript = path.join(root, PYTHON_RELEASE_SCRIPT);
  const pythonSource = existsSync(pythonScript) ? readFileSync(pythonScript, "utf8") : null;
  const python = pythonMoves({
    overlay: pinned.pythonOverlay,
    paths,
    targets: pythonSource === null ? new Map() : readPythonTargets(pythonSource),
    discovered: pinned.pythonProjects,
    existing: pythonProjectsAt(root, "HEAD", filesAt(root, "HEAD")),
  });
  if (python.moves.length > 0 && pythonSource === null) throw new PromoteError("malformed-file", `${PYTHON_RELEASE_SCRIPT} not found`);
  return { release, python, pythonSource };
}

/** Writes the manifest, release-packages.json and TARGETS edits; returns the files it changed. */
function writeEdits(root, { manifest, changed, plan }) {
  const edited = [];
  if (Object.values(changed).some((list) => list.length > 0)) {
    writeFileSync(path.join(root, PUBLIC_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    edited.push(PUBLIC_MANIFEST);
  }
  if (plan.release.moves.length > 0) {
    const file = path.join(root, RELEASE_FILES.public);
    writeFileSync(file, appendReleaseEntries(readFileSync(file, "utf8"), plan.release.moves));
    edited.push(RELEASE_FILES.public);
  }
  if (plan.python.moves.length > 0) {
    writeFileSync(path.join(root, PYTHON_RELEASE_SCRIPT), addPythonTargets(plan.pythonSource, plan.python.moves));
    edited.push(PYTHON_RELEASE_SCRIPT);
  }
  return edited;
}

const OVERWRITE_REFUSED = /would be (?:overwritten|removed) by (?:checkout|merge):\n((?:\s.*\n?)*)/;

/** Runs a git command that writes the working tree; git's refusal to replace untracked or ignored files is a path-conflict. */
function writeTree(root, args) {
  // git's own messages are parsed below, so they must be untranslated.
  const result = git(root, args, { allowFailure: true, env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" } });
  const refused = OVERWRITE_REFUSED.exec(result.stderr);
  if (refused) {
    const blocked = lines(refused[1]).map((line) => line.trim()).join(", ");
    throw new PromoteError("path-conflict", `${blocked} exists here as an untracked or ignored file and next's history would replace it; move it out of the way first`);
  }
  return result;
}

/**
 * Creates the branch with the imported history merged in, then stages the edits and commits them (with merge
 * conflicts left by --reconcile they stay staged for the operator's merge commit). Returns the conflicting paths.
 */
function mergeAndCommit(root, { branch, imported, label, paths, pin, reconcile, edits }) {
  const message = `Promote ${label} from next at ${pin.slice(0, 12)}\n\nImported with history by scripts/promote.mjs (SFNS-121 D9): ${paths.join(" ")} from next ${pin}.`;
  const conflicts = mergeInScratch(root, { branch, imported, message, reconcile });
  const edited = writeEdits(root, edits);
  if (edited.length > 0) git(root, ["add", "--", ...edited]);
  if (edited.length > 0 && conflicts.length === 0) {
    git(root, ["commit", "-q", "-m", `Promote ${label}: public owner and release entries from next\n\nscripts/promote.mjs (SFNS-121 D8, D9): ${edited.join(", ")}.`]);
  }
  return conflicts;
}

/**
 * git merge replaces ignored files whatever its --overwrite-ignore setting (ort ignores it), and undoing a failed
 * attempt cannot bring them back. So git merge runs in a scratch worktree of this repository, with its configuration
 * and hooks (pre-merge-commit, commit-msg, merge.verifySignatures, signing), and its result reaches this working tree
 * only through checkout --no-overwrite-ignore, which refuses, atomically and before any change, to replace an
 * untracked or ignored file, including one that appeared after refuseLocalFiles. A conflicting --reconcile merge
 * arrives as a temporary commit of its files (conflict markers included) that then gives way to the merge state git
 * merge leaves (conflict stages, MERGE_HEAD). Returns the conflicting paths.
 */
function mergeInScratch(root, { branch, imported, message, reconcile }) {
  const scratch = mkdtempSync(path.join(tmpdir(), "promote-merge-"));
  const worktree = path.join(scratch, "worktree");
  const original = git(root, ["rev-parse", "HEAD"]).trim();
  const checkout = (commit) => {
    const switched = writeTree(root, ["checkout", "-q", "--no-overwrite-ignore", "-b", branch, commit]);
    if (switched.status !== 0) throw new PromoteError("git-failed", `checkout of the merge failed: ${switched.stderr.trim()}`);
  };
  // This checkout's hooks, also when core.hooksPath is relative to it (the scratch worktree lacks untracked files).
  const hooks = path.resolve(root, git(root, ["rev-parse", "--git-path", "hooks"]).trim());
  try {
    git(root, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "--detach", worktree, "HEAD"]);
    const mergeArgs = ["-c", `core.hooksPath=${hooks}`, "merge", "-q", "--no-ff", "--allow-unrelated-histories", "-m", message, imported];
    const merged = git(worktree, mergeArgs, { allowFailure: true });
    if (merged.status === 0) {
      checkout(git(worktree, ["rev-parse", "HEAD"]).trim());
      git(root, ["update-ref", "ORIG_HEAD", original]); // as git merge leaves it, for git reset --merge ORIG_HEAD
      return [];
    }
    const conflicts = lines(git(worktree, ["diff", "--name-only", "--diff-filter=U"]));
    if (!reconcile || conflicts.length === 0) throw new PromoteError("git-failed", `merge failed: ${(merged.stderr || merged.stdout).trim()}`);
    const stages = git(worktree, ["ls-files", "-s", "-z"]);
    // The worktree's files, conflict markers included, as a tree, staged in a copy of its index.
    const index = path.join(scratch, "index");
    copyFileSync(path.resolve(worktree, git(worktree, ["rev-parse", "--git-path", "index"]).trim()), index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(worktree, ["add", "-A"], { env });
    const files = git(worktree, ["write-tree"], { env }).trim();
    checkout(git(root, ["commit-tree", files, "-p", "HEAD", "-m", "promote: conflicted merge (temporary)"]).trim());
    // Back to the original commit with the merge's index and the merge in progress; the files stay as they are.
    git(root, ["reset", "-q", "--soft", "HEAD^"]);
    git(root, ["read-tree", "--empty"]);
    git(root, ["update-index", "-z", "--index-info"], { input: stages });
    git(root, ["update-index", "-q", "--refresh"], { allowFailure: true });
    const gitPath = (name) => path.resolve(root, git(root, ["rev-parse", "--git-path", name]).trim());
    writeFileSync(gitPath("MERGE_HEAD"), `${imported}\n`);
    writeFileSync(gitPath("MERGE_MSG"), `${message}\n`);
    writeFileSync(gitPath("MERGE_MODE"), "no-ff");
    git(root, ["update-ref", "ORIG_HEAD", original]);
    return conflicts;
  } finally {
    git(root, ["worktree", "remove", "--force", worktree], { allowFailure: true });
    rmSync(scratch, { recursive: true, force: true });
    git(root, ["worktree", "prune"], { allowFailure: true });
  }
}

/** Without --reconcile every imported path must equal next at the pin, mode included. */
function verifyImported(root, { paths, pinned, branch }) {
  for (const target of paths) {
    if (!sameObject(objectAt(root, "HEAD", target), pinned.objects.get(target))) {
      throw new PromoteError("git-failed", `${target} on ${branch} does not equal next at ${pinned.sha}`);
    }
  }
}

/**
 * Promotes `paths` (or the top-level function directory `fn`) from next at `pin`. Throws PromoteError when it
 * refuses; on success returns what it imported and changed.
 */
export function promote({ root = REPO_ROOT, fn, paths: rawPaths = [], pin, source, base = "origin/dev", branch, reconcile = false } = {}) {
  root = path.resolve(root);
  const paths = normalizePaths(fn === undefined ? rawPaths : [fn]);
  if (!hasFilterRepo()) throw new PromoteError("missing-filter-repo", FILTER_REPO_HINT);
  branch ??= `promote/${fn ?? paths[0]}`;
  const from = pinSource(root, { source, pin });
  checkWorkingRepo(root, { base, branch });
  const fetchPin = from.local ? localPin(root, from.pin) : from.pin;

  const current = readJsonFile(root, RELEASE_FILES.public).data;
  if (!Array.isArray(current)) throw new PromoteError("malformed-file", `${RELEASE_FILES.public} must be an array`);
  const work = mkdtempSync(path.join(tmpdir(), "promote-"));
  try {
    const pinned = readPin(work, { source: from.source, pin: fetchPin, paths });
    if (fn !== undefined && pinned.objects.get(paths[0]).type !== "tree") {
      throw new PromoteError("path-missing", `${fn} is not a directory in next at ${pinned.sha}; use --path for a file`);
    }
    const manifest = readJsonFile(root, PUBLIC_MANIFEST).data;
    ownersCheck(() => parseManifest(structuredClone(manifest), { kind: "public" }));
    const { topLevel, rootFiles } = classifyPaths(root, { paths, pinned, manifest, reconcile });
    refuseLocalFiles(root, paths, pinned.files);
    const plan = planReleases(root, { pinned, paths, current });
    // Every imported release becomes public, including one this checkout already lists (a retry or partial cutover).
    const flip = { topLevel, rootFiles, slugs: plan.release.entries.map((entry) => entry.slug), pythonNames: plan.python.names };
    const changed = flipManifest(manifest, flip);

    const { head, commits } = filterHistory(work, paths);
    git(root, ["fetch", "-q", "--no-tags", work, `refs/heads/${SOURCE_BRANCH}`]);
    const imported = git(root, ["rev-parse", "FETCH_HEAD^{commit}"]).trim();
    if (imported !== head) throw new PromoteError("git-failed", `fetched ${imported}, expected ${head}`);

    const original = currentCheckout(root);
    try {
      // Branch creation is inside the recovery path: a failing post-checkout hook fails the checkout after the branch
      // is created and checked out.
      const label = fn ?? paths.join(", ");
      const edits = { manifest, changed, plan };
      const conflicts = mergeAndCommit(root, { branch, imported, label, paths, pin: pinned.sha, reconcile, edits });
      if (!reconcile) verifyImported(root, { paths, pinned, branch });
      return promotionResult({ fn, branch, paths, pinned, commits, plan, changed, conflicts, flip });
    } catch (error) {
      undoBranch(root, original, branch);
      throw error;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function promotionResult({ fn, branch, paths, pinned, commits, plan, changed, conflicts, flip }) {
  const releaseEntries = plan.release.entries;
  const pythonEntries = plan.python.entries;
  return {
    branch,
    pin: pinned.sha,
    paths,
    commits,
    files: pinned.files,
    releases: plan.release.moves,
    python: plan.python.moves,
    changed,
    conflicts,
    nextCleanup: {
      manifest: nextManifestEntries(pinned.nextManifest, flip),
      overlay: releaseEntries.filter((entry) => entry.source === RELEASE_FILES.next).map((entry) => entry.slug),
      pythonOverlay: pythonEntries.map((entry) => entry.name),
    },
    issues: referencedIssues(commits),
    searchTerms: [...new Set([...(fn ? [fn] : paths), ...releaseEntries.map((entry) => entry.name), ...pythonEntries.map((entry) => entry.name)])],
  };
}

export function formatReport(result) {
  const out = [];
  const list = (title, items, format = (item) => item) => {
    out.push(`${title} (${items.length}):`);
    for (const item of items) out.push(`  ${format(item)}`);
  };
  out.push(`Promoted ${result.paths.join(" ")} from next ${result.pin} onto branch ${result.branch}.`);
  list("Imported commits", result.commits, ({ sha, subject }) => `${sha.slice(0, 12)} ${subject}`);
  list("Imported files", result.files);
  list("Release entries moved into release-packages.json", result.releases, ({ slug, name, path: directory, source }) => `${slug} ${name} ${directory} (from ${source})`);
  list("Python projects moved into TARGETS", result.python, ({ name, path: directory }) => `${name} ${directory}`);
  const flipped = Object.entries(result.changed).flatMap(([section, names]) => names.map((name) => `${section}.${name}`));
  list(`Set to "public" in ${PUBLIC_MANIFEST}`, flipped);
  if (result.conflicts.length > 0) {
    list("Merge conflicts left for you (--reconcile); resolve them, git add, then git commit", result.conflicts);
  }
  const cleanup = [
    ...result.nextCleanup.manifest.map((entry) => `${NEXT_MANIFEST}: remove ${entry}`),
    ...result.nextCleanup.overlay.map((slug) => `${RELEASE_FILES.next}: remove ${slug}`),
    ...result.nextCleanup.pythonOverlay.map((name) => `${PYTHON_OVERLAY}: remove ${name}`),
  ];
  list("On next, before the next sync merges this (else the owner and release checks fail)", cleanup);
  const issues = result.issues.length > 0 ? result.issues.join(", ") : "none";
  out.push(
    "Linear move list (D11, operator step; this script moves no issues):",
    "  Move every open SF Next issue of the promoted code to its public team (or SFNS when none exists); closed issues stay.",
    `  SF Next issues named in the imported history: ${issues}`,
    ...result.searchTerms.map((term) => `  Search SF Next open issues for: ${term}`),
    "Next: npm install (refresh package-lock.json), node scripts/verify-owners.mjs, node scripts/verify-public-boundary.mjs,",
    "      then open a PR to dev and merge it with a merge commit (squash or rebase drops the imported history).",
  );
  return out.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    const result = promote(options);
    console.log(formatReport(result));
    return result.conflicts.length > 0 ? 2 : 0;
  } catch (error) {
    if (error instanceof OwnersError) {
      console.error(`promote: malformed-file: ${error.message}`);
      return 1;
    }
    if (!(error instanceof PromoteError)) throw error;
    console.error(`promote: ${error.code}: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
