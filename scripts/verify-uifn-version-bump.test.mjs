import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { gitBinary } from "./verify-package-lockfiles.mjs";
import { changelogHasEntry, classifyPath, compareSemver, reportSincePublished } from "./verify-uifn-version-bump.mjs";

const script = fileURLToPath(new URL("./verify-uifn-version-bump.mjs", import.meta.url));

function manifest(name, version, extra = {}) {
  return `${JSON.stringify({ name, version, files: ["dist", "README.md", "CHANGELOG.md"], scripts: { build: "tsup", test: "vitest run" }, ...extra }, null, 2)}\n`;
}

// Fixture repo: stable @uifn/core and @uifn/react (react depends on core), experimental @uifn/patterns.
function fixtureRepo(t) {
  const root = mkdtempSync(path.join(tmpdir(), "uifn-version-bump-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "Bump Test", GIT_AUTHOR_EMAIL: "bump@example.invalid", GIT_COMMITTER_NAME: "Bump Test", GIT_COMMITTER_EMAIL: "bump@example.invalid" };
  const git = (...args) =>
    execFileSync(gitBinary(), ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "--quiet", "--allow-empty", "-m", message);
  };
  const edit = (file, replace) => write(file, replace(readFileSync(path.join(root, file), "utf8")));
  git("init", "--quiet", "--initial-branch=dev");
  write("uifn/package-graph.json", JSON.stringify({
    stable: [{ name: "@uifn/core", path: "uifn/core" }, { name: "@uifn/react", path: "uifn/react" }],
    experimental: [{ name: "@uifn/patterns", path: "uifn/patterns" }],
  }));
  write("release-packages.json", JSON.stringify([
    { slug: "uifn-core", path: "uifn/core", name: "@uifn/core" },
    { slug: "uifn-react", path: "uifn/react", name: "@uifn/react" },
  ]));
  write("uifn/core/package.json", manifest("@uifn/core", "1.0.0"));
  write("uifn/core/src/index.ts", "export const core = 1;\n");
  write("uifn/core/CHANGELOG.md", "# Changelog\n\n## 1.0.0 - 2026-01-01\n\n- Initial.\n");
  write("uifn/react/package.json", manifest("@uifn/react", "1.0.0", { dependencies: { "@uifn/core": "1.0.0" } }));
  write("uifn/react/src/index.ts", "export const react = 1;\n");
  write("uifn/patterns/package.json", manifest("@uifn/patterns", "0.1.0-experimental.0"));
  write("uifn/patterns/src/index.ts", "export const patterns = 1;\n");
  commit("base");
  git("branch", "base");
  return { root, git, write, edit, commit };
}

function check(root) {
  const result = spawnSync(process.execPath, [script, "--base", "base"], { cwd: root, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("shipped source change without a version bump fails and names the package", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/core/src/index.ts", "export const core = 2;\n");
  repo.commit("change core");
  const { status, output } = check(repo.root);
  assert.equal(status, 1);
  assert.match(output, /@uifn\/core: shipped code changed \(src\/index\.ts\) but version is still 1\.0\.0/);
  assert.doesNotMatch(output, /@uifn\/react/);
});

test("version bump without a changelog entry fails", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/core/src/index.ts", "export const core = 2;\n");
  repo.edit("uifn/core/package.json", (text) => text.replace('"1.0.0"', '"1.0.1"'));
  repo.commit("bump core only");
  const { status, output } = check(repo.root);
  assert.equal(status, 1);
  assert.match(output, /@uifn\/core: version bumped to 1\.0\.1 but uifn\/core\/CHANGELOG\.md has no "## 1\.0\.1" entry/);
});

test("version bump with a heading but no changelog content fails", (t) => {
  const repo = fixtureRepo(t);
  repo.edit("uifn/core/package.json", (text) => text.replace('"1.0.0"', '"1.0.1"'));
  repo.edit("uifn/core/CHANGELOG.md", (text) => text.replace("## 1.0.0", "## 1.0.1\n\n## 1.0.0"));
  repo.commit("empty entry");
  assert.equal(check(repo.root).status, 1);
});

test("shipped change with a version bump and changelog entry passes", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/core/src/index.ts", "export const core = 2;\n");
  repo.edit("uifn/core/package.json", (text) => text.replace('"1.0.0"', '"1.0.1"'));
  repo.edit("uifn/core/CHANGELOG.md", (text) => text.replace("## 1.0.0", "## 1.0.1 - 2026-02-01\n\n- Changed core.\n\n## 1.0.0"));
  repo.commit("release core");
  const { status, output } = check(repo.root);
  assert.equal(status, 0, output);
  assert.match(output, /ok @uifn\/core: 1\.0\.0 -> 1\.0\.1 with changelog entry/);
});

test("test-only, docs-only, fixture and non-published manifest changes pass without a bump", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/core/src/__tests__/core.test.ts", "test;\n");
  repo.write("uifn/core/src/index.spec.ts", "test;\n");
  repo.write("uifn/core/fixtures/case.json", "{}\n");
  repo.write("uifn/core/README.md", "# Core\n");
  repo.write("uifn/core/vitest.config.ts", "export default {};\n");
  repo.write("uifn/core/vite.config.ts", "export default {};\n");
  repo.edit("uifn/core/package.json", (text) => text.replace('"test": "vitest run"', '"test": "vitest run --coverage"').replace('"files"', '"devDependencies": { "vitest": "3.0.0" },\n  "files"'));
  repo.commit("tests and docs");
  const { status, output } = check(repo.root);
  assert.equal(status, 0, output);
});

test("a dependency-only bump in a dependent package needs its own bump", (t) => {
  const repo = fixtureRepo(t);
  repo.edit("uifn/react/package.json", (text) => text.replace('"@uifn/core": "1.0.0"', '"@uifn/core": "1.0.1"'));
  repo.commit("follow core");
  const { status, output } = check(repo.root);
  assert.equal(status, 1);
  assert.match(output, /@uifn\/react: shipped code changed \(package\.json \(published fields\)\)/);
});

test("experimental packages are not checked", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/patterns/src/index.ts", "export const patterns = 2;\n");
  repo.commit("change patterns");
  assert.equal(check(repo.root).status, 0);
});

test("a version that does not increase fails", (t) => {
  const repo = fixtureRepo(t);
  repo.edit("uifn/core/package.json", (text) => text.replace('"1.0.0"', '"1.0.0-rc.1"'));
  repo.edit("uifn/core/CHANGELOG.md", (text) => text.replace("## 1.0.0", "## 1.0.0-rc.1\n\n- Oops.\n\n## 1.0.0"));
  repo.commit("downgrade");
  const { status, output } = check(repo.root);
  assert.equal(status, 1);
  assert.match(output, /version 1\.0\.0-rc\.1 must be greater than 1\.0\.0/);
});

test("changes already on the base branch after the merge base are not attributed to the PR", (t) => {
  const repo = fixtureRepo(t);
  repo.git("checkout", "--quiet", "-b", "feature");
  repo.write("uifn/core/README.md", "# Core docs\n");
  repo.commit("docs only");
  repo.git("checkout", "--quiet", "base");
  repo.write("uifn/react/src/index.ts", "export const react = 2;\n");
  repo.commit("base moved");
  repo.git("checkout", "--quiet", "feature");
  assert.equal(check(repo.root).status, 0);
});

test("since-published report lists packages with shipped changes after their highest tag", (t) => {
  const repo = fixtureRepo(t);
  repo.git("tag", "uifn-core-v0.9.0", "HEAD");
  repo.write("uifn/core/src/index.ts", "export const core = 2;\n");
  repo.commit("after old tag");
  repo.git("tag", "uifn-core-v1.0.0");
  repo.git("tag", "uifn-react-v1.0.0");
  repo.write("uifn/react/src/index.ts", "export const react = 2;\n");
  repo.commit("unreleased react change");
  const report = Object.fromEntries(reportSincePublished({ cwd: repo.root }).map((entry) => [entry.name, entry]));
  assert.equal(report["@uifn/core"].tag, "uifn-core-v1.0.0");
  assert.deepEqual(report["@uifn/core"].shippedFiles, []);
  assert.deepEqual(report["@uifn/react"].shippedFiles, ["uifn/react/src/index.ts"]);
  const cli = spawnSync(process.execPath, [script, "--since-published"], { cwd: repo.root, encoding: "utf8" });
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /1 of 2 stable packages have shipped changes/);
});

test("classifyPath separates tarball inputs from tests, fixtures, stories and docs", () => {
  for (const file of ["src/index.ts", "lib/Button.svelte", "styles.css", "tsup.config.ts", "tsconfig.json", "migrations/removed.json", "src/fixture.ts", "src/preset/fixtures.ts", ".npmignore"]) {
    assert.equal(classifyPath(file), "shipped", file);
  }
  for (const file of ["src/__tests__/a.ts", "tests/a.ts", "src/test/setup.ts", "src/a.test.tsx", "lib/a.spec.ts", "src/a.stories.tsx", "fixtures/a.json", "src/__tests__/fixtures/a.ts", "README.md", "docs/hooks.md", "CHANGELOG.md", "vitest.ssr.config.ts", "playwright.config.ts", "browser/main.ts", "type-tests/a.ts", "stories/a.tsx", "workbenches/react/harness.tsx"]) {
    assert.equal(classifyPath(file), "excluded", file);
  }
  assert.equal(classifyPath("package.json"), "manifest");
  assert.equal(classifyPath("vite.config.ts", { buildUsesVite: true }), "shipped");
  assert.equal(classifyPath("vite.config.ts", { buildUsesVite: false }), "excluded");
});

test("changelogHasEntry matches the exact version heading with content", () => {
  const text = "# Changelog\n\n## [0.0.10] - 2026-01-02\n\n### Fixed\n\n- Ten.\n\n## 0.0.2\n\n## 0.0.1\n- One.\n";
  assert.equal(changelogHasEntry(text, "0.0.10"), true);
  assert.equal(changelogHasEntry(text, "0.0.1"), true);
  assert.equal(changelogHasEntry(text, "0.0.2"), false);
  assert.equal(changelogHasEntry(text, "0.0.3"), false);
  assert.equal(changelogHasEntry(null, "0.0.1"), false);
});

test("compareSemver follows prerelease precedence", () => {
  assert.ok(compareSemver("1.0.0", "1.0.0-rc.1") > 0);
  assert.ok(compareSemver("1.0.0-rc.2", "1.0.0-rc.10") < 0);
  assert.ok(compareSemver("0.0.10", "0.0.9") > 0);
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
});
