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
//
// Usage: node scripts/turbo-cache-merge.mjs --cache-dir <dir> --aside-dir <dir> --dry-run <turbo --dry=json output>

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

// The task hash an entry file is named after, or null for any other file.
const ENTRY_FILE = /^([0-9a-f]+)(?:\.tar\.zst|-meta\.json)$/;

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

function parseArgs(argv) {
  const options = {};
  const names = { "--cache-dir": "cacheDir", "--aside-dir": "asideDir", "--dry-run": "dryRun" };
  for (let index = 0; index < argv.length; index += 2) {
    const name = names[argv[index]];
    const value = argv[index + 1];
    if (name === undefined || value === undefined || value === "" || options[name] !== undefined) {
      throw new Error(
        "usage: node scripts/turbo-cache-merge.mjs --cache-dir <dir> --aside-dir <dir> --dry-run <dry-run JSON file>"
      );
    }
    options[name] = value;
  }
  for (const flag of Object.keys(names)) {
    if (options[names[flag]] === undefined) throw new Error(`${flag} is required`);
  }
  return options;
}

function main() {
  const { cacheDir, asideDir, dryRun } = parseArgs(process.argv.slice(2));
  const currentHashes = readDryRunHashes(readFileSync(dryRun, "utf8"));
  const result = mergeTurboCache({ cacheDir, asideDir, currentHashes });
  console.log(
    `turbo-cache-merge: ${currentHashes.size} current task hashes; kept ${result.kept.length} new entries, ` +
      `restored ${result.restored.length} set-aside entries, dropped ${result.superseded.length} set-aside entries ` +
      `this run rewrote, pruned ${result.pruned.length} set-aside entries not in the current hashes`
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
