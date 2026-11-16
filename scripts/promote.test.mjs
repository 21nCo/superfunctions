// SFNS-127: scripts/promote.mjs against temporary git repositories. The history tests need git-filter-repo; they
// skip without it unless PROMOTE_REQUIRE_FILTER_REPO=1 (set in CI, where the job installs it), which makes them fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FILTER_REPO_HINT,
  PromoteError,
  appendReleaseEntries,
  flipManifest,
  hasFilterRepo,
  normalizePaths,
  parseArgs,
  promote,
  pythonMoves,
  releaseMoves,
  resolveSource,
} from "./promote.mjs";
import { gitBinary } from "./verify-package-lockfiles.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "promote.mjs");
const scratch = mkdtempSync(path.join(tmpdir(), "promote-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Isolate from the developer's git configuration (signing, hooks, default branch).
const globalConfig = path.join(scratch, "gitconfig");
writeFileSync(globalConfig, "");
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Promote Test",
  GIT_AUTHOR_EMAIL: "promote@example.invalid",
  GIT_COMMITTER_NAME: "Promote Test",
  GIT_COMMITTER_EMAIL: "promote@example.invalid",
});

const filterRepo = hasFilterRepo();
const requireFilterRepo = process.env.PROMOTE_REQUIRE_FILTER_REPO === "1";
const historyTest = (name, fn) =>
  test(name, { skip: !filterRepo && !requireFilterRepo && "git-filter-repo is not installed" }, () => {
    assert.ok(filterRepo, FILTER_REPO_HINT);
    return fn();
  });

function git(cwd, ...args) {
  const result = spawnSync(gitBinary(), args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root, files) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

function commit(root, message, files = {}) {
  write(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

const PYTHON_RELEASE = `ROOT = None\nTARGETS = {\n    "alphafn": "alphafn/python",\n}\n\nOTHER = {}\n`;
const RELEASES_TEXT = `[\n  { "slug": "alphafn-core", "path": "alphafn/core", "name": "@alphafn/core" },\n  {"slug": "alphafn-cli", "path": "alphafn/cli", "name": "@alphafn/cli"}\n]\n`;
const publicManifest = () => ({
  version: 1,
  paths: { alphafn: "public", scripts: "public", uifn: "public" },
  rootFiles: { public: ["release-packages.json", "superfunctions.owners.json"], generated: ["package-lock.json"] },
  releases: { "alphafn-cli": "public", "alphafn-core": "public" },
  python: { alphafn: "public" },
});

/**
 * next: widgetfn gets three commits (the third renames a file and archives its .conduct planning file), plus
 * gadgetfn (stays next-owned) and uifn/foo (a sub-path of a public directory). dev: alphafn and uifn/keep.js.
 */
function fixture(name) {
  const dir = path.join(scratch, name);
  const next = path.join(dir, "next");
  const dev = path.join(dir, "dev");
  mkdirSync(next, { recursive: true });
  git(next, "init", "-q", "-b", "main");
  commit(next, "SFN-7: start widgetfn", {
    "release-packages.json": RELEASES_TEXT,
    "alphafn/core/index.js": "export const alpha = 1;\n",
    "widgetfn/core/package.json": { name: "@widgetfn/core", version: "0.0.1" },
    "widgetfn/core/src/old.js": "export const widget = 1;\nexport const shared = 'a long enough line to keep the rename similar';\n",
    "widgetfn/.conduct/plan.md": "private planning\n",
  });
  commit(next, "SFN-12 widget python", {
    "widgetfn/core/src/old.js": "export const widget = 2;\nexport const shared = 'a long enough line to keep the rename similar';\n",
    "widgetfn/python/pyproject.toml": '[project]\nname = "widgetfn"\nversion = "0.0.1"\n',
    "uifn/foo/bar.js": "export const bar = 1;\n",
  });
  git(next, "mv", "widgetfn/core/src/old.js", "widgetfn/core/src/index.js");
  rmSync(path.join(next, "widgetfn/.conduct"), { recursive: true });
  const pin = commit(next, "Rename widget entry (SFN-12)", {
    "21n/conduct-archive/widgetfn/plan.md": "private planning\n",
    "gadgetfn/core/index.js": "export const gadget = 1;\n",
    "uifn/other/x.js": "export const x = 1;\n",
    "release-packages.next.json": [
      { slug: "widgetfn-core", path: "widgetfn/core", name: "@widgetfn/core" },
      { slug: "gadgetfn-core", path: "gadgetfn/core", name: "@gadgetfn/core" },
    ],
    "python-release-packages.next.json": [{ name: "widgetfn", path: "widgetfn/python" }],
    "superfunctions.owners.next.json": {
      version: 1,
      paths: { "21n": "next", gadgetfn: "next", widgetfn: "next" },
      releases: { "gadgetfn-core": "next", "widgetfn-core": "next" },
      python: { widgetfn: "next" },
    },
  });

  mkdirSync(dev, { recursive: true });
  git(dev, "init", "-q", "-b", "dev");
  commit(dev, "dev baseline", {
    "superfunctions.owners.json": publicManifest(),
    "release-packages.json": RELEASES_TEXT,
    "scripts/python_release.py": PYTHON_RELEASE,
    "alphafn/core/index.js": "export const alpha = 1;\n",
    "uifn/keep.js": "export const keep = 1;\n",
  });
  git(dev, "update-ref", "refs/remotes/origin/dev", "HEAD");
  git(dev, "fetch", "-q", next, "+refs/heads/main:refs/remotes/next/next");
  return { dev, next, pin };
}

function promoteCli(dev, args, { env = process.env, cwd } = {}) {
  return spawnSync(process.execPath, [SCRIPT, "--root", dev, ...args], { encoding: "utf8", env, cwd });
}

const throwsCode = (fn, code) =>
  assert.throws(fn, (error) => error instanceof PromoteError && error.code === code, `expected PromoteError ${code}`);

historyTest("a function directory arrives with its history, a public owner and its release entries", () => {
  const { dev, next, pin } = fixture("fn");
  const run = promoteCli(dev, ["widgetfn"]);
  assert.equal(run.status, 0, run.stderr);

  assert.equal(git(dev, "branch", "--show-current"), "promote/widgetfn");
  // The imported paths equal next at the pin; nothing outside them is imported.
  assert.equal(git(dev, "rev-parse", "HEAD:widgetfn"), git(next, "rev-parse", `${pin}:widgetfn`));
  assert.equal(spawnSync(gitBinary(), ["cat-file", "-e", "HEAD:gadgetfn"], { cwd: dev }).status, 128);
  assert.equal(spawnSync(gitBinary(), ["cat-file", "-e", "HEAD:21n"], { cwd: dev }).status, 128);
  assert.equal(git(dev, "show", "HEAD:uifn/keep.js"), "export const keep = 1;");

  // History: all three commits, followed across the rename.
  const followed = git(dev, "log", "--follow", "--format=%s", "--", "widgetfn/core/src/index.js").split("\n");
  assert.deepEqual(followed, ["Rename widget entry (SFN-12)", "SFN-12 widget python", "SFN-7: start widgetfn"]);
  const merge = git(dev, "rev-list", "--merges", "-1", "HEAD");
  assert.equal(git(dev, "rev-parse", `${merge}^1`), git(dev, "rev-parse", "origin/dev"));
  const imported = git(dev, "rev-list", "--count", `${merge}^2`);
  assert.equal(imported, "3");
  // .conduct planning files are stripped from every imported commit (D1).
  assert.equal(git(dev, "log", "--format=%H", `${merge}^2`, "--", "widgetfn/.conduct"), "");
  assert.doesNotMatch(git(dev, "log", "--name-only", "--format=", `${merge}^2`), /\.conduct/);

  // Manifest owner flipped and release entries moved; existing lines are untouched.
  const manifest = JSON.parse(git(dev, "show", "HEAD:superfunctions.owners.json"));
  assert.deepEqual(Object.keys(manifest.paths), ["alphafn", "scripts", "uifn", "widgetfn"]);
  assert.equal(manifest.releases["widgetfn-core"], "public");
  assert.equal(manifest.releases["gadgetfn-core"], undefined);
  assert.equal(manifest.python.widgetfn, "public");
  const releases = git(dev, "show", "HEAD:release-packages.json");
  assert.ok(releases.startsWith(RELEASES_TEXT.trimEnd().slice(0, -2)), "existing release lines unchanged");
  assert.deepEqual(JSON.parse(releases).map((entry) => entry.slug), ["alphafn-core", "alphafn-cli", "widgetfn-core"]);
  assert.match(git(dev, "show", "HEAD:scripts/python_release.py"), /TARGETS = \{\n {4}"alphafn": "alphafn\/python",\n {4}"widgetfn": "widgetfn\/python",\n\}\n/);
  assert.equal(git(dev, "status", "--porcelain"), "");

  // Report: commits, files, moved entries, next clean-up and the Linear move list.
  assert.match(run.stdout, /Imported commits \(3\):/);
  assert.match(run.stdout, /widgetfn\/core\/src\/index\.js/);
  assert.match(run.stdout, /widgetfn-core @widgetfn\/core widgetfn\/core \(from release-packages\.next\.json\)/);
  assert.match(run.stdout, /superfunctions\.owners\.next\.json: remove paths\.widgetfn/);
  assert.match(run.stdout, /release-packages\.next\.json: remove widgetfn-core/);
  assert.match(run.stdout, /SF Next issues named in the imported history: SFN-7, SFN-12/);
  assert.match(run.stdout, /Search SF Next open issues for: @widgetfn\/core/);
});

historyTest("--path imports only the sub-path, at the pin, and leaves an already public manifest alone", () => {
  const { dev, next, pin } = fixture("subpath");
  const before = git(dev, "rev-parse", "HEAD");
  const result = promote({ root: dev, paths: ["uifn/foo/", "uifn/foo/bar.js", "alphafn/core"], pin });
  assert.deepEqual(result.paths, ["alphafn/core", "uifn/foo"]);
  assert.equal(result.branch, "promote/alphafn/core");
  const merge = git(dev, "rev-parse", "HEAD");
  assert.equal(git(dev, "rev-parse", "HEAD^1"), before, "no ownership commit: everything was already public");
  assert.deepEqual(git(dev, "ls-tree", "-r", "--name-only", `${merge}^2`).split("\n"), ["alphafn/core/index.js", "uifn/foo/bar.js"]);
  assert.equal(git(dev, "rev-parse", "HEAD:uifn/foo"), git(next, "rev-parse", `${pin}:uifn/foo`));
  assert.equal(spawnSync(gitBinary(), ["cat-file", "-e", "HEAD:uifn/other"], { cwd: dev }).status, 128);
  assert.equal(git(dev, "show", "HEAD:superfunctions.owners.json"), git(dev, "show", `${before}:superfunctions.owners.json`));
  assert.deepEqual(result.releases, []);
});

historyTest("a dirty tree, a branch not based on origin/dev and a conflicting path are refused without changes", () => {
  const { dev, pin } = fixture("refuse");
  const head = git(dev, "rev-parse", "HEAD");
  const unchanged = () => {
    assert.equal(git(dev, "rev-parse", "HEAD"), head);
    assert.equal(git(dev, "branch", "--list", "promote/*"), "");
  };

  writeFileSync(path.join(dev, "stray.txt"), "x\n");
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "dirty-tree");
  rmSync(path.join(dev, "stray.txt"));
  unchanged();

  const ahead = git(dev, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "dev moved on");
  git(dev, "update-ref", "refs/remotes/origin/dev", ahead);
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "wrong-base");
  unchanged();
  git(dev, "update-ref", "refs/remotes/origin/dev", head);

  commit(dev, "dev has its own uifn/foo", { "uifn/foo/bar.js": "export const bar = 'dev';\n" });
  git(dev, "update-ref", "refs/remotes/origin/dev", "HEAD");
  const conflicted = git(dev, "rev-parse", "HEAD");
  throwsCode(() => promote({ root: dev, paths: ["uifn/foo"], pin }), "path-conflict");
  assert.equal(git(dev, "rev-parse", "HEAD"), conflicted);
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");

  // --reconcile merges and leaves the conflict for the operator (exit 2).
  const run = promoteCli(dev, ["--path", "uifn/foo", "--pin", pin, "--reconcile"]);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stdout, /Merge conflicts left for you[^\n]*\n {2}uifn\/foo\/bar\.js/);
  assert.equal(git(dev, "branch", "--show-current"), "promote/uifn/foo");
  assert.equal(git(dev, "diff", "--name-only", "--diff-filter=U"), "uifn/foo/bar.js");
});

historyTest("paths outside the public manifest, missing paths and an unknown pin are refused", () => {
  const { dev, pin } = fixture("invalid");
  throwsCode(() => promote({ root: dev, paths: ["gadgetfn/core"], pin }), "unownable-path");
  throwsCode(() => promote({ root: dev, paths: ["nothere"], pin }), "path-missing");
  throwsCode(() => promote({ root: dev, paths: ["uifn/foo"], pin: "0".repeat(40) }), "pin-missing");
  throwsCode(() => promote({ root: dev, fn: "widgetfn", pin: "refs/remotes/next/missing" }), "pin-missing");
  throwsCode(() => promote({ root: dev, fn: "widgetfn", pin: "--upload-pack=x" }), "usage");
  throwsCode(() => promote({ root: dev, fn: "widgetfn", source: "--upload-pack=x" }), "usage");
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");
});

historyTest("two imported release entries sharing a slug or npm name, or a Python canonical name, are refused before the branch", () => {
  const { dev, next } = fixture("batch");
  const head = git(dev, "rev-parse", "HEAD");
  const overlays = [
    {
      "release-packages.next.json": [
        { slug: "widgetfn-core", path: "widgetfn/core", name: "@widgetfn/core" },
        { slug: "widgetfn-core", path: "widgetfn/python", name: "@widgetfn/other" },
      ],
    },
    {
      "release-packages.next.json": [
        { slug: "widgetfn-core", path: "widgetfn/core", name: "@widgetfn/core" },
        { slug: "widgetfn-other", path: "widgetfn/python", name: "@widgetfn/core" },
      ],
    },
    {
      "release-packages.next.json": [],
      "python-release-packages.next.json": [
        { name: "widgetfn", path: "widgetfn/python" },
        { name: "WidgetFn", path: "widgetfn/core" },
      ],
    },
  ];
  for (const files of overlays) {
    const pin = commit(next, "bad overlay", files);
    throwsCode(() => promote({ root: dev, fn: "widgetfn", pin, source: next }), "release-conflict");
    assert.equal(git(dev, "rev-parse", "HEAD"), head);
    assert.equal(git(dev, "branch", "--list", "promote/*"), "");
  }
});

historyTest("a relative --source is resolved against the caller's working directory", () => {
  const { dev, next, pin } = fixture("relative");
  const run = promoteCli(dev, ["--path", "uifn/foo", "--pin", pin, "--source", "next"], { cwd: path.dirname(next) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(git(dev, "rev-parse", "HEAD:uifn/foo"), git(next, "rev-parse", `${pin}:uifn/foo`));
});

historyTest("malformed files here or at the pin fail with one promote: line, not a stack trace", () => {
  const { dev, next } = fixture("malformed");
  const pin = commit(next, "broken pyproject", { "widgetfn/python/pyproject.toml": "[project\nname = \n" });
  throwsCode(() => promote({ root: dev, fn: "widgetfn", pin, source: next }), "malformed-file");

  const head = commit(dev, "broken release list", { "release-packages.json": "[\n  { \"slug\": \n" });
  git(dev, "update-ref", "refs/remotes/origin/dev", head);
  const run = promoteCli(dev, ["widgetfn"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^promote: malformed-file: release-packages\.json: invalid JSON: [^\n]*\n$/);
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");
});

historyTest("imported Python projects colliding with each other or with a project here at another path are refused before the branch", () => {
  const { dev, next } = fixture("python-identity");
  const project = '[project]\nname = "alphafn"\nversion = "0.0.1"\n';
  commit(next, "alphafn python on next", { "alphafn/python/pyproject.toml": project });
  const head = commit(dev, "alphafn python on dev", { "alphafn/python/pyproject.toml": project });
  git(dev, "update-ref", "refs/remotes/origin/dev", head);
  const pins = [
    // Two spellings of one name among the imported pyproject.toml files, with no overlay entry for either.
    commit(next, "duplicate widget project", { "python-release-packages.next.json": [], "widgetfn/py2/pyproject.toml": '[project]\nname = "WidgetFn"\n' }),
    // An imported project named like the public alphafn project this checkout holds in alphafn/python.
    commit(next, "widget copy of alphafn", { "widgetfn/py2/pyproject.toml": '[project]\nname = "AlphaFN"\n' }),
  ];
  for (const pin of pins) {
    throwsCode(() => promote({ root: dev, fn: "widgetfn", pin, source: next }), "release-conflict");
    assert.equal(git(dev, "rev-parse", "HEAD"), head);
    assert.equal(git(dev, "branch", "--list", "promote/*"), "");
    assert.equal(git(dev, "status", "--porcelain"), "");
  }
  // The same project in the same directory is the same identity, so promotion goes ahead.
  const pin = commit(next, "drop the copy", { "widgetfn/py2/pyproject.toml": '[project]\nname = "widget-two"\n' });
  const result = promote({ root: dev, paths: ["alphafn/python", "widgetfn"], pin, source: next });
  assert.deepEqual(result.changed.python, ["widget-two", "widgetfn"]);
  assert.equal(git(dev, "rev-parse", "HEAD:alphafn/python"), git(next, "rev-parse", `${pin}:alphafn/python`));
});

historyTest("a project under a non-ASCII path is found and made public", () => {
  const { dev, next } = fixture("unicode");
  const pin = commit(next, "naive widget", { "widgetfn/naïve/pyproject.toml": '[project]\nname = "naive-widget"\n' });
  const result = promote({ root: dev, fn: "widgetfn", pin, source: next });
  assert.ok(result.files.includes("widgetfn/naïve/pyproject.toml"), result.files.join(", "));
  assert.equal(JSON.parse(git(dev, "show", "HEAD:superfunctions.owners.json")).python["naive-widget"], "public");
});

historyTest("a single file with the same bytes but another mode is a conflicting path", () => {
  const { dev, next } = fixture("mode");
  const script = "#!/bin/sh\necho run\n";
  const head = commit(dev, "run.sh on dev", { "uifn/run.sh": script });
  git(dev, "update-ref", "refs/remotes/origin/dev", head);
  write(next, { "uifn/run.sh": script });
  git(next, "add", "uifn/run.sh");
  git(next, "update-index", "--chmod=+x", "uifn/run.sh");
  git(next, "commit", "-q", "-m", "executable run.sh");
  const pin = git(next, "rev-parse", "HEAD");
  assert.equal(git(dev, "rev-parse", "HEAD:uifn/run.sh"), git(next, "rev-parse", `${pin}:uifn/run.sh`), "same blob");
  throwsCode(() => promote({ root: dev, paths: ["uifn/run.sh"], pin, source: next }), "path-conflict");
  assert.equal(git(dev, "rev-parse", "HEAD"), head);
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");
});

historyTest("another repository as --source needs an explicit --pin", () => {
  const { dev, next } = fixture("source-pin");
  throwsCode(() => promote({ root: dev, fn: "widgetfn", source: next }), "usage");
  const run = promoteCli(dev, ["widgetfn", "--source", next]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^promote: usage: --source .* needs --pin <next-sha>/);
  // This checkout as --source keeps the next/next default.
  assert.equal(promote({ root: dev, fn: "widgetfn", source: dev }).branch, "promote/widgetfn");
});

historyTest("a failure after the merge restores the original branch and removes the new one", () => {
  const { dev } = fixture("rollback");
  const head = git(dev, "rev-parse", "HEAD");
  const hooks = path.join(dev, ".git", "failing-hooks");
  write(hooks, { "pre-commit": "#!/bin/sh\nexit 1\n" });
  chmodSync(path.join(hooks, "pre-commit"), 0o755);
  git(dev, "config", "core.hooksPath", hooks);
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "git-failed");
  assert.equal(git(dev, "branch", "--show-current"), "dev");
  assert.equal(git(dev, "rev-parse", "HEAD"), head);
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");
  assert.equal(git(dev, "status", "--porcelain", "--untracked-files=all"), "");
});

test("a missing git-filter-repo fails with an install hint", () => {
  const empty = mkdtempSync(path.join(scratch, "path-"));
  const run = spawnSync(process.execPath, [SCRIPT, "widgetfn", "--root", scratch], {
    encoding: "utf8",
    env: { ...process.env, PATH: empty, GIT_BINARY: gitBinary() },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /missing-filter-repo: git-filter-repo is required: install it with `python3 -m pip install git-filter-repo`/);
});

test("arguments: a function or --path entries, and --path needs a pin", () => {
  assert.deepEqual(parseArgs(["widgetfn"]), { paths: [], reconcile: false, fn: "widgetfn" });
  assert.deepEqual(parseArgs(["--path", "a/b", "--path", "c", "--pin", "abc", "--reconcile"]), {
    paths: ["a/b", "c"],
    reconcile: true,
    pin: "abc",
  });
  for (const argv of [["--path", "a"], ["fn", "--path", "a", "--pin", "x"], ["a/b"], ["a", "b"], ["--pin"], ["--pin", "x", "--pin", "y", "a"], ["--bogus"]]) {
    throwsCode(() => parseArgs(argv), "usage");
  }
});

test("paths: protected files, .conduct and paths leaving the repository are refused; nested paths collapse", () => {
  assert.deepEqual(normalizePaths(["docs/", "docs/a", "./uifn/x", "uifn/x"]), ["docs", "uifn/x"]);
  for (const target of ["release-packages.json", "superfunctions.owners.next.json", "scripts", "scripts/python_release.py", "package-lock.json"]) {
    throwsCode(() => normalizePaths([target]), "protected-path");
  }
  throwsCode(() => normalizePaths(["widgetfn/.conduct"]), "conduct-path");
  throwsCode(() => normalizePaths(["../x"]), "usage");
  throwsCode(() => normalizePaths([]), "usage");
});

test("release moves: overlay first, identical entries skipped, conflicting slugs and names refused", () => {
  const current = [{ slug: "alphafn-core", path: "alphafn/core", name: "@alphafn/core" }];
  const overlay = [
    { slug: "widgetfn-core", path: "widgetfn/core", name: "@widgetfn/core" },
    { slug: "gadgetfn-core", path: "gadgetfn/core", name: "@gadgetfn/core" },
  ];
  assert.deepEqual(releaseMoves({ pinOverlay: overlay, pinBase: [], current, paths: ["widgetfn"] }), [
    { ...overlay[0], source: "release-packages.next.json" },
  ]);
  // A pin from before the overlay: next's release-packages.json, minus what dev already lists.
  const base = [...current, overlay[0]];
  assert.deepEqual(releaseMoves({ pinOverlay: null, pinBase: base, current, paths: ["alphafn", "widgetfn"] }), [
    { ...overlay[0], source: "release-packages.json" },
  ]);
  throwsCode(() => releaseMoves({ pinOverlay: [{ slug: "alphafn-core", path: "widgetfn/x", name: "@widgetfn/x" }], pinBase: [], current, paths: ["widgetfn"] }), "release-conflict");
  throwsCode(() => releaseMoves({ pinOverlay: [{ slug: "widgetfn-x", path: "widgetfn/x", name: "@alphafn/core" }], pinBase: [], current, paths: ["widgetfn"] }), "release-conflict");
  // Two imported entries colliding with each other (next's overlay is not validated before the first sync).
  const pair = (a, b) => [
    { slug: "widgetfn-a", path: "widgetfn/a", name: "@widgetfn/a", ...a },
    { slug: "widgetfn-b", path: "widgetfn/b", name: "@widgetfn/b", ...b },
  ];
  throwsCode(() => releaseMoves({ pinOverlay: pair({}, { slug: "widgetfn-a" }), pinBase: [], current, paths: ["widgetfn"] }), "release-conflict");
  throwsCode(() => releaseMoves({ pinOverlay: pair({}, { name: "@widgetfn/a" }), pinBase: [], current, paths: ["widgetfn"] }), "release-conflict");
  throwsCode(() => releaseMoves({ pinOverlay: null, pinBase: pair({}, { name: "@widgetfn/a" }), current, paths: ["widgetfn"] }), "release-conflict");
  assert.equal(releaseMoves({ pinOverlay: pair({}, {}), pinBase: [], current, paths: ["widgetfn"] }).length, 2);
});

test("Python identities: overlay entries and imported pyproject.toml files, unique by canonical name and matching this checkout", () => {
  const targets = new Map([["Alpha_FN", "alphafn/python"]]);
  const paths = ["alphafn"];
  assert.deepEqual(pythonMoves({ overlay: [{ name: "alpha-fn", path: "alphafn/python" }, { name: "beta", path: "alphafn/beta/" }], paths, targets }), {
    names: ["alpha-fn", "beta"],
    moves: [{ name: "beta", path: "alphafn/beta/" }],
  });
  // An overlay entry and its own pyproject.toml are one project; this checkout may hold it in the same directory.
  const discovered = [{ name: "Beta", file: "alphafn/beta/pyproject.toml" }, { name: "gamma", file: "alphafn/gamma/pyproject.toml" }];
  const existing = [{ name: "beta", file: "alphafn/beta/pyproject.toml" }, { name: "delta", file: "deltafn/pyproject.toml" }];
  assert.deepEqual(pythonMoves({ overlay: [{ name: "beta", path: "alphafn/beta" }], paths, targets, discovered, existing }), {
    names: ["Beta", "gamma"],
    moves: [{ name: "beta", path: "alphafn/beta" }],
  });
  const refused = [
    { overlay: [{ name: "alpha.fn", path: "alphafn/other" }] },
    { overlay: [{ name: "beta", path: "alphafn/b1" }, { name: "Beta", path: "alphafn/b2" }] },
    { overlay: [{ name: "beta", path: "alphafn/b1" }, { name: "Beta", path: "alphafn/b1" }] },
    { discovered: [{ name: "new-pkg", file: "alphafn/a/pyproject.toml" }, { name: "New_Pkg", file: "alphafn/b/pyproject.toml" }] },
    { discovered: [{ name: "beta", file: "alphafn/a/pyproject.toml" }], overlay: [{ name: "beta", path: "alphafn/b" }] },
    { discovered: [{ name: "Delta", file: "alphafn/delta/pyproject.toml" }], existing },
    { discovered: [{ name: "alpha_fn", file: "alphafn/py/pyproject.toml" }] },
  ];
  for (const input of refused) throwsCode(() => pythonMoves({ paths, targets, ...input }), "release-conflict");
});

test("sources: local paths resolve against the caller's directory, URLs stay, a leading dash is refused", () => {
  assert.equal(resolveSource("next", "/work"), path.resolve("/work", "next"));
  assert.equal(resolveSource("../next", "/work/dev"), path.resolve("/work/next"));
  for (const url of ["https://github.com/o/r.git", "ssh://git@host/r", "git@github.com:o/r.git", "file:///tmp/r"]) assert.equal(resolveSource(url, "/work"), url);
  throwsCode(() => resolveSource("--upload-pack=x", "/work"), "usage");
});

test("release file and manifest edits keep existing formatting and order", () => {
  const appended = appendReleaseEntries(RELEASES_TEXT, [{ slug: "w", path: "w/core", name: "@w/core" }]);
  assert.equal(appended, `${RELEASES_TEXT.slice(0, -3)},\n  { "slug": "w", "path": "w/core", "name": "@w/core" }\n]\n`);
  assert.equal(appendReleaseEntries("[]\n", [{ slug: "w", path: "w", name: "w" }]), `[\n  { "slug": "w", "path": "w", "name": "w" }\n]\n`);

  const manifest = publicManifest();
  const changed = flipManifest(manifest, { topLevel: ["docs", "alphafn"], rootFiles: ["NOTES.md"], slugs: ["docs-site"], pythonNames: ["Alpha_FN", "beta"] });
  assert.deepEqual(changed, { paths: ["docs"], rootFiles: ["NOTES.md"], releases: ["docs-site"], python: ["Alpha_FN", "beta"] });
  assert.deepEqual(Object.keys(manifest.paths), ["alphafn", "docs", "scripts", "uifn"]);
  assert.deepEqual(manifest.rootFiles.public, ["NOTES.md", "release-packages.json", "superfunctions.owners.json"]);
  // A project already listed under another spelling of the same canonical name is not added twice.
  const again = flipManifest(manifest, { topLevel: [], rootFiles: [], slugs: [], pythonNames: ["alpha-fn", "BETA"] });
  assert.deepEqual(again.python, []);
});
