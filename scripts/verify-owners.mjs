#!/usr/bin/env node
// Fails when the ownership manifests and the tree disagree: every tracked top-level directory and root file,
// every release slug and every Python project must be listed, and every listed entry must exist.
// Usage: node scripts/verify-owners.mjs [--repo public|next] [--root <checkout>]
// Without --repo, OWNERS_REPO selects the semantics; without either, the checkout decides (next when
// superfunctions.owners.next.json exists, public otherwise).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NEXT_MANIFEST, OwnersError, PUBLIC_MANIFEST, REPO_ROOT, REPOS, loadOwners } from "./owners.mjs";
import { gitBinary } from "./verify-package-lockfiles.mjs";

export const RELEASE_FILES = Object.freeze({ public: "release-packages.json", next: "release-packages.next.json" });

export function trackedFiles(root) {
  return execFileSync(gitBinary(), ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\0")
    .filter(Boolean);
}

/** Reads release entries from release-packages.json and, on `next`, release-packages.next.json (D3). */
export function readReleaseEntries(root, repo) {
  const files = repo === "next" ? [RELEASE_FILES.public, RELEASE_FILES.next] : [RELEASE_FILES.public];
  const entries = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) {
      if (file === RELEASE_FILES.public) throw new OwnersError("manifest-not-found", `${file} not found`, { file });
      continue;
    }
    let data;
    try {
      data = JSON.parse(readFileSync(absolute, "utf8"));
    } catch (error) {
      throw new OwnersError("malformed-manifest", `${file}: invalid JSON: ${error.message}`, { file });
    }
    if (!Array.isArray(data)) throw new OwnersError("malformed-manifest", `${file}: expected an array`, { file });
    for (const [index, entry] of data.entries()) {
      if (typeof entry?.slug !== "string" || entry.slug === "" || typeof entry.path !== "string" || entry.path === "") {
        throw new OwnersError("malformed-manifest", `${file}: entry ${index} needs a non-empty slug and path`, { file, index });
      }
      entries.push({ slug: entry.slug, path: entry.path, source: file });
    }
  }
  return entries;
}

/** Throws the typed error for a pyproject.toml whose project metadata cannot be read reliably. */
function unreadable(file, line, reason) {
  return new OwnersError("unreadable-pyproject", `${file}${line ? `:${line}` : ""}: ${reason}`, { file, line });
}

const BASIC_ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };

function unescapeBasic(raw, fail) {
  return raw.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S])/g, (_, escape) => {
    if (escape.length > 1) {
      const codePoint = Number.parseInt(escape.slice(1), 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) throw fail(`invalid escape \\${escape}`);
      return String.fromCodePoint(codePoint);
    }
    if (Object.hasOwn(BASIC_ESCAPES, escape)) return BASIC_ESCAPES[escape];
    throw fail(`invalid escape \\${escape}`);
  });
}

/** Reads a TOML dotted key (bare, "basic" or 'literal' segments) at the start of `text`. */
function readKey(text, fail) {
  const segments = [];
  let rest = text;
  for (;;) {
    rest = rest.trimStart();
    let match;
    if ((match = /^"((?:[^"\\\n]|\\.)*)"/.exec(rest))) segments.push(unescapeBasic(match[1], fail));
    else if ((match = /^'([^'\n]*)'/.exec(rest))) segments.push(match[1]);
    else if ((match = /^[A-Za-z0-9_-]+/.exec(rest))) segments.push(match[0]);
    else return null;
    rest = rest.slice(match[0].length).trimStart();
    if (!rest.startsWith(".")) return { segments, rest };
    rest = rest.slice(1);
  }
}

/** A single-line TOML string value followed only by an optional comment, or undefined. */
function readStringValue(value, fail) {
  let match = /^"((?:[^"\\\n]|\\.)*)"\s*(?:#.*)?$/.exec(value);
  if (match) return unescapeBasic(match[1], fail);
  match = /^'([^'\n]*)'\s*(?:#.*)?$/.exec(value);
  return match ? match[1] : undefined;
}

/**
 * Advances over a TOML value so that lines inside multi-line strings, arrays and inline tables are not read
 * as keys or table headers. Returns the open state to carry to the next line, or null when the value ended.
 */
function scanValue(text, state = { depth: 0, string: null }) {
  let { depth, string } = state;
  for (let index = 0; index < text.length; index += 1) {
    if (string) {
      if (string === '"""' && text[index] === "\\") index += 1;
      else if (text.startsWith(string, index)) {
        // A closing delimiter may be followed by up to two quotes that belong to the string.
        while (text[index + 3] === string[0]) index += 1;
        index += 2;
        string = null;
      }
      continue;
    }
    const char = text[index];
    if (char === "#") break;
    if (text.startsWith('"""', index) || text.startsWith("'''", index)) {
      string = text.slice(index, index + 3);
      index += 2;
    } else if (char === '"') {
      const match = /^"(?:[^"\\\n]|\\.)*"/.exec(text.slice(index));
      index += match ? match[0].length - 1 : text.length;
    } else if (char === "'") {
      const end = text.indexOf("'", index + 1);
      index = end === -1 ? text.length : end;
    } else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
  }
  return string || depth > 0 ? { depth, string } : null;
}

/**
 * Name of the project a pyproject.toml declares (`[project] name`, in any valid TOML spelling of the table or
 * key, or the top-level dotted key `project.name`), or null when it declares no project. Fails closed with an
 * `unreadable-pyproject` OwnersError naming the file when it declares project metadata whose name cannot be read.
 */
export function pyprojectName(source, file = "pyproject.toml") {
  let table = [];
  let open = null;
  let sawProject = false;
  const names = [];
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = index + 1;
    const fail = (reason) => unreadable(file, line, reason);
    if (open) {
      open = scanValue(raw, open);
      continue;
    }
    const text = raw.trim();
    if (text === "" || text.startsWith("#")) continue;
    if (text.startsWith("[")) {
      const isArray = text.startsWith("[[");
      const close = isArray ? "]]" : "]";
      const key = readKey(text.slice(isArray ? 2 : 1), fail);
      if (!key || !key.rest.startsWith(close) || !/^\s*(?:#.*)?$/.test(key.rest.slice(close.length))) {
        throw fail(`cannot read table header ${text}`);
      }
      table = key.segments;
      if (table[0] === "project") {
        // Subtables and arrays of tables under project ([project.urls], [[project.authors]]) are project
        // metadata; their keys sit below project.<sub> and are never read as the name. Only the project
        // table itself must not be an array of tables.
        sawProject = true;
        if (isArray && table.length === 1) throw fail("project metadata must not be an array of tables");
      }
      continue;
    }
    const key = readKey(text, fail);
    if (!key || !key.rest.startsWith("=")) throw fail(`cannot read key/value line ${text}`);
    const full = [...table, ...key.segments];
    const value = key.rest.slice(1).trim();
    if (full[0] === "project") {
      sawProject = true;
      if (full.length === 1) throw fail("project metadata defined as an inline table cannot be read; use a [project] table");
      if (full.length === 2 && full[1] === "name") {
        const name = readStringValue(value, fail);
        if (name === undefined) throw fail("project name must be a single-line string");
        if (name === "") throw fail("project name is empty");
        names.push(name);
      }
    }
    open = scanValue(value);
  }
  if (open) throw unreadable(file, 0, "unterminated multi-line value");
  if (names.length > 1) throw unreadable(file, 0, "project name is defined more than once");
  if (names.length === 1) return names[0];
  if (sawProject) throw unreadable(file, 0, "project metadata has no name");
  return null;
}

export function readPythonProjects(root, files) {
  return files
    .filter((file) => path.posix.basename(file) === "pyproject.toml")
    .sort()
    .flatMap((file) => {
      const name = pyprojectName(readFileSync(path.join(root, file), "utf8"), file);
      return name === null ? [] : [{ name, file }];
    });
}

function tryOwner(lookup) {
  try {
    return lookup();
  } catch (error) {
    if (error instanceof OwnersError) return null;
    throw error;
  }
}

/**
 * Compares the manifests with a tree. Returns one message per disagreement, each naming the path or entry.
 * @param {{ owners: ReturnType<typeof loadOwners>, repo: "public" | "next", files: string[], releases: {slug: string, path: string, source: string}[], python: {name: string, file: string}[] }} input
 */
export function findOwnershipErrors({ owners, repo, files, releases, python }) {
  const errors = [];
  const { publicManifest, nextManifest } = owners;
  const dirs = new Set();
  const rootFiles = new Set();
  for (const file of files) {
    const slash = file.indexOf("/");
    if (slash === -1) rootFiles.add(file);
    else dirs.add(file.slice(0, slash));
  }

  if (repo === "public" && files.includes(NEXT_MANIFEST)) {
    errors.push(`${NEXT_MANIFEST}: exists only on next and must not be tracked in the public repository`);
  }

  for (const dir of [...dirs].sort()) {
    if (repo === "public" && !publicManifest.paths.has(dir)) {
      errors.push(`${dir}/: top-level directory is not listed in ${PUBLIC_MANIFEST} paths`);
    }
  }
  for (const file of [...rootFiles].sort()) {
    if (repo === "public" && !publicManifest.rootFiles.has(file)) {
      errors.push(`${file}: root file is not listed in ${PUBLIC_MANIFEST} rootFiles`);
    }
  }

  // Listed entries must exist in this repository's tree. Generated root files are regenerated per repository
  // and may be absent; on `next` the public entries are checked by the sync, not here.
  const listed = repo === "public" ? publicManifest : nextManifest;
  if (listed) {
    for (const dir of listed.paths.keys()) {
      if (!dirs.has(dir)) errors.push(`${dir}/: listed in ${listed.file} paths but is not a tracked top-level directory`);
    }
    for (const [file, rootClass] of listed.rootFiles) {
      if (rootClass !== "generated" && !rootFiles.has(file)) {
        errors.push(`${file}: listed in ${listed.file} rootFiles.${rootClass} but is not a tracked root file`);
      }
    }
  }

  const releaseSlugs = new Set();
  for (const entry of releases) {
    releaseSlugs.add(entry.slug);
    const owner = tryOwner(() => owners.ownerOfRelease(entry.slug, { repo }));
    if (owner === null) {
      errors.push(`${entry.path}: release ${JSON.stringify(entry.slug)} from ${entry.source} is not listed in the releases of ${repo === "next" && nextManifest ? `${PUBLIC_MANIFEST} or ${NEXT_MANIFEST}` : PUBLIC_MANIFEST}`);
      continue;
    }
    const pathOwner = tryOwner(() => owners.ownerOfPath(entry.path, { repo }));
    if (pathOwner !== null && pathOwner !== owner) {
      errors.push(`${entry.path}: release ${JSON.stringify(entry.slug)} is ${owner}-published but its path is ${pathOwner}-owned`);
    }
  }
  if (listed) {
    for (const slug of listed.releases.keys()) {
      if (!releaseSlugs.has(slug)) errors.push(`${listed.file}: release ${JSON.stringify(slug)} has no entry in the release files`);
    }
  }

  const projects = new Set();
  for (const project of python) {
    if (projects.has(project.name)) {
      errors.push(`${project.file}: Python project ${JSON.stringify(project.name)} is defined by more than one pyproject.toml`);
      continue;
    }
    projects.add(project.name);
    const owner = tryOwner(() => owners.ownerOfPython(project.name, { repo }));
    if (owner === null) {
      errors.push(`${project.file}: Python project ${JSON.stringify(project.name)} is not listed in the python entries of ${repo === "next" && nextManifest ? `${PUBLIC_MANIFEST} or ${NEXT_MANIFEST}` : PUBLIC_MANIFEST}`);
      continue;
    }
    const pathOwner = tryOwner(() => owners.ownerOfPath(project.file, { repo }));
    if (pathOwner !== null && pathOwner !== owner) {
      errors.push(`${project.file}: Python project ${JSON.stringify(project.name)} is ${owner}-published but its path is ${pathOwner}-owned`);
    }
  }
  if (listed) {
    for (const name of listed.python.keys()) {
      if (!projects.has(name)) errors.push(`${listed.file}: Python project ${JSON.stringify(name)} has no tracked pyproject.toml`);
    }
  }
  return errors;
}

/**
 * Repository semantics requested by the environment: OWNERS_REPO when set (CI sets it per repository), else
 * undefined so that verifyOwners falls back to the checkout's default ("next" when the next manifest exists).
 */
export function repoFromEnv(env = process.env) {
  return env.OWNERS_REPO ? env.OWNERS_REPO : undefined;
}

/** Disagreements between a checkout's manifests and its tree; `repo` defaults to the checkout's semantics. */
export function verifyOwners({ root = REPO_ROOT, repo } = {}) {
  const owners = loadOwners({ root });
  repo ??= owners.defaultRepo;
  if (!REPOS.includes(repo)) throw new OwnersError("invalid-repo", `--repo must be "public" or "next", not ${JSON.stringify(repo)}`, { repo });
  const files = trackedFiles(root);
  return findOwnershipErrors({
    owners,
    repo,
    files,
    releases: readReleaseEntries(root, repo),
    python: readPythonProjects(root, files),
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.split(/=(.*)/s, 2);
    if (flag !== "--repo" && flag !== "--root") throw new Error(`unknown argument ${arg}`);
    const value = inline ?? argv[++index];
    if (value === undefined || value === "") throw new Error(`${flag} needs a value`);
    options[flag.slice(2)] = flag === "--root" ? path.resolve(value) : value;
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let errors;
  try {
    const options = parseArgs(process.argv.slice(2));
    options.repo ??= repoFromEnv();
    errors = verifyOwners(options);
  } catch (error) {
    console.error(error instanceof OwnersError ? `error (${error.code}): ${error.message}` : `error: ${error.message}`);
    process.exit(1);
  }
  if (errors.length > 0) {
    console.error(`Ownership manifest and tree disagree (${errors.length}):`);
    for (const message of errors) console.error(`  ${message}`);
    process.exit(1);
  }
  console.log("Ownership manifests match the tree.");
}
