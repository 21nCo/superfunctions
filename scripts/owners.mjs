// Ownership manifests (SFNS-121 D1, D2, D8): which repository owns each top-level path and publishes each
// release slug and Python project. `superfunctions.owners.json` is the public allow-list and exists in both
// repositories; `superfunctions.owners.next.json` exists only on `next` and lists the next-owned entries.
// On public an unlisted path or package is an error; on `next` an unlisted path is public-owned.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_MANIFEST = "superfunctions.owners.json";
export const NEXT_MANIFEST = "superfunctions.owners.next.json";
export const REPOS = Object.freeze(["public", "next"]);
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function ownerMap(file, where, value, owner, { nameCheck = true } = {}) {
  if (value === undefined) return new Map();
  if (!isPlainObject(value)) throw malformed(file, `${where} must be an object`);
  const map = new Map();
  for (const [key, entry] of Object.entries(value)) {
    if (nameCheck) checkName(file, where, key);
    else if (key === "" || key.trim() !== key) throw malformed(file, `${where} entry ${JSON.stringify(key)} is not a valid name`);
    if (entry !== owner) {
      throw malformed(file, `${where}.${key} must be ${JSON.stringify(owner)}, not ${JSON.stringify(entry)}`);
    }
    map.set(key, owner);
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
 * Validates a parsed manifest. The public manifest assigns "public" and classifies root files as public or
 * generated; the next manifest assigns "next" and lists next-owned root files.
 * @param {unknown} data
 * @param {{ kind?: "public" | "next", file?: string }} [options]
 */
export function parseManifest(data, { kind = "public", file = kind === "next" ? NEXT_MANIFEST : PUBLIC_MANIFEST } = {}) {
  if (!isPlainObject(data)) throw malformed(file, "manifest must be a JSON object");
  checkKeys(file, "the manifest", data, ["version", "paths", "rootFiles", "releases", "python"]);
  if (data.version !== 1) throw malformed(file, `version must be 1, not ${JSON.stringify(data.version)}`);
  const owner = kind;
  if (kind === "public" && data.paths === undefined) throw malformed(file, "paths is required");
  const paths = ownerMap(file, "paths", data.paths, owner);
  const releases = ownerMap(file, "releases", data.releases, owner, { nameCheck: false });
  const python = ownerMap(file, "python", data.python, owner, { nameCheck: false });

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
  return { kind, file, paths, rootFiles, releases, python };
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
        throw new OwnersError(
          "duplicate-owner",
          `${label} ${JSON.stringify(name)} is listed in both ${publicManifest.file} and ${nextManifest.file}`,
          { field, name },
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

  const ownerOf = (field, code, label) => (name, { repo } = {}) => {
    repo = resolveRepo(repo);
    if (typeof name !== "string" || name === "") throw new OwnersError(code, `${label} must be a non-empty string`, { name });
    if (publicManifest[field].has(name)) return "public";
    if (repo === "next" && nextManifest?.[field].has(name)) return "next";
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
    /** Publishing repository of a Python project; an unlisted project is an error in both repos (D8). */
    ownerOfPython: ownerOf("python", "unlisted-python", "Python project"),
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
  const normalized = path.posix.normalize(slashed).replace(/\/+$/, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new OwnersError("invalid-path", `path ${JSON.stringify(target)} does not name an entry inside the repository`, { path: target });
  }
  return normalized;
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
