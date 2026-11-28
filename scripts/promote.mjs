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
// Exit status: 0 promoted, 1 refused or failed (nothing changed), 2 merge conflicts left in a printed worktree (--reconcile).

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
   * @param {"usage" | "missing-filter-repo" | "dirty-tree" | "wrong-base" | "branch-exists" | "pin-missing" | "path-missing" | "protected-path" | "conduct-path" | "unownable-path" | "path-conflict" | "release-conflict" | "malformed-file" | "checkout-policy" | "git-failed"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "PromoteError";
    this.code = code;
  }
}

const lines = (text) => text.split("\n").filter(Boolean);

let localEnvVars;
/**
 * process.env without the variables that select a repository, index, object store or command-scope configuration
 * (git rev-parse --local-env-vars, and GIT_CONFIG_KEY_n/VALUE_n): an exported GIT_DIR or GIT_WORK_TREE must not
 * point git init, update-ref or filter-repo --force in the temporary repository at this one.
 */
function gitEnv() {
  if (!localEnvVars) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
    const probe = spawnSync(gitBinary(), ["rev-parse", "--local-env-vars"], { env, encoding: "utf8" });
    localEnvVars = new Set(["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", ...lines(probe.stdout ?? "")]);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !localEnvVars.has(name) && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)));
  // git reads a relative GIT_CONFIG_GLOBAL/SYSTEM against its own directory, which differs per call (this checkout,
  // the temporary repository, the scratch worktree): resolve it once against the caller's, as the operator meant it.
  for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) if (env[name] && !path.isAbsolute(env[name])) env[name] = path.resolve(env[name]);
  return env;
}

/** Runs git in `cwd` with gitEnv() plus the per-call `env` overrides; `encoding: "buffer"` returns raw bytes. */
function git(cwd, args, { input, allowFailure = false, env, encoding = "utf8" } = {}) {
  const result = spawnSync(gitBinary(), args, { cwd, input, env: { ...gitEnv(), ...env }, encoding, maxBuffer: 1 << 30 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new PromoteError("git-failed", `git ${args.join(" ")} failed: ${String(result.stderr || result.stdout).trim()}`);
  }
  return allowFailure ? result : result.stdout;
}

const gitOk = (cwd, args) => git(cwd, args, { allowFailure: true }).status === 0;

/** True when `git filter-repo` runs. */
export function hasFilterRepo() {
  try {
    return gitOk(process.cwd(), ["filter-repo", "--version"]);
  } catch {
    return false;
  }
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

/** Parsed JSON of a file at `rev` of this checkout (the commit promotion plans against). */
function readJsonFile(root, rev, file) {
  const result = git(root, ["show", `${rev}:${file}`], { allowFailure: true });
  if (result.status !== 0) throw new PromoteError("malformed-file", `${file} not found at ${rev}`);
  const text = result.stdout;
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
  const entries = candidates.map(({ slug, path: directory, name, ...rest }) => ({ slug, path: directory, name, ...bareFields(rest), source }));
  const moves = entries.filter((entry) => {
    const sameSlug = current.find((existing) => existing?.slug === entry.slug);
    const sameName = current.find((existing) => existing?.name === entry.name);
    if (sameSlug && sameSlug.path === entry.path && sameSlug.name === entry.name && sameBareFields(sameSlug, entry)) return false;
    if (sameSlug || sameName) {
      const other = sameSlug ?? sameName;
      throw new PromoteError(
        "release-conflict",
        `release ${JSON.stringify(entry.slug)} (${entry.name}, ${entry.path}) from next's ${source} conflicts with ${RELEASE_FILES.public} entry ${JSON.stringify(other)}`,
      );
    }
    return true;
  });
  // A bare entry and its core and CLI move together: a linked slug left behind makes the public release file invalid,
  // and a bare entry left behind on next would publish from a different repository than its core or CLI.
  const all = Array.isArray(pinOverlay ?? pinBase) ? (pinOverlay ?? pinBase) : [];
  for (const entry of moves) {
    const behind = all.find((other) => other?.kind === "bare" && other.slug !== entry.slug && (other.core === entry.slug || other.cli === entry.slug) && !moves.some((moved) => moved.slug === other.slug) && !current.some((existing) => existing?.slug === other.slug));
    if (behind) {
      throw new PromoteError("release-conflict", `release ${JSON.stringify(entry.slug)} from next's ${source} is the ${behind.core === entry.slug ? "core" : "cli"} of bare release ${JSON.stringify(behind.slug)} (${behind.path}), which is not promoted with it; promote both`);
    }
  }
  for (const entry of moves) {
    for (const field of ["core", "cli"]) {
      const slug = entry[field];
      if (slug === undefined || slug === entry.slug) continue;
      if (!current.some((existing) => existing?.slug === slug) && !entries.some((other) => other.slug === slug)) {
        throw new PromoteError("release-conflict", `bare release ${JSON.stringify(entry.slug)} from next's ${source} names ${field} ${JSON.stringify(slug)}, which is neither promoted with it nor in ${RELEASE_FILES.public}`);
      }
    }
  }
  return { entries, moves };
}

/** The bare-package fields of a release entry (resolve-release-tag.mjs), in their written order; none for other entries. */
const BARE_FIELDS = ["kind", "core", "cli"];
function bareFields(entry) {
  return Object.fromEntries(BARE_FIELDS.filter((field) => entry?.[field] !== undefined).map((field) => [field, entry[field]]));
}
const sameBareFields = (a, b) => BARE_FIELDS.every((field) => a?.[field] === b?.[field]);

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
  const added = moves.map((entry) => {
    const fields = { slug: entry.slug, path: entry.path, name: entry.name, ...bareFields(entry) };
    return `  { ${Object.entries(fields).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ")} }`;
  });
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
  if (gitOk(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) || gitOk(root, ["symbolic-ref", "-q", `refs/heads/${branch}`])) {
    throw new PromoteError("branch-exists", `branch ${branch} already exists`);
  }
  if (!gitOk(root, ["check-ref-format", "--branch", branch])) throw new PromoteError("usage", `${JSON.stringify(branch)} is not a valid branch name`);
  return currentCheckout(root);
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
  return { head, commits, history: auditHistory(work, head) };
}

const RAW_ENTRY = /^\n*:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*$/;
// Formats to render rather than read, including those stored as text: SVG (any namespace prefix), PNM, XPM, XBM,
// PostScript/EPS, PDF and image data embedded in text (data: URIs, notebook outputs), recognised by extension or by
// content. Text formats are matched anywhere in the file, past comments and whitespace; listing an extra version only
// costs one more look.
const IMAGE_EXTENSION = /\.(?:svgz?|p[bgpna]m|xpm|xbm|e?ps|pdf|ai)$/i;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
// Leading bytes: PNG, JPEG, GIF87a/89a and WebP (RIFF, any 4-byte size, WEBP); PNM is P1-P7 and whitespace.
const IMAGE_MAGIC = [
  [0, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  [0, Buffer.from([0xff, 0xd8, 0xff])],
  [0, Buffer.from("GIF87a")],
  [0, Buffer.from("GIF89a")],
  [0, Buffer.from("RIFF"), 8, Buffer.from("WEBP")],
];
const PNM_SPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0]);
// Simple patterns, each linear in the text: leading whitespace never runs across lines.
const IMAGE_TEXT = [
  /<(?:[\w.-]+:)?svg[\s>/]/i,
  /http:\/\/www\.w3\.org\/2000\/svg/i,
  /\/\*\s*XPM\s*\*\//i,
  /^[ \t\v\f]*#[ \t\v\f]*define[ \t\v\f]+\S*_width\s/im,
  /^[ \t\v\f]*%!PS/im,
  /%PDF-/i,
  /data:image\//i,
  /"image\/[\w.+-]+"\s*:/i,
];
// Control characters other than tab, line feed, vertical tab, form feed and carriage return: not text.
const CONTROL = /[\x00-\x08\x0e-\x1f\x7f]/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function hasImageMagic(content) {
  const bytes = content.subarray(0, BOM.length).equals(BOM) ? content.subarray(BOM.length) : content;
  const at = (offset, signature) => bytes.subarray(offset, offset + signature.length).equals(signature);
  if (IMAGE_MAGIC.some(([offset, signature, offset2, signature2]) => at(offset, signature) && (!signature2 || at(offset2, signature2)))) return true;
  return bytes[0] === 0x50 && bytes[1] >= 0x31 && bytes[1] <= 0x37 && PNM_SPACE.has(bytes[2]);
}

/** "image" (to render), "binary" or null (text) for one blob and the paths it was imported under. */
export function classifyBlob(content, paths) {
  let text = null;
  try {
    text = utf8.decode(content);
    if (CONTROL.test(text)) text = null;
  } catch {
    // invalid UTF-8: binary
  }
  if (hasImageMagic(content) || paths.some((file) => IMAGE_EXTENSION.test(file)) || (text !== null && IMAGE_TEXT.some((pattern) => pattern.test(text)))) return "image";
  return text === null ? "binary" : null;
}

/**
 * Every non-text or image blob version the promotion imports, from the filtered history (deleted and side-branch
 * versions too): {oid, kind, paths}. Fails closed: rev-list --objects is the complete set, each blob must have a path
 * in some commit's diff and be read by cat-file, so a missing object or a gap stops the promotion (git-failed).
 */
function auditHistory(work, head) {
  const objects = lines(git(work, ["rev-list", "--objects", "--no-object-names", head]));
  const checked = lines(git(work, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: `${objects.join("\n")}\n` })).map((line) => line.split(" "));
  if (checked.length !== objects.length || checked.some(([, type]) => type === "missing")) throw new PromoteError("git-failed", "history audit: an imported object is missing");
  const blobs = checked.filter(([, type]) => type === "blob").map(([oid]) => oid);
  const raw = git(work, ["log", "--raw", "-z", "--no-abbrev", "--no-renames", "--root", "--diff-merges=separate", "--no-show-signature", "--format=", head]).split("\0");
  const pathsOf = new Map();
  for (let index = 0; index < raw.length; index += 1) {
    const entry = RAW_ENTRY.exec(raw[index]);
    if (!entry) continue;
    index += 1;
    const file = raw[index];
    if (entry[1] !== "000000" && entry[1] !== "160000") pathsOf.set(entry[2], (pathsOf.get(entry[2]) ?? new Set()).add(file));
  }
  if (blobs.length === 0) return [];
  const out = git(work, ["cat-file", "--batch"], { input: Buffer.from(`${blobs.join("\n")}\n`), encoding: "buffer" });
  const listed = [];
  let at = 0;
  for (const oid of blobs) {
    const eol = out.indexOf(10, at);
    const [name, type, size] = out.subarray(at, eol === -1 ? out.length : eol).toString().split(" ");
    const paths = [...(pathsOf.get(oid) ?? [])].sort(compareText);
    if (eol === -1 || name !== oid || type !== "blob" || paths.length === 0) throw new PromoteError("git-failed", `history audit: cannot read or place imported blob ${oid}`);
    const kind = classifyBlob(out.subarray(eol + 1, eol + 1 + Number(size)), paths);
    if (kind) listed.push({ oid, kind, paths });
    at = eol + 2 + Number(size);
  }
  return listed.sort((a, b) => compareText(a.paths[0], b.paths[0]) || compareText(a.oid, b.oid));
}

/** SF Next issue identifiers named in the imported commits, for the Linear move list (D11). */
export function referencedIssues(commits) {
  const found = new Set();
  for (const { subject, body } of commits) for (const match of `${subject}\n${body}`.matchAll(/\bSFN-\d+\b/g)) found.add(match[0]);
  return [...found].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}

/** The commit and branch (null when detached) checked out now: what promotion plans against and builds from. */
function currentCheckout(root) {
  const symbolic = git(root, ["symbolic-ref", "-q", "--short", "HEAD"], { allowFailure: true }).stdout.trim();
  return { sha: git(root, ["rev-parse", "HEAD"]).trim(), branch: symbolic || null };
}

/**
 * Creates the promotion branch at `start` only if no such ref exists (compare-and-create) and records it as owned.
 * A branch something else created after the early check is never adopted: branch-exists, and nothing to clean up.
 */
function claimBranch(root, owned, start) {
  // A symbolic ref (even a dangling one) is something else's; some git versions would replace a dangling one.
  if (gitOk(root, ["symbolic-ref", "-q", owned.ref])) {
    throw new PromoteError("branch-exists", `branch ${owned.branch} was created by something else while promotion ran; it was left as it is`);
  }
  const created = git(root, ["update-ref", "--no-deref", "--create-reflog", "-m", "promote: create", owned.ref, start, ""], { allowFailure: true });
  if (created.status === 0) {
    owned.oid = start;
    return;
  }
  if (gitOk(root, ["rev-parse", "--verify", "--quiet", owned.ref]) || gitOk(root, ["symbolic-ref", "-q", owned.ref])) {
    throw new PromoteError("branch-exists", `branch ${owned.branch} was created by something else while promotion ran; it was left as it is`);
  }
  throw new PromoteError("git-failed", `cannot create branch ${owned.branch}: ${created.stderr.trim()}`);
}

/** Whether the promotion branch is still the plain (not symbolic) ref promotion created, where promotion left it. */
function stillOwned(root, owned) {
  if (owned.oid === null || gitOk(root, ["symbolic-ref", "-q", owned.ref])) return false;
  return git(root, ["rev-parse", "--verify", "--quiet", owned.ref], { allowFailure: true }).stdout.trim() === owned.oid;
}

/** Refuses to go on with a promotion branch that no longer points where promotion left it: something else moved it. */
function requireOwned(root, owned) {
  if (!stillOwned(root, owned)) throw new PromoteError("git-failed", `branch ${owned.branch} was moved by something else while promotion ran; it was left as it is`);
}

/** Adopts the commit a promotion step just made on the owned branch, but only one made on top of the owned commit. */
function advanceBranch(worktree, owned) {
  const [tip, parent] = lines(git(worktree, ["rev-parse", "HEAD", "HEAD^"]));
  if (parent === owned.oid) owned.oid = tip;
}

/**
 * After a failed attempt, deletes the promotion branch only if promotion created it and it is still a plain ref
 * where promotion left it (update-ref --no-deref -d with that old value), and never while any worktree has it checked
 * out (as git branch -D refuses). A branch something else created, moved, recreated, replaced with a symbolic ref or
 * checked out survives with its reflog, and so does the target of such a symbolic ref.
 */
function discardBranch(root, owned) {
  if (!stillOwned(root, owned)) return;
  const checkedOut = git(root, ["worktree", "list", "--porcelain", "-z"]).split("\0").includes(`branch ${owned.ref}`);
  if (checkedOut) return;
  git(root, ["update-ref", "--no-deref", "-d", owned.ref, owned.oid], { allowFailure: true });
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
function classifyPaths(root, { start, paths, pinned, manifest, reconcile }) {
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
    const here = objectAt(root, start.sha, target);
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
function localEntries(root, paths, start) {
  const listed = git(root, ["--literal-pathspecs", "ls-files", "-z", "--others", "--", ...paths]).split("\0").filter(Boolean);
  const entries = new Set(listed.map((entry) => (entry.endsWith("/") ? entry.slice(0, -1) : entry)));
  for (const target of paths) {
    // Outermost first, stopping at the first obstruction: nothing below a file, symlink or nested repository is
    // reachable (lstat would fail with ENOTDIR), and the obstruction alone already collides with the path.
    for (const directory of ancestorsOf(target)) {
      const tracked = objectAt(root, start.sha, directory);
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
function refuseLocalFiles(root, paths, files, start) {
  const importedFiles = new Set(files);
  const importedDirectories = new Set(files.flatMap(ancestorsOf));
  for (const entry of localEntries(root, paths, start)) {
    const clash = importedFiles.has(entry) || importedDirectories.has(entry) ? entry : ancestorsOf(entry).find((directory) => importedFiles.has(directory));
    if (clash !== undefined) {
      throw new PromoteError("path-conflict", `${entry} exists here as an untracked or ignored file or repository and next's ${clash} would replace it; move it out of the way first`);
    }
  }
}

/** The npm and Python release moves, checked before anything changes. */
function planReleases(root, { start, pinned, paths, current }) {
  const release = releaseMoves({ pinOverlay: pinned.overlay, pinBase: pinned.base, current, paths });
  const script = git(root, ["show", `${start.sha}:${PYTHON_RELEASE_SCRIPT}`], { allowFailure: true });
  const pythonSource = script.status === 0 ? script.stdout : null;
  const python = pythonMoves({
    overlay: pinned.pythonOverlay,
    paths,
    targets: pythonSource === null ? new Map() : readPythonTargets(pythonSource),
    discovered: pinned.pythonProjects,
    existing: pythonProjectsAt(root, start.sha, filesAt(root, start.sha)),
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
  const result = git(root, args, { allowFailure: true, env: { LC_ALL: "C", LANGUAGE: "C" } });
  const refused = OVERWRITE_REFUSED.exec(result.stderr);
  if (refused) {
    const blocked = lines(refused[1]).map((line) => line.trim()).join(", ");
    throw new PromoteError("path-conflict", `${blocked} exists here as an untracked or ignored file and next's history would replace it; move it out of the way first`);
  }
  return result;
}

/** Removes only the scratch worktree (never a repository-wide prune, which would drop other missing worktrees). */
function removeWorktree(root, worktree) {
  if (!existsSync(worktree)) return;
  const admin = git(worktree, ["rev-parse", "--absolute-git-dir"], { allowFailure: true }).stdout.trim();
  if (git(root, ["worktree", "remove", "--force", worktree], { allowFailure: true }).status !== 0 && admin.includes(`${path.sep}worktrees${path.sep}`)) {
    rmSync(admin, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
}

/** Every configuration entry git loads in `cwd`, in order: scope, file (absolute, real path) and entry. */
function configEntries(cwd) {
  const records = git(cwd, ["config", "--list", "--show-origin", "--show-scope", "-z"]).split("\0");
  const entries = [];
  for (let index = 0; index + 2 < records.length; index += 3) {
    const [scope, origin, entry] = records.slice(index, index + 3);
    // Only the spelling differs between worktrees: git names this checkout's files relative to it (file:.git/config).
    const where = origin.startsWith("file:") ? `file:${realPath(path.resolve(cwd, origin.slice(5)))}` : origin;
    entries.push(`${scope}\0${where}\0${entry}`);
  }
  return entries;
}

const POLICY_HINT = "promotion builds the branch in a linked worktree and refuses to emulate git configuration there";
const PARENT_SEGMENT = /(?:^|[\s"'=:;,(/\\])\.\.(?:[/\\]|$)/;
// Resolved against the including file (and compared as loaded files) or not a local path at all.
const NOT_WORKTREE_PATH = /^(?:include(?:if\..*)?\.path|remote\..*\.(?:push)?url|submodule\..*\.url|url\..*)$/i;

/**
 * The branch is built with exactly this checkout's git policy or not at all: git itself must load the same
 * configuration, entry for entry and in order, in the scratch worktree as here. A gitdir include matching only one of
 * them, an onbranch include for the current branch, or a worktree-scoped config.worktree makes them differ. A relative
 * core.hooksPath (resolved per worktree) and core.worktree (which would point the scratch worktree elsewhere) are
 * refused too, also when the promotion branch's own onbranch configuration sets them; so is a gitdir include that
 * configuration adds, which git may resolve differently for this checkout's git directory. Called with the entries the
 * scratch worktree loaded before the branch existed (`start`) once it does; returns its entries.
 */
function refusePolicyDifference(root, worktree, start = null) {
  const there = configEntries(worktree);
  if (start === null) {
    const here = configEntries(root);
    const index = here.findIndex((entry, at) => entry !== there[at]);
    if (index !== -1 || here.length !== there.length) {
      const differing = (here[index] ?? there[here.length]).split("\0");
      throw new PromoteError("checkout-policy", `git loads other configuration in a linked worktree than here (first difference: ${differing[2].split("\n")[0]} from ${differing[1]}); ${POLICY_HINT}. Run it from a detached checkout (git switch --detach origin/dev) without worktree-only or gitdir-specific configuration`);
    }
  } else {
    const added = there.find((record) => !start.includes(record) && /^includeif\.gitdir/i.test(record.split("\0")[2]));
    if (added) throw new PromoteError("checkout-policy", `the promotion branch's configuration adds ${added.split("\0")[2].split("\n")[0]} (from ${added.split("\0")[1]}), which git may resolve differently for this checkout; ${POLICY_HINT}`);
  }
  // A value climbing out with ".." (a gpg program, core.fsmonitor, a merge or filter driver) names another file from
  // the scratch worktree than from here, possibly in a shared directory above this repository.
  for (const record of there) {
    const [key, value = ""] = record.split("\0")[2].split("\n");
    if (!NOT_WORKTREE_PATH.test(key) && PARENT_SEGMENT.test(value)) {
      throw new PromoteError("checkout-policy", `${key} = ${JSON.stringify(value)} climbs out of the work tree with "..", so it names another path in a linked worktree; ${POLICY_HINT}. Use an absolute path, then retry`);
    }
  }
  const setting = (key) => git(worktree, ["config", "--path", "--get", key], { allowFailure: true }).stdout.trim();
  const hooksPath = setting("core.hooksPath"); // ~/ and %(prefix)/ expanded: the same in every worktree
  if (hooksPath && !path.isAbsolute(hooksPath)) {
    throw new PromoteError("checkout-policy", `core.hooksPath ${JSON.stringify(hooksPath)} is relative, so it names another directory in a linked worktree; ${POLICY_HINT}. Set it to an absolute path, then retry`);
  }
  if (setting("core.worktree")) throw new PromoteError("checkout-policy", `core.worktree is set; ${POLICY_HINT}. Unset it, then retry`);
  return there;
}

/**
 * Builds `branch` from `start` in a scratch worktree of this repository and never writes this checkout: git merge
 * (ort) replaces ignored files whatever its --overwrite-ignore setting. The worktree starts detached, its configuration
 * must equal this checkout's, and only then is the branch created in it, so git itself applies the policy it resolves
 * for that branch (includeIf onbranch, hooks, signing, merge.verifySignatures) to the merge and the ownership commit.
 * With merge conflicts left by --reconcile the worktree is kept for the operator, the edits staged; otherwise it is
 * removed. Returns the conflicting paths and the kept worktree (null when none).
 */
function buildBranch(root, { start, owned, imported, label, paths, pin, reconcile, edits }) {
  // A private (0700) directory in this repository's git directory, not the shared tmpdir: a relative path git resolves
  // against the work tree (core.fsmonitor, gpg programs, merge and filter drivers) can then only reach this repository
  // and its ancestors, never a location another user can write.
  const common = path.resolve(root, git(root, ["rev-parse", "--git-common-dir"]).trim());
  const scratch = mkdtempSync(path.join(common, "promote-"));
  const worktree = path.join(scratch, "worktree");
  let kept = null;
  try {
    git(root, ["worktree", "add", "-q", "--detach", "--no-checkout", worktree, start]);
    const loaded = refusePolicyDifference(root, worktree);
    claimBranch(root, owned, start);
    git(worktree, ["switch", "-q", owned.branch]);
    requireOwned(root, owned);
    refusePolicyDifference(root, worktree, loaded);
    git(worktree, ["reset", "-q", "--hard"]);
    const message = `Promote ${label} from next at ${pin.slice(0, 12)}\n\nImported with history by scripts/promote.mjs (SFNS-121 D9): ${paths.join(" ")} from next ${pin}.`;
    const merged = git(worktree, ["merge", "-q", "--no-ff", "--allow-unrelated-histories", "-m", message, imported], { allowFailure: true });
    const conflicts = merged.status === 0 ? [] : lines(git(worktree, ["diff", "--name-only", "--diff-filter=U"]));
    if (merged.status !== 0 && (!reconcile || conflicts.length === 0)) throw new PromoteError("git-failed", `merge failed: ${(merged.stderr || merged.stdout).trim()}`);
    if (merged.status === 0) advanceBranch(worktree, owned);
    const edited = writeEdits(worktree, edits);
    if (edited.length > 0) git(worktree, ["add", "--", ...edited]);
    if (conflicts.length > 0) {
      kept = worktree;
      return { conflicts, worktree };
    }
    if (edited.length > 0) {
      git(worktree, ["commit", "-q", "-m", `Promote ${label}: public owner and release entries from next\n\nscripts/promote.mjs (SFNS-121 D8, D9): ${edited.join(", ")}.`]);
      advanceBranch(worktree, owned);
    }
    return { conflicts, worktree: null };
  } finally {
    if (!kept) {
      removeWorktree(root, worktree);
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/**
 * Checks out the built branch here with checkout --no-overwrite-ignore, which refuses, atomically and before any
 * change, to replace an untracked or ignored file (path-conflict). When only a post-checkout hook failed after the
 * switch, it switches back without forcing, so nothing local is lost, and reports the failure.
 */
function switchToBranch(root, branch, original) {
  const switched = writeTree(root, ["checkout", "-q", "--no-overwrite-ignore", branch, "--"]);
  if (switched.status === 0) return;
  const onBranch = () => git(root, ["symbolic-ref", "-q", "HEAD"], { allowFailure: true }).stdout.trim() === `refs/heads/${branch}`;
  if (onBranch()) git(root, ["checkout", "-q", "--no-overwrite-ignore", original.branch ?? original.sha, "--"], { allowFailure: true });
  const where = onBranch() ? `; ${branch} is still checked out here` : "";
  throw new PromoteError("git-failed", `checkout of ${branch} failed: ${(switched.stderr || switched.stdout).trim()}${where}`);
}

/** Refuses to switch when this checkout moved or changed while promotion ran: the branch was planned from `start`. */
function refuseMovedCheckout(root, start) {
  const now = currentCheckout(root);
  if (now.sha !== start.sha || now.branch !== start.branch || git(root, ["status", "--porcelain", "--untracked-files=normal"]).trim() !== "") {
    const onBranch = start.branch ? ` on ${start.branch}` : "";
    throw new PromoteError("git-failed", `this checkout changed while promotion ran (it was planned from ${start.sha.slice(0, 12)}${onBranch}); nothing was switched, retry from a clean checkout`);
  }
}

/** Without --reconcile every imported path must equal next at the pin, mode included. */
function verifyImported(root, { paths, pinned, branch }) {
  for (const target of paths) {
    if (!sameObject(objectAt(root, `refs/heads/${branch}`, target), pinned.objects.get(target))) {
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
  // Everything is planned against this one commit, and the branch is built from it.
  const start = checkWorkingRepo(root, { base, branch });
  const fetchPin = from.local ? localPin(root, from.pin) : from.pin;

  const current = readJsonFile(root, start.sha, RELEASE_FILES.public).data;
  if (!Array.isArray(current)) throw new PromoteError("malformed-file", `${RELEASE_FILES.public} must be an array`);
  const work = mkdtempSync(path.join(tmpdir(), "promote-"));
  try {
    const pinned = readPin(work, { source: from.source, pin: fetchPin, paths });
    if (fn !== undefined && pinned.objects.get(paths[0]).type !== "tree") {
      throw new PromoteError("path-missing", `${fn} is not a directory in next at ${pinned.sha}; use --path for a file`);
    }
    const manifest = readJsonFile(root, start.sha, PUBLIC_MANIFEST).data;
    ownersCheck(() => parseManifest(structuredClone(manifest), { kind: "public" }));
    const { topLevel, rootFiles } = classifyPaths(root, { start, paths, pinned, manifest, reconcile });
    refuseLocalFiles(root, paths, pinned.files, start);
    const plan = planReleases(root, { start, pinned, paths, current });
    // Every imported release becomes public, including one this checkout already lists (a retry or partial cutover).
    const flip = { topLevel, rootFiles, slugs: plan.release.entries.map((entry) => entry.slug), pythonNames: plan.python.names };
    const changed = flipManifest(manifest, flip);

    const { head, commits, history } = filterHistory(work, paths);
    git(root, ["fetch", "-q", "--no-tags", work, `refs/heads/${SOURCE_BRANCH}`]);
    const imported = git(root, ["rev-parse", "FETCH_HEAD^{commit}"]).trim();
    if (imported !== head) throw new PromoteError("git-failed", `fetched ${imported}, expected ${head}`);

    // Until the final checkout promotion owns only the scratch worktree and the branch it created (once it has); a
    // failure removes those.
    const owned = { branch, ref: `refs/heads/${branch}`, oid: null };
    try {
      const label = fn ?? paths.join(", ");
      const edits = { manifest, changed, plan };
      const { conflicts, worktree } = buildBranch(root, { start: start.sha, owned, imported, label, paths, pin: pinned.sha, reconcile, edits });
      const result = promotionResult({ fn, branch, paths, pinned, commits, history, plan, changed, conflicts, flip, worktree });
      if (conflicts.length > 0) return result;
      requireOwned(root, owned);
      if (!reconcile) verifyImported(root, { paths, pinned, branch });
      refuseMovedCheckout(root, start);
      switchToBranch(root, branch, start);
      git(root, ["update-ref", "ORIG_HEAD", start.sha]); // as git merge leaves it, for git reset --merge ORIG_HEAD
      return result;
    } catch (error) {
      discardBranch(root, owned);
      throw error;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function promotionResult({ fn, branch, paths, pinned, commits, history, plan, changed, conflicts, flip, worktree }) {
  const releaseEntries = plan.release.entries;
  const pythonEntries = plan.python.entries;
  return {
    branch,
    pin: pinned.sha,
    paths,
    commits,
    files: pinned.files,
    history,
    releases: plan.release.moves,
    python: plan.python.moves,
    changed,
    conflicts,
    worktree,
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
  list(
    "Historical non-text and image versions to inspect before the PR (git cat-file blob <id>; render every image)",
    result.history,
    ({ oid, kind, paths }) => `${oid} ${kind} ${paths.map((file) => JSON.stringify(file)).join(" ")}`,
  );
  list("Release entries moved into release-packages.json", result.releases, ({ slug, name, path: directory, source }) => `${slug} ${name} ${directory} (from ${source})`);
  list("Python projects moved into TARGETS", result.python, ({ name, path: directory }) => `${name} ${directory}`);
  const flipped = Object.entries(result.changed).flatMap(([section, names]) => names.map((name) => `${section}.${name}`));
  list(`Set to "public" in ${PUBLIC_MANIFEST}`, flipped);
  if (result.conflicts.length > 0) {
    list(`Merge conflicts left for you (--reconcile) in the worktree ${result.worktree} on ${result.branch}; resolve them there, git add, then git commit`, result.conflicts);
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
