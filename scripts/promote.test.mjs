// SFNS-127: scripts/promote.mjs against temporary git repositories. The history tests need git-filter-repo; they
// skip without it unless PROMOTE_REQUIRE_FILTER_REPO=1 (set in CI, where the job installs it), which makes them fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FILTER_REPO_HINT,
  PromoteError,
  appendReleaseEntries,
  classifyBlob,
  flipManifest,
  hasFilterRepo,
  normalizePaths,
  parseArgs,
  promote,
  pythonMoves,
  releaseMoves,
  resolveSource,
} from "./promote.mjs";
import { createOwners, parseManifest } from "./owners.mjs";
import { gitBinary } from "./verify-package-lockfiles.mjs";
import { findOwnershipErrors } from "./verify-owners.mjs";

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
    writeFileSync(path.join(root, file), typeof content === "string" || Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`);
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

/** Runs `fn` with `env` merged into process.env, then restores each name, deleting those that were unset. */
function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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

  // --reconcile merges in a worktree it keeps and prints, and leaves the conflict there for the operator (exit 2).
  const run = promoteCli(dev, ["--path", "uifn/foo", "--pin", pin, "--reconcile"]);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stdout, /Merge conflicts left for you[^\n]*\n {2}uifn\/foo\/bar\.js/);
  const worktree = /in the worktree (.+) on promote\/uifn\/foo;/.exec(run.stdout)[1];
  assert.equal(git(dev, "branch", "--show-current"), "dev", "this checkout is not written");
  assert.equal(git(dev, "status", "--porcelain"), "");
  assert.equal(git(worktree, "branch", "--show-current"), "promote/uifn/foo");
  assert.equal(git(worktree, "diff", "--name-only", "--diff-filter=U"), "uifn/foo/bar.js");
  assert.equal(git(worktree, "rev-parse", "HEAD"), conflicted);
  const mergeHead = git(worktree, "rev-parse", "MERGE_HEAD");
  assert.equal(git(worktree, "log", "-1", "--format=%s", mergeHead), "SFN-12 widget python");
  assert.match(readFileSync(path.join(worktree, "uifn/foo/bar.js"), "utf8"), /^<<<<<<< /m);
  write(worktree, { "uifn/foo/bar.js": "export const bar = 'merged';\n" });
  git(worktree, "add", "uifn/foo/bar.js");
  git(worktree, "commit", "-q", "--no-edit");
  assert.deepEqual(git(dev, "rev-list", "--parents", "-1", "promote/uifn/foo").split(" ").slice(1), [conflicted, mergeHead]);
  git(dev, "worktree", "remove", worktree);
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
    // An overlay entry naming another project than the pyproject.toml in its directory.
    commit(next, "overlay names another project", {
      "widgetfn/py2/pyproject.toml": '[project]\nname = "widget-two"\n',
      "python-release-packages.next.json": [{ name: "other-widget", path: "widgetfn/python" }],
    }),
    // Two overlay entries for one imported project.
    commit(next, "overlay lists widgetfn twice", {
      "python-release-packages.next.json": [{ name: "widgetfn", path: "widgetfn/python" }, { name: "WidgetFN", path: "widgetfn/python/" }],
    }),
  ];
  for (const pin of pins) {
    throwsCode(() => promote({ root: dev, fn: "widgetfn", pin, source: next }), "release-conflict");
    assert.equal(git(dev, "rev-parse", "HEAD"), head);
    assert.equal(git(dev, "branch", "--list", "promote/*"), "");
    assert.equal(git(dev, "status", "--porcelain"), "");
  }
  // The same project in the same directory is the same identity, so promotion goes ahead.
  const pin = commit(next, "fix the overlay", { "python-release-packages.next.json": [{ name: "widgetfn", path: "widgetfn/python" }] });
  const result = promote({ root: dev, paths: ["alphafn/python", "widgetfn"], pin, source: next });
  assert.deepEqual(result.changed.python, ["widget-two", "widgetfn"]);
  assert.equal(git(dev, "rev-parse", "HEAD:alphafn/python"), git(next, "rev-parse", `${pin}:alphafn/python`));
});

historyTest("entries this checkout already lists are skipped but still listed for next's clean-up", () => {
  const { dev } = fixture("already-listed");
  const manifest = publicManifest();
  manifest.releases["widgetfn-core"] = "public";
  manifest.python.widgetfn = "public";
  const head = commit(dev, "widgetfn releases already listed", {
    "superfunctions.owners.json": manifest,
    "release-packages.json": appendReleaseEntries(RELEASES_TEXT, [{ slug: "widgetfn-core", path: "widgetfn/core", name: "@widgetfn/core" }]),
    "scripts/python_release.py": PYTHON_RELEASE.replace('}\n\nOTHER', '    "widgetfn": "widgetfn/python",\n}\n\nOTHER'),
  });
  git(dev, "update-ref", "refs/remotes/origin/dev", head);
  const result = promote({ root: dev, fn: "widgetfn" });
  assert.deepEqual([result.releases, result.python, result.changed.releases, result.changed.python], [[], [], [], []]);
  assert.deepEqual(result.nextCleanup, {
    manifest: ["paths.widgetfn", "releases.widgetfn-core", "python.widgetfn"],
    overlay: ["widgetfn-core"],
    pythonOverlay: ["widgetfn"],
  });
  for (const file of ["release-packages.json", "scripts/python_release.py"]) assert.equal(git(dev, "show", `HEAD:${file}`), git(dev, "show", `${head}:${file}`));
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

historyTest("an untracked or ignored file where next tracks a path is refused before the branch and keeps its content", () => {
  const { dev, pin } = fixture("ignored");
  const head = git(dev, "rev-parse", "HEAD");
  write(dev, { ".git/info/exclude": "widgetfn/core/src/index.js\nwidgetfn/python\nnode_modules/\n" });
  write(dev, { "widgetfn/core/src/index.js": "local only\n", "widgetfn/core/node_modules/dep.js": "dep\n" });
  const unchanged = () => {
    assert.equal(git(dev, "rev-parse", "HEAD"), head);
    assert.equal(git(dev, "branch", "--show-current"), "dev");
    assert.equal(git(dev, "branch", "--list", "promote/*"), "");
  };

  // An ignored file at the path of an imported file.
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "path-conflict");
  assert.equal(readFileSync(path.join(dev, "widgetfn/core/src/index.js"), "utf8"), "local only\n");
  unchanged();

  // An ignored file where next has a directory (widgetfn/python/pyproject.toml).
  rmSync(path.join(dev, "widgetfn/core/src/index.js"));
  write(dev, { "widgetfn/python": "local only\n" });
  const run = promoteCli(dev, ["widgetfn"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^promote: path-conflict: widgetfn\/python exists here as an untracked or ignored file/);
  assert.equal(readFileSync(path.join(dev, "widgetfn/python"), "utf8"), "local only\n");
  unchanged();

  // An ignored file above a selected sub-path, where next has a directory.
  rmSync(path.join(dev, "widgetfn/python"));
  write(dev, { ".git/info/exclude": "widgetfn/core/src/index.js\nnode_modules/\nuifn/foo\n", "uifn/foo": "local only\n" });
  throwsCode(() => promote({ root: dev, paths: ["uifn/foo/bar.js"], pin }), "path-conflict");
  assert.equal(readFileSync(path.join(dev, "uifn/foo"), "utf8"), "local only\n");
  unchanged();
  rmSync(path.join(dev, "uifn/foo"));

  // Ignored files no imported path needs stay as they are through a successful promotion.
  promote({ root: dev, fn: "widgetfn" });
  assert.equal(git(dev, "branch", "--show-current"), "promote/widgetfn");
  assert.equal(readFileSync(path.join(dev, "widgetfn/core/node_modules/dep.js"), "utf8"), "dep\n");
});

/** An ignored nested repository at `dir` (git lists it as one opaque `dir/` entry) holding `file`. */
function nestedRepository(root, dir, file) {
  write(root, { [path.join(dir, file)]: "nested only\n" });
  git(path.join(root, dir), "init", "-q");
}

/** A fixture with a rejecting pre-commit hook available, and a check that nothing in it changed. */
function nestedFixture(name) {
  const { dev, pin } = fixture(name);
  const head = git(dev, "rev-parse", "HEAD");
  const hooks = path.join(dev, ".git", "failing-hooks");
  write(hooks, { "pre-commit": "#!/bin/sh\nexit 1\n" });
  chmodSync(path.join(hooks, "pre-commit"), 0o755);
  write(dev, { ".git/info/exclude": "widgetfn/core/src/\nwidgetfn/cache/\nuifn/foo/\n" });
  const unchanged = () => {
    assert.equal(git(dev, "rev-parse", "HEAD"), head);
    assert.equal(git(dev, "branch", "--show-current"), "dev");
    assert.equal(git(dev, "branch", "--list", "promote/*"), "");
    assert.equal(git(dev, "status", "--porcelain"), "");
  };
  return { dev, pin, hooks, unchanged };
}

historyTest("an ignored nested repository holding a file next tracks is refused before the branch, with or without a failing hook", () => {
  const { dev, hooks, unchanged } = nestedFixture("nested-file");
  nestedRepository(dev, "widgetfn/core/src", "index.js");
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "path-conflict");
  unchanged();
  git(dev, "config", "core.hooksPath", hooks);
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "path-conflict");
  unchanged();
  assert.equal(readFileSync(path.join(dev, "widgetfn/core/src/index.js"), "utf8"), "nested only\n");
});

historyTest("an ignored nested repository above a selected sub-path is refused before the branch", () => {
  const { dev, pin, unchanged } = nestedFixture("nested-above");
  nestedRepository(dev, "uifn/foo", "bar.js");
  throwsCode(() => promote({ root: dev, paths: ["uifn/foo/bar.js"], pin }), "path-conflict");
  assert.equal(readFileSync(path.join(dev, "uifn/foo/bar.js"), "utf8"), "nested only\n");
  unchanged();
});

historyTest("an ignored nested repository next writes nothing into survives a rolled-back and a successful promotion", () => {
  const { dev, hooks, unchanged } = nestedFixture("nested-untouched");
  nestedRepository(dev, "widgetfn/cache", "file.txt");
  git(dev, "config", "core.hooksPath", hooks);
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "git-failed");
  unchanged();
  assert.equal(readFileSync(path.join(dev, "widgetfn/cache/file.txt"), "utf8"), "nested only\n", "survives the undo");
  git(dev, "config", "--unset", "core.hooksPath");
  promote({ root: dev, fn: "widgetfn" });
  assert.equal(git(dev, "branch", "--show-current"), "promote/widgetfn");
  assert.equal(readFileSync(path.join(dev, "widgetfn/cache/file.txt"), "utf8"), "nested only\n");
});

historyTest("a failure after the merge restores the original branch and removes the new one", () => {
  const { dev } = fixture("rollback");
  const head = git(dev, "rev-parse", "HEAD");
  write(dev, { ".git/info/exclude": "node_modules/\n", "widgetfn/core/node_modules/dep.js": "dep\n" });
  const hooks = path.join(dev, ".git", "failing-hooks");
  write(hooks, { "pre-commit": "#!/bin/sh\nexit 1\n" });
  chmodSync(path.join(hooks, "pre-commit"), 0o755);
  git(dev, "config", "core.hooksPath", hooks);
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "git-failed");
  assert.equal(git(dev, "branch", "--show-current"), "dev");
  assert.equal(git(dev, "rev-parse", "HEAD"), head);
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");
  assert.equal(git(dev, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(readFileSync(path.join(dev, "widgetfn/core/node_modules/dep.js"), "utf8"), "dep\n", "ignored files survive the undo");
});

/** Installs one hook script in a fresh hooks directory of `dev` and points core.hooksPath at it. */
function useHook(dev, name, script) {
  const hooks = path.join(dev, ".git", `hooks-${name}`);
  write(hooks, { [name]: `#!/bin/sh\n${script}\n` });
  chmodSync(path.join(hooks, name), 0o755);
  git(dev, "config", "core.hooksPath", hooks);
}

/** Environment whose git-filter-repo runs `before` and `after` shell code around each real run (not --version). */
function wrapFilterRepo(name, { before = ":", after = ":" }) {
  const real = spawnSync("sh", ["-c", "command -v git-filter-repo"], { encoding: "utf8" }).stdout.trim();
  const bin = path.join(scratch, `${name}-bin`);
  const script = `[ "$1" = "--version" ] && exec '${real}' "$@"\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\n${before}\n'${real}' "$@" || exit $?\n${after}`;
  write(bin, { "git-filter-repo": `#!/bin/sh\n${script}\n` });
  chmodSync(path.join(bin, "git-filter-repo"), 0o755);
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

/** Environment whose git-filter-repo writes `content` to `file` while promote filters the history (after its preflight). */
const lateFilterRepo = (name, file, content) => wrapFilterRepo(name, { before: `mkdir -p '${path.dirname(file)}'; printf '${content}\\n' > '${file}'` });

historyTest("an ignored file created after the preflight is not overwritten, and a retry after moving it succeeds", () => {
  const { dev } = fixture("late-ignored");
  const head = git(dev, "rev-parse", "HEAD");
  write(dev, { ".git/info/exclude": "widgetfn/core/src/index.js\n" });
  const late = path.join(dev, "widgetfn/core/src/index.js");
  const run = promoteCli(dev, ["widgetfn"], { env: lateFilterRepo("late-ignored", late, "late local") });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /^promote: path-conflict: widgetfn\/core\/src\/index\.js exists here as an untracked or ignored file/);
  assert.equal(readFileSync(late, "utf8"), "late local\n");
  assert.equal(git(dev, "rev-parse", "HEAD"), head);
  assert.equal(git(dev, "branch", "--show-current"), "dev");
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");
  assert.equal(git(dev, "status", "--porcelain"), "");

  rmSync(path.join(dev, "widgetfn"), { recursive: true });
  promote({ root: dev, fn: "widgetfn" });
  assert.equal(git(dev, "branch", "--show-current"), "promote/widgetfn");
});

historyTest("a conflicting --reconcile merge stays in a kept worktree with the edits staged; this checkout is not written", () => {
  const { dev } = fixture("late-reconcile");
  const head = commit(dev, "dev has its own widgetfn entry", { "widgetfn/core/src/index.js": "export const widget = 'dev';\n" });
  git(dev, "update-ref", "refs/remotes/origin/dev", head);
  write(dev, { ".git/info/exclude": "widgetfn/core/package.json\n" });
  useHook(dev, "pre-commit", "exit 1");
  const late = path.join(dev, "widgetfn/core/package.json");
  const run = promoteCli(dev, ["widgetfn", "--reconcile"], { env: lateFilterRepo("late-reconcile", late, "late local") });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(readFileSync(late, "utf8"), "late local\n");
  assert.equal(git(dev, "rev-parse", "HEAD"), head);
  assert.equal(git(dev, "branch", "--show-current"), "dev");
  assert.equal(git(dev, "status", "--porcelain"), "");
  assert.equal(spawnSync(gitBinary(), ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: dev }).status, 1);
  const worktree = /in the worktree (.+) on promote\/widgetfn;/.exec(run.stdout)[1];
  assert.equal(git(worktree, "diff", "--name-only", "--diff-filter=U"), "widgetfn/core/src/index.js");
  const staged = git(worktree, "diff", "--cached", "--name-only").split("\n");
  for (const file of ["superfunctions.owners.json", "release-packages.json", "scripts/python_release.py"]) assert.ok(staged.includes(file), file);
  // Plain git commands in the kept worktree work on it, and the operator's commit there runs this checkout's hooks.
  assert.equal(realpathSync(git(worktree, "rev-parse", "--show-toplevel")), realpathSync(worktree));
  write(worktree, { "widgetfn/core/src/index.js": "export const widget = 'merged';\n" });
  git(worktree, "add", "widgetfn/core/src/index.js");
  assert.notEqual(spawnSync(gitBinary(), ["commit", "-q", "--no-edit"], { cwd: worktree }).status, 0, "the rejecting pre-commit hook runs");
  git(dev, "worktree", "remove", "--force", worktree);
});

historyTest("the destination branch's policy (includeIf onbranch:promote/**) refuses the promotion and leaves nothing behind", () => {
  const { dev } = fixture("onbranch-policy");
  const head = git(dev, "rev-parse", "HEAD");
  const unchanged = () => {
    assert.equal(git(dev, "rev-parse", "HEAD"), head);
    assert.equal(git(dev, "branch", "--show-current"), "dev");
    assert.equal(git(dev, "branch", "--list", "promote/*"), "");
    assert.equal(git(dev, "status", "--porcelain"), "");
    assert.equal(git(dev, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1, "no scratch worktree is left");
  };
  const hooks = path.join(dev, ".git", "promote-hooks");
  write(hooks, { "pre-merge-commit": "#!/bin/sh\nexit 1\n" });
  chmodSync(path.join(hooks, "pre-merge-commit"), 0o755);
  write(dev, { ".git/promote-hooks.conf": `[core]\n\thooksPath = ${hooks}\n` });
  git(dev, "config", "includeIf.onbranch:promote/**.path", "promote-hooks.conf");
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "git-failed");
  unchanged();
  git(dev, "config", "--unset", "includeIf.onbranch:promote/**.path");
  git(dev, "config", "merge.verifySignatures", "false");
  write(dev, { ".git/promote-signed.conf": "[merge]\n\tverifySignatures = true\n" });
  git(dev, "config", "includeIf.onbranch:promote/**.path", "promote-signed.conf");
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "git-failed");
  unchanged();
});

historyTest("configuration git would apply differently in the scratch worktree is refused as checkout-policy, never emulated", () => {
  const { dev } = fixture("checkout-policy");
  const head = git(dev, "rev-parse", "HEAD");
  const config = path.join(dev, ".git", "config");
  const baseline = readFileSync(config, "utf8");
  const gitdir = realpathSync(path.join(dev, ".git"));
  const planted = path.join(scratch, "checkout-policy-planted");
  write(dev, { ".git/signed.conf": "[merge]\n\tverifySignatures = true\n" });
  const refused = (what, setup, env = {}) => {
    writeFileSync(config, baseline);
    rmSync(path.join(dev, ".git", "config.worktree"), { force: true });
    setup();
    withEnv(env, () => assert.throws(() => promote({ root: dev, fn: "widgetfn" }), (error) => error.code === "checkout-policy", what));
    assert.equal(git(dev, "rev-parse", "HEAD"), head, what);
    assert.equal(git(dev, "branch", "--list", "promote/*"), "", what);
    assert.equal(git(dev, "status", "--porcelain"), "", what);
    assert.equal(git(dev, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1, what);
  };
  // Relative hooks directories name another directory in a linked worktree; a hook planted there never runs.
  const tmp = path.join(scratch, "checkout-policy-tmp");
  write(tmp, { "hooks/post-checkout": `#!/bin/sh\ntouch '${planted}'\n`, "hooks/pre-merge-commit": `#!/bin/sh\ntouch '${planted}'\n` });
  chmodSync(path.join(tmp, "hooks/post-checkout"), 0o755);
  chmodSync(path.join(tmp, "hooks/pre-merge-commit"), 0o755);
  for (const hooksPath of [".git/hooks", "../../hooks", "local-hooks"]) {
    refused(`core.hooksPath ${hooksPath}`, () => git(dev, "config", "core.hooksPath", hooksPath), { TMPDIR: tmp });
  }
  assert.equal(spawnSync("test", ["-e", planted]).status, 1, "the planted hook never ran");
  // ... also when only the promotion branch's onbranch configuration sets one.
  write(dev, { ".git/promote-hooks.conf": "[core]\n\thooksPath = ../../hooks\n" });
  refused("onbranch:promote/** relative hooksPath", () => git(dev, "config", "includeIf.onbranch:promote/**.path", "promote-hooks.conf"), { TMPDIR: tmp });
  assert.equal(spawnSync("test", ["-e", planted]).status, 1, "the planted hook never ran");
  // Other relative commands git runs from the work tree (here core.fsmonitor) never reach the shared tmpdir either.
  writeFileSync(config, baseline);
  write(tmp, { fsmon: `#!/bin/sh\ntouch '${planted}'\n` });
  chmodSync(path.join(tmp, "fsmon"), 0o755);
  git(dev, "config", "core.fsmonitor", "../../fsmon");
  withEnv({ TMPDIR: tmp }, () => {
    try {
      promote({ root: dev, fn: "widgetfn" });
    } catch {
      // whether git tolerates the missing monitor does not matter here
    }
  });
  assert.equal(spawnSync("test", ["-e", planted]).status, 1, "the planted fsmonitor never ran");
  git(dev, "switch", "-q", "dev");
  spawnSync(gitBinary(), ["branch", "-q", "-D", "promote/widgetfn"], { cwd: dev });
  refused("core.worktree", () => git(dev, "config", "core.worktree", dev));
  refused("a gitdir include nested in the promotion branch's configuration", () => {
    write(dev, { ".git/promotion.conf": `[includeIf "gitdir:${gitdir}"]\n\tpath = signed.conf\n` });
    git(dev, "config", "includeIf.onbranch:promote/**.path", "promotion.conf");
  });
  refused("a gpg program climbing out of the work tree", () => {
    git(dev, "config", "gpg.program", `${"../".repeat(8)}signer`);
    git(dev, "config", "commit.gpgSign", "true");
  });
  refused("a merge driver climbing out on the promotion branch only", () => {
    write(dev, { ".git/promote-driver.conf": "[merge \"x\"]\n\tdriver = ../../../driver %O %A %B\n" });
    git(dev, "config", "includeIf.onbranch:promote/**.path", "promote-driver.conf");
  });
  refused("config.worktree", () => {
    git(dev, "config", "extensions.worktreeConfig", "true");
    git(dev, "config", "--worktree", "merge.verifySignatures", "true");
  });
  refused("gitdir include for this checkout only", () => git(dev, "config", `includeIf.gitdir:${gitdir}.path`, "signed.conf"));
  refused("gitdir include through ~/", () => git(dev, "config", "includeIf.gitdir:~/dev/.git.path", "signed.conf"), { HOME: realpathSync(path.dirname(dev)) });
  refused("gitdir include for linked worktrees only", () => git(dev, "config", "includeIf.gitdir:**/worktrees/**.path", "signed.conf"));
  refused("onbranch include for the current branch", () => git(dev, "config", "includeIf.onbranch:dev.path", "signed.conf"));
  refused("a file included everywhere and again only here", () =>
    writeFileSync(config, `${baseline}[include]\n\tpath = signed.conf\n[merge]\n\tverifySignatures = false\n[includeIf "gitdir:${gitdir}"]\n\tpath = signed.conf\n`));
  // A global configuration reached through a symlink (git resolves its relative include beside the link), with a
  // nested include for this checkout only.
  const linked = path.join(scratch, "checkout-policy", "gitconfig");
  write(scratch, { "checkout-policy/dotfiles/gitconfig": "[include]\n\tpath = nested.inc\n", "checkout-policy/nested.inc": `[includeIf "gitdir:${gitdir}"]\n\tpath = ${path.join(gitdir, "signed.conf")}\n` });
  spawnSync("ln", ["-s", path.join(scratch, "checkout-policy/dotfiles/gitconfig"), linked]);
  refused("nested include in a symlinked global config", () => {}, { GIT_CONFIG_GLOBAL: linked });

  // From a detached checkout, as the runbook says, the current-branch include no longer differs and promotion runs.
  writeFileSync(config, baseline);
  git(dev, "config", "includeIf.onbranch:dev.path", "signed.conf");
  git(dev, "switch", "-q", "--detach");
  const result = promote({ root: dev, fn: "widgetfn" });
  assert.equal(git(dev, "branch", "--show-current"), "promote/widgetfn");
  assert.deepEqual(result.history, [], "a text-only history has nothing to inspect");
});

historyTest("a relative GIT_CONFIG_GLOBAL keeps its meaning in every repository promotion runs git in", () => {
  const { dev } = fixture("relative-global");
  const head = git(dev, "rev-parse", "HEAD");
  write(scratch, { "relative-global/home/gitconfig": "[merge]\n\tverifySignatures = true\n" });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join("home", "gitconfig") };
  const run = promoteCli(dev, ["widgetfn"], { env, cwd: path.join(scratch, "relative-global") });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /^promote: git-failed: merge failed/, "the unsigned history is refused by the global policy");
  assert.equal(git(dev, "rev-parse", "HEAD"), head);
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");
});

historyTest("a commit made here while promotion filters is refused, keeping the advanced checkout and its metadata", () => {
  const { dev } = fixture("moved-head");
  const manifest = JSON.parse(readFileSync(path.join(dev, "superfunctions.owners.json"), "utf8"));
  manifest.paths.newfn = "public";
  const staged = path.join(scratch, "moved-head-files");
  write(staged, {
    "superfunctions.owners.json": manifest,
    "python_release.py": PYTHON_RELEASE.replace("}\n\nOTHER", '    "newfn": "newfn/python",\n}\n\nOTHER'),
  });
  const marker = path.join(staged, "done");
  const env = wrapFilterRepo("moved-head", {
    before: `[ -e '${marker}' ] || { touch '${marker}'; cp '${staged}/superfunctions.owners.json' '${dev}/'; cp '${staged}/python_release.py' '${dev}/scripts/'; git -C '${dev}' commit -qam concurrent; }`,
  });
  const run = promoteCli(dev, ["widgetfn"], { env });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /^promote: git-failed: this checkout changed while promotion ran/);
  assert.equal(git(dev, "log", "-1", "--format=%s"), "concurrent");
  assert.equal(git(dev, "branch", "--show-current"), "dev");
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");
  assert.equal(git(dev, "status", "--porcelain"), "");
  assert.equal(git(dev, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
  // A retry plans against the advanced checkout and keeps its additions.
  git(dev, "update-ref", "refs/remotes/origin/dev", "HEAD");
  promote({ root: dev, fn: "widgetfn" });
  const owners = JSON.parse(readFileSync(path.join(dev, "superfunctions.owners.json"), "utf8"));
  assert.equal(owners.paths.newfn, "public");
  assert.equal(owners.paths.widgetfn, "public");
  assert.match(readFileSync(path.join(dev, "scripts/python_release.py"), "utf8"), /"newfn": "newfn\/python"/);
});

historyTest("every non-text or image version in the imported history is listed with its literal paths", () => {
  const { dev, next } = fixture("history-audit");
  const png = (byte) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, byte]);
  const binary = (byte) => Buffer.from([0xff, 0xfe, byte, 0x80]);
  const odd = "widgetfn/assets/tab\tnamé.bin";
  const first = commit(next, "assets", {
    "widgetfn/assets/logo.png": png(1),
    "widgetfn/assets/pic.ppm": "P3\n1 1\n255\n0 0 0\n",
    "widgetfn/assets/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    [odd]: binary(1),
    "widgetfn/assets/icon": '/* XPM */\nstatic char *icon[] = { "1 1 1 1", "a c #000000", "a" };\n',
    "widgetfn/assets/logo.xml": '<s:svg xmlns:s="http://www.w3.org/2000/svg"/>\n',
    "widgetfn/assets/figure.dat": "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 1 1\n",
    "widgetfn/assets/doc": "%PDF-1.4\n1 0 obj << >> endobj\n",
    "widgetfn/assets/ctrl.bin": Buffer.from([1, 2, 3, 4]),
    "widgetfn/assets/notes.md": "![logo](data:image/png;base64,iVBORw0KGgo=)\n",
    "widgetfn/assets/demo.ipynb": '{"cells": [{"outputs": [{"data": {"image/png": "iVBORw0KGgo="}}]}]}\n',
    "widgetfn/assets/drawing.h": "/* diagram */\n#define drawing_width 8\n#define drawing_height 1\nstatic unsigned char drawing_bits[] = { 0x3c };\n",
  });
  git(next, "mv", "widgetfn/assets/logo.png", "widgetfn/assets/brand.png");
  git(next, "rm", "-q", "widgetfn/assets/pic.ppm", "widgetfn/assets/notes.md");
  const second = commit(next, "rename and change the logo, delete the PPM", { "widgetfn/assets/brand.png": png(2) });
  git(next, "switch", "-q", "-c", "side");
  const side = commit(next, "side data", { "widgetfn/data.bin": binary(2) });
  git(next, "switch", "-q", "main");
  const main = commit(next, "main data", { "widgetfn/data.bin": binary(3) });
  spawnSync(gitBinary(), ["merge", "-q", "-m", "merge side", "side"], { cwd: next });
  const pin = commit(next, "resolve to main", { "widgetfn/data.bin": binary(3) });
  const oid = (rev, file) => git(next, "rev-parse", `${rev}:${file}`);
  const expected = [
    { oid: oid(second, "widgetfn/assets/brand.png"), kind: "image", paths: ["widgetfn/assets/brand.png"] },
    { oid: oid(first, "widgetfn/assets/icon.svg"), kind: "image", paths: ["widgetfn/assets/icon.svg"] },
    { oid: oid(first, "widgetfn/assets/logo.png"), kind: "image", paths: ["widgetfn/assets/logo.png"] },
    { oid: oid(first, "widgetfn/assets/pic.ppm"), kind: "image", paths: ["widgetfn/assets/pic.ppm"] },
    ...["icon", "logo.xml", "figure.dat", "doc", "drawing.h", "notes.md", "demo.ipynb"].map((file) => ({ oid: oid(first, `widgetfn/assets/${file}`), kind: "image", paths: [`widgetfn/assets/${file}`] })),
    { oid: oid(first, odd), kind: "binary", paths: [odd] },
    { oid: oid(first, "widgetfn/assets/ctrl.bin"), kind: "binary", paths: ["widgetfn/assets/ctrl.bin"] },
    ...[side, main].map((rev) => ({ oid: oid(rev, "widgetfn/data.bin"), kind: "binary", paths: ["widgetfn/data.bin"] })),
  ].sort((a, b) => (a.paths[0] < b.paths[0] ? -1 : a.paths[0] > b.paths[0] ? 1 : a.oid < b.oid ? -1 : 1));
  const run = promoteCli(dev, ["widgetfn", "--pin", pin, "--source", next]);
  assert.equal(run.status, 0, run.stderr);
  for (const { oid: id, kind, paths } of expected) assert.ok(run.stdout.includes(`  ${id} ${kind} ${paths.map((file) => JSON.stringify(file)).join(" ")}`), `${id}\n${run.stdout}`);
  assert.match(run.stdout, /^Historical non-text and image versions to inspect before the PR .*\(15\):$/m);
  // The same set as the imported branch tip's blobs that are not plain text.
  const blobs = git(dev, "rev-list", "--objects", "--no-object-names", "HEAD^^2").split("\n");
  const types = spawnSync(gitBinary(), ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { cwd: dev, input: `${blobs.join("\n")}\n`, encoding: "utf8" }).stdout;
  const unlisted = types.split("\n").filter((line) => line.endsWith(" blob")).map((line) => line.split(" ")[0]).filter((id) => !expected.some((entry) => entry.oid === id));
  assert.equal(unlisted.length + expected.length, types.split("\n").filter((line) => line.endsWith(" blob")).length);
  for (const id of unlisted) {
    const content = spawnSync(gitBinary(), ["cat-file", "blob", id], { cwd: dev }).stdout;
    assert.ok(!content.includes(0) && !/^P[1-7]\s|XPM|_width|%!PS|%PDF|svg/.test(content.toString()), `${id} is plain text`);
  }
});

historyTest("a missing object in the imported history stops the promotion before the branch", () => {
  const { dev } = fixture("history-missing");
  const head = git(dev, "rev-parse", "HEAD");
  const env = wrapFilterRepo("history-missing", {
    after: `case "$*" in *--invert-paths*) tree=$(printf '100644 blob ${"1".repeat(40)}\\tghost.bin\\n' | git mktree --missing) && c=$(git commit-tree "$tree" -p refs/heads/promote-source -m ghost) && git update-ref refs/heads/promote-source "$c";; esac`,
  });
  const run = promoteCli(dev, ["widgetfn"], { env });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /^promote: git-failed: /);
  assert.equal(git(dev, "rev-parse", "HEAD"), head);
  assert.equal(git(dev, "branch", "--show-current"), "dev");
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");
  assert.equal(git(dev, "status", "--porcelain"), "");
});

historyTest("an exported GIT_DIR and GIT_WORK_TREE do not redirect the temporary repository to this one", () => {
  const { dev } = fixture("git-env");
  const refs = () => git(dev, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter((line) => !line.startsWith("refs/heads/promote/"));
  const before = refs();
  const env = { ...process.env, GIT_DIR: path.join(dev, ".git"), GIT_WORK_TREE: dev, GIT_INDEX_FILE: path.join(dev, ".git", "index") };
  const run = promoteCli(dev, ["widgetfn"], { env, cwd: scratch });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(refs(), before, "only the promotion branch is new");
  assert.equal(git(dev, "branch", "--show-current"), "promote/widgetfn");
  assert.equal(git(dev, "rev-list", "--count", "HEAD^^2"), "3", "the merge (before the ownership commit) imports the three commits");
  assert.equal(git(dev, "status", "--porcelain"), "");
});

historyTest("a tracked edit made during filtering survives a rejected merge: only promotion-owned state is removed", () => {
  const { dev } = fixture("tracked-late");
  const head = git(dev, "rev-parse", "HEAD");
  const edited = path.join(dev, "uifn/keep.js");
  useHook(dev, "pre-merge-commit", "exit 1");
  const run = promoteCli(dev, ["widgetfn"], { env: lateFilterRepo("tracked-late", edited, "edited locally") });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /^promote: git-failed: merge failed/);
  assert.equal(readFileSync(edited, "utf8"), "edited locally\n");
  assert.equal(git(dev, "rev-parse", "HEAD"), head);
  assert.equal(git(dev, "branch", "--show-current"), "dev");
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");
  assert.equal(git(dev, "status", "--porcelain"), "M uifn/keep.js");
  assert.equal(git(dev, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
});

historyTest("merge policies still apply: a rejecting pre-merge-commit hook or merge.verifySignatures refuses the promotion", () => {
  const { dev } = fixture("merge-policy");
  const head = git(dev, "rev-parse", "HEAD");
  // An unrelated linked worktree whose directory is missing (an unmounted volume) is left registered.
  const away = path.join(scratch, "merge-policy-away");
  git(dev, "worktree", "add", "-q", "--detach", away, "HEAD");
  rmSync(away, { recursive: true, force: true });
  const worktrees = git(dev, "worktree", "list", "--porcelain").match(/^worktree /gm).length;
  const unchanged = () => {
    assert.equal(git(dev, "rev-parse", "HEAD"), head);
    assert.equal(git(dev, "branch", "--show-current"), "dev");
    assert.equal(git(dev, "branch", "--list", "promote/*"), "");
    assert.equal(git(dev, "status", "--porcelain"), "");
    assert.equal(git(dev, "worktree", "list", "--porcelain").match(/^worktree /gm).length, worktrees);
  };
  useHook(dev, "pre-merge-commit", "exit 1");
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "git-failed");
  unchanged();
  // A hook that rejects merges on promote/* branches still sees the promotion branch.
  useHook(dev, "pre-merge-commit", 'case "$(git branch --show-current)" in promote/*) exit 1;; esac');
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "git-failed");
  unchanged();
  git(dev, "config", "--unset", "core.hooksPath");
  // The imported commits are unsigned.
  git(dev, "config", "merge.verifySignatures", "true");
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "git-failed");
  unchanged();
  git(dev, "config", "--unset", "merge.verifySignatures");
  write(dev, { ".git/signed.conf": "[merge]\n\tverifySignatures = true\n" });
  // An include that covers this checkout and the repository's linked worktrees alike applies there.
  git(dev, "config", `includeIf.gitdir:${realpathSync(dev)}/.path`, "signed.conf");
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "git-failed");
  unchanged();
  write(dev, { ".git/signed.conf": "" });
  promote({ root: dev, fn: "widgetfn" });
  assert.equal(git(dev, "branch", "--show-current"), "promote/widgetfn");
  assert.equal(git(dev, "rev-parse", "ORIG_HEAD"), head, "ORIG_HEAD is the commit before the merge, as git merge leaves it");
  assert.equal(git(dev, "worktree", "list", "--porcelain").match(/^worktree /gm).length, worktrees);
});

historyTest("a rejecting post-checkout hook on the new branch restores the original checkout and branch list", () => {
  const { dev } = fixture("checkout-hook");
  const head = git(dev, "rev-parse", "HEAD");
  const branches = git(dev, "branch", "--list");
  useHook(dev, "post-checkout", "exit 1");
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "git-failed");
  assert.equal(git(dev, "branch", "--show-current"), "dev");
  assert.equal(git(dev, "rev-parse", "HEAD"), head);
  assert.equal(git(dev, "branch", "--list"), branches);
  assert.equal(git(dev, "status", "--porcelain"), "");
  // The retry does not hit branch-exists.
  git(dev, "config", "--unset", "core.hooksPath");
  promote({ root: dev, fn: "widgetfn" });
  assert.equal(git(dev, "branch", "--show-current"), "promote/widgetfn");
});

historyTest("a promotion branch created or moved by something else while promotion runs survives with its reflog", () => {
  const { dev } = fixture("branch-race");
  const head = git(dev, "rev-parse", "HEAD");
  git(dev, "switch", "-q", "-c", "other");
  const other = commit(dev, "other work", { "uifn/other.js": "export const other = 1;\n" });
  git(dev, "switch", "-q", "dev");
  const ref = "refs/heads/promote/widgetfn";
  const reflog = () => git(dev, "reflog", "show", "--format=%H %gs", ref);
  const competing = (name) => wrapFilterRepo(name, { before: `git -C '${dev}' branch -q promote/widgetfn other` });
  const unchanged = (what, log) => {
    assert.equal(git(dev, "rev-parse", ref), other, what);
    assert.equal(reflog(), log, what);
    assert.equal(git(dev, "rev-parse", "HEAD"), head, what);
    assert.equal(git(dev, "branch", "--show-current"), "dev", what);
    assert.equal(git(dev, "status", "--porcelain"), "", what);
    assert.equal(git(dev, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1, what);
  };
  // Created during filtering: branch-exists, and the competing branch is not deleted.
  let run = promoteCli(dev, ["widgetfn"], { env: competing("branch-race") });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /^promote: branch-exists: branch promote\/widgetfn was created by something else/);
  const log = reflog();
  assert.match(log, new RegExp(`^${other} `));
  unchanged("created during filtering", log);
  // The same race when promotion fails before it would create the branch (a policy refusal).
  git(dev, "branch", "-q", "-D", "promote/widgetfn");
  git(dev, "config", "core.worktree", dev);
  run = promoteCli(dev, ["widgetfn"], { env: competing("branch-race-policy") });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /^promote: checkout-policy: /);
  unchanged("created during filtering, then a policy refusal", reflog());
  git(dev, "config", "--unset", "core.worktree");
  // Moved by something else after promotion created it: a failure leaves the moved branch alone.
  git(dev, "branch", "-q", "-D", "promote/widgetfn");
  useHook(dev, "pre-merge-commit", `git update-ref ${ref} ${other}\nexit 1`);
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "git-failed");
  assert.equal(git(dev, "rev-parse", ref), other);
  assert.equal(git(dev, "rev-parse", "HEAD"), head);
  assert.equal(git(dev, "status", "--porcelain"), "");
  assert.equal(git(dev, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
  // Replaced with a symbolic ref to another branch at the same commit: neither that branch nor its reflog is deleted.
  git(dev, "branch", "-q", "-D", "promote/widgetfn");
  git(dev, "branch", "-q", "victim", head);
  const victimLog = git(dev, "reflog", "show", "--format=%H %gs", "refs/heads/victim");
  useHook(dev, "pre-merge-commit", `git symbolic-ref ${ref} refs/heads/victim\nexit 1`);
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "git-failed");
  assert.equal(git(dev, "rev-parse", "refs/heads/victim"), head);
  assert.equal(git(dev, "reflog", "show", "--format=%H %gs", "refs/heads/victim"), victimLog);
  assert.equal(git(dev, "symbolic-ref", ref), "refs/heads/victim");
  git(dev, "symbolic-ref", "--delete", ref);
  git(dev, "branch", "-q", "-D", "victim");
  // A dangling symbolic promotion ref, there before the run or created during filtering, is neither replaced nor followed.
  git(dev, "symbolic-ref", ref, "refs/heads/absent");
  git(dev, "config", "--unset", "core.hooksPath");
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "branch-exists");
  assert.equal(git(dev, "symbolic-ref", ref), "refs/heads/absent");
  assert.equal(spawnSync(gitBinary(), ["rev-parse", "-q", "--verify", "refs/heads/absent"], { cwd: dev }).status, 1);
  git(dev, "symbolic-ref", "--delete", ref);
  run = promoteCli(dev, ["widgetfn"], { env: wrapFilterRepo("branch-race-symref", { before: `git -C '${dev}' symbolic-ref ${ref} refs/heads/absent` }) });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /^promote: branch-exists: /);
  assert.equal(git(dev, "symbolic-ref", ref), "refs/heads/absent");
  assert.equal(spawnSync(gitBinary(), ["rev-parse", "-q", "--verify", "refs/heads/absent"], { cwd: dev }).status, 1);
  git(dev, "symbolic-ref", "--delete", ref);
  git(dev, "branch", "-q", "promote/widgetfn", other);
  // Moved after the ownership commit: promotion neither checks it out nor reports success, and leaves it alone
  // (also with --reconcile, which skips the content check).
  git(dev, "branch", "-q", "-D", "promote/widgetfn");
  useHook(dev, "post-commit", `git update-ref ${ref} ${other}`);
  throwsCode(() => promote({ root: dev, fn: "widgetfn", reconcile: true }), "git-failed");
  assert.equal(git(dev, "rev-parse", ref), other);
  assert.equal(git(dev, "branch", "--show-current"), "dev");
  assert.equal(git(dev, "rev-parse", "HEAD"), head);
  assert.equal(git(dev, "status", "--porcelain"), "");
  // Checked out in another worktree before the cleanup: the branch is kept, as git branch -D would.
  git(dev, "branch", "-q", "-D", "promote/widgetfn");
  const elsewhere = path.join(scratch, "branch-race-elsewhere");
  useHook(dev, "pre-merge-commit", `unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\ngit -C '${dev}' worktree add -q -f '${elsewhere}' promote/widgetfn\nexit 1`);
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "git-failed");
  assert.equal(git(elsewhere, "branch", "--show-current"), "promote/widgetfn");
  assert.equal(git(elsewhere, "rev-parse", "HEAD"), head);
  assert.equal(git(dev, "rev-parse", "HEAD"), head);
  git(dev, "worktree", "remove", "--force", elsewhere);
  // A branch promotion created and still owns is removed after a rejecting hook; a retry then succeeds.
  git(dev, "branch", "-q", "-D", "promote/widgetfn");
  useHook(dev, "pre-merge-commit", "exit 1");
  throwsCode(() => promote({ root: dev, fn: "widgetfn" }), "git-failed");
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");
  git(dev, "config", "--unset", "core.hooksPath");
  promote({ root: dev, fn: "widgetfn" });
  assert.equal(git(dev, "branch", "--show-current"), "promote/widgetfn");
});

test("image signatures and text-stored image formats are recognised; long whitespace-heavy text is classified quickly", () => {
  const bytes = (...values) => Buffer.from(values);
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1);
  for (const [what, content] of [
    ["PNG", png],
    ["PNG after a UTF-8 BOM", Buffer.concat([bytes(0xef, 0xbb, 0xbf), png])],
    ["JPEG", bytes(0xff, 0xd8, 0xff, 0xe0)],
    ["GIF87a", Buffer.from("GIF87a\x01\x00", "latin1")],
    ["GIF89a", Buffer.from("GIF89a", "latin1")],
    ["WebP", Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1")],
    ["PNM P1", Buffer.from("P1\n1 1\n0\n")],
    ["PNM P6", Buffer.from("P6 1 1 255\n\xff\xff\xff", "latin1")],
    ["SVG", Buffer.from('<x:svg xmlns:x="http://www.w3.org/2000/svg"/>')],
    ["XPM", Buffer.from("/* XPM */\n")],
    ["XBM", Buffer.from("/* c */\n  #  define a_width 8\n")],
    ["XBM with a form feed", Buffer.from("#\fdefine a_width 8\n")],
    ["XBM with a vertical tab", Buffer.from("\v#define\va_width 8\n")],
    ["PostScript", Buffer.from("\n %!PS-Adobe-3.0\n")],
    ["PDF", Buffer.from("%PDF-1.4\n")],
    ["data URI", Buffer.from("x data:image/png;base64,AA")],
    ["notebook output", Buffer.from('{"image/png" : "AA"}')],
  ]) assert.equal(classifyBlob(content, ["file"]), "image", what);
  assert.equal(classifyBlob(Buffer.from("RIFF\x10\x00\x00\x00WAVE", "latin1"), ["file"]), "binary");
  assert.equal(classifyBlob(Buffer.from("P8 not an image\n"), ["file"]), null);
  assert.equal(classifyBlob(Buffer.from("plain text\n"), ["file.svg"]), "image");
  const started = performance.now();
  for (const filler of [" \n", "\t \n#", "<a", "/* ", "\n# define x "]) {
    assert.equal(classifyBlob(Buffer.from(filler.repeat(Math.ceil(1_000_000 / filler.length))), ["file"]), null, JSON.stringify(filler));
  }
  assert.ok(performance.now() - started < 5000, `classified 5 MB in ${Math.round(performance.now() - started)} ms`);
});

historyTest("an ignored file several levels above a selected sub-path is a path-conflict, not an uncaught error", () => {
  const { dev, next } = fixture("deep-obstruction");
  const pin = commit(next, "deep uifn path", { "uifn/deep/a/b/c.js": "export const c = 1;\n" });
  const head = git(dev, "rev-parse", "HEAD");
  write(dev, { ".git/info/exclude": "uifn/deep\n", "uifn/deep": "local only\n" });
  throwsCode(() => promote({ root: dev, paths: ["uifn/deep/a/b/c.js"], pin, source: next }), "path-conflict");
  const run = promoteCli(dev, ["--path", "uifn/deep/a/b/c.js", "--pin", pin, "--source", next]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^promote: path-conflict: uifn\/deep exists here as an untracked or ignored file/);
  assert.equal(readFileSync(path.join(dev, "uifn/deep"), "utf8"), "local only\n");
  assert.equal(git(dev, "rev-parse", "HEAD"), head);
  assert.equal(git(dev, "branch", "--show-current"), "dev");
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");
  assert.equal(git(dev, "status", "--porcelain"), "");
});

historyTest("a released Python project must be spelled exactly as its canonical name in pyproject.toml, the overlay and TARGETS", () => {
  const { dev, next } = fixture("python-spelling");
  const head = git(dev, "rev-parse", "HEAD");
  const variant = (message, project, overlay) =>
    commit(next, message, {
      "widgetfn/python/pyproject.toml": `[project]\nname = "${project}"\nversion = "0.0.1"\n`,
      "python-release-packages.next.json": [{ name: overlay, path: "widgetfn/python" }],
    });
  const pins = [
    variant("mixed-case project", "WidgetFn", "widgetfn"),
    variant("mixed-case project and overlay", "WidgetFn", "WidgetFn"),
    variant("underscore project", "widget_fn", "widget-fn"),
    variant("underscore project and overlay", "widget_fn", "widget_fn"),
    variant("dotted overlay", "widget-fn", "widget.fn"),
  ];
  for (const pin of pins) {
    throwsCode(() => promote({ root: dev, fn: "widgetfn", pin, source: next }), "release-conflict");
    assert.equal(git(dev, "rev-parse", "HEAD"), head);
    assert.equal(git(dev, "branch", "--list", "promote/*"), "");
  }
  // TARGETS here listing the imported project in another spelling is refused too.
  const canonical = variant("canonical", "widget-fn", "widget-fn");
  const targets = commit(dev, "TARGETS lists Widget_Fn", {
    "scripts/python_release.py": PYTHON_RELEASE.replace('}\n\nOTHER', '    "Widget_Fn": "widgetfn/python",\n}\n\nOTHER'),
  });
  git(dev, "update-ref", "refs/remotes/origin/dev", targets);
  throwsCode(() => promote({ root: dev, fn: "widgetfn", pin: canonical, source: next }), "release-conflict");
  assert.equal(git(dev, "branch", "--list", "promote/*"), "");

  // The canonical spelling everywhere is released under exactly the pyproject.toml name.
  git(dev, "reset", "-q", "--hard", head);
  git(dev, "update-ref", "refs/remotes/origin/dev", head);
  promote({ root: dev, fn: "widgetfn", pin: canonical, source: next });
  assert.match(readFileSync(path.join(dev, "scripts/python_release.py"), "utf8"), /^ {4}"widget-fn": "widgetfn\/python",$/m);
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
  assert.deepEqual(releaseMoves({ pinOverlay: overlay, pinBase: [], current, paths: ["widgetfn"] }).moves, [
    { ...overlay[0], source: "release-packages.next.json" },
  ]);
  // A pin from before the overlay: next's release-packages.json, minus what dev already lists.
  const base = [...current, overlay[0]];
  assert.deepEqual(releaseMoves({ pinOverlay: null, pinBase: base, current, paths: ["alphafn", "widgetfn"] }), {
    entries: [
      { ...current[0], source: "release-packages.json" },
      { ...overlay[0], source: "release-packages.json" },
    ],
    moves: [{ ...overlay[0], source: "release-packages.json" }],
  });
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
  assert.equal(releaseMoves({ pinOverlay: pair({}, {}), pinBase: [], current, paths: ["widgetfn"] }).moves.length, 2);

  // A bare entry keeps its kind, core and CLI, is compared with them, and needs its linked slugs promoted or present.
  const bare = { slug: "widgetfn", path: "widgetfn/bare", name: "widgetfn", kind: "bare", core: "widgetfn-core", cli: "alphafn-core" };
  const withBare = [overlay[0], bare];
  assert.deepEqual(releaseMoves({ pinOverlay: withBare, pinBase: [], current, paths: ["widgetfn"] }).moves[1], { ...bare, source: "release-packages.next.json" });
  const plainCopy = [...current, { slug: "widgetfn", path: "widgetfn/bare", name: "widgetfn" }];
  throwsCode(() => releaseMoves({ pinOverlay: withBare, pinBase: [], current: plainCopy, paths: ["widgetfn"] }), "release-conflict");
  assert.equal(releaseMoves({ pinOverlay: withBare, pinBase: [], current: [...current, overlay[0], bare], paths: ["widgetfn"] }).moves.length, 0);
  throwsCode(() => releaseMoves({ pinOverlay: [bare], pinBase: [], current, paths: ["widgetfn"] }), "release-conflict");
  const appended = JSON.parse(appendReleaseEntries("[\n]\n", [{ ...bare, source: "release-packages.next.json" }]));
  assert.deepEqual(appended, [{ slug: "widgetfn", path: "widgetfn/bare", name: "widgetfn", kind: "bare", core: "widgetfn-core", cli: "alphafn-core" }]);
});

test("Python identities: one order-independent check across overlay entries, imported pyproject.toml files and this checkout", () => {
  const targets = new Map([["alpha-fn", "alphafn/python"]]);
  const paths = ["alphafn"];
  const pyproject = (name, directory) => ({ name, file: `${directory}/pyproject.toml` });
  // gamma has no overlay entry, so it is not released and its spelling is not checked.
  const discovered = [pyproject("alpha-fn", "alphafn/python"), pyproject("beta", "alphafn/beta"), pyproject("Gamma", "alphafn/gamma")];
  // Each overlay entry names the imported project in its directory; TARGETS already lists alphafn, so only beta moves.
  assert.deepEqual(pythonMoves({ overlay: [{ name: "alpha-fn", path: "alphafn/python" }, { name: "beta", path: "alphafn/beta/" }], paths, targets, discovered }), {
    names: ["alpha-fn", "beta", "Gamma"],
    entries: [{ name: "alpha-fn", path: "alphafn/python" }, { name: "beta", path: "alphafn/beta/" }],
    moves: [{ name: "beta", path: "alphafn/beta/" }],
  });
  // The same project in the same directory here (pyproject.toml and TARGETS) is the same identity.
  const existing = [pyproject("beta", "alphafn/beta"), pyproject("delta", "deltafn")];
  assert.deepEqual(pythonMoves({ overlay: [{ name: "beta", path: "alphafn/beta" }], paths, targets: new Map([...targets, ["beta", "alphafn/beta/"]]), discovered, existing }), {
    names: ["alpha-fn", "beta", "Gamma"],
    entries: [{ name: "beta", path: "alphafn/beta" }],
    moves: [],
  });
  const beta = discovered.slice(1, 2);
  const twice = [{ name: "beta", path: "alphafn/beta" }, { name: "Beta", path: "alphafn/beta/" }];
  const spelled = (name) => [pyproject(name, "alphafn/beta")];
  const refused = {
    "two imported projects with one canonical name": { discovered: [pyproject("new-pkg", "alphafn/a"), pyproject("New_Pkg", "alphafn/b")] },
    "overlay name differs from the pyproject.toml in its directory": { discovered: beta, overlay: [{ name: "other-beta", path: "alphafn/beta" }] },
    "overlay entry with no imported pyproject.toml": { discovered: beta, overlay: [{ name: "lonely", path: "alphafn/lonely" }] },
    "overlay entry naming a project in another directory": { discovered: beta, overlay: [{ name: "beta", path: "alphafn/b2" }] },
    "two identical overlay entries after the pyproject.toml": { discovered: beta, overlay: twice },
    "two identical overlay entries, reversed": { discovered: beta, overlay: [...twice].reverse() },
    "two overlay entries for one directory": { discovered: beta, overlay: [{ name: "beta", path: "alphafn/beta" }, { name: "beta-2", path: "alphafn/beta" }] },
    "a pyproject.toml here with the name at another path": { discovered: [pyproject("Delta", "alphafn/delta")], existing },
    "TARGETS with the name at another path": { discovered: [pyproject("alpha-fn", "alphafn/py")] },
    // python_release.py resolves a tag only when its name equals project.name exactly, and the overlay must be canonical.
    "a mixed-case pyproject.toml released under the canonical name": { discovered: spelled("Beta"), overlay: [{ name: "beta", path: "alphafn/beta" }] },
    "a mixed-case pyproject.toml and overlay entry": { discovered: spelled("Beta"), overlay: [{ name: "Beta", path: "alphafn/beta" }] },
    "an underscore pyproject.toml released under the hyphenated name": { discovered: spelled("beta_x"), overlay: [{ name: "beta-x", path: "alphafn/beta" }] },
    "a dotted overlay entry for a canonical pyproject.toml": { discovered: spelled("beta-x"), overlay: [{ name: "beta.x", path: "alphafn/beta" }] },
    "TARGETS listing an imported project in another spelling": { discovered: [pyproject("alpha-fn", "alphafn/python")], targets: new Map([["Alpha_FN", "alphafn/python"]]) },
    "TARGETS with another name in the imported directory": { discovered: [pyproject("other", "alphafn/python")] },
    "a pyproject.toml here with another name in the imported directory": { discovered: [pyproject("zeta", "deltafn")], existing, targets: new Map() },
  };
  for (const [label, input] of Object.entries(refused)) {
    assert.throws(() => pythonMoves({ paths, targets, ...input }), (error) => error instanceof PromoteError && error.code === "release-conflict", label);
  }
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

test("ownership keys such as __proto__ are written and kept as own entries", () => {
  const manifest = publicManifest();
  manifest.rootFiles.public.push("index.js");
  const changed = flipManifest(manifest, { topLevel: ["__proto__"], rootFiles: [], slugs: ["__proto__"], pythonNames: [] });
  assert.deepEqual(changed, { paths: ["__proto__"], rootFiles: [], releases: ["__proto__"], python: [] });
  const written = JSON.parse(JSON.stringify(manifest));
  assert.deepEqual(Object.keys(written.paths), ["__proto__", "alphafn", "scripts", "uifn"]);
  assert.ok(Object.hasOwn(written.releases, "__proto__"));

  // An existing own __proto__ key (as JSON.parse creates it) survives a flip that re-sorts the section.
  flipManifest(written, { topLevel: ["betafn"], rootFiles: [], slugs: ["betafn-core"], pythonNames: [] });
  const rewritten = JSON.parse(JSON.stringify(written));
  assert.deepEqual(Object.keys(rewritten.paths), ["__proto__", "alphafn", "betafn", "scripts", "uifn"]);
  assert.deepEqual(Object.keys(rewritten.releases), ["__proto__", "alphafn-cli", "alphafn-core", "betafn-core"]);

  // verify-owners accepts the promoted tree.
  const owners = createOwners(parseManifest(rewritten, { kind: "public" }));
  const errors = findOwnershipErrors({
    owners,
    repo: "public",
    files: ["__proto__/index.js", "alphafn/core/index.js", "alphafn/python/pyproject.toml", "betafn/core/index.js", "index.js", "release-packages.json", "scripts/x.mjs", "superfunctions.owners.json", "uifn/keep.js"],
    releases: [
      { slug: "__proto__", path: "__proto__", name: "@proto/core", source: "release-packages.json" },
      { slug: "alphafn-cli", path: "alphafn/cli", name: "@alphafn/cli", source: "release-packages.json" },
      { slug: "alphafn-core", path: "alphafn/core", name: "@alphafn/core", source: "release-packages.json" },
      { slug: "betafn-core", path: "betafn/core", name: "@betafn/core", source: "release-packages.json" },
    ],
    python: [{ name: "alphafn", file: "alphafn/python/pyproject.toml" }],
  });
  assert.deepEqual(errors, []);
});
