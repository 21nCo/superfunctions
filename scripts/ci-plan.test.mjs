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
  const plan = (file) => {
    git("reset", "--quiet", "--hard", base);
    put(file, `${readFileSync(path.join(root, file), "utf8")}\n`);
    git("add", "."); git("commit", "--quiet", "-m", `change ${file}`);
    put(".git/event.json", JSON.stringify({ before: base }));
    const outputFile = path.join(root, ".git/outputs");
    writeFileSync(outputFile, "");
    execFileSync(process.execPath, ["scripts/ci-plan.mjs"], { cwd: root, env: { ...env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: path.join(root, ".git/event.json"), GITHUB_OUTPUT: outputFile }, stdio: ["ignore", "pipe", "pipe"] });
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

test("a lockfile-only change runs every DevFn package in the DevFn job and none in the JavaScript job", () => {
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
