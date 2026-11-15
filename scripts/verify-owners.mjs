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

/**
 * Decodes the escapes of a basic string (TOML 1.0 plus the 1.1 \e and \xHH escapes); in a multi-line basic
 * string a line-ending backslash trims whitespace.
 */
function unescapeBasic(raw, multiline, fail) {
  return raw.replace(/\\([ \t]*\n[ \t\n]*|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S])/g, (_, escape) => {
    if (multiline && escape.includes("\n")) return "";
    if (/^x[0-9A-Fa-f]{2}$/.test(escape)) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    if (/^[uU][0-9A-Fa-f]+$/.test(escape) && escape.length > 1) {
      const codePoint = Number.parseInt(escape.slice(1), 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) throw fail(`invalid escape \\${escape}`);
      return String.fromCodePoint(codePoint);
    }
    if (Object.hasOwn(BASIC_ESCAPES, escape)) return BASIC_ESCAPES[escape];
    throw fail(`invalid escape \\${escape.trimEnd()}`);
  });
}

/** An integer, float, boolean, date or time value; only strings and tables matter to the ownership check. */
class TomlScalar {
  constructor(text) {
    this.text = text;
  }
}

const SCALARS = [
  /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/y,
  /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/y,
  /true|false|[+-]?(?:inf|nan|0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|[0-9_]+(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)/y,
];

/**
 * Parses a TOML document into plain objects (tables are null-prototype objects, arrays are arrays, strings are
 * strings, other values are TomlScalar). It covers TOML 1.0 plus the TOML 1.1 changes: the \e and \xHH escapes,
 * newlines, trailing commas and comments inside inline tables, and times and datetimes without seconds. On input that
 * TOML 1.0 rejects it is lenient in two places: an underscore directly after a 0x, 0o or 0b prefix (0x_ff) and a
 * leading byte order mark are accepted. Redefining a key or table fails, as TOML requires. `onHeader` sees every
 * table header before it is applied. Errors come from `fail(line, reason)`. Returns the document and the line on
 * which each key path was first defined.
 */
export function parseToml(source, { fail, onHeader = () => {} }) {
  const text = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const newlines = [];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) newlines.push(index);
  const lineAt = (at) => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (newlines[middle] < at) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
  let pos = 0;
  const error = (reason, at = pos) => fail(lineAt(at), reason);
  const lineText = (at) => text.slice(text.lastIndexOf("\n", at - 1) + 1, (text.indexOf("\n", at) + 1 || text.length + 1) - 1).trim();

  // Table kinds: "implicit" (only named by a longer header), "header", "dotted" (made by a dotted key) and
  // "inline" (an inline table and the dotted tables inside it, which are closed once written).
  const kinds = new WeakMap();
  const arraysOfTables = new WeakSet();
  const lines = new Map();
  const newTable = (kind) => {
    const table = Object.create(null);
    kinds.set(table, kind);
    return table;
  };
  const isTable = (value) => typeof value === "object" && value !== null && kinds.has(value);
  const display = (segments) => segments.map((segment) => (/^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment))).join(".");
  const record = (segments, at) => {
    const key = JSON.stringify(segments);
    if (!lines.has(key)) lines.set(key, lineAt(at));
  };
  const redefined = (segments, at) => error(`${display(segments)} is defined more than once`, at);

  const skipSpace = () => {
    while (text[pos] === " " || text[pos] === "\t") pos += 1;
  };
  const skipComment = () => {
    if (text[pos] === "#") {
      const end = text.indexOf("\n", pos);
      pos = end === -1 ? text.length : end;
    }
  };
  const skipBlank = () => {
    for (;;) {
      skipSpace();
      skipComment();
      if (text[pos] !== "\n") return;
      pos += 1;
    }
  };
  const endOfLine = (what) => {
    skipSpace();
    skipComment();
    if (pos < text.length && text[pos] !== "\n") throw error(`unexpected text after ${what}`);
    pos += 1;
  };

  const matchAt = (pattern) => {
    pattern.lastIndex = pos;
    const match = pattern.exec(text);
    if (match) pos += match[0].length;
    return match;
  };

  const readMultiline = (delimiter) => {
    const start = pos;
    pos += 3;
    if (text[pos] === "\n") pos += 1;
    const bodyStart = pos;
    for (let index = pos; index < text.length; index += 1) {
      if (delimiter === '"""' && text[index] === "\\") {
        index += 1;
      } else if (text.startsWith(delimiter, index)) {
        // Up to two quotes directly before the closing delimiter belong to the string.
        let end = index;
        while (end < index + 2 && text[end + 3] === delimiter[0]) end += 1;
        pos = end + 3;
        const raw = text.slice(bodyStart, end);
        return delimiter === "'''" ? raw : unescapeBasic(raw, true, (reason) => error(reason, start));
      }
    }
    throw error("unterminated multi-line string", start);
  };

  const readString = () => {
    const start = pos;
    if (text.startsWith('"""', pos)) return readMultiline('"""');
    if (text.startsWith("'''", pos)) return readMultiline("'''");
    let match = matchAt(/"((?:[^"\\\n]|\\.)*)"/y);
    if (match) return unescapeBasic(match[1], false, (reason) => error(reason, start));
    match = matchAt(/'([^'\n]*)'/y);
    if (match) return match[1];
    throw error("unterminated string", start);
  };

  const readKey = () => {
    const segments = [];
    for (;;) {
      skipSpace();
      if (text[pos] === '"' || text[pos] === "'") {
        if (text.startsWith('"""', pos) || text.startsWith("'''", pos)) throw error("a key cannot be a multi-line string");
        segments.push(readString());
      } else {
        const match = matchAt(/[A-Za-z0-9_-]+/y);
        if (!match) throw error(`cannot read key in ${lineText(pos)}`);
        segments.push(match[0]);
      }
      skipSpace();
      if (text[pos] !== ".") return segments;
      pos += 1;
    }
  };

  // Writes `value` at the dotted key `segments` below `table` (whose path is `base`).
  const assign = (table, base, segments, value, at, dottedKind) => {
    let target = table;
    for (const [index, segment] of segments.slice(0, -1).entries()) {
      const pathSoFar = [...base, ...segments.slice(0, index + 1)];
      if (!Object.hasOwn(target, segment)) {
        target[segment] = newTable(dottedKind);
        record(pathSoFar, at);
      } else if (isTable(target[segment]) && kinds.get(target[segment]) === "implicit") {
        // A table only named by a longer header may be extended by dotted keys, and is then closed to headers.
        kinds.set(target[segment], dottedKind);
      } else if (!isTable(target[segment]) || kinds.get(target[segment]) !== dottedKind) {
        throw redefined(pathSoFar, at);
      }
      target = target[segment];
    }
    const last = segments.at(-1);
    if (Object.hasOwn(target, last)) throw redefined([...base, ...segments], at);
    target[last] = value;
    record([...base, ...segments], at);
  };

  const readValue = (valuePath) => {
    const start = pos;
    const char = text[pos];
    if (char === '"' || char === "'") return readString();
    if (char === "[") {
      pos += 1;
      const array = [];
      for (;;) {
        skipBlank();
        if (text[pos] === "]") break;
        array.push(readValue([...valuePath, String(array.length)]));
        skipBlank();
        if (text[pos] === ",") pos += 1;
        else if (text[pos] !== "]") throw error("expected , or ] in array", pos < text.length ? pos : start);
      }
      pos += 1;
      return array;
    }
    if (char === "{") {
      // Newlines and a trailing comma are accepted (TOML 1.1).
      pos += 1;
      const table = newTable("inline");
      for (;;) {
        skipBlank();
        if (text[pos] === "}") break;
        const at = pos;
        const segments = readKey();
        if (text[pos] !== "=") throw error(`expected = after key in inline table`);
        pos += 1;
        skipSpace();
        assign(table, valuePath, segments, readValue([...valuePath, ...segments]), at, "inline");
        skipBlank();
        if (text[pos] === ",") pos += 1;
        else if (text[pos] !== "}") throw error("expected , or } in inline table", pos < text.length ? pos : start);
      }
      pos += 1;
      return table;
    }
    for (const pattern of SCALARS) {
      const match = matchAt(pattern);
      if (match && match[0] !== "") return new TomlScalar(match[0]);
    }
    throw error(`cannot read value in ${lineText(start)}`, start);
  };

  const root = newTable("header");
  let current = root;
  let currentPath = [];
  for (;;) {
    skipBlank();
    if (pos >= text.length) break;
    const at = pos;
    if (text[pos] === "[") {
      const isArray = text.startsWith("[[", pos);
      pos += isArray ? 2 : 1;
      const headerFail = () => error(`cannot read table header ${lineText(at)}`, at);
      let segments;
      try {
        segments = readKey();
      } catch {
        throw headerFail();
      }
      const close = isArray ? "]]" : "]";
      if (!text.startsWith(close, pos)) throw headerFail();
      pos += close.length;
      endOfLine("table header");
      onHeader(segments, isArray, lineAt(at));
      let table = root;
      for (const [index, segment] of segments.slice(0, -1).entries()) {
        const pathSoFar = segments.slice(0, index + 1);
        if (!Object.hasOwn(table, segment)) {
          table[segment] = newTable("implicit");
          record(pathSoFar, at);
        }
        const next = table[segment];
        if (arraysOfTables.has(next)) table = next.at(-1);
        else if (isTable(next) && kinds.get(next) !== "inline") table = next;
        else throw redefined(pathSoFar, at);
      }
      const last = segments.at(-1);
      if (isArray) {
        if (!Object.hasOwn(table, last)) {
          table[last] = [];
          arraysOfTables.add(table[last]);
          record(segments, at);
        } else if (!arraysOfTables.has(table[last])) {
          throw redefined(segments, at);
        }
        current = newTable("header");
        table[last].push(current);
      } else {
        if (!Object.hasOwn(table, last)) {
          table[last] = newTable("header");
          record(segments, at);
        } else if (!isTable(table[last]) || kinds.get(table[last]) !== "implicit") {
          throw redefined(segments, at);
        }
        current = table[last];
        kinds.set(current, "header");
      }
      currentPath = segments;
      continue;
    }
    const segments = readKey();
    if (text[pos] !== "=") throw error(`cannot read key/value line ${lineText(at)}`, at);
    pos += 1;
    skipSpace();
    const value = readValue([...currentPath, ...segments]);
    assign(current, currentPath, segments, value, at, "dotted");
    endOfLine("value");
  }
  return { document: root, lineOf: (segments) => lines.get(JSON.stringify(segments)) ?? 0 };
}

/**
 * Name of the project a pyproject.toml declares (`project.name`, in any valid TOML spelling: a [project] table,
 * dotted keys, an inline table, any string kind), or null when it declares no project. Fails closed with an
 * `unreadable-pyproject` OwnersError naming the file when the file is not valid TOML or declares project
 * metadata whose name cannot be read.
 */
export function pyprojectName(source, file = "pyproject.toml") {
  const { document, lineOf } = parseToml(source, {
    fail: (line, reason) => unreadable(file, line, reason),
    onHeader: (segments, isArray, line) => {
      if (isArray && segments.length === 1 && segments[0] === "project") {
        throw unreadable(file, line, "project metadata must not be an array of tables");
      }
    },
  });
  if (!Object.hasOwn(document, "project")) return null;
  const project = document.project;
  if (typeof project !== "object" || project === null || Array.isArray(project) || project instanceof TomlScalar) {
    throw unreadable(file, lineOf(["project"]), "project metadata must be a table");
  }
  if (!Object.hasOwn(project, "name")) throw unreadable(file, 0, "project metadata has no name");
  const name = project.name;
  const line = lineOf(["project", "name"]);
  if (typeof name !== "string") throw unreadable(file, line, "project name must be a string");
  if (name === "") throw unreadable(file, line, "project name is empty");
  if (/[\r\n]/.test(name)) throw unreadable(file, line, "project name must not contain a line break");
  return name;
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
