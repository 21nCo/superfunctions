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
    for (const file of ["package.json", "package-lock.json", "turbo.json"]) put(file, "{}\n");
    put("scripts/run-owned-step.mjs", "// fixture\n");
    for (const directory of ["packages/oauth-core", "packages/oauth-storage", "packages/auth", "packages/admin", "packages/db", "packages/http", "packages/observability", "datafn/core", "datafn/server", "mcpfn/core"]) {
      put(`${directory}/package.json`, JSON.stringify({name:directory.replaceAll("/", "-"),scripts:{test:"echo test"}}));
      put(`${directory}/src/index.ts`, "// fixture\n");
    }
    git("init", "--quiet", "--initial-branch=dev");
    git("add", "."); git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    for (const [file, python, js, mcp = false, mcpOnly = false] of [
      [".github/workflows/ci.yml", true, true, true],
      ["scripts/ci-plan.mjs", true, true, true],
      ["README.md", false, false],
      ...["package.json", "package-lock.json", "turbo.json", "scripts/run-owned-step.mjs"].map(file => [file, false, true, true]),
      ...["oauth-core", "oauth-storage", "auth", "admin", "db", "http", "observability"].map(name => [`packages/${name}/src/index.ts`, false, true, true]),
      ["datafn/core/src/index.ts", false, true, true],
      ["datafn/server/src/index.ts", false, true, true, true],
      ["mcpfn/core/src/index.ts", false, true, true, true],
      ["docsfn/docs/content.md", false, true],
    ]) {
      git("reset", "--hard", base);
      const prior = readFileSync(path.join(root, file), "utf8");
      put(file, prior + (file.endsWith(".json") ? "\n " : file.endsWith(".mjs") ? "\n// changed\n" : "\n# changed\n"));
      git("add", file); git("commit", "--quiet", "-m", "change");
      put(".git/event.json", JSON.stringify({ before: base }));
      const outputFile = path.join(root, ".git/outputs");
      writeFileSync(outputFile, "");
      execFileSync(process.execPath, ["scripts/ci-plan.mjs"], { cwd: root, env: { ...env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: path.join(root, ".git/event.json"), GITHUB_OUTPUT: outputFile }, stdio: ["ignore", "pipe", "pipe"] });
      const outputs = readFileSync(outputFile, "utf8");
      assert.match(outputs, new RegExp(`^run_python<<__CI_EOF__\n${python}\n__CI_EOF__$`, "m"), file);
      assert.match(outputs, new RegExp(`^run_js<<__CI_EOF__\n${js}\n__CI_EOF__$`, "m"), file);
      assert.match(outputs, new RegExp(`^run_mcpfn<<__CI_EOF__\n${mcp}\n__CI_EOF__$`, "m"), file);
      assert.match(outputs, new RegExp(`^mcpfn_only<<__CI_EOF__\n${mcpOnly}\n__CI_EOF__$`, "m"), file);
      assert.doesNotMatch(outputs, /run_docs(?:=|<<)/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
