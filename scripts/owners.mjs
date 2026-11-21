// Ownership manifests (SFNS-121 D1, D2, D8): which repository owns each top-level path and publishes each
// release slug and Python project. `superfunctions.owners.json` is the public allow-list and exists in both
// repositories; `superfunctions.owners.next.json` exists only on `next` and lists the next-owned entries.
// On public an unlisted path or package is an error; on `next` an unlisted path is public-owned.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_MANIFEST = "superfunctions.owners.json";
export const NEXT_MANIFEST = "superfunctions.owners.next.json";
export const REPOS = Object.freeze(["public", "next"]);
const MODULE_FILE = fileURLToPath(import.meta.url);
/** The real path of this file: under `--preserve-symlinks-main` (or `--preserve-symlinks`) the module URL keeps a symlink. */
const REAL_MODULE_FILE = realPathOr(MODULE_FILE);
export const REPO_ROOT = path.resolve(path.dirname(REAL_MODULE_FILE), "..");
/** CI a public release tag's commit must pass when the public manifest has no `ci` section (SFNS-124): .github/workflows/ci.yml. */
export const DEFAULT_RELEASE_CI = Object.freeze({ kind: "workflow", name: "ci.yml", app: null });

export class OwnersError extends Error {
  /**
   * @param {"malformed-manifest" | "manifest-not-found" | "duplicate-owner" | "unlisted-path" | "unlisted-release" | "unlisted-python" | "invalid-path" | "invalid-repo" | "unreadable-pyproject"} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OwnersError";
    this.code = code;
    this.details = details;
  }
}

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function malformed(file, message) {
  return new OwnersError("malformed-manifest", `${file}: ${message}`, { file });
}

function checkName(file, where, name) {
  if (typeof name !== "string" || name === "" || name === "." || name === ".." || /[/\\]/.test(name) || name.trim() !== name) {
    throw malformed(file, `${where} entry ${JSON.stringify(name)} must be a single top-level name`);
  }
}

function checkKeys(file, where, object, allowed) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw malformed(file, `unknown key ${JSON.stringify(key)} in ${where}`);
  }
}

/**
 * PEP 503 canonical form of a Python project name: lowercase, each run of "-", "_" and "." collapsed to "-".
 * Two spellings with the same canonical form name one distribution.
 * @param {string} name
 */
export function canonicalPythonName(name) {
  return name.toLowerCase().replaceAll(/[-_.]+/g, "-");
}

/**
 * Validated entries of one manifest section, keyed by `canonical(name)`; `names` keeps each entry's spelling.
 * Two entries with the same key are malformed.
 */
function ownerMap(file, where, value, owner, { nameCheck = true, canonical = (name) => name, names = new Map() } = {}) {
  if (value === undefined) return new Map();
  if (!isPlainObject(value)) throw malformed(file, `${where} must be an object`);
  const map = new Map();
  for (const [key, entry] of Object.entries(value)) {
    if (nameCheck) checkName(file, where, key);
    else if (key === "" || key.trim() !== key) throw malformed(file, `${where} entry ${JSON.stringify(key)} is not a valid name`);
    if (entry !== owner) {
      throw malformed(file, `${where}.${key} must be ${JSON.stringify(owner)}, not ${JSON.stringify(entry)}`);
    }
    const id = canonical(key);
    if (map.has(id)) {
      throw malformed(file, `${where} entries ${JSON.stringify(names.get(id))} and ${JSON.stringify(key)} name the same project`);
    }
    map.set(id, owner);
    names.set(id, key);
  }
  return map;
}

function nameList(file, where, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw malformed(file, `${where} must be an array`);
  const seen = new Set();
  for (const name of value) {
    checkName(file, where, name);
    if (seen.has(name)) throw malformed(file, `${where} lists ${JSON.stringify(name)} twice`);
    seen.add(name);
  }
  return value;
}

/**
 * The optional `ci` section names the CI a release tag's commit must pass in the repository that reads this manifest
 * (SFNS-124): `{"workflow": "<file under .github/workflows>"}` for a GitHub Actions workflow, identified by its file
 * rather than its display name, or `{"checkRun": "<check run name>", "app": "<GitHub App slug>"}` for CI that reports
 * check runs from another app, such as Depot on `next`; the app is required because any app can name a check run.
 * Absent means null.
 */
function releaseCi(file, value) {
  if (value === undefined) return null;
  if (!isPlainObject(value)) throw malformed(file, "ci must be an object");
  checkKeys(file, "ci", value, ["workflow", "checkRun", "app"]);
  const nonEmpty = (key) => {
    if (typeof value[key] !== "string" || value[key] === "" || value[key].trim() !== value[key]) {
      throw malformed(file, `ci.${key} must be a non-empty string without surrounding spaces`);
    }
    return value[key];
  };
  if ((value.workflow === undefined) === (value.checkRun === undefined)) throw malformed(file, "ci needs exactly one of workflow or checkRun");
  if (value.workflow !== undefined) {
    if (value.app !== undefined) throw malformed(file, "ci.app applies only to checkRun");
    if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(nonEmpty("workflow"))) throw malformed(file, "ci.workflow must be a workflow file name such as ci.yml");
    return Object.freeze({ kind: "workflow", name: value.workflow, app: null });
  }
  if (value.app === undefined) throw malformed(file, "ci.checkRun needs ci.app, the slug of the GitHub App that reports it");
  return Object.freeze({ kind: "check-run", name: nonEmpty("checkRun"), app: nonEmpty("app") });
}

/**
 * Validates a parsed manifest. The public manifest assigns "public" and classifies root files as public or
 * generated; the next manifest assigns "next" and lists next-owned root files. `ci` is the release CI (see
 * releaseCi) or null. `python` is keyed by the PEP 503
 * canonical name (see canonicalPythonName); `pythonNames` maps each canonical name to its manifest spelling.
 * @param {unknown} data
 * @param {{ kind?: "public" | "next", file?: string }} [options]
 */
export function parseManifest(data, { kind = "public", file = kind === "next" ? NEXT_MANIFEST : PUBLIC_MANIFEST } = {}) {
  if (!REPOS.includes(kind)) throw malformed(file, `manifest kind must be "public" or "next", not ${JSON.stringify(kind)}`);
  if (!isPlainObject(data)) throw malformed(file, "manifest must be a JSON object");
  checkKeys(file, "the manifest", data, ["version", "paths", "rootFiles", "releases", "python", "ci"]);
  if (data.version !== 1) throw malformed(file, `version must be 1, not ${JSON.stringify(data.version)}`);
  const owner = kind;
  if (kind === "public" && data.paths === undefined) throw malformed(file, "paths is required");
  const paths = ownerMap(file, "paths", data.paths, owner);
  const releases = ownerMap(file, "releases", data.releases, owner, { nameCheck: false });
  const pythonNames = new Map();
  const python = ownerMap(file, "python", data.python, owner, { nameCheck: false, canonical: canonicalPythonName, names: pythonNames });

  const rootFiles = new Map();
  if (data.rootFiles !== undefined) {
    if (!isPlainObject(data.rootFiles)) throw malformed(file, "rootFiles must be an object");
    const classes = kind === "public" ? ["public", "generated"] : ["next"];
    checkKeys(file, "rootFiles", data.rootFiles, classes);
    for (const rootClass of classes) {
      for (const name of nameList(file, `rootFiles.${rootClass}`, data.rootFiles[rootClass])) {
        if (rootFiles.has(name)) throw malformed(file, `root file ${JSON.stringify(name)} is listed in more than one class`);
        rootFiles.set(name, rootClass);
      }
    }
  } else if (kind === "public") {
    throw malformed(file, "rootFiles is required");
  }
  for (const name of rootFiles.keys()) {
    if (paths.has(name)) throw malformed(file, `${JSON.stringify(name)} is listed both as a path and as a root file`);
  }
  return { kind, file, paths, rootFiles, releases, python, pythonNames, ci: releaseCi(file, data.ci) };
}

/** Reads and validates a manifest file; a missing optional file returns null. */
export function readManifest(file, { kind = "public", optional = false } = {}) {
  if (!existsSync(file)) {
    if (optional) return null;
    throw new OwnersError("manifest-not-found", `${path.basename(file)} not found at ${file}`, { file });
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw malformed(path.basename(file), `invalid JSON: ${error.message}`);
  }
  return parseManifest(data, { kind, file: path.basename(file) });
}

function assertDisjoint(publicManifest, nextManifest) {
  const pairs = [
    ["paths", "path"],
    ["rootFiles", "root file"],
    ["releases", "release"],
    ["python", "Python project"],
  ];
  for (const [field, label] of pairs) {
    for (const name of nextManifest[field].keys()) {
      const publicHas =
        publicManifest[field].has(name) ||
        (field === "paths" && publicManifest.rootFiles.has(name)) ||
        (field === "rootFiles" && publicManifest.paths.has(name));
      if (publicHas) {
        const spelling = field === "python" ? nextManifest.pythonNames.get(name) : name;
        const publicSpelling = field === "python" ? publicManifest.pythonNames.get(name) : name;
        const alias = publicSpelling === spelling ? "" : ` (as ${JSON.stringify(publicSpelling)})`;
        throw new OwnersError(
          "duplicate-owner",
          `${label} ${JSON.stringify(spelling)} is listed in both ${publicManifest.file}${alias} and ${nextManifest.file}`,
          { field, name: spelling },
        );
      }
    }
  }
}

/**
 * Builds an ownership oracle from validated manifests. A slug, project or path listed in both manifests is
 * a duplicate-owner error.
 * @param {ReturnType<typeof parseManifest>} publicManifest
 * @param {ReturnType<typeof parseManifest> | null} [nextManifest]
 */
export function createOwners(publicManifest, nextManifest = null) {
  if (!publicManifest || publicManifest.kind !== "public") throw new TypeError("createOwners needs the public manifest");
  if (nextManifest && nextManifest.kind !== "next") throw new TypeError("the second manifest must be the next manifest");
  if (nextManifest) assertDisjoint(publicManifest, nextManifest);
  const defaultRepo = nextManifest ? "next" : "public";

  const resolveRepo = (repo = defaultRepo) => {
    if (!REPOS.includes(repo)) throw new OwnersError("invalid-repo", `repo must be "public" or "next", not ${JSON.stringify(repo)}`, { repo });
    return repo;
  };

  /**
   * Owner of a repository-relative path: "public", "next" or, for per-repo regenerated root files, "generated".
   * @param {string} target
   * @param {{ repo?: "public" | "next" }} [options]
   */
  function ownerOfPath(target, { repo } = {}) {
    repo = resolveRepo(repo);
    const top = topLevelName(target);
    const isRootFile = !normalizePath(target).includes("/");
    if (publicManifest.paths.has(top)) return "public";
    if (isRootFile && publicManifest.rootFiles.has(top)) {
      return publicManifest.rootFiles.get(top) === "generated" ? "generated" : "public";
    }
    if (repo === "next") {
      if (nextManifest?.paths.has(top) || (isRootFile && nextManifest?.rootFiles.has(top))) return "next";
      return "public";
    }
    throw new OwnersError(
      "unlisted-path",
      `${JSON.stringify(normalizePath(target))} is not listed in ${publicManifest.file} (top-level ${JSON.stringify(top)})`,
      { path: normalizePath(target), topLevel: top },
    );
  }

  const ownerOf = (field, code, label, canonical = (name) => name) => (name, { repo } = {}) => {
    repo = resolveRepo(repo);
    if (typeof name !== "string" || name === "") throw new OwnersError(code, `${label} must be a non-empty string`, { name });
    const id = canonical(name);
    if (publicManifest[field].has(id)) return "public";
    if (repo === "next" && nextManifest?.[field].has(id)) return "next";
    const files = repo === "next" && nextManifest ? `${publicManifest.file} or ${nextManifest.file}` : publicManifest.file;
    throw new OwnersError(code, `${label} ${JSON.stringify(name)} is not listed in ${files}`, { name });
  };

  return {
    defaultRepo,
    publicManifest,
    nextManifest,
    ownerOfPath,
    /** Publishing repository of a release slug; an unlisted slug is an error in both repos (D8). */
    ownerOfRelease: ownerOf("releases", "unlisted-release", "release"),
    /**
     * Publishing repository of a Python project, matched by its PEP 503 canonical name; an unlisted project is an
     * error in both repos (D8).
     */
    ownerOfPython: ownerOf("python", "unlisted-python", "Python project", canonicalPythonName),
  };
}

/** Normalises a repository-relative path; absolute paths and paths leaving the repository are rejected. */
export function normalizePath(target) {
  if (typeof target !== "string" || target.trim() === "") {
    throw new OwnersError("invalid-path", `path must be a non-empty string, not ${JSON.stringify(target)}`, { path: target });
  }
  const slashed = target.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:\//.test(slashed)) {
    throw new OwnersError("invalid-path", `path ${JSON.stringify(target)} must be relative to the repository root`, { path: target });
  }
  const normalized = trimTrailingSlashes(path.posix.normalize(slashed));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new OwnersError("invalid-path", `path ${JSON.stringify(target)} does not name an entry inside the repository`, { path: target });
  }
  return normalized;
}

function trimTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export function topLevelName(target) {
  return normalizePath(target).split("/")[0];
}

/**
 * Loads the manifests of a checkout. The next manifest is read when present; `repo` defaults to "next" when
 * it exists and "public" otherwise.
 * @param {{ root?: string }} [options]
 */
export function loadOwners({ root = REPO_ROOT } = {}) {
  const publicManifest = readManifest(path.join(root, PUBLIC_MANIFEST), { kind: "public" });
  const nextManifest = readManifest(path.join(root, NEXT_MANIFEST), { kind: "next", optional: true });
  return createOwners(publicManifest, nextManifest);
}

let cached;
function defaultOwners() {
  cached ??= loadOwners();
  return cached;
}

/** Owner of `target` in this checkout's manifests (read once from the repository root); `repo` selects the public or next semantics. */
export function ownerOfPath(target, options) {
  return defaultOwners().ownerOfPath(target, options);
}

/** Publishing repository of `slug` in this checkout's manifests. */
export function ownerOfRelease(slug, options) {
  return defaultOwners().ownerOfRelease(slug, options);
}

/** Publishing repository of a Python project in this checkout's manifests. */
export function ownerOfPython(project, options) {
  return defaultOwners().ownerOfPython(project, options);
}

const CLI_USAGE = "usage: node scripts/owners.mjs [--repo public|next] [--root <checkout>] <path>...";

/**
 * Command line lookup (SFNS-128): prints `<path>: <owner>` for each repository-relative path, where the owner is
 * "public", "next" or "generated". Returns the exit status: 0 when every path has an owner, 1 when a manifest or
 * a path is rejected (an unlisted path on public, or a `--repo next` lookup of a path the public manifest does not
 * list in a checkout without the next manifest), 2 for a usage error.
 * @param {string[]} argv
 * @param {{ stdout?: (line: string) => void, stderr?: (line: string) => void }} [io]
 */
export function runOwnersCli(argv, { stdout = console.log, stderr = console.error } = {}) {
  // Every diagnostic goes through one place: user- and path-derived text (an option, a --root value inside a
  // manifest error, a path) must not put a raw line break on stderr, where it could read as a forged record.
  const report = (message, { usage = false } = {}) => stderr(escapeControlCharacters(message) + (usage ? `\n${CLI_USAGE}` : ""));
  const options = {};
  const targets = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      targets.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      stdout(CLI_USAGE);
      return 0;
    }
    if (arg.startsWith("-")) {
      const [flag, inline] = arg.split(/=(.*)/s, 2);
      if (flag !== "--repo" && flag !== "--root") {
        report(`error: unknown option ${quoteForLine(arg)}`, { usage: true });
        return 2;
      }
      const value = inline ?? argv[++index];
      // A separate value that is itself an option (`--root --repo=next`) or `--` means the value is missing.
      if (value === undefined || value === "" || (inline === undefined && value.startsWith("-"))) {
        report(`error: ${flag} needs a value`, { usage: true });
        return 2;
      }
      options[flag.slice(2)] = value;
      continue;
    }
    targets.push(arg);
  }
  if (targets.length === 0) {
    report("error: name at least one path", { usage: true });
    return 2;
  }
  if (options.repo !== undefined && !REPOS.includes(options.repo)) {
    report(`error: --repo must be "public" or "next", not ${quoteForLine(options.repo)}`, { usage: true });
    return 2;
  }
  let owners;
  try {
    owners = loadOwners({ root: options.root ? path.resolve(options.root) : REPO_ROOT });
  } catch (error) {
    report(error instanceof OwnersError ? `error (${error.code}): ${error.message}` : `error: ${error.message}`);
    return 1;
  }
  // Without the next manifest (a public checkout), a path the public manifest does not list cannot be classified
  // under next's rules: it may be next-owned (NEXT.md, an unpublished function), so the command refuses to guess.
  const guessesNext = (options.repo ?? owners.defaultRepo) === "next" && !owners.nextManifest;
  let status = 0;
  for (const target of targets) {
    try {
      if (guessesNext && !isPublicListed(owners, target)) {
        report(
          `error (next-manifest-needed): ${quoteForLine(normalizePath(target))} is not listed in ${PUBLIC_MANIFEST}, and ${NEXT_MANIFEST} ` +
            "is not in this checkout; run the command in a next checkout to see whether next owns it",
        );
        status = 1;
        continue;
      }
      stdout(`${displayPath(normalizePath(target))}: ${owners.ownerOfPath(target, { repo: options.repo })}`);
    } catch (error) {
      if (!(error instanceof OwnersError)) throw error;
      report(`error (${error.code}): ${error.message}`);
      status = 1;
    }
  }
  return status;
}

/** C0/C1 control characters (including line breaks) and the Unicode line and paragraph separators. */
function hasControlCharacter(value) {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/** Replaces each character hasControlCharacter matches with its `\uXXXX` escape, so `value` stays on one line. */
function escapeControlCharacters(value) {
  let escaped = "";
  for (const char of value) {
    escaped += hasControlCharacter(char) ? `\\u${char.codePointAt(0).toString(16).padStart(4, "0")}` : char;
  }
  return escaped;
}

/** JSON-quotes `value` and also escapes what JSON.stringify leaves raw (DEL, C1 controls, U+2028, U+2029). */
function quoteForLine(value) {
  return escapeControlCharacters(JSON.stringify(value));
}

/**
 * A path as printed in a `<path>: <owner>` record. A Git path may hold a tab, a line break or another control
 * character; printed raw, one argument could print a second, forged record. Such a path, and one that starts with
 * a double quote (so it cannot be mistaken for a quoted one), is printed quoted as quoteForLine does instead.
 */
function displayPath(normalized) {
  return hasControlCharacter(normalized) || normalized.startsWith('"') ? quoteForLine(normalized) : normalized;
}

/** Whether the public manifest lists `target` (as a top-level path or a root file); invalid paths throw. */
function isPublicListed(owners, target) {
  try {
    owners.ownerOfPath(target, { repo: "public" });
    return true;
  } catch (error) {
    if (error instanceof OwnersError && error.code === "unlisted-path") return false;
    throw error;
  }
}

/** Options that make Node evaluate a string (`-e`, `-p`, `-pe`, `--eval=...`), so `process.argv[1]` is not the entry. */
const EVAL_OPTION = /^(?:-[A-Za-z]*[ep][A-Za-z]*|--(?:eval|print)(?:=.*)?)$/s;

function realPathOr(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

// Run the command only when this file is the entry module: never as a side effect of an import. Newer Node sets
// import.meta.main; otherwise compare real paths on both sides, so a symlinked checkout, macOS's /var ->
// /private/var and --preserve-symlinks-main all still run the command instead of exiting 0 with no output.
function isMainModule() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  if (process.execArgv.some((arg) => EVAL_OPTION.test(arg))) return false;
  if (!process.argv[1]) return false;
  const url = new URL(import.meta.url);
  if (url.search || url.hash) return false;
  try {
    return realpathSync(process.argv[1]) === REAL_MODULE_FILE;
  } catch {
    return false;
  }
}

// One run per process: a second instance of this file (a preload under another URL, or a canonical preload of a
// symlinked entry under --preserve-symlinks-main) can also pass the real-path check, and must not print the records
// again or overwrite the exit status. An instance loaded under a query or fragment is never the entry module.
const CLI_RAN = Symbol.for("superfunctions.owners.cli.ran");

if (!globalThis[CLI_RAN] && isMainModule()) {
  globalThis[CLI_RAN] = true;
  process.exitCode = runOwnersCli(process.argv.slice(2));
}
