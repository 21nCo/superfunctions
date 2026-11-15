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
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    assert.match(outputs, /^js_test_filters<<__CI_EOF__\n--filter=\.\.\.\.\/devfn\/core --filter=\.\.\.\.\/devfn\/proxy\n__CI_EOF__$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test("a pull request whose base branch cannot be fetched falls back to base.sha", () => {
  const { dir, origin, work, oldBase, gitIn, commitIn, plan } = pullRequestFixture("ci-plan-merge-base-fallback-");
  try {
    commitIn(work, "README.md", "# pull request change");
    commitIn(origin, "scripts/ci-plan.mjs", "// base change");
    gitIn(work, "fetch", "--quiet", "origin");
    gitIn(work, "merge", "--quiet", "--no-edit", "origin/dev");
    gitIn(work, "remote", "set-url", "origin", path.join(dir, "missing"));
    gitIn(work, "update-ref", "-d", "refs/remotes/origin/dev");
    const outputs = plan({ base: { ref: "dev", sha: oldBase } });
    assert.equal(outputs.base_ref, oldBase);
    assert.equal(outputs.full_python, "true");
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});
