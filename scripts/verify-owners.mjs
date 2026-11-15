#!/usr/bin/env node
// Fails when the ownership manifests and the tree disagree: every tracked top-level directory and root file,
// every release slug and every Python project must be listed, and every listed entry must exist.
// Usage: node scripts/verify-owners.mjs [--repo public|next] [--root <checkout>]

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

/** Name in the [project] table of a pyproject.toml, or null when it has no [project] table. */
export function pyprojectName(source, file = "pyproject.toml") {
  let inProject = false;
  let sawProject = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inProject = /^\[\s*project\s*\]\s*(#.*)?$/.test(line);
      sawProject ||= inProject;
      continue;
    }
    if (!inProject) continue;
    const match = /^name\s*=\s*(?:"([^"]+)"|'([^']+)')\s*(#.*)?$/.exec(line);
    if (match) return match[1] ?? match[2];
  }
  if (sawProject) throw new OwnersError("malformed-manifest", `${file}: [project] has no name`, { file });
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
    errors = verifyOwners(parseArgs(process.argv.slice(2)));
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
