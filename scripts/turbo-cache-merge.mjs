#!/usr/bin/env node
// SFNS-312: Turbo's local task cache in the JavaScript and DevFn tests CI jobs.
//
// Taint. A replayed task restores only the outputs turbo.json declares for it. A task that also writes a file outside
// them (a tracked file, or an untracked one that is not ignored) leaves it behind when it runs and not when it is
// replayed, so its entry is not saved. Each Turbo step runs with `--summarize`, then records (`--record <step>`) its
// run summary, the cache directory's files and a drift snapshot (changed tracked and untracked unignored files, each
// with a content hash); `--baseline` records the same before any task runs. Before saving, the merge deletes every
// entry that first appeared during a step whose snapshot changed outside the declared outputs of the tasks summarised
// so far, every entry of a step without a readable summary, listing or snapshot, and every entry no step recorded.
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

// The task hash an entry file is named after, or null for any other file. Turbo's task hashes are 16 hex digits.
const ENTRY_FILE = /^([0-9a-f]{16})(?:\.tar\.zst|-meta\.json)$/;

export function entryHash(fileName) {
  return ENTRY_FILE.exec(fileName)?.[1] ?? null;
}

// The tasks of a Turbo run summary or `--dry=json` output, each with a task hash and a directory. A summary without
// tasks would prune every restored entry, so it is an error rather than an empty list.
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
    if (entryHash(`${task?.hash}.tar.zst`) !== task?.hash || typeof task.directory !== "string") {
      throw new Error(`the ${what} gives task ${JSON.stringify(task?.taskId)} no task hash or directory`);
    }
    const { taskId, hash, directory, outputs, excludedOutputs } = task;
    return { taskId, hash, directory, outputs, excludedOutputs };
  });
}

// A regular expression source for one Turbo output glob: `**` as a whole path segment matches any number of segments,
// `*` and `?` match within one segment, `{a,b}` matches either alternative and `[…]` (or `[!…]`) a character class.
function globSource(glob) {
  let source = "";
  let braces = 0;
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      const segmentStart = index === 0 || glob[index - 1] === "/";
      const segmentEnd = index + 2 === glob.length || glob[index + 2] === "/";
      if (!segmentStart || !segmentEnd) throw new Error(`unsupported output glob ${JSON.stringify(glob)}`);
      if (index + 2 === glob.length) {
        // A trailing `**` matches everything below the directory, or the directory's own path.
        source = source.endsWith("/") ? `${source.slice(0, -1)}(?:/.*)?` : `${source}.*`;
      } else {
        source += "(?:[^/]*/)*";
        index += 1; // also skip the `/` after `**`
      }
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const end = glob.indexOf("]", index + 2);
      if (end === -1) throw new Error(`unsupported output glob ${JSON.stringify(glob)}`);
      source += `[${glob.slice(index + 1, end).replace(/^!/, "^").replaceAll("\\", "\\\\")}]`;
      index = end;
    } else if (char === "{") {
      braces += 1;
      source += "(?:";
    } else if (char === "}" && braces > 0) {
      braces -= 1;
      source += ")";
    } else if (char === "," && braces > 0) {
      source += "|";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  if (braces !== 0) throw new Error(`unsupported output glob ${JSON.stringify(glob)}`);
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

function filesIn(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

// The files of the Git checkout at `cwd` that differ from HEAD (changed, deleted or staged) and the untracked files
// that are not ignored, each with a hash of its content ("deleted" for a missing file).
export function driftSnapshot(cwd) {
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"];
  const status = execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  const snapshot = {};
  for (const line of status.split("\0").filter(Boolean)) {
    const file = line.slice(3);
    const full = path.join(cwd, file);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    const link = stat?.isSymbolicLink() ? `link:${fs.readlinkSync(full)}` : null;
    const content = !stat ? null : (link ?? (stat.isFile() ? fs.readFileSync(full) : "directory"));
    snapshot[file] = content === null ? "deleted" : createHash("sha256").update(content).digest("hex");
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

// The hashes of the entries to delete, from the step records in order (baseline first) and the cache directory's files
// now, plus a report of each tainted step.
export function taintedEntries(records, finalListing) {
  const [baseline, ...steps] = records;
  if (!baseline?.baseline || !Array.isArray(baseline.listing) || !baseline.snapshot) {
    throw new Error("the first step record is not a complete baseline");
  }
  const tainted = new Set();
  const reports = [];
  const tasks = [];
  let listing = new Set(baseline.listing);
  let snapshot = baseline.snapshot;
  let carried = null;
  const taint = (files, report) => {
    const hashes = files.map(entryHash).filter((hash) => hash !== null);
    for (const hash of hashes) tainted.add(hash);
    reports.push({ ...report, entries: new Set(hashes).size });
  };
  for (const step of steps) {
    if (Array.isArray(step.tasks)) tasks.push(...step.tasks);
    if (!Array.isArray(step.listing)) {
      carried ??= `step ${step.name} has no cache listing`;
      snapshot = null;
      continue;
    }
    let reason = carried ?? (step.tasks ? null : "no readable Turbo run summary");
    let drift = [];
    if (!reason && (!step.snapshot || !snapshot)) reason = "no drift snapshot";
    if (!reason) {
      try {
        const isOutput = declaredOutputMatcher(tasks);
        const files = new Set([...Object.keys(snapshot), ...Object.keys(step.snapshot)]);
        drift = [...files].filter((file) => snapshot[file] !== step.snapshot[file] && !isOutput(file)).sort();
        if (drift.length > 0) reason = "files changed outside the declared outputs";
      } catch (error) {
        reason = error.message;
      }
    }
    if (reason) taint(step.listing.filter((file) => !listing.has(file)), { step: step.name, reason, drift });
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
  for (const { fileName, hash, from } of candidates) {
    const source = path.join(from, fileName);
    if (hash === null || !currentHashes.has(hash) || tainted.has(hash)) {
      fs.rmSync(source);
      outcome.pruned.add(hash ?? fileName);
    } else if (from === cacheDir) {
      outcome.restored.add(hash);
    } else if (newHashes.has(hash)) {
      fs.rmSync(source);
      outcome.superseded.add(hash);
    } else {
      fs.mkdirSync(cacheDir, { recursive: true });
      moveFile(source, path.join(cacheDir, fileName));
      outcome.restored.add(hash);
    }
  }
  if (asideDir !== undefined) fs.rmSync(asideDir, { recursive: true, force: true });
  const sorted = (set) => [...set].sort();
  return Object.fromEntries(Object.entries({ kept: newHashes, ...outcome }).map(([key, set]) => [key, sorted(set)]));
}

// A value for a GitHub Actions annotation property (`file=…`).
function annotationProperty(value) {
  return value.replace(/[%\r\n:,]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
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
  const { tainted, reports } = taintedEntries(records, filesIn(cacheDir));
  for (const { step, reason, drift, entries } of reports) {
    console.log(`::warning title=Turbo cache not saved for ${step}::${reason}; dropping ${entries} new entries`);
    for (const file of drift) {
      console.log(
        `::warning file=${annotationProperty(file)},title=Changed outside Turbo outputs::The ${step} step changed ` +
          "this file, which no task declares as an output, so a replay would not restore it. Its cache entries are " +
          "not saved. Commit the regenerated file or declare it as an output."
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
    console.error(`turbo-cache-merge: ${error.message}`);
    process.exitCode = 1;
  }
}
