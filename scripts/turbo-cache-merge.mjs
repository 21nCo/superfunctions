#!/usr/bin/env node
// SFNS-312: CI runs that must verify every task (pushes, the nightly run, manual runs) replay nothing from Turbo's
// local cache, yet the cache entry they save is the one every later pull request restores, so it must still hold an
// entry for each task. Such a run restores the latest entry and sets its `.turbo/cache` aside, so Turbo reads none of
// it, records the current task hashes (`turbo run … --dry=json`) before any task runs, then runs every selected task
// while Turbo writes the cache. This script then merges the set-aside entries back:
//   - every entry this run wrote is kept: Turbo wrote it for a task hash of this commit;
//   - a set-aside entry is kept only when its hash is one of the current task hashes and this run wrote no entry with
//     that hash (the new entry wins);
//   - every other set-aside entry is pruned, so the saved cache never grows past one entry per current task.
// Turbo names an entry's files after its task hash (`<hash>.tar.zst` and `<hash>-meta.json`); a set-aside file whose
// name does not start with a hash is pruned too. The set-aside directory is removed afterwards.
// A pull request replays the restored entries, so it sets none aside: it lists the restored files instead, and the
// same rules prune the restored entries whose hash is not current, so a pull request's saved cache does not keep every
// stale entry of its earlier pushes.
// A replayed task restores only the outputs turbo.json declares for it. A task that also rewrites a tracked file (a
// generated source or doc that a later task checks) passes when it runs, since it regenerates the file first, and fails
// when it is replayed, since the stale committed file stays. With `--check-clean` the script fails when the checkout's
// tracked files differ from HEAD after the tasks, so such a run fails whether its tasks ran or were replayed.
//
// Usage: node scripts/turbo-cache-merge.mjs --cache-dir <dir> --dry-run <turbo --dry=json output>
//          (--aside-dir <dir> | --restored-list <file listing the restored cache files, one name per line>)
//        node scripts/turbo-cache-merge.mjs --check-clean

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The task hash an entry file is named after, or null for any other file. Turbo's task hashes are 16 hex digits.
const ENTRY_FILE = /^([0-9a-f]{16})(?:\.tar\.zst|-meta\.json)$/;

export function entryHash(fileName) {
  return ENTRY_FILE.exec(fileName)?.[1] ?? null;
}

// The task hashes in Turbo's `--dry=json` output. An output without tasks would prune every set-aside entry, so it is
// an error rather than an empty set.
export function readDryRunHashes(dryRunJson) {
  let summary;
  try {
    summary = JSON.parse(dryRunJson);
  } catch (error) {
    throw new Error(`the dry run is not JSON: ${error.message}`);
  }
  const tasks = summary?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("the dry run lists no tasks");
  }
  const hashes = new Set();
  for (const task of tasks) {
    if (typeof task?.hash !== "string" || entryHash(`${task.hash}.tar.zst`) === null) {
      throw new Error(`the dry run gives task ${JSON.stringify(task?.taskId)} no task hash`);
    }
    hashes.add(task.hash);
  }
  return hashes;
}

function filesIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function moveFile(from, to) {
  try {
    renameSync(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    copyFileSync(from, to);
    rmSync(from);
  }
}

// Merges the set-aside entries into cacheDir as described above and returns the hashes of each outcome, sorted.
export function mergeTurboCache({ cacheDir, asideDir, currentHashes }) {
  const newHashes = new Set();
  for (const fileName of filesIn(cacheDir)) {
    const hash = entryHash(fileName);
    if (hash !== null) newHashes.add(hash);
  }

  const restored = new Set();
  const superseded = new Set();
  const pruned = new Set();
  for (const fileName of filesIn(asideDir)) {
    const hash = entryHash(fileName);
    if (hash === null || !currentHashes.has(hash)) {
      pruned.add(hash ?? fileName);
    } else if (newHashes.has(hash)) {
      superseded.add(hash);
    } else {
      mkdirSync(cacheDir, { recursive: true });
      moveFile(path.join(asideDir, fileName), path.join(cacheDir, fileName));
      restored.add(hash);
    }
  }
  rmSync(asideDir, { recursive: true, force: true });

  const sorted = (set) => [...set].sort();
  return {
    kept: sorted(newHashes),
    // Entries this run wrote whose hash the dry run did not report: kept, but a sign the dry run and the tasks hash
    // differently (an untracked file a task writes into a package, say), which would prune entries pull requests need.
    keptNotInDryRun: sorted([...newHashes].filter((hash) => !currentHashes.has(hash))),
    restored: sorted(restored),
    superseded: sorted(superseded),
    pruned: sorted(pruned),
  };
}

// Prunes, in place, the restored entries of cacheDir (restoredFiles names their files) whose hash is not current,
// keeping every entry this run wrote. Returns the hashes of each outcome, sorted, as mergeTurboCache does.
export function pruneRestoredTurboCache({ cacheDir, restoredFiles, currentHashes }) {
  const restoredNames = new Set(restoredFiles);
  const present = filesIn(cacheDir);
  const newHashes = new Set();
  for (const fileName of present) {
    const hash = entryHash(fileName);
    if (hash !== null && !restoredNames.has(fileName)) newHashes.add(hash);
  }

  const restored = new Set();
  const pruned = new Set();
  for (const fileName of present.filter((name) => restoredNames.has(name))) {
    const hash = entryHash(fileName);
    if (hash !== null && (currentHashes.has(hash) || newHashes.has(hash))) {
      if (!newHashes.has(hash)) restored.add(hash);
    } else {
      rmSync(path.join(cacheDir, fileName));
      pruned.add(hash ?? fileName);
    }
  }

  const sorted = (set) => [...set].sort();
  return {
    kept: sorted(newHashes),
    keptNotInDryRun: sorted([...newHashes].filter((hash) => !currentHashes.has(hash))),
    restored: sorted(restored),
    superseded: [],
    pruned: sorted(pruned),
  };
}

// The tracked files of the Git checkout at `cwd` that differ from HEAD (changed, deleted or staged), sorted.
// Untracked files are not reported.
export function changedTrackedFiles(cwd) {
  const output = execFileSync("git", ["diff", "HEAD", "--name-only", "-z", "--no-renames"], {
    cwd,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean).sort();
}

// A value for a GitHub Actions annotation property (`file=…`).
function annotationProperty(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

function checkClean() {
  const changed = changedTrackedFiles(process.cwd());
  if (changed.length === 0) {
    console.log("turbo-cache-merge: no task changed a tracked file");
    return;
  }
  for (const file of changed) {
    console.log(
      `::error file=${annotationProperty(file)},title=Tracked file changed by a task::A task changed this tracked ` +
        "file. A replayed task restores only its declared outputs, so regenerate the file and commit it."
    );
  }
  execFileSync("git", ["--no-pager", "diff", "HEAD", "--stat", "--no-renames"], { stdio: "inherit" });
  throw new Error(`${changed.length} tracked files changed after the tasks ran: ${changed.join(", ")}`);
}

const USAGE =
  "usage: node scripts/turbo-cache-merge.mjs --cache-dir <dir> --dry-run <dry-run JSON file> " +
  "(--aside-dir <dir> | --restored-list <file>), or node scripts/turbo-cache-merge.mjs --check-clean";

function parseArgs(argv) {
  const options = {};
  const names = {
    "--cache-dir": "cacheDir",
    "--aside-dir": "asideDir",
    "--restored-list": "restoredList",
    "--dry-run": "dryRun",
  };
  for (let index = 0; index < argv.length; index += 2) {
    const name = names[argv[index]];
    const value = argv[index + 1];
    if (name === undefined || value === undefined || value === "" || options[name] !== undefined) {
      throw new Error(USAGE);
    }
    options[name] = value;
  }
  if (options.cacheDir === undefined) throw new Error("--cache-dir is required");
  if (options.dryRun === undefined) throw new Error("--dry-run is required");
  if ((options.asideDir === undefined) === (options.restoredList === undefined)) {
    throw new Error("give exactly one of --aside-dir and --restored-list");
  }
  return options;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--check-clean")) {
    if (argv.length !== 1) throw new Error(USAGE);
    checkClean();
    return;
  }
  const { cacheDir, asideDir, restoredList, dryRun } = parseArgs(argv);
  const currentHashes = readDryRunHashes(readFileSync(dryRun, "utf8"));
  const source = asideDir === undefined ? "restored" : "set-aside";
  const result =
    asideDir === undefined
      ? pruneRestoredTurboCache({
          cacheDir,
          restoredFiles: readFileSync(restoredList, "utf8").split("\n").filter(Boolean),
          currentHashes,
        })
      : mergeTurboCache({ cacheDir, asideDir, currentHashes });
  console.log(
    `turbo-cache-merge: ${currentHashes.size} current task hashes; kept ${result.kept.length} new entries, ` +
      `kept ${result.restored.length} ${source} entries, dropped ${result.superseded.length} ${source} entries ` +
      `this run rewrote, pruned ${result.pruned.length} ${source} entries not in the current hashes`
  );
  if (result.keptNotInDryRun.length > 0) {
    const sample = result.keptNotInDryRun.slice(0, 20).join(", ");
    console.log(
      `::warning title=Turbo cache merge::${result.keptNotInDryRun.length} new cache entries have a hash the dry run ` +
        `did not report, so the dry run and the tasks hash differently: ${sample}`
    );
  }
}

// Whether Node runs this file as its entry point. argv[1] keeps the path it was given (a symlinked checkout, or the
// name without its extension) while import.meta.url is the real path, so compare real paths.
function isEntryPoint() {
  if (import.meta.main !== undefined) return import.meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  const self = realpathSync(fileURLToPath(import.meta.url));
  return [entry, `${entry}.mjs`].some((candidate) => {
    try {
      return realpathSync(candidate) === self;
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
