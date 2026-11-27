import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

import {
  archivedContents,
  archiveReader,
  byCodeUnit,
  declaredOutputMatcher,
  driftSnapshot,
  entryHash,
  mergeTurboCache,
  readRecords,
  readSummaryTasks,
  recordStep,
  taintedEntries,
} from "./turbo-cache-merge.mjs";

const script = fileURLToPath(new URL("./turbo-cache-merge.mjs", import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "turbo-cache-merge-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Readable 16-digit hex hashes, the length Turbo uses.
const KEPT = "aaaa000000000001";
const STALE = "bbbb000000000002";
const REWRITTEN = "cccc000000000003";
const NEW = "dddd000000000004";
const BUILD = "eeee000000000005";
const TYPECHECK = "ffff000000000006";

let caseNumber = 0;
function freshDirs() {
  const root = path.join(scratch, `case-${++caseNumber}`);
  mkdirSync(root, { recursive: true });
  return { root, cacheDir: path.join(root, "cache"), asideDir: path.join(root, "aside") };
}

function writeEntry(directory, hash, label) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${hash}.tar.zst`), `${label} archive`);
  writeFileSync(path.join(directory, `${hash}-meta.json`), JSON.stringify({ hash, label }));
}

const files = (...hashes) => hashes.flatMap((hash) => [`${hash}-meta.json`, `${hash}.tar.zst`]).sort();

function summary(hashes, extra = {}) {
  return JSON.stringify({
    tasks: hashes.map((hash, index) => ({ taskId: `pkg-${index}#build`, hash, directory: `pkg-${index}`, ...extra })),
  });
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
    dropped: [],
    restored: [KEPT],
    superseded: [REWRITTEN],
    pruned: [STALE, "notes.txt"],
  });
  assert.equal(existsSync(asideDir), false, "the set-aside directory is removed");
});

test("tainted new entries are dropped and a set-aside entry with a tainted hash is pruned", () => {
  const { cacheDir, asideDir } = freshDirs();
  writeEntry(asideDir, KEPT, "aside");
  writeEntry(asideDir, BUILD, "aside");
  writeEntry(cacheDir, BUILD, "new");
  writeEntry(cacheDir, NEW, "new");
  const currentHashes = new Set([KEPT, BUILD, NEW]);

  const result = mergeTurboCache({ cacheDir, asideDir, currentHashes, tainted: new Set([BUILD]) });

  assert.deepEqual(Object.keys(cacheContents(cacheDir)), files(KEPT, NEW));
  assert.deepEqual(result, { kept: [NEW], dropped: [BUILD], restored: [KEPT], superseded: [], pruned: [BUILD] });
});

test("a run that wrote no cache keeps the current set-aside entries, and missing directories are not an error", () => {
  const { cacheDir, asideDir } = freshDirs();
  writeEntry(asideDir, KEPT, "aside");
  writeEntry(asideDir, STALE, "aside");

  const result = mergeTurboCache({ cacheDir, asideDir, currentHashes: new Set([KEPT]) });

  assert.deepEqual(Object.keys(cacheContents(cacheDir)), files(KEPT));
  assert.deepEqual(result.pruned, [STALE]);
  const empty = freshDirs();
  assert.deepEqual(mergeTurboCache({ ...empty, currentHashes: new Set() }).kept, []);
  assert.deepEqual(mergeTurboCache({ cacheDir: empty.cacheDir, currentHashes: new Set() }).kept, []);
});

test("a pull request prunes its restored entries that are stale or tainted and keeps every untainted new entry", () => {
  const { cacheDir } = freshDirs();
  writeEntry(cacheDir, KEPT, "restored");
  writeEntry(cacheDir, STALE, "restored");
  writeEntry(cacheDir, BUILD, "restored");
  writeFileSync(path.join(cacheDir, "notes.txt"), "restored, not an entry");
  const restoredFiles = readdirSync(cacheDir);
  writeEntry(cacheDir, NEW, "new");
  writeEntry(cacheDir, REWRITTEN, "new");
  writeEntry(cacheDir, TYPECHECK, "new");
  writeFileSync(path.join(cacheDir, "turbo-scratch"), "new, not an entry");
  const currentHashes = new Set([KEPT, BUILD, NEW]);

  const result = mergeTurboCache({ cacheDir, restoredFiles, currentHashes, tainted: new Set([BUILD, TYPECHECK]) });

  assert.deepEqual(Object.keys(cacheContents(cacheDir)), [...files(KEPT, REWRITTEN, NEW), "turbo-scratch"]);
  assert.equal(cacheContents(cacheDir)[`${KEPT}.tar.zst`], "restored archive");
  assert.deepEqual(result, {
    kept: [REWRITTEN, NEW],
    dropped: [TYPECHECK],
    restored: [KEPT],
    superseded: [],
    pruned: [BUILD, STALE, "notes.txt"].sort(),
  });
});

test("paths and hashes sort by code unit, not by locale", () => {
  const names = ["b.txt", "B.txt", "_x", "a.txt", "é", "10", "9"];
  assert.deepEqual([...names].sort(byCodeUnit), [...names].sort());
  assert.deepEqual([...names].sort(byCodeUnit), ["10", "9", "B.txt", "_x", "a.txt", "b.txt", "é"]);
});

test("entry files are recognised by Turbo's names only", () => {
  assert.equal(entryHash(`${KEPT}.tar.zst`), KEPT);
  assert.equal(entryHash(`${KEPT}-meta.json`), KEPT);
  assert.equal(entryHash(`${KEPT}.tar.gz`), null);
  assert.equal(entryHash("notes.txt"), null);
  assert.equal(entryHash(`${KEPT.toUpperCase()}.tar.zst`), null);
  assert.equal(entryHash("a.tar.zst"), null);
  assert.equal(entryHash(`${KEPT}0.tar.zst`), null);
});

test("a summary's tasks are read, and a summary without tasks, hashes or directories is an error", () => {
  const tasks = readSummaryTasks(summary([KEPT, NEW], { outputs: ["dist/**"], cache: { status: "HIT" } }), "x");
  assert.deepEqual(tasks[1], {
    taskId: "pkg-1#build",
    hash: NEW,
    directory: "pkg-1",
    outputs: ["dist/**"],
    excludedOutputs: undefined,
    cacheStatus: "HIT",
  });
  assert.throws(() => readSummaryTasks("turbo 2.6.1\n{}", "dry run"), /dry run is not JSON/);
  assert.throws(() => readSummaryTasks(JSON.stringify({ tasks: [] }), "dry run"), /lists no tasks/);
  assert.throws(() => readSummaryTasks(JSON.stringify({}), "dry run"), /lists no tasks/);
  const noDirectory = JSON.stringify({ tasks: [{ taskId: "pkg#build", hash: KEPT }] });
  assert.throws(() => readSummaryTasks(noDirectory, "dry run"), /gives task "pkg#build" no task hash or directory/);
  // A hash that is not 16 hex digits is not a Turbo task hash: such a summary would keep no entry, so it is refused.
  for (const hash of ["a", `${KEPT}0`, KEPT.slice(1), undefined, null]) {
    assert.throws(() => readSummaryTasks(summary([KEPT, hash]), "x"), /gives task "pkg-1#build" no task hash/);
  }
});

test("declared outputs follow Turbo's globs relative to each task's directory", () => {
  const isOutput = declaredOutputMatcher([
    { taskId: "a#build", directory: "apps/a", outputs: [".next/**", "dist/**"], excludedOutputs: [".next/cache/**"] },
    { taskId: "b#build", directory: "libs/b", outputs: ["src/*.generated.{ts,js}", "!src/skip.generated.ts", "?.md"] },
    { taskId: "c#build", directory: "libs/c", outputs: ["$TURBO_ROOT$/shared/out/**", "lib/**/index.d.ts"] },
    { taskId: "//#lint", directory: "", outputs: ["report.json"] },
    { taskId: "d#test", directory: "libs/d" },
    { taskId: "e#build", directory: "libs/e", outputs: ["out/[ab].txt", "out/[!ab]x.txt", "a}b,c.txt"] },
  ]);
  const cases = {
    "apps/a/.next/server/page.js": true,
    "apps/a/dist/index.js": true,
    "apps/a/.next/cache/entry": false, // excluded output
    "apps/a/src/index.ts": false,
    "apps/b/dist/index.js": false, // another package
    "libs/b/src/catalog.generated.ts": true,
    "libs/b/src/catalog.generated.js": true,
    "libs/b/src/nested/catalog.generated.ts": false, // `*` stays within one segment
    "libs/b/src/skip.generated.ts": false, // `!` output glob
    "libs/b/x.md": true,
    "libs/b/xy.md": false,
    "shared/out/a/b.txt": true, // $TURBO_ROOT$ is the repository root
    "libs/c/shared/out/a.txt": false,
    "libs/c/lib/index.d.ts": true, // `**/` matches no directory too
    "libs/c/lib/x/y/index.d.ts": true,
    "report.json": true,
    "libs/d/report.json": false,
    "libs/e/out/a.txt": true, // `[…]` is a character class
    "libs/e/out/c.txt": false,
    "libs/e/out/cx.txt": true, // `[!…]` negates it
    "libs/e/out/ax.txt": false,
    "libs/e/a}b,c.txt": true, // `}` and `,` outside braces are literal
    "libs/e/aXb,c.txt": false,
  };
  for (const [file, expected] of Object.entries(cases)) assert.equal(isOutput(file), expected, file);
  const matcher = (outputs) => () => declaredOutputMatcher([{ taskId: "a#build", directory: "a", outputs }]);
  assert.throws(matcher("dist/**"), /malformed outputs/);
  assert.throws(matcher([""]), /malformed outputs/);
  assert.throws(matcher(["../../x/**"]), /outside the repository/);
  assert.throws(matcher(["dist**"]), /unsupported output glob/);
  assert.throws(matcher(["{a,b"]), /unsupported output glob/);
  assert.throws(matcher(["out/[x"]), /unsupported output glob/);
  assert.throws(matcher(["a/***/b"]), /unsupported output glob/);
});

// Step records as recordStep writes them: `listing` names the cache files, `snapshot` maps drift paths to hashes.
const baseline = (listing = [], snapshot = {}) => ({ name: "prepare", baseline: true, tasks: [], listing, snapshot });
const step = (name, listing, snapshot, tasks = [{ taskId: `${name}#x`, hash: KEPT, directory: "pkg" }]) => ({
  name,
  tasks,
  listing,
  snapshot,
});

test("only the entries that first appeared in a step that changed files outside declared outputs are tainted", () => {
  const drift = { "pkg/src/generated.ts": "v2", "pkg/notes.txt": "new" };
  const records = [
    baseline(files(KEPT)),
    step("build", files(KEPT, BUILD), drift),
    step("typecheck", files(KEPT, BUILD, TYPECHECK), drift), // reads the regenerated file, writes nothing new
    step("test", files(KEPT, BUILD, TYPECHECK), drift), // replays every task
  ];

  const { tainted, reports } = taintedEntries(records, files(KEPT, BUILD, TYPECHECK));

  assert.deepEqual([...tainted], [BUILD]);
  assert.deepEqual(reports, [
    {
      step: "build",
      reason: "files changed outside the declared outputs",
      drift: ["pkg/notes.txt", "pkg/src/generated.ts"],
      entries: 1,
    },
  ]);
  // A later step that changes a drifted file again, or deletes it, is tainted too.
  const all = files(KEPT, BUILD, TYPECHECK);
  for (const later of [{ ...drift, "pkg/notes.txt": "v3" }, { "pkg/notes.txt": "new" }]) {
    const records2 = [...records.slice(0, 2), step("typecheck", all, later)];
    assert.deepEqual([...taintedEntries(records2, all).tainted].sort(), [BUILD, TYPECHECK].sort());
  }
});

test("only files a task the step ran declares as an output are not drift", () => {
  const buildTask = {
    taskId: "ui#build",
    hash: BUILD,
    directory: "ui",
    outputs: ["src/*.generated.ts", "dist/**"],
    excludedOutputs: ["dist/skip/**"],
    cacheStatus: "MISS",
  };
  const buildTasks = [buildTask];
  const snapshot = { "ui/src/catalog.generated.ts": "v2", "ui/dist/index.js": "v2" };
  const rewritten = { ...snapshot, "ui/src/catalog.generated.ts": "v3" };
  const typecheck = { taskId: "app#typecheck", hash: TYPECHECK, directory: "app", cacheStatus: "MISS" };
  const built = step("build", files(BUILD), snapshot, buildTasks);
  const report = {
    step: "typecheck",
    reason: "files changed outside the declared outputs",
    drift: ["ui/src/catalog.generated.ts"],
    entries: 1,
  };
  // Typecheck rewrites a file only the build declares, whether the build is absent from its summary or only replayed
  // there (HIT): replaying typecheck would leave the build's archived v2, so its entry is tainted and the build's kept.
  for (const tasks of [[typecheck], [{ ...buildTask, cacheStatus: "HIT" }, typecheck]]) {
    const records = [baseline(), built, step("typecheck", files(BUILD, TYPECHECK), rewritten, tasks)];
    const { tainted, reports } = taintedEntries(records, files(BUILD, TYPECHECK));
    assert.deepEqual([...tainted], [TYPECHECK], JSON.stringify(tasks));
    assert.deepEqual(reports, [report]);
  }
  // A build the step replayed restoring its own archived output over a stale committed copy is not drift, so the entry
  // of a task the step ran is kept; a content other than the archived one, or no readable archive, is drift.
  const restoredBuild = { ...buildTask, cacheStatus: "HIT" };
  const fresh = { taskId: "app#build", hash: NEW, directory: "app", cacheStatus: "MISS" };
  const restoring = [baseline(files(BUILD)), step("build", files(BUILD, NEW), snapshot, [restoredBuild, fresh])];
  const archive = (contents) => (hash, file) => (hash === BUILD ? contents[file] : undefined);
  assert.deepEqual([...taintedEntries(restoring, files(BUILD, NEW), archive(snapshot)).tainted], []);
  for (const contents of [rewritten, {}]) {
    assert.deepEqual([...taintedEntries(restoring, files(BUILD, NEW), archive(contents)).tainted], [NEW]);
  }
  // A declared file that went back to HEAD is not proven restored by an archive that lacks it.
  const reverted = [baseline(files(BUILD), snapshot), step("build", files(BUILD, NEW), {}, [restoredBuild, fresh])];
  assert.deepEqual([...taintedEntries(reverted, files(BUILD, NEW), archive({})).tainted], [NEW]);
  // A replay never deletes, so deleting even a file a task the step ran declares is drift.
  const deleted = { ...snapshot, "ui/src/catalog.generated.ts": "deleted" };
  const deleting = [baseline(files(BUILD), snapshot), step("build", files(BUILD, NEW), deleted, [buildTask, fresh])];
  assert.deepEqual([...taintedEntries(deleting, files(BUILD, NEW)).tainted], [NEW]);
  // Nor is removing an untracked file a task the step ran declares (it leaves the snapshot): replaying the step's
  // entries would leave the file in place, so they are tainted.
  const removed = [baseline(), built, step("typecheck", files(BUILD, TYPECHECK), {}, [buildTask, typecheck])];
  const removedResult = taintedEntries(removed, files(BUILD, TYPECHECK));
  assert.deepEqual([...removedResult.tainted], [TYPECHECK]);
  assert.deepEqual(removedResult.reports[0].drift, ["ui/dist/index.js", "ui/src/catalog.generated.ts"]);
  // A file the build declares, written while the build ran in this step, is not drift.
  const ranAgain = [baseline(), built, step("typecheck", files(BUILD, TYPECHECK), rewritten, [buildTask, typecheck])];
  assert.deepEqual([...taintedEntries(ranAgain, files(BUILD, TYPECHECK)).tainted], []);
  // Nor is a summary task without a cache status (fail closed: only a MISS excuses a file).
  const unknown = [baseline(), step("build", files(BUILD), snapshot, [{ ...buildTask, cacheStatus: null }])];
  assert.deepEqual([...taintedEntries(unknown, files(BUILD)).tainted], [BUILD]);

  const excluded = [baseline(), step("build", files(BUILD), { ...snapshot, "ui/dist/skip/x.js": "v1" }, buildTasks)];
  const excludedResult = taintedEntries(excluded, files(BUILD));
  assert.deepEqual([...excludedResult.tainted], [BUILD]);
  assert.deepEqual(excludedResult.reports[0].drift, ["ui/dist/skip/x.js"]);
});

test("missing evidence taints: no summary, no listing, no snapshot, no record or a malformed output glob", () => {
  const built = files(BUILD);
  const both = files(BUILD, TYPECHECK);
  const TC = TYPECHECK;
  const malformed = [{ taskId: "x#build", hash: BUILD, directory: "x", outputs: [7], cacheStatus: "MISS" }];
  const cases = [
    ["no readable Turbo run summary", [baseline(), step("build", built, {}, null)], built, [BUILD]],
    // Without the build's listing, its entries first show up in the typecheck record, which is tainted for them.
    ["has no cache listing", [baseline(), step("build", null, {}), step("typecheck", both, {})], both, [BUILD, TC]],
    // A step without a snapshot cannot be compared, so it and the step after it are tainted.
    ["no drift snapshot", [baseline(), step("build", built, null), step("typecheck", both, {})], both, [BUILD, TC]],
    ["entries no step recorded", [baseline(), step("build", built, {})], files(BUILD, NEW), [NEW]],
    ["has no cache listing", [baseline(), step("build", built, {}), step("lint", null, {})], files(BUILD, NEW), [NEW]],
    ["malformed outputs", [baseline(), step("build", built, {}, malformed)], built, [BUILD]],
  ];
  for (const [reason, records, finalListing, expected] of cases) {
    const { tainted, reports } = taintedEntries(records, finalListing);
    assert.deepEqual([...tainted].sort(), expected.sort(), reason);
    assert.ok(reports.some((report) => report.reason.includes(reason)), `${reason}: ${JSON.stringify(reports)}`);
  }
  assert.deepEqual([...taintedEntries([baseline(), step("build", files(BUILD), {})], files(BUILD)).tainted], []);
  const incomplete = [[], [step("build", [], {})], [{ ...baseline(), snapshot: null }]];
  incomplete.push([{ ...baseline(), listing: null }]);
  for (const records of incomplete) {
    assert.throws(() => taintedEntries(records, []), /not a complete baseline/);
  }
});

function git(cwd, ...args) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

// A Git checkout with a committed template, the file generated from it and a .gitignore for Turbo's directories.
function freshCheckout() {
  const { root } = freshDirs();
  mkdirSync(path.join(root, "pkg"), { recursive: true });
  writeFileSync(path.join(root, ".gitignore"), ".turbo/\ndist/\n");
  writeFileSync(path.join(root, "pkg", "template.txt"), "v1\n");
  writeFileSync(path.join(root, "pkg", "generated.txt"), "generated from v1\n");
  git(root, "init", "--quiet");
  git(root, "add", ".");
  const identity = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];
  git(root, ...identity, "commit", "--quiet", "-m", "init");
  return root;
}

// One tar entry as Turbo's GNU tar archives write it (or a ustar one with a name prefix).
function tarEntry(name, { type = "0", data = "", link = "", magic = "ustar  ", prefix = "" } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write(Buffer.byteLength(data).toString(8).padStart(11, "0"), 124);
  header.write(type, 156);
  header.write(link, 157);
  header.write(magic, 257);
  header.write(prefix, 345);
  const body = Buffer.alloc(Math.ceil(Buffer.byteLength(data) / 512) * 512);
  body.write(data);
  return Buffer.concat([header, body]);
}

test("a cache archive's files hash as the drift snapshot hashes the same files, read once per archive", () => {
  const root = freshCheckout();
  const long = `pkg/${"x".repeat(120)}.ts`;
  writeFileSync(path.join(root, "pkg", "generated.txt"), "generated from v2\n");
  writeFileSync(path.join(root, long), "long");
  symlinkSync("template.txt", path.join(root, "pkg", "link"));
  writeFileSync(path.join(root, "pkg", "split.txt"), "split");
  const tar = Buffer.concat([
    tarEntry("pkg/dist/", { type: "5" }),
    tarEntry("pkg/generated.txt", { data: "generated from v2\n" }),
    tarEntry("././@LongLink", { type: "L", data: `${long}\0` }),
    tarEntry(long.slice(0, 99), { data: "long" }),
    tarEntry("pkg/link", { type: "2", link: "template.txt" }),
    tarEntry("split.txt", { magic: "ustar\u000000", prefix: "pkg", data: "split" }),
    Buffer.alloc(1024),
  ]);
  const snapshot = driftSnapshot(root);
  const contents = archivedContents(tar);
  assert.deepEqual([...contents.keys()].sort(byCodeUnit), Object.keys(snapshot).sort(byCodeUnit));
  for (const [file, hash] of contents) assert.equal(hash, snapshot[file], file);
  assert.throws(() => archivedContents(tarEntry("pkg/fifo", { type: "6" })), /unsupported tar entry "6"/);
  // A size past the archive's end, or not octal (a negative one would move backwards), gives no evidence.
  assert.throws(() => archivedContents(tarEntry("pkg/a", { data: "abc" }).subarray(0, 514)), /ends past the archive/);
  const negative = tarEntry("pkg/a", { data: "abc" });
  negative.write("-0000002000", 124);
  assert.throws(() => archivedContents(negative), /unsupported tar entry size "-0000002000"/);

  const { cacheDir } = freshDirs();
  mkdirSync(cacheDir);
  // zstd is in node:zlib from Node 22.15; without it no archive is readable, so a replay proves nothing (fail closed).
  const zstd = typeof zlib.zstdCompressSync === "function";
  writeFileSync(path.join(cacheDir, `${BUILD}.tar.zst`), zstd ? zlib.zstdCompressSync(tar) : tar);
  writeFileSync(path.join(cacheDir, `${NEW}.tar.zst`), "not zstd");
  const archived = archiveReader(cacheDir);
  assert.equal(archived(BUILD, "pkg/generated.txt"), zstd ? snapshot["pkg/generated.txt"] : undefined);
  rmSync(path.join(cacheDir, `${BUILD}.tar.zst`));
  assert.equal(archived(BUILD, long), zstd ? snapshot[long] : undefined, "an archive is read once");
  assert.equal(archived(NEW, "pkg/generated.txt"), undefined, "an unreadable archive restores nothing");
  assert.equal(archived(KEPT, "pkg/generated.txt"), undefined, "a missing archive restores nothing");
});

test("the drift snapshot hashes changed and deleted tracked files and untracked files that are not ignored", () => {
  const root = freshCheckout();
  assert.deepEqual(driftSnapshot(root), {});
  mkdirSync(path.join(root, "pkg", "dist"), { recursive: true });
  writeFileSync(path.join(root, "pkg", "dist", "index.js"), "ignored output");
  writeFileSync(path.join(root, "pkg", "generated.txt"), "generated from v2\n");
  writeFileSync(path.join(root, "pkg", "new file.txt"), "untracked");
  rmSync(path.join(root, "pkg", "template.txt"));

  const first = driftSnapshot(root);
  assert.deepEqual(Object.keys(first).sort(), ["pkg/generated.txt", "pkg/new file.txt", "pkg/template.txt"]);
  assert.equal(first["pkg/template.txt"], "deleted");
  assert.match(first["pkg/generated.txt"], /^[0-9a-f]{64}$/);
  writeFileSync(path.join(root, "pkg", "new file.txt"), "untracked, rewritten");
  const second = driftSnapshot(root);
  assert.notEqual(second["pkg/new file.txt"], first["pkg/new file.txt"]);
  assert.equal(second["pkg/generated.txt"], first["pkg/generated.txt"]);
});

test("a step record holds the step's one run summary, which it removes, the cache files and the snapshot", () => {
  const root = freshCheckout();
  const stepsDir = path.join(root, ".turbo", "steps");
  const runsDir = path.join(root, ".turbo", "runs");
  const base = recordStep({ name: "prepare", stepsDir, cwd: root, baseline: true });
  assert.deepEqual(base, { name: "prepare", baseline: true, tasks: [], listing: [], snapshot: {}, errors: [] });

  writeEntry(path.join(root, ".turbo", "cache"), BUILD, "new");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(runsDir, "run-1.json"), summary([BUILD], { outputs: ["dist/**"] }));
  writeFileSync(path.join(root, "pkg", "generated.txt"), "generated from v2\n");
  const build = recordStep({ name: "build", stepsDir, cwd: root });
  assert.deepEqual(build.tasks.map((task) => task.hash), [BUILD]);
  assert.deepEqual(build.listing, files(BUILD));
  assert.deepEqual(Object.keys(build.snapshot), ["pkg/generated.txt"]);
  assert.deepEqual(readdirSync(runsDir), []);

  writeFileSync(path.join(runsDir, "run-2.json"), summary([TYPECHECK]));
  writeFileSync(path.join(runsDir, "run-3.json"), summary([TYPECHECK]));
  const ambiguous = recordStep({ name: "typecheck", stepsDir, cwd: root });
  assert.equal(ambiguous.tasks, null);
  assert.match(ambiguous.errors[0], /found 2 Turbo run summaries, expected 1/);
  assert.equal(recordStep({ name: "lint", stepsDir, cwd: root }).tasks, null, "a step without a summary has none");
  // A summary task with a null hash makes the summary unreadable, so the step's entries are tainted.
  const nullHash = JSON.stringify({ tasks: [{ taskId: "pkg#test", hash: null, directory: "pkg" }] });
  writeFileSync(path.join(runsDir, "run-4.json"), nullHash);
  const unreadable = recordStep({ name: "test", stepsDir, cwd: root });
  assert.equal(unreadable.tasks, null);
  assert.match(unreadable.errors[0], /gives task "pkg#test" no task hash/);
  const names = ["prepare", "build", "typecheck", "lint", "test"];
  assert.deepEqual(readdirSync(stepsDir), names.map((name, index) => `0${index}-${name}.json`));
  assert.deepEqual(readRecords(stepsDir).map((record) => record.name), names);
});

function runCli(cwd, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

// Runs one Turbo step as CI does: the step's task writes `entries` and changes `writes`, Turbo writes a summary of
// `tasks`, and the step records its evidence.
function runStep(root, name, { entries = [], tasks = [], writes = {} }) {
  for (const hash of entries) writeEntry(path.join(root, ".turbo", "cache"), hash, name);
  for (const [file, content] of Object.entries(writes)) writeFileSync(path.join(root, file), content);
  mkdirSync(path.join(root, ".turbo", "runs"), { recursive: true });
  const summaryTasks = tasks.map(([hash, outputs]) => ({ taskId: `pkg#${name}`, hash, directory: "pkg", outputs }));
  writeFileSync(path.join(root, ".turbo", "runs", `${name}.json`), JSON.stringify({ tasks: summaryTasks }));
  const run = runCli(root, ["--record", name, "--steps-dir", path.join(root, "..", `${path.basename(root)}-steps`)]);
  assert.equal(run.status, 0, run.stderr);
}

function merge(root, extra = []) {
  const dryRunFile = path.join(root, "..", `${path.basename(root)}-dry-run.json`);
  const stepsDir = path.join(root, "..", `${path.basename(root)}-steps`);
  const args = ["--merge", "--steps-dir", stepsDir, "--cache-dir", ".turbo/cache", "--dry-run", dryRunFile];
  return runCli(root, [...args, ...extra]);
}

test("a pull request saves no entry of a step that changed a tracked file, keeping hashes only a summary gives", () => {
  const root = freshCheckout();
  // The pull request restored KEPT (current) and STALE (not current); REWRITTEN is a task hash that only a step summary
  // gives, as when an earlier step rewrote a declared output that the task reads.
  writeEntry(path.join(root, ".turbo", "cache"), KEPT, "restored");
  writeEntry(path.join(root, ".turbo", "cache"), STALE, "restored");
  writeEntry(path.join(root, ".turbo", "cache"), REWRITTEN, "restored");
  writeFileSync(path.join(root, "..", `${path.basename(root)}-dry-run.json`), summary([KEPT, BUILD, TYPECHECK]));
  const steps = path.join(root, "..", `${path.basename(root)}-steps`);
  assert.equal(runCli(root, ["--record", "prepare", "--baseline", "--steps-dir", steps]).status, 0);

  runStep(root, "build", { entries: [BUILD], tasks: [[BUILD, ["dist/**"]]], writes: { "pkg/generated.txt": "v2\n" } });
  runStep(root, "typecheck", { entries: [TYPECHECK], tasks: [[BUILD], [TYPECHECK], [REWRITTEN]] });
  const run = merge(root);

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(Object.keys(cacheContents(path.join(root, ".turbo", "cache"))), files(KEPT, REWRITTEN, TYPECHECK));
  assert.match(
    run.stdout,
    /^::warning title=Turbo cache not saved for build::files changed outside the declared outputs; dropping 1 new /m
  );
  assert.match(run.stdout, /^::warning file=pkg\/generated\.txt,title=Changed outside Turbo outputs::The build step /m);
  assert.match(
    run.stdout,
    /4 current task hashes; kept 1 new entries, dropped 1 tainted new entries, kept 2 restored entries, .* pruned 1 /
  );
});

test("a push merges the set-aside entries, drops tainted ones and escapes annotation file names", () => {
  const root = freshCheckout();
  const aside = path.join(root, "..", `${path.basename(root)}-aside`);
  writeEntry(aside, KEPT, "aside");
  writeEntry(aside, STALE, "aside");
  writeEntry(aside, BUILD, "aside");
  writeFileSync(path.join(root, "..", `${path.basename(root)}-dry-run.json`), summary([KEPT, BUILD, NEW]));
  const steps = path.join(root, "..", `${path.basename(root)}-steps`);
  assert.equal(runCli(root, ["--record", "prepare", "--baseline", "--steps-dir", steps]).status, 0);

  runStep(root, "build", { entries: [BUILD], tasks: [[BUILD]], writes: { "pkg/a,b:c%.txt": "x" } });
  runStep(root, "test", { entries: [NEW], tasks: [[NEW]] });
  const run = merge(root, ["--aside-dir", aside]);

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(Object.keys(cacheContents(path.join(root, ".turbo", "cache"))), files(KEPT, NEW));
  assert.match(run.stdout, /^::warning file=pkg\/a%2Cb%3Ac%25\.txt,title=/m);
  assert.equal(existsSync(aside), false);
});

test("the command fails without a complete baseline, on a bad dry run or on bad arguments, changing nothing", () => {
  const root = freshCheckout();
  const aside = path.join(root, "..", `${path.basename(root)}-aside`);
  writeEntry(aside, KEPT, "aside");
  const dryRunFile = path.join(root, "..", `${path.basename(root)}-dry-run.json`);
  writeFileSync(dryRunFile, summary([KEPT]));
  const noBaseline = merge(root, ["--aside-dir", aside]);
  assert.equal(noBaseline.status, 1);
  assert.match(noBaseline.stderr, /turbo-cache-merge: the first step record is not a complete baseline/);

  const steps = path.join(root, "..", `${path.basename(root)}-steps`);
  assert.equal(runCli(root, ["--record", "prepare", "--baseline", "--steps-dir", steps]).status, 0);
  writeFileSync(dryRunFile, JSON.stringify({ tasks: [] }));
  const badDryRun = merge(root, ["--aside-dir", aside]);
  assert.equal(badDryRun.status, 1);
  assert.match(badDryRun.stderr, /turbo-cache-merge: the dry run lists no tasks/);
  assert.equal(existsSync(path.join(aside, `${KEPT}.tar.zst`)), true);
  writeFileSync(dryRunFile, JSON.stringify({ tasks: [{ taskId: "pkg#build", hash: null, directory: "pkg" }] }));
  const nullDryRun = merge(root, ["--aside-dir", aside]);
  assert.equal(nullDryRun.status, 1);
  assert.match(nullDryRun.stderr, /turbo-cache-merge: the dry run gives task "pkg#build" no task hash/);
  assert.equal(existsSync(path.join(aside, `${KEPT}.tar.zst`)), true);

  for (const args of [
    [],
    ["--record", "build"],
    ["--record", "../build", "--steps-dir", steps],
    ["--record", "build", "--steps-dir", steps, "--cache-dir", "c"],
    ["--merge", "--steps-dir", steps, "--cache-dir", "c"],
    ["--merge", "--steps-dir", steps, "--dry-run", dryRunFile],
    ["--merge", "--record", "build", "--steps-dir", steps, "--cache-dir", "c", "--dry-run", dryRunFile],
    ["--merge", "--baseline", "--steps-dir", steps, "--cache-dir", "c", "--dry-run", dryRunFile],
    ["--merge", "--steps-dir", steps, "--cache-dir", "c", "--cache-dir", "c", "--dry-run", dryRunFile],
    ["--merge", "--steps-dir", steps, "--cache-dir", "c", "--dry-run", dryRunFile, "--extra", "x"],
    ["--merge", "--steps-dir", steps, "--cache-dir", "c", "--dry-run"],
  ]) {
    const run = runCli(root, args);
    assert.equal(run.status, 1, `${args.join(" ")} must fail`);
    assert.match(run.stderr, /turbo-cache-merge: /);
  }
  assert.deepEqual(readdirSync(steps), ["00-prepare.json"]);
});
