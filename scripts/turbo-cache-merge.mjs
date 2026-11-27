#!/usr/bin/env node
// SFNS-312: Turbo's local task cache in the JavaScript and DevFn tests CI jobs.
//
// Taint. A replayed task restores only the outputs turbo.json declares for it. A task that also writes a file outside
// them (a tracked file, or an untracked one that is not ignored) leaves it behind when it runs and not when it is
// replayed, so its entry is not saved. Each Turbo step runs with `--summarize`, then records (`--record <step>`) its
// run summary, the cache directory's files and a drift snapshot (changed tracked and untracked unignored files, each
// with a content hash); `--baseline` records the same before any task runs. Before saving, the merge deletes every
// entry that first appeared during a step whose snapshot changed outside the declared outputs of the tasks that step
// ran (cache MISS in its own summary) and outside the archived outputs of the tasks it replayed (HIT, compared by
// content), every entry of a step without a readable summary, listing or snapshot, and every entry no step recorded.
// Drift only warns: the cache never changes a job's result.
//
// Merge. Runs that must verify every task (pushes, the nightly run, manual runs) replay nothing, yet the entry they
// save is the one pull requests restore, so it must hold an entry for each task. Such a run sets the restored
// `.turbo/cache` aside before any task runs; afterwards a set-aside entry is moved back when its hash is current and
// the run wrote no entry with that hash (the new entry wins); every other one is pruned. A pull request replays the
// restored entries (the baseline listing) and prunes those whose hash is not current. The current hashes are the
// pre-task `--dry=json` hashes (the whole graph, so a per-package push still saves a complete entry) and every step
// summary hash (a task whose hash changed during the run keeps its entry). Entry files are `<hash>.tar.zst` and
// `<hash>-meta.json`; a restored or set-aside file of another name is pruned.
//
// Usage: node scripts/turbo-cache-merge.mjs --record <step> --steps-dir <dir> [--baseline]
//        node scripts/turbo-cache-merge.mjs --merge --steps-dir <dir> --cache-dir <dir> --dry-run <file>
//          [--aside-dir <dir>]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

// The task hash an entry file is named after, or null for any other file. Turbo's task hashes are 16 hex digits.
const ENTRY_FILE = /^([0-9a-f]{16})(?:\.tar\.zst|-meta\.json)$/;

export function entryHash(fileName) {
  return ENTRY_FILE.exec(fileName)?.[1] ?? null;
}

// The tasks of a Turbo run summary or `--dry=json` output, each with a task hash, a directory and its cache status
// ("HIT" when Turbo replayed it, "MISS" when it ran). A summary without tasks would prune every restored entry, so it
// is an error rather than an empty list.
export function readSummaryTasks(json, what) {
  let summary;
  try {
    summary = JSON.parse(json);
  } catch (error) {
    throw new Error(`the ${what} is not JSON: ${error.message}`);
  }
  const tasks = summary?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error(`the ${what} lists no tasks`);
  return tasks.map((task) => {
    const hash = typeof task?.hash === "string" ? entryHash(`${task.hash}.tar.zst`) : null;
    if (hash === null || hash !== task.hash || typeof task.directory !== "string") {
      throw new Error(`the ${what} gives task ${JSON.stringify(task?.taskId)} no task hash or directory`);
    }
    const { taskId, directory, outputs, excludedOutputs } = task;
    return { taskId, hash, directory, outputs, excludedOutputs, cacheStatus: task.cache?.status ?? null };
  });
}

// One token of an output glob: `**` with the `/` after it, `*`, `?`, a character class (`[` and at least one character
// up to the next `]`) or any other single character.
const GLOB_TOKEN = /\*\*\/?|\*|\?|\[.[^\]]*\]|./gs;

function unsupportedGlob(glob) {
  return new Error(`unsupported output glob ${JSON.stringify(glob)}`);
}

// `**` must be a whole path segment. Before a `/` it matches any number of segments; at the end of the glob it matches
// everything below the directory, or the directory's own path.
function doubleStarSource(glob, token, index, source) {
  const segmentStart = index === 0 || glob[index - 1] === "/";
  const trailing = index + token.length === glob.length;
  if (!segmentStart || !(trailing || token.endsWith("/"))) throw unsupportedGlob(glob);
  if (token.endsWith("/")) return `${source}(?:[^/]*/)*`;
  return source.endsWith("/") ? `${source.slice(0, -1)}(?:/.*)?` : `${source}.*`;
}

// The source for a token that is not `**` or part of a brace group.
function tokenSource(glob, token) {
  if (token === "*") return "[^/]*";
  if (token === "?") return "[^/]";
  if (token === "[") throw unsupportedGlob(glob);
  if (token.startsWith("[")) return `[${token.slice(1, -1).replace(/^!/, "^").replaceAll("\\", String.raw`\\`)}]`;
  return token.replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
}

// A regular expression source for one Turbo output glob: `**` as a whole path segment matches any number of segments,
// `*` and `?` match within one segment, `{a,b}` matches either alternative and `[…]` (or `[!…]`) a character class.
function globSource(glob) {
  let source = "";
  let braces = 0;
  for (const { 0: token, index } of glob.matchAll(GLOB_TOKEN)) {
    if (token.startsWith("**")) {
      source = doubleStarSource(glob, token, index, source);
    } else if (token === "{") {
      braces += 1;
      source += "(?:";
    } else if (token === "}" && braces > 0) {
      braces -= 1;
      source += ")";
    } else if (token === "," && braces > 0) {
      source += "|";
    } else {
      source += tokenSource(glob, token);
    }
  }
  if (braces !== 0) throw unsupportedGlob(glob);
  return source;
}

// The repository-relative pattern for an output glob of the task in `directory`. Turbo reads output globs relative to
// the task's package directory, or to the repository root after `$TURBO_ROOT$/`.
function outputPattern(directory, glob) {
  const relative = glob.startsWith("$TURBO_ROOT$/") ? glob.slice(13) : path.posix.join(directory, glob);
  const normalized = path.posix.normalize(relative).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`output glob ${JSON.stringify(glob)} of ${JSON.stringify(directory)} is outside the repository`);
  }
  return new RegExp(`^${globSource(normalized)}$`);
}

// A predicate for repository-relative paths: whether one of `tasks` declares the file as an output. Turbo lists a
// task's `!` output globs under `excludedOutputs`; a file a task excludes is not that task's output.
export function declaredOutputMatcher(tasks) {
  const matchers = tasks.map(({ taskId, directory, outputs, excludedOutputs }) => {
    const included = [];
    const excluded = [];
    for (const [list, globs] of [
      [included, outputs ?? []],
      [excluded, excludedOutputs ?? []],
    ]) {
      if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== "string" || glob === "")) {
        throw new Error(`task ${JSON.stringify(taskId)} has malformed outputs`);
      }
      for (const glob of globs) {
        const negated = glob.startsWith("!");
        (negated ? excluded : list).push(outputPattern(directory, negated ? glob.slice(1) : glob));
      }
    }
    return { included, excluded };
  });
  return (file) =>
    matchers.some(
      ({ included, excluded }) => included.some((re) => re.test(file)) && !excluded.some((re) => re.test(file))
    );
}

// Orders strings by UTF-16 code unit, as the default sort does, so paths and hashes sort the same on every machine.
export function byCodeUnit(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function filesIn(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort(byCodeUnit);
}

// Git by absolute path, not looked up on PATH: /usr/bin/git on the Linux runners and on macOS.
const GIT_CANDIDATES = ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];

function gitExecutable() {
  const git = GIT_CANDIDATES.find((file) => fs.existsSync(file));
  if (!git) throw new Error(`git is not at ${GIT_CANDIDATES.join(", ")}`);
  return git;
}

// A hash of the content at `full`: a symbolic link's target, a file's bytes, "directory" for anything else, or
// "deleted" when nothing is there.
function contentHash(full) {
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!stat) return "deleted";
  let content = "directory";
  if (stat.isSymbolicLink()) content = `link:${fs.readlinkSync(full)}`;
  else if (stat.isFile()) content = fs.readFileSync(full);
  return sha256(content);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

// One tar header's fields: its entry type, size, name and link target ("ustar" headers may split the name).
function tarHeader(header) {
  const field = (start, end) => header.toString("utf8", start, end).replace(/\0[\s\S]*$/, "");
  const prefix = field(257, 263) === "ustar" ? field(345, 500) : "";
  const name = field(0, 100);
  const size = field(124, 136).trim() || "0";
  if (!/^[0-7]+$/.test(size)) throw new Error(`unsupported tar entry size ${JSON.stringify(size)} for ${name}`);
  return {
    type: field(156, 157) || "0",
    size: Number.parseInt(size, 8),
    name: prefix ? `${prefix}/${name}` : name,
    link: field(157, 257),
  };
}

// The files of an uncompressed Turbo cache archive (a GNU or ustar tar with repository-relative paths), each mapped to
// the hash driftSnapshot gives the same content. Directories are skipped; another entry type is an error.
export function archivedContents(tar) {
  const contents = new Map();
  const long = {}; // GNU long name (L) and long link target (K) entries apply to the next entry
  for (let offset = 0; offset + 512 <= tar.length && tar[offset] !== 0; ) {
    const header = tarHeader(tar.subarray(offset, offset + 512));
    if (offset + 512 + header.size > tar.length) throw new Error(`tar entry ${header.name} ends past the archive`);
    const data = tar.subarray(offset + 512, offset + 512 + header.size);
    offset += 512 + Math.ceil(header.size / 512) * 512;
    if (header.type === "L" || header.type === "K") {
      long[header.type] = data.toString("utf8").replace(/\0[\s\S]*$/, "");
      continue;
    }
    const name = long.L ?? header.name;
    if (header.type === "0") contents.set(name, sha256(data));
    else if (header.type === "2") contents.set(name, sha256(`link:${long.K ?? header.link}`));
    else if (header.type !== "5") throw new Error(`unsupported tar entry ${JSON.stringify(header.type)} for ${name}`);
    delete long.L;
    delete long.K;
  }
  return contents;
}

// A function giving the content hash of `file` in the cache archive of task `hash` in cacheDir, or undefined when the
// archive does not hold it or cannot be read. Each archive is read once.
export function archiveReader(cacheDir) {
  const archives = new Map();
  return (hash, file) => {
    if (!archives.has(hash)) {
      let contents = new Map();
      try {
        contents = archivedContents(zlib.zstdDecompressSync(fs.readFileSync(path.join(cacheDir, `${hash}.tar.zst`))));
      } catch {
        // Not readable (or no zstd in this Node): the archive restores nothing this check can rely on.
      }
      archives.set(hash, contents);
    }
    return archives.get(hash).get(file);
  };
}

// The files of the Git checkout at `cwd` that differ from HEAD (changed, deleted or staged) and the untracked files
// that are not ignored, each with a hash of its content ("deleted" for a missing file).
export function driftSnapshot(cwd) {
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"];
  const status = execFileSync(gitExecutable(), args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  const snapshot = {};
  for (const line of status.split("\0").filter(Boolean)) {
    const file = line.slice(3);
    snapshot[file] = contentHash(path.join(cwd, file));
  }
  return snapshot;
}

// Records one step's evidence in stepsDir: the run summary Turbo wrote to `.turbo/runs` during the step (exactly one,
// which is then removed, or null), the cache directory's files and the drift snapshot. A piece that cannot be read is
// recorded as null, so the merge taints the step's entries.
export function recordStep({ name, stepsDir, cwd, baseline = false }) {
  const record = { name, baseline, tasks: baseline ? [] : null, listing: null, snapshot: null, errors: [] };
  const attempt = (field, read) => {
    try {
      record[field] = read();
    } catch (error) {
      record.errors.push(`${field}: ${error.message}`);
    }
  };
  const runsDir = path.join(cwd, ".turbo/runs");
  const summaries = filesIn(runsDir).filter((file) => file.endsWith(".json"));
  if (!baseline) {
    attempt("tasks", () => {
      if (summaries.length !== 1) throw new Error(`found ${summaries.length} Turbo run summaries, expected 1`);
      return readSummaryTasks(fs.readFileSync(path.join(runsDir, summaries[0]), "utf8"), "run summary");
    });
  }
  for (const file of summaries) fs.rmSync(path.join(runsDir, file));
  attempt("listing", () => filesIn(path.join(cwd, ".turbo/cache")));
  attempt("snapshot", () => driftSnapshot(cwd));
  fs.mkdirSync(stepsDir, { recursive: true });
  const index = filesIn(stepsDir).filter((file) => file.endsWith(".json")).length;
  fs.writeFileSync(path.join(stepsDir, `${String(index).padStart(2, "0")}-${name}.json`), JSON.stringify(record));
  return record;
}

export function readRecords(stepsDir) {
  return filesIn(stepsDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(stepsDir, file), "utf8")));
}

// Why a step's new entries cannot be saved ({ reason, drift }), or null: its record has no readable summary or no
// snapshot to compare with `previous`, or a file changed during the step that replaying the step would not restore.
// A file a task the step ran (cache MISS in its own summary) declares as an output is restored. A task the step
// replayed (HIT) restores only its archived outputs, so a file it declares counts only when the content now equals the
// archived one (`archived(hash, file)`): its own restore, not another task writing over it.
function stepTaint(step, previous, archived) {
  if (!Array.isArray(step.tasks)) return { reason: "no readable Turbo run summary", drift: [] };
  if (!step.snapshot || !previous) return { reason: "no drift snapshot", drift: [] };
  let ran;
  let replayed;
  try {
    ran = declaredOutputMatcher(step.tasks.filter((task) => task.cacheStatus === "MISS"));
    replayed = step.tasks.filter((task) => task.cacheStatus === "HIT");
    replayed = replayed.map((task) => ({ hash: task.hash, declares: declaredOutputMatcher([task]) }));
  } catch (error) {
    return { reason: error.message, drift: [] };
  }
  // A replay only writes files, so it never restores a removal: a file now absent from the snapshot (a deleted tracked
  // file, a tracked file back at HEAD or a removed untracked file) is drift even when a task the step ran or replayed
  // declares it. A tracked file back at HEAD is over-tainted, which costs cache hits only.
  const restored = (file) => {
    const now = step.snapshot[file];
    if (now === undefined || now === "deleted") return false;
    return ran(file) || replayed.some(({ hash, declares }) => declares(file) && archived(hash, file) === now);
  };
  const files = new Set([...Object.keys(previous), ...Object.keys(step.snapshot)]);
  const drift = [...files].filter((file) => previous[file] !== step.snapshot[file] && !restored(file));
  if (drift.length === 0) return null;
  return { reason: "files changed outside the declared outputs", drift: drift.sort(byCodeUnit) };
}

// The hashes of the entries to delete, from the step records in order (baseline first) and the cache directory's files
// now, plus a report of each tainted step. `archived` reads the cache archives (see archiveReader).
export function taintedEntries(records, finalListing, archived = () => undefined) {
  const [baseline, ...steps] = records;
  if (!baseline?.baseline || !Array.isArray(baseline.listing) || !baseline.snapshot) {
    throw new Error("the first step record is not a complete baseline");
  }
  const tainted = new Set();
  const reports = [];
  let listing = new Set(baseline.listing);
  let snapshot = baseline.snapshot;
  let carried = null;
  const taint = (files, report) => {
    const hashes = files.map(entryHash).filter((hash) => hash !== null);
    for (const hash of hashes) tainted.add(hash);
    reports.push({ ...report, entries: new Set(hashes).size });
  };
  for (const step of steps) {
    if (!Array.isArray(step.listing)) {
      carried ??= `step ${step.name} has no cache listing`;
      snapshot = null;
      continue;
    }
    const found = carried ? { reason: carried, drift: [] } : stepTaint(step, snapshot, archived);
    if (found) taint(step.listing.filter((file) => !listing.has(file)), { step: step.name, ...found });
    listing = new Set(step.listing);
    snapshot = step.snapshot ?? null;
    carried = null;
  }
  const unrecorded = finalListing.filter((file) => !listing.has(file));
  if (unrecorded.length > 0 || carried) {
    taint(unrecorded, { step: "after the last record", reason: carried ?? "entries no step recorded", drift: [] });
  }
  return { tainted, reports };
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    fs.copyFileSync(from, to);
    fs.rmSync(from);
  }
}

// Settles one restored or set-aside entry file and returns its outcome: "pruned" (deleted) when its hash is not current
// or is tainted, "superseded" (deleted) for a set-aside entry the run wrote again, otherwise "restored" (kept in or
// moved back to cacheDir).
function settleCandidate({ fileName, hash, from }, { cacheDir, currentHashes, tainted, newHashes }) {
  const source = path.join(from, fileName);
  if (hash === null || !currentHashes.has(hash) || tainted.has(hash)) {
    fs.rmSync(source);
    return "pruned";
  }
  if (from === cacheDir) return "restored";
  if (newHashes.has(hash)) {
    fs.rmSync(source);
    return "superseded";
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  moveFile(source, path.join(cacheDir, fileName));
  return "restored";
}

// Deletes the tainted entries of cacheDir, then merges the set-aside entries (asideDir) or prunes the restored ones
// (restoredFiles, the baseline listing) as described above. Returns the hashes of each outcome, sorted.
export function mergeTurboCache({ cacheDir, asideDir, restoredFiles = [], currentHashes, tainted = new Set() }) {
  const restoredNames = new Set(asideDir === undefined ? restoredFiles : []);
  const newHashes = new Set();
  const outcome = { dropped: new Set(), restored: new Set(), superseded: new Set(), pruned: new Set() };
  const candidates = [];
  for (const fileName of filesIn(cacheDir)) {
    const hash = entryHash(fileName);
    if (restoredNames.has(fileName)) {
      candidates.push({ fileName, hash, from: cacheDir });
    } else if (hash !== null && tainted.has(hash)) {
      fs.rmSync(path.join(cacheDir, fileName));
      outcome.dropped.add(hash);
    } else if (hash !== null) {
      newHashes.add(hash);
    }
  }
  if (asideDir !== undefined) {
    for (const fileName of filesIn(asideDir)) candidates.push({ fileName, hash: entryHash(fileName), from: asideDir });
  }
  const context = { cacheDir, currentHashes, tainted, newHashes };
  for (const candidate of candidates) {
    outcome[settleCandidate(candidate, context)].add(candidate.hash ?? candidate.fileName);
  }
  if (asideDir !== undefined) fs.rmSync(asideDir, { recursive: true, force: true });
  const sorted = (set) => [...set].sort(byCodeUnit);
  return Object.fromEntries(Object.entries({ kept: newHashes, ...outcome }).map(([key, set]) => [key, sorted(set)]));
}

// A value for a GitHub Actions annotation property (`file=…`).
function annotationProperty(value) {
  return value.replace(/[%\r\n:,]/g, (char) => `%${char.codePointAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

const USAGE =
  "usage: node scripts/turbo-cache-merge.mjs --record <step> --steps-dir <dir> [--baseline], or " +
  "--merge --steps-dir <dir> --cache-dir <dir> --dry-run <dry-run JSON file> [--aside-dir <dir>]";

function parseArgs(argv) {
  const options = { baseline: false, merge: false };
  const names = { "--record": "record", "--steps-dir": "stepsDir", "--cache-dir": "cacheDir" };
  Object.assign(names, { "--dry-run": "dryRun", "--aside-dir": "asideDir" });
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--baseline" || argv[index] === "--merge") {
      options[argv[index].slice(2)] = true;
      continue;
    }
    const name = names[argv[index]];
    const value = argv[++index];
    if (name === undefined || !value || options[name] !== undefined) throw new Error(USAGE);
    options[name] = value;
  }
  const merging = ["cacheDir", "dryRun", "asideDir"].some((name) => options[name] !== undefined);
  const valid = options.merge
    ? options.record === undefined && !options.baseline && options.cacheDir && options.dryRun
    : /^[a-z][a-z0-9-]*$/.test(options.record ?? "") && !merging;
  if (!valid || !options.stepsDir) throw new Error(USAGE);
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.merge) {
    const { record: name, stepsDir, baseline } = options;
    const record = recordStep({ name, stepsDir, baseline, cwd: process.cwd() });
    for (const error of record.errors) console.log(`::warning title=Turbo cache record::${name}: ${error}`);
    return;
  }
  const { stepsDir, cacheDir, dryRun, asideDir } = options;
  const records = readRecords(stepsDir);
  const currentHashes = new Set(readSummaryTasks(fs.readFileSync(dryRun, "utf8"), "dry run").map((task) => task.hash));
  for (const record of records) for (const task of record.tasks ?? []) currentHashes.add(task.hash);
  const { tainted, reports } = taintedEntries(records, filesIn(cacheDir), archiveReader(cacheDir));
  for (const { step, reason, drift, entries } of reports) {
    console.log(`::warning title=Turbo cache not saved for ${step}::${reason}; dropping ${entries} new entries`);
    for (const file of drift) {
      console.log(
        `::warning file=${annotationProperty(file)},title=Changed outside Turbo outputs::The ${step} step changed ` +
          "this file, which no task the step ran declares as an output, so a replay would not restore it. Its " +
          "cache entries are not saved. Commit the regenerated file or declare it as an output of the task writing it."
      );
    }
  }
  const restoredFiles = asideDir === undefined ? records[0].listing : [];
  const result = mergeTurboCache({ cacheDir, asideDir, restoredFiles, currentHashes, tainted });
  const source = asideDir === undefined ? "restored" : "set-aside";
  console.log(
    `turbo-cache-merge: ${currentHashes.size} current task hashes; kept ${result.kept.length} new entries, ` +
      `dropped ${result.dropped.length} tainted new entries, kept ${result.restored.length} ${source} entries, ` +
      `dropped ${result.superseded.length} ${source} entries this run rewrote, pruned ${result.pruned.length} ` +
      `${source} entries not current or tainted`
  );
}

// Whether Node runs this file as its entry point. argv[1] keeps the path it was given (a symlinked checkout, or the
// name without its extension) while import.meta.url is the real path, so compare real paths.
function isEntryPoint() {
  if (import.meta.main !== undefined) return import.meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fs.realpathSync(fileURLToPath(import.meta.url));
  return [entry, `${entry}.mjs`].some((candidate) => {
    try {
      return fs.realpathSync(candidate) === self;
    } catch {
      return false;
    }
  });
}

if (isEntryPoint()) {
  try {
    main();
  } catch (error) {
    console.error(`::warning title=Turbo cache not saved::turbo-cache-merge: ${error.message.replace(/\r?\n/g, " ")}`);
    process.exitCode = 1;
  }
}
