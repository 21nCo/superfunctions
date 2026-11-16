// SFNS-127: scripts/promote.mjs against temporary git repositories. The history tests need git-filter-repo; they
// skip without it unless PROMOTE_REQUIRE_FILTER_REPO=1 (set in CI, where the job installs it), which makes them fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  releaseMoves,
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

function promoteCli(dev, args, env = process.env) {
  return spawnSync(process.execPath, [SCRIPT, "--root", dev, ...args], { encoding: "utf8", env });
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
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");
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
