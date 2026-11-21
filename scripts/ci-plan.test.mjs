import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// A tiny, disposable Git fixture exercises the actual planner and its diff discovery.
test("CI changes cannot silently disable Python coverage", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-plan-contract-"));
  const env = {
    ...process.env,
    // Fixture plans must not write to the run summary of the CI step running these tests.
    GITHUB_STEP_SUMMARY: "",
    GIT_AUTHOR_NAME: "Planner Test", GIT_AUTHOR_EMAIL: "planner@example.invalid",
    GIT_COMMITTER_NAME: "Planner Test", GIT_COMMITTER_EMAIL: "planner@example.invalid",
  };
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (file, contents) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  };
  try {
    for (const file of ["ci-plan.mjs", "ci-utils.mjs"]) put(`scripts/${file}`, readFileSync(new URL(file, import.meta.url), "utf8"));
    put("example/python/pyproject.toml", '[project]\nname = "example-python"\n');
    put("docsfn/docs/package.json", '{"name":"@docsfn/site","scripts":{"build":"echo build"}}');
    put("docsfn/docs/content.md", "# Docs\n");
    put(".github/workflows/ci.yml", "jobs: {}\n");
    put("README.md", "# Fixture\n");
    git("init", "--quiet", "--initial-branch=dev");
    git("add", "."); git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    for (const [file, python, js] of [
      [".github/workflows/ci.yml", true, true],
      ["scripts/ci-plan.mjs", true, true],
      ["README.md", false, false],
      ["docsfn/docs/content.md", false, true],
    ]) {
      git("reset", "--hard", base);
      const prior = readFileSync(path.join(root, file), "utf8");
      put(file, prior + (file.endsWith(".mjs") ? "\n// changed\n" : "\n# changed\n"));
      git("add", file); git("commit", "--quiet", "-m", "change");
      put(".git/event.json", JSON.stringify({ before: base }));
      const outputFile = path.join(root, ".git/outputs");
      writeFileSync(outputFile, "");
      execFileSync(process.execPath, ["scripts/ci-plan.mjs"], { cwd: root, env: { ...env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: path.join(root, ".git/event.json"), GITHUB_OUTPUT: outputFile }, stdio: ["ignore", "pipe", "pipe"] });
      const outputs = readFileSync(outputFile, "utf8");
      assert.match(outputs, new RegExp(`^run_python<<__CI_EOF__\n${python}\n__CI_EOF__$`, "m"), file);
      assert.match(outputs, new RegExp(`^run_js<<__CI_EOF__\n${js}\n__CI_EOF__$`, "m"), file);
      assert.doesNotMatch(outputs, /run_docs(?:=|<<)/);
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

// Shared test support outside any package (devfn/test-support) still selects the packages that use it.
test("a change to a product's shared test support runs that product's package tests", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-plan-test-support-"));
  const env = {
    ...process.env,
    // Fixture plans must not write to the run summary of the CI step running these tests.
    GITHUB_STEP_SUMMARY: "",
    GIT_AUTHOR_NAME: "Planner Test", GIT_AUTHOR_EMAIL: "planner@example.invalid",
    GIT_COMMITTER_NAME: "Planner Test", GIT_COMMITTER_EMAIL: "planner@example.invalid",
  };
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (file, contents) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  };
  try {
    for (const file of ["ci-plan.mjs", "ci-utils.mjs"]) put(`scripts/${file}`, readFileSync(new URL(file, import.meta.url), "utf8"));
    put("package.json", JSON.stringify({ name: "fixture", private: true, workspaces: ["devfn/*", "otherfn/*"] }));
    for (const dir of ["devfn/core", "devfn/proxy", "otherfn/core"]) put(`${dir}/package.json`, JSON.stringify({ name: `@${dir.replace("/", "-")}/pkg`, scripts: { test: "vitest run" } }));
    put("devfn/test-support/leak-guard.mjs", "export {};\n");
    git("init", "--quiet", "--initial-branch=dev");
    git("add", "."); git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    put("devfn/test-support/leak-guard.mjs", "export {};\n// changed\n");
    git("add", "."); git("commit", "--quiet", "-m", "change");
    put(".git/event.json", JSON.stringify({ before: base }));
    const outputFile = path.join(root, ".git/outputs");
    writeFileSync(outputFile, "");
    execFileSync(process.execPath, ["scripts/ci-plan.mjs"], { cwd: root, env: { ...env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: path.join(root, ".git/event.json"), GITHUB_OUTPUT: outputFile }, stdio: ["ignore", "pipe", "pipe"] });
    const outputs = readFileSync(outputFile, "utf8");
    assert.match(outputs, /^full_js<<__CI_EOF__\nfalse\n__CI_EOF__$/m);
    assert.match(outputs, /^run_devfn<<__CI_EOF__\ntrue\n__CI_EOF__$/m);
    assert.match(outputs, /^devfn_test_filters<<__CI_EOF__\n--filter=\.\/devfn\/core --filter=\.\/devfn\/proxy\n__CI_EOF__$/m);
    assert.match(outputs, /^has_js_test<<__CI_EOF__\nfalse\n__CI_EOF__$/m);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

// DevFn tests (SFNS-293) run in their own serialized job: the plan gives that job the DevFn part of the JavaScript test
// selection (a changed package and its dependents, or everything on a full run) and the JavaScript test step none of it.
function devfnFixture(extraFiles = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ci-plan-devfn-"));
  const env = {
    ...process.env,
    // Fixture plans must not write to the run summary of the CI step running these tests.
    GITHUB_STEP_SUMMARY: "",
    GIT_AUTHOR_NAME: "Planner Test", GIT_AUTHOR_EMAIL: "planner@example.invalid",
    GIT_COMMITTER_NAME: "Planner Test", GIT_COMMITTER_EMAIL: "planner@example.invalid",
  };
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (file, contents) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  };
  for (const file of ["ci-plan.mjs", "ci-utils.mjs"]) put(`scripts/${file}`, readFileSync(new URL(file, import.meta.url), "utf8"));
  put("package.json", JSON.stringify({ name: "fixture", private: true, workspaces: ["clifn/*", "devfn/*", "filefn/*", "otherfn/*"] }));
  put("package-lock.json", "{}\n");
  const pkg = (dir, name, dependencies = {}, devDependencies = {}) => {
    put(`${dir}/package.json`, JSON.stringify({ name, scripts: { build: "tsc", test: "vitest run" }, dependencies, devDependencies }));
    put(`${dir}/src/index.ts`, "export {};\n");
  };
  // devfn/core depends on devfn/config, which depends on clifn/core outside DevFn; otherfn/cli depends on devfn/core.
  pkg("clifn/core", "@clifn/core");
  pkg("devfn/config", "@devfn/config", { "@clifn/core": "*" });
  pkg("devfn/core", "@devfn/core", {}, { "@devfn/config": "*" });
  pkg("devfn/proxy", "@devfn/proxy");
  pkg("filefn/core", "@filefn/core");
  pkg("otherfn/cli", "@otherfn/cli", { "@devfn/core": "*" });
  for (const [file, contents] of Object.entries(extraFiles)) put(file, contents);
  git("init", "--quiet", "--initial-branch=dev");
  git("add", "."); git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  // `change` is a file to append a newline to, or a function that edits the tree through `put` and `read`.
  const read = (file) => readFileSync(path.join(root, file), "utf8");
  const plan = (change, extraEnv = {}) => {
    git("reset", "--quiet", "--hard", base);
    if (typeof change === "function") change({ put, read });
    else put(change, `${read(change)}\n`);
    git("add", "."); git("commit", "--quiet", "-m", "change");
    put(".git/event.json", JSON.stringify({ before: base }));
    const outputFile = path.join(root, ".git/outputs");
    writeFileSync(outputFile, "");
    execFileSync(process.execPath, ["scripts/ci-plan.mjs"], { cwd: root, env: { ...env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: path.join(root, ".git/event.json"), GITHUB_OUTPUT: outputFile, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    const outputs = readFileSync(outputFile, "utf8");
    return Object.fromEntries([...outputs.matchAll(/^(\w+)<<__CI_EOF__\n([\s\S]*?)\n__CI_EOF__$/gm)].map(([, name, value]) => [name, value]));
  };
  return { root, plan };
}

const EXCLUDE_DEVFN = "--filter=!./devfn/config --filter=!./devfn/core --filter=!./devfn/proxy";

test("a DevFn change selects DevFn tests for the DevFn job and leaves them out of the JavaScript test filters", () => {
  const { root, plan } = devfnFixture();
  try {
    const outputs = plan("devfn/core/src/index.ts");
    assert.equal(outputs.full_js, "false");
    assert.equal(outputs.run_devfn, "true");
    assert.equal(outputs.devfn_test_filters, "--filter=./devfn/core");
    // The JavaScript job still tests otherfn/cli, which depends on devfn/core, and builds devfn/core.
    assert.equal(outputs.has_js_test, "true");
    assert.equal(outputs.js_test_filters, `--filter=..../devfn/core ${EXCLUDE_DEVFN}`);
    assert.equal(outputs.js_build_filters, "--filter=..../devfn/core");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test("a DevFn change with no dependent outside DevFn leaves the JavaScript test step nothing to run", () => {
  const { root, plan } = devfnFixture();
  try {
    const outputs = plan("devfn/proxy/src/index.ts");
    assert.equal(outputs.run_devfn, "true");
    assert.equal(outputs.devfn_test_filters, "--filter=./devfn/proxy");
    assert.equal(outputs.has_js_test, "false");
    assert.equal(outputs.js_test_filters, "");
    assert.equal(outputs.has_js_build, "true");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test("a change to a package DevFn depends on selects its DevFn dependents for the DevFn job", () => {
  const { root, plan } = devfnFixture();
  try {
    const outputs = plan("clifn/core/src/index.ts");
    assert.equal(outputs.run_devfn, "true");
    assert.equal(outputs.devfn_test_filters, "--filter=./devfn/config --filter=./devfn/core");
    assert.equal(outputs.has_js_test, "true");
    assert.equal(outputs.js_test_filters, `--filter=..../clifn/core ${EXCLUDE_DEVFN}`);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test("a change outside DevFn and everything it depends on selects no DevFn tests", () => {
  const { root, plan } = devfnFixture();
  try {
    const outputs = plan("filefn/core/src/index.ts");
    assert.equal(outputs.run_devfn, "false");
    assert.equal(outputs.devfn_test_filters, "");
    assert.equal(outputs.has_js_test, "true");
    assert.equal(outputs.js_test_filters, `--filter=..../filefn/core ${EXCLUDE_DEVFN}`);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

// The fixture lockfile has no packages map, so the planner cannot tell which packages a change touches.
test("a lockfile change the planner cannot classify runs every DevFn package in the DevFn job and none in the JavaScript job", () => {
  const { root, plan } = devfnFixture();
  try {
    const outputs = plan("package-lock.json");
    assert.equal(outputs.full_js, "true");
    assert.equal(outputs.run_devfn, "true");
    assert.equal(outputs.devfn_test_filters, "--filter=./devfn/config --filter=./devfn/core --filter=./devfn/proxy");
    assert.equal(outputs.has_js_test, "true");
    assert.equal(outputs.js_test_filters, EXCLUDE_DEVFN);
    // Build stays a full, unfiltered run in the JavaScript job.
    assert.equal(outputs.js_build_filters, "");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

// SFNS-307: standalone root scripts and workflows other than ci.yml no longer force a full JavaScript run; every other
// scripts/ path still does, because a package may read it.
test("only ci.yml and non-standalone scripts force a full JavaScript run", () => {
  const { root, plan } = devfnFixture({
    "scripts/promote.mjs": "export {};\n",
    "scripts/public-boundary.allow.json": "{}\n",
    "scripts/promote-helper.mjs": "export {};\n",
    "scripts/docs-site/llms.mjs": "export {};\n",
    ".github/workflows/ci.yml": "jobs: {}\n",
    ".github/workflows/uifn-browser.yml": "jobs: {}\n",
  });
  try {
    for (const [file, fullJs] of [
      ["scripts/promote.mjs", false],
      ["scripts/public-boundary.allow.json", false],
      ["scripts/promote-helper.mjs", true],
      ["scripts/docs-site/llms.mjs", true],
      [".github/workflows/uifn-browser.yml", false],
      [".github/workflows/ci.yml", true],
    ]) {
      const outputs = plan(file);
      assert.equal(outputs.full_js, String(fullJs), file);
      // Outside every package, a change that is not global selects no JavaScript work at all.
      assert.equal(outputs.run_js, String(fullJs), file);
      assert.equal(outputs.run_devfn, String(fullJs), file);
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

// Pull request plans diff against the live merge base: GitHub never refreshes base.sha after the base moves.
function pullRequestFixture(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const env = {
    ...process.env,
    // Fixture plans must not write to the run summary of the CI step running these tests.
    GITHUB_STEP_SUMMARY: "",
    GIT_AUTHOR_NAME: "Planner Test", GIT_AUTHOR_EMAIL: "planner@example.invalid",
    GIT_COMMITTER_NAME: "Planner Test", GIT_COMMITTER_EMAIL: "planner@example.invalid",
  };
  const gitIn = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const origin = path.join(dir, "origin");
  const work = path.join(dir, "work");
  const append = (root, file, line) => writeFileSync(path.join(root, file), readFileSync(path.join(root, file), "utf8") + `\n${line}\n`);
  const commitIn = (root, file, line) => { append(root, file, line); gitIn(root, "add", file); gitIn(root, "commit", "--quiet", "-m", `change ${file}`); return gitIn(root, "rev-parse", "HEAD"); };
  mkdirSync(path.join(origin, "scripts"), { recursive: true });
  mkdirSync(path.join(origin, "example/python"), { recursive: true });
  for (const file of ["ci-plan.mjs", "ci-utils.mjs"]) writeFileSync(path.join(origin, "scripts", file), readFileSync(new URL(file, import.meta.url), "utf8"));
  writeFileSync(path.join(origin, "example/python/pyproject.toml"), '[project]\nname = "example-python"\n');
  writeFileSync(path.join(origin, "README.md"), "# Fixture\n");
  gitIn(origin, "init", "--quiet", "--initial-branch=dev");
  gitIn(origin, "add", "."); gitIn(origin, "commit", "--quiet", "-m", "base");
  const oldBase = gitIn(origin, "rev-parse", "HEAD");
  gitIn(dir, "clone", "--quiet", origin, work);
  gitIn(work, "checkout", "--quiet", "-b", "feature");
  const plan = (pullRequest) => {
    const eventFile = path.join(dir, "event.json");
    const outputFile = path.join(dir, "outputs");
    writeFileSync(eventFile, JSON.stringify({ pull_request: pullRequest, repository: { default_branch: "dev" } }));
    writeFileSync(outputFile, "");
    execFileSync(process.execPath, ["scripts/ci-plan.mjs"], { cwd: work, env: { ...env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: outputFile }, stdio: ["ignore", "pipe", "pipe"] });
    const outputs = readFileSync(outputFile, "utf8");
    return Object.fromEntries([...outputs.matchAll(/^(\w+)<<__CI_EOF__\n([\s\S]*?)\n__CI_EOF__$/gm)].map(([, name, value]) => [name, value]));
  };
  return { dir, origin, work, oldBase, gitIn, commitIn, plan };
}

for (const shallowRefresh of [false, true]) {
  test(`base-branch changes a pull request merged in do not select Python${shallowRefresh ? " after a shallow base refresh" : ""}`, () => {
    const { dir, origin, work, oldBase, gitIn, commitIn, plan } = pullRequestFixture("ci-plan-merge-base-");
    try {
      commitIn(work, "README.md", "# pull request change");
      // dev gains a full-Python trigger change, and the pull request merges it in; base.sha stays the old base.
      const newBase = commitIn(origin, "scripts/ci-plan.mjs", "// base change");
      gitIn(work, "fetch", "--quiet", "origin");
      gitIn(work, "merge", "--quiet", "--no-edit", "origin/dev");
      if (shallowRefresh) {
        // CI's "Refresh common target branches" step fetches dev with --depth=1 after it moved again.
        commitIn(origin, "README.md", "# later base change");
        gitIn(work, "fetch", "--quiet", "--no-tags", "--depth=1", "origin", "dev");
        assert.equal(gitIn(work, "rev-parse", "--is-shallow-repository"), "true");
      }
      const outputs = plan({ base: { ref: "dev", sha: oldBase } });
      assert.equal(outputs.base_ref, newBase);
      assert.equal(outputs.changed_files_count, "1");
      assert.equal(outputs.full_python, "false");
      assert.equal(outputs.run_python, "false");
      assert.equal(outputs.python_matrix, "[]");
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
  });
}

test("a pull request that changes a full-Python trigger still selects the full Python matrix", () => {
  const { dir, origin, work, oldBase, gitIn, commitIn, plan } = pullRequestFixture("ci-plan-merge-base-own-");
  try {
    commitIn(origin, "README.md", "# base change");
    gitIn(work, "fetch", "--quiet", "origin");
    gitIn(work, "merge", "--quiet", "--no-edit", "origin/dev");
    commitIn(work, "scripts/ci-plan.mjs", "// pull request change");
    const outputs = plan({ base: { ref: "dev", sha: oldBase } });
    assert.equal(outputs.full_python, "true");
    assert.equal(outputs.run_python, "true");
    assert.match(outputs.python_matrix, /"example\/python"/);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test("a stale cached base tracking ref is refreshed before computing the merge base", () => {
  const { dir, origin, work, oldBase, gitIn, commitIn, plan } = pullRequestFixture("ci-plan-merge-base-stale-");
  try {
    commitIn(work, "README.md", "# pull request change");
    const newBase = commitIn(origin, "scripts/ci-plan.mjs", "// base change");
    gitIn(work, "fetch", "--quiet", "origin");
    gitIn(work, "merge", "--quiet", "--no-edit", newBase);
    // The checkout's cached origin/dev still points at the old base the pull request was opened against.
    gitIn(work, "update-ref", "refs/remotes/origin/dev", oldBase);
    const outputs = plan({ base: { ref: "dev", sha: oldBase } });
    assert.equal(outputs.base_ref, newBase);
    assert.equal(outputs.full_python, "false");
    assert.equal(outputs.python_matrix, "[]");
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

for (const cachedRef of [false, true]) {
  test(`a pull request whose base branch cannot be fetched falls back to base.sha${cachedRef ? " despite a cached tracking ref" : ""}`, () => {
    const { dir, origin, work, oldBase, gitIn, commitIn, plan } = pullRequestFixture("ci-plan-merge-base-fallback-");
    try {
      commitIn(work, "README.md", "# pull request change");
      commitIn(origin, "scripts/ci-plan.mjs", "// base change");
      gitIn(work, "fetch", "--quiet", "origin");
      gitIn(work, "merge", "--quiet", "--no-edit", "origin/dev");
      gitIn(work, "remote", "set-url", "origin", path.join(dir, "missing"));
      if (!cachedRef) gitIn(work, "update-ref", "-d", "refs/remotes/origin/dev");
      const outputs = plan({ base: { ref: "dev", sha: oldBase } });
      assert.equal(outputs.base_ref, oldBase);
      assert.equal(outputs.full_python, "true");
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
  });
}

test("a base branch with no merge base falls back to base.sha", () => {
  const { dir, origin, work, oldBase, gitIn, commitIn, plan } = pullRequestFixture("ci-plan-merge-base-unrelated-");
  try {
    commitIn(work, "README.md", "# pull request change");
    // dev is replaced by unrelated history, so HEAD and origin/dev share no commit.
    gitIn(origin, "checkout", "--quiet", "--orphan", "rewritten");
    gitIn(origin, "commit", "--quiet", "-m", "unrelated");
    gitIn(origin, "branch", "--quiet", "-M", "rewritten", "dev");
    const outputs = plan({ base: { ref: "dev", sha: oldBase } });
    assert.equal(outputs.base_ref, oldBase);
    assert.equal(outputs.changed_files_count, "1");
    assert.equal(outputs.full_python, "false");
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test("a non-default target with no fetch and no base.sha uses its cached tracking ref, not the default branch", () => {
  const { dir, origin, work, oldBase, gitIn, commitIn, plan } = pullRequestFixture("ci-plan-merge-base-cached-target-");
  try {
    // main gains a full-Python trigger change that dev lacks; the pull request branches from main.
    gitIn(origin, "checkout", "--quiet", "-b", "main");
    const mainBase = commitIn(origin, "scripts/ci-plan.mjs", "// main change");
    gitIn(origin, "checkout", "--quiet", "dev");
    gitIn(work, "fetch", "--quiet", "origin");
    gitIn(work, "checkout", "--quiet", "-B", "feature", "origin/main");
    commitIn(work, "README.md", "# pull request change");
    gitIn(work, "remote", "set-url", "origin", path.join(dir, "missing"));
    assert.equal(gitIn(work, "merge-base", "HEAD", "origin/dev"), oldBase);
    const outputs = plan({ base: { ref: "main", sha: "f".repeat(40) } });
    assert.equal(outputs.base_ref, mainBase);
    assert.equal(outputs.changed_files_count, "1");
    assert.equal(outputs.full_python, "false");
    assert.equal(outputs.run_python, "false");
    assert.equal(outputs.python_matrix, "[]");
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

// A lockfile shaped like npm's: each workspace's own entry keyed by its directory, a hoisted link entry per workspace,
// and one external package.
const WORKSPACES = {
  "clifn/core": "@clifn/core",
  "devfn/config": "@devfn/config",
  "devfn/core": "@devfn/core",
  "devfn/proxy": "@devfn/proxy",
  "filefn/core": "@filefn/core",
  "otherfn/cli": "@otherfn/cli",
};
function fixtureLockfile() {
  const packages = { "": { name: "fixture", workspaces: ["clifn/*", "devfn/*", "filefn/*", "otherfn/*"] } };
  for (const [dir, name] of Object.entries(WORKSPACES)) {
    packages[dir] = { name, version: "0.1.0" };
    packages[`node_modules/${name}`] = { resolved: dir, link: true };
  }
  packages["node_modules/left-pad"] = { version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz" };
  return { name: "fixture", lockfileVersion: 3, requires: true, packages };
}
const lockfileFixture = () => devfnFixture({ "package-lock.json": `${JSON.stringify(fixtureLockfile(), null, 2)}\n` });
const editLockfile = (edit) => ({ put, read }) => {
  const lockfile = JSON.parse(read("package-lock.json"));
  edit(lockfile.packages, lockfile);
  put("package-lock.json", `${JSON.stringify(lockfile, null, 2)}\n`);
};
const bump = (dir) => editLockfile((packages) => { packages[dir].version = "0.2.0"; });

test("a one-package change with its lockfile version bump selects only that package", () => {
  const { root, plan } = lockfileFixture();
  try {
    const outputs = plan(({ put, read }) => {
      put("filefn/core/src/index.ts", `${read("filefn/core/src/index.ts")}export const changed = true;\n`);
      bump("filefn/core")({ put, read });
    });
    assert.equal(outputs.full_js, "false");
    assert.equal(outputs.run_js, "true");
    assert.equal(outputs.js_build_filters, "--filter=..../filefn/core");
    // No fixture package defines typecheck, so the step is skipped even though it has a filter.
    assert.equal(outputs.has_js_typecheck, "false");
    assert.equal(outputs.js_test_filters, `--filter=..../filefn/core ${EXCLUDE_DEVFN}`);
    assert.equal(outputs.run_devfn, "false");
    assert.equal(outputs.run_python, "false");
    assert.equal(outputs.run_mcpfn, "false");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test("a lockfile-only workspace version bump selects that package and its dependents", () => {
  const { root, plan } = lockfileFixture();
  try {
    // clifn/core is shared: devfn/config depends on it, devfn/core on devfn/config, otherfn/cli on devfn/core.
    const outputs = plan(bump("clifn/core"));
    assert.equal(outputs.full_js, "false");
    assert.equal(outputs.js_build_filters, "--filter=..../clifn/core");
    assert.equal(outputs.js_test_filters, `--filter=..../clifn/core ${EXCLUDE_DEVFN}`);
    assert.equal(outputs.devfn_test_filters, "--filter=./devfn/config --filter=./devfn/core");
    assert.equal(outputs.has_js_test, "true");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test("a package installed under one workspace's node_modules selects only that workspace", () => {
  const { root, plan } = lockfileFixture();
  try {
    const outputs = plan(editLockfile((packages) => {
      packages["filefn/core/node_modules/left-pad"] = { version: "1.0.0" };
      packages["filefn/core/node_modules/left-pad/node_modules/pad-core"] = { version: "2.0.0" };
    }));
    assert.equal(outputs.full_js, "false");
    assert.equal(outputs.js_build_filters, "--filter=..../filefn/core");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test("a package under a workspace's node_modules also selects the workspaces nested inside it", () => {
  const { root, plan } = devfnFixture({
    "package-lock.json": `${JSON.stringify(fixtureLockfile(), null, 2)}\n`,
    "otherfn/cli/example/package.json": JSON.stringify({ name: "@otherfn/cli-example", scripts: { build: "vite build" } }),
  });
  try {
    const outputs = plan(editLockfile((packages) => { packages["otherfn/cli/node_modules/vite"] = { version: "6.0.0" }; }));
    assert.equal(outputs.full_js, "false");
    assert.equal(outputs.js_build_filters, "--filter=..../otherfn/cli --filter=..../otherfn/cli/example");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test("a changed package without a task still runs that task in its dependents", () => {
  const { root, plan } = devfnFixture({
    "basefn/core/package.json": JSON.stringify({ name: "@basefn/core" }),
    "basefn/app/package.json": JSON.stringify({ name: "@basefn/app", dependencies: { "@basefn/core": "*" }, scripts: { typecheck: "tsc", test: "vitest run", lint: "eslint ." } }),
  });
  try {
    const outputs = plan(({ put, read }) => put("basefn/core/index.js", "export {};\n"));
    assert.equal(outputs.js_typecheck_filters, "--filter=..../basefn/core");
    assert.equal(outputs.has_js_typecheck, "true");
    assert.equal(outputs.has_js_lint, "true");
    assert.equal(outputs.has_js_test, "true");
    assert.equal(outputs.has_js_build, "false");
    assert.equal(outputs.js_test_filters, `--filter=..../basefn/core ${EXCLUDE_DEVFN}`);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test("a package directory Turbo cannot take as a filter fails the plan when a filter would name it", () => {
  for (const [dir, file] of [
    ["filefn/reference assets", "filefn/reference assets/notes.md"],
    ["devfn/reference assets", "README.md"],
    ["filefn/reference...", "filefn/reference.../notes.md"],
    ["filefn/{x}", "filefn/{x}/notes.md"],
  ]) {
    const { root, plan } = devfnFixture({ [`${dir}/package.json`]: JSON.stringify({ name: "@fixture/odd" }), "README.md": "# Fixture\n" });
    try {
      assert.throws(() => plan(({ put }) => put(file, "changed\n")), (error) => {
        assert.match(String(error.stderr), /cannot be passed to Turbo as filters/, dir);
        return true;
      }, dir);
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
  }
  // Outside DevFn, an odd directory that no filter names does not block other changes or a full run.
  const odd = devfnFixture({ "fixtures/with space/package.json": JSON.stringify({ name: "@fixture/odd" }) });
  try {
    assert.equal(odd.plan("filefn/core/src/index.ts").js_build_filters, "--filter=..../filefn/core");
    assert.equal(odd.plan("filefn/core/src/index.ts", { CI_PLAN_MODE: "full" }).full_js, "true");
  } finally { rmSync(odd.root, { recursive: true, force: true, maxRetries: 5 }); }
  // A leading dot, as in .github/apifn-cli-install, is fine.
  const { root, plan } = devfnFixture({ ".github/apifn-cli-install/package.json": JSON.stringify({ name: "apifn-cli-install" }) });
  try {
    assert.equal(plan(".github/apifn-cli-install/package.json").js_build_filters, "--filter=..../.github/apifn-cli-install");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test("a package whose code references another package's files by relative path is selected with it", () => {
  const { root, plan } = devfnFixture({
    // otherfn/cli's test imports filefn/core's source without depending on it; filefn/core's own "../" paths stay inside it.
    "otherfn/cli/tests/integration.test.ts": 'import { x } from "../../../filefn/core/src/index.ts";\nconst outside = "../../../../elsewhere";\n',
    "filefn/core/tests/self.test.ts": 'import "../src/index.ts";\n',
    "devfn/core/tests/reads-clifn.test.ts": 'import "../../../clifn/core/src/index.ts";\n',
    // A direct manifest edge, so the manifest graph reaches devfn/core before its reference is followed.
    "devfn/core/package.json": JSON.stringify({ name: "@devfn/core", scripts: { build: "tsc", test: "vitest run" }, dependencies: { "@clifn/core": "*" }, devDependencies: { "@devfn/config": "*" } }),
  });
  try {
    const outputs = plan("filefn/core/src/index.ts");
    assert.equal(outputs.full_js, "false");
    assert.equal(outputs.js_build_filters, "--filter=..../filefn/core --filter=..../otherfn/cli");
    assert.equal(outputs.js_test_filters, `--filter=..../filefn/core --filter=..../otherfn/cli ${EXCLUDE_DEVFN}`);
    // devfn/core depends on clifn/core by manifest and also reads its files; the reference still makes it a seed, since the
    // manifest may pin a published version Turbo treats as external.
    assert.match(plan("clifn/core/src/index.ts").js_build_filters, /--filter=\.\.\.\.\/devfn\/core/);
    // Nothing references otherfn/cli, so a change there selects only it.
    assert.equal(plan("otherfn/cli/src/index.ts").js_build_filters, "--filter=..../otherfn/cli");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test("a new workspace's lockfile entries select only that workspace", () => {
  const { root, plan } = lockfileFixture();
  try {
    const outputs = plan(({ put, read }) => {
      put("newfn/core/package.json", JSON.stringify({ name: "@newfn/core", scripts: { build: "tsc", test: "vitest run" } }));
      editLockfile((packages) => {
        packages["newfn/core"] = { name: "@newfn/core", version: "0.0.1" };
        packages["node_modules/@newfn/core"] = { resolved: "newfn/core", link: true };
      })({ put, read });
    });
    assert.equal(outputs.full_js, "false");
    assert.equal(outputs.js_build_filters, "--filter=..../newfn/core");
    assert.equal(outputs.run_devfn, "false");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test("lockfile changes outside workspace entries and root config force a full JavaScript run", () => {
  const { root, plan } = lockfileFixture();
  try {
    for (const [name, change] of [
      ["external package", editLockfile((packages) => { packages["node_modules/left-pad"].version = "1.3.1"; })],
      ["added external package", editLockfile((packages) => { packages["node_modules/right-pad"] = { version: "1.0.0" }; })],
      ["package nested outside any workspace", editLockfile((packages) => { packages["tools/node_modules/left-pad"] = { version: "1.0.0" }; })],
      ["root entry", editLockfile((packages) => { packages[""].devDependencies = { turbo: "2.0.0" }; })],
      ["top-level field", editLockfile((packages, lockfile) => { lockfile.lockfileVersion = 4; })],
      ["link to a missing directory", editLockfile((packages) => { packages["node_modules/@ghost/pkg"] = { resolved: "ghost/pkg", link: true }; })],
      ["workspace link removed (a rename)", editLockfile((packages) => {
        delete packages["node_modules/@filefn/core"];
        packages["node_modules/@filefn/renamed"] = { resolved: "filefn/core", link: true };
      })],
      ["workspace link retargeted", editLockfile((packages) => { packages["node_modules/@filefn/core"].resolved = "clifn/core"; })],
      ["key one character past a workspace", editLockfile((packages) => { packages["filefn/cores"] = { version: "1.0.0" }; })],
      ["unparseable lockfile", ({ put }) => put("package-lock.json", "{ not json\n")],
      ["root package.json", "package.json"],
    ]) {
      const outputs = plan(change);
      assert.equal(outputs.full_js, "true", name);
      assert.equal(outputs.js_build_filters, "", name);
      assert.equal(outputs.run_devfn, "true", name);
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test("CI_PLAN_MODE=full plans every job whatever changed", () => {
  const { root, plan } = lockfileFixture();
  try {
    const outputs = plan("filefn/core/src/index.ts", { CI_PLAN_MODE: "full" });
    assert.equal(outputs.plan_mode, "full");
    assert.equal(outputs.full_js, "true");
    assert.equal(outputs.full_python, "true");
    assert.equal(outputs.run_python, "true");
    assert.equal(outputs.run_mcpfn, "true");
    assert.equal(outputs.mcpfn_only, "false");
    assert.equal(outputs.run_devfn, "true");
    assert.equal(outputs.js_build_filters, "");
    // Any other value plans the affected selection.
    const affected = plan("filefn/core/src/index.ts", { CI_PLAN_MODE: "something-else" });
    assert.equal(affected.plan_mode, "affected");
    assert.equal(affected.full_js, "false");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
