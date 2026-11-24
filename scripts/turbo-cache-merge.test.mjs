import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { entryHash, mergeTurboCache, pruneRestoredTurboCache, readDryRunHashes } from "./turbo-cache-merge.mjs";

const script = fileURLToPath(new URL("./turbo-cache-merge.mjs", import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "turbo-cache-merge-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Readable 16-digit hex hashes, the length Turbo uses.
const KEPT = "aaaa000000000001";
const STALE = "bbbb000000000002";
const REWRITTEN = "cccc000000000003";
const NEW = "dddd000000000004";

let caseNumber = 0;
function freshDirs() {
  const root = path.join(scratch, `case-${++caseNumber}`);
  return { root, cacheDir: path.join(root, "cache"), asideDir: path.join(root, "aside") };
}

function writeEntry(directory, hash, label) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${hash}.tar.zst`), `${label} archive`);
  writeFileSync(path.join(directory, `${hash}-meta.json`), JSON.stringify({ hash, label }));
}

function dryRun(hashes) {
  return JSON.stringify({ tasks: hashes.map((hash, index) => ({ taskId: `pkg-${index}#build`, hash })) });
}

function cacheContents(cacheDir) {
  return Object.fromEntries(
    readdirSync(cacheDir)
      .sort()
      .map((fileName) => [fileName, readFileSync(path.join(cacheDir, fileName), "utf8")])
  );
}

test("set-aside entries in the current hashes are kept, others are pruned, and new entries win", () => {
  const { cacheDir, asideDir } = freshDirs();
  writeEntry(asideDir, KEPT, "aside");
  writeEntry(asideDir, STALE, "aside");
  writeEntry(asideDir, REWRITTEN, "aside");
  writeFileSync(path.join(asideDir, "notes.txt"), "not an entry");
  writeEntry(cacheDir, REWRITTEN, "new");
  writeEntry(cacheDir, NEW, "new");

  const result = mergeTurboCache({ cacheDir, asideDir, currentHashes: new Set([KEPT, REWRITTEN, NEW]) });

  assert.deepEqual(cacheContents(cacheDir), {
    [`${KEPT}-meta.json`]: JSON.stringify({ hash: KEPT, label: "aside" }),
    [`${KEPT}.tar.zst`]: "aside archive",
    [`${REWRITTEN}-meta.json`]: JSON.stringify({ hash: REWRITTEN, label: "new" }),
    [`${REWRITTEN}.tar.zst`]: "new archive",
    [`${NEW}-meta.json`]: JSON.stringify({ hash: NEW, label: "new" }),
    [`${NEW}.tar.zst`]: "new archive",
  });
  assert.deepEqual(result, {
    kept: [REWRITTEN, NEW],
    keptNotInDryRun: [],
    restored: [KEPT],
    superseded: [REWRITTEN],
    pruned: [STALE, "notes.txt"],
  });
  assert.equal(existsSync(asideDir), false, "the set-aside directory is removed");
});

test("an entry this run wrote is kept even when the dry run did not report its hash", () => {
  const { cacheDir, asideDir } = freshDirs();
  writeEntry(cacheDir, NEW, "new");
  writeEntry(asideDir, NEW, "aside");

  const result = mergeTurboCache({ cacheDir, asideDir, currentHashes: new Set([KEPT]) });

  assert.deepEqual(Object.keys(cacheContents(cacheDir)), [`${NEW}-meta.json`, `${NEW}.tar.zst`]);
  assert.equal(cacheContents(cacheDir)[`${NEW}.tar.zst`], "new archive");
  assert.deepEqual(result.keptNotInDryRun, [NEW]);
  assert.deepEqual(result.pruned, [NEW], "a set-aside entry is pruned when its hash is not current");
});

test("a run that wrote no cache still keeps the current set-aside entries", () => {
  const { cacheDir, asideDir } = freshDirs();
  writeEntry(asideDir, KEPT, "aside");
  writeEntry(asideDir, STALE, "aside");

  const result = mergeTurboCache({ cacheDir, asideDir, currentHashes: new Set([KEPT]) });

  assert.deepEqual(Object.keys(cacheContents(cacheDir)), [`${KEPT}-meta.json`, `${KEPT}.tar.zst`]);
  assert.deepEqual(result.restored, [KEPT]);
  assert.deepEqual(result.pruned, [STALE]);
});

test("a run that restored nothing leaves its new entries as they are", () => {
  const { cacheDir, asideDir } = freshDirs();
  writeEntry(cacheDir, NEW, "new");

  const result = mergeTurboCache({ cacheDir, asideDir, currentHashes: new Set([NEW]) });

  assert.deepEqual(Object.keys(cacheContents(cacheDir)), [`${NEW}-meta.json`, `${NEW}.tar.zst`]);
  assert.deepEqual(result, { kept: [NEW], keptNotInDryRun: [], restored: [], superseded: [], pruned: [] });
});

test("a pull request's restored entries outside the current hashes are pruned, and every new entry is kept", () => {
  const { cacheDir } = freshDirs();
  writeEntry(cacheDir, KEPT, "restored");
  writeEntry(cacheDir, STALE, "restored");
  writeFileSync(path.join(cacheDir, "notes.txt"), "restored, not an entry");
  const restoredFiles = readdirSync(cacheDir);
  writeEntry(cacheDir, NEW, "new");
  writeEntry(cacheDir, REWRITTEN, "new");
  writeFileSync(path.join(cacheDir, "turbo-scratch"), "new, not an entry");

  const result = pruneRestoredTurboCache({ cacheDir, restoredFiles, currentHashes: new Set([KEPT, NEW]) });

  assert.deepEqual(Object.keys(cacheContents(cacheDir)), [
    `${KEPT}-meta.json`,
    `${KEPT}.tar.zst`,
    `${REWRITTEN}-meta.json`,
    `${REWRITTEN}.tar.zst`,
    `${NEW}-meta.json`,
    `${NEW}.tar.zst`,
    "turbo-scratch",
  ]);
  assert.equal(cacheContents(cacheDir)[`${KEPT}.tar.zst`], "restored archive");
  assert.deepEqual(result, {
    kept: [REWRITTEN, NEW],
    keptNotInDryRun: [REWRITTEN],
    restored: [KEPT],
    superseded: [],
    pruned: [STALE, "notes.txt"],
  });
});

test("a pull request that restored nothing keeps its new entries", () => {
  const { cacheDir } = freshDirs();
  writeEntry(cacheDir, NEW, "new");

  const result = pruneRestoredTurboCache({ cacheDir, restoredFiles: [], currentHashes: new Set([NEW]) });

  assert.deepEqual(Object.keys(cacheContents(cacheDir)), [`${NEW}-meta.json`, `${NEW}.tar.zst`]);
  assert.deepEqual(result, { kept: [NEW], keptNotInDryRun: [], restored: [], superseded: [], pruned: [] });
  assert.deepEqual(
    pruneRestoredTurboCache({ cacheDir: path.join(cacheDir, "missing"), restoredFiles: [], currentHashes: new Set() })
      .kept,
    [],
    "a run that wrote no cache directory is not an error"
  );
});

test("entry files are recognised by Turbo's names only", () => {
  assert.equal(entryHash(`${KEPT}.tar.zst`), KEPT);
  assert.equal(entryHash(`${KEPT}-meta.json`), KEPT);
  assert.equal(entryHash(`${KEPT}.tar.gz`), null);
  assert.equal(entryHash("notes.txt"), null);
  assert.equal(entryHash(`${KEPT.toUpperCase()}.tar.zst`), null);
});

test("the dry run's task hashes are read, and a dry run without them is an error", () => {
  assert.deepEqual(readDryRunHashes(dryRun([KEPT, NEW, KEPT])), new Set([KEPT, NEW]));
  assert.throws(() => readDryRunHashes("turbo 2.6.1\n{}"), /not JSON/);
  assert.throws(() => readDryRunHashes(JSON.stringify({ tasks: [] })), /lists no tasks/);
  assert.throws(() => readDryRunHashes(JSON.stringify({})), /lists no tasks/);
  assert.throws(
    () => readDryRunHashes(JSON.stringify({ tasks: [{ taskId: "pkg#build" }] })),
    /gives task "pkg#build" no task hash/
  );
});

function runCli(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("the command merges with the dry run's hashes and reports the counts", () => {
  const { root, cacheDir, asideDir } = freshDirs();
  writeEntry(asideDir, KEPT, "aside");
  writeEntry(asideDir, STALE, "aside");
  writeEntry(cacheDir, NEW, "new");
  const dryRunFile = path.join(root, "dry-run.json");
  writeFileSync(dryRunFile, dryRun([KEPT, NEW]));

  const run = runCli(["--cache-dir", cacheDir, "--aside-dir", asideDir, "--dry-run", dryRunFile]);

  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stdout,
    /2 current task hashes; kept 1 new entries, kept 1 set-aside entries, dropped 0 .* pruned 1 set-aside /
  );
  assert.doesNotMatch(run.stdout, /::warning/);
  assert.deepEqual(Object.keys(cacheContents(cacheDir)), [
    `${KEPT}-meta.json`,
    `${KEPT}.tar.zst`,
    `${NEW}-meta.json`,
    `${NEW}.tar.zst`,
  ]);
});

test("the command prunes a pull request's restored entries from the restored list", () => {
  const { root, cacheDir } = freshDirs();
  writeEntry(cacheDir, KEPT, "restored");
  writeEntry(cacheDir, STALE, "restored");
  const restoredList = path.join(root, "restored.txt");
  writeFileSync(restoredList, `${readdirSync(cacheDir).join("\n")}\n`);
  writeEntry(cacheDir, NEW, "new");
  const dryRunFile = path.join(root, "dry-run.json");
  writeFileSync(dryRunFile, dryRun([KEPT, NEW]));

  const run = runCli(["--cache-dir", cacheDir, "--restored-list", restoredList, "--dry-run", dryRunFile]);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /kept 1 new entries, kept 1 restored entries, .* pruned 1 restored entries /);
  assert.deepEqual(Object.keys(cacheContents(cacheDir)), [
    `${KEPT}-meta.json`,
    `${KEPT}.tar.zst`,
    `${NEW}-meta.json`,
    `${NEW}.tar.zst`,
  ]);
});

test("the command warns when a new entry's hash is missing from the dry run", () => {
  const { root, cacheDir, asideDir } = freshDirs();
  writeEntry(cacheDir, NEW, "new");
  const dryRunFile = path.join(root, "dry-run.json");
  mkdirSync(root, { recursive: true });
  writeFileSync(dryRunFile, dryRun([KEPT]));

  const run = runCli(["--cache-dir", cacheDir, "--aside-dir", asideDir, "--dry-run", dryRunFile]);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`::warning title=Turbo cache merge::1 new cache entries .*: ${NEW}`));
});

test("the command fails, leaving the set-aside entries, on a bad dry run or bad arguments", () => {
  const { root, cacheDir, asideDir } = freshDirs();
  writeEntry(asideDir, KEPT, "aside");
  const dryRunFile = path.join(root, "dry-run.json");
  writeFileSync(dryRunFile, JSON.stringify({ tasks: [] }));

  const badDryRun = runCli(["--cache-dir", cacheDir, "--aside-dir", asideDir, "--dry-run", dryRunFile]);
  assert.equal(badDryRun.status, 1);
  assert.match(badDryRun.stderr, /turbo-cache-merge: the dry run lists no tasks/);
  assert.equal(existsSync(path.join(asideDir, `${KEPT}.tar.zst`)), true);

  for (const args of [
    ["--cache-dir", cacheDir, "--aside-dir", asideDir],
    ["--cache-dir", cacheDir, "--aside-dir", asideDir, "--dry-run"],
    ["--cache-dir", cacheDir, "--aside-dir", asideDir, "--dry-run", dryRunFile, "--extra", "x"],
    ["--cache-dir", cacheDir, "--cache-dir", cacheDir, "--aside-dir", asideDir, "--dry-run", dryRunFile],
    ["--cache-dir", cacheDir, "--dry-run", dryRunFile],
    ["--cache-dir", cacheDir, "--aside-dir", asideDir, "--restored-list", dryRunFile, "--dry-run", dryRunFile],
  ]) {
    const run = runCli(args);
    assert.equal(run.status, 1, `${args.join(" ")} must fail`);
    assert.match(run.stderr, /turbo-cache-merge: /);
  }
});
