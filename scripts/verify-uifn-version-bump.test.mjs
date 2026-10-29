import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { gitBinary } from "./verify-package-lockfiles.mjs";
import { changelogHasEntry, classifyPath, compareSemver, entryReferences, evaluatePackage, fileInventory, fileReferences, globToRegExp, invokedScripts, parseInputDeclarations, reportSincePublished, resolveReference, scriptReferences, shippedScriptNames, tsconfigEntries } from "./verify-uifn-version-bump.mjs";

const script = fileURLToPath(new URL("./verify-uifn-version-bump.mjs", import.meta.url));

function manifest(name, version, extra = {}) {
  return `${JSON.stringify({ name, version, files: ["dist", "README.md", "CHANGELOG.md"], scripts: { build: "tsup", test: "vitest run" }, ...extra }, null, 2)}\n`;
}

// Fixture repo: stable @uifn/core and @uifn/react (react depends on core), experimental @uifn/patterns.
// Declared out-of-package inputs: core's build reads uifn/catalog/catalog.json; react bundles uifn/shared/src.
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
  write("uifn/core/scripts/build.mjs", 'const catalog = path.resolve(packageRoot, "..", "catalog", "catalog.json");\n');
  write("uifn/core/generated/inventory.json", "{}\n");
  write("uifn/catalog/catalog.json", '{ "primitives": [] }\n');
  write("uifn/shared/src/index.ts", "export const shared = 1;\n");
  write("uifn/shared/src/__tests__/shared.test.ts", "test;\n");
  write("uifn/version-bump-inputs.json", JSON.stringify({
    packages: {
      "@uifn/core": { inputs: { "uifn/catalog/catalog.json": "build reads it" }, excluded: { "generated/inventory.json": "read from a checkout at run time" } },
      "@uifn/react": { inputs: { "uifn/shared/src": "bundled through a relative import" } },
    },
  }));
  write("uifn/core/CHANGELOG.md", "# Changelog\n\n## 1.0.0 - 2026-01-01\n\n- Initial.\n");
  write("uifn/react/package.json", manifest("@uifn/react", "1.0.0", { dependencies: { "@uifn/core": "1.0.0" } }));
  write("uifn/react/src/index.ts", 'export { shared } from "../../shared/src/index";\nexport const react = 1;\n');
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

test("a declared out-of-package input change without a bump fails and names the dependent package", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/catalog/catalog.json", '{ "primitives": ["button"] }\n');
  repo.write("uifn/shared/src/index.ts", "export const shared = 2;\n");
  repo.commit("change external inputs only");
  const { status, output } = check(repo.root);
  assert.equal(status, 1);
  assert.match(output, /@uifn\/core: shipped code changed \(uifn\/catalog\/catalog\.json\) but version is still 1\.0\.0/);
  assert.match(output, /@uifn\/react: shipped code changed \(uifn\/shared\/src\/index\.ts\) but version is still 1\.0\.0/);
});

test("tests inside a declared input and declared exclusions need no bump", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/shared/src/__tests__/shared.test.ts", "test 2;\n");
  repo.write("uifn/core/generated/inventory.json", '{ "stories": 1 }\n');
  repo.commit("tests and excluded inventory");
  const { status, output } = check(repo.root);
  assert.equal(status, 0, output);
});

test("a declared input change with a bump and changelog entry passes", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/catalog/catalog.json", '{ "primitives": ["button"] }\n');
  repo.edit("uifn/core/package.json", (text) => text.replace('"1.0.0"', '"1.0.1"'));
  repo.edit("uifn/core/CHANGELOG.md", (text) => text.replace("## 1.0.0", "## 1.0.1\n\n- Catalog adds button.\n\n## 1.0.0"));
  repo.commit("release core for catalog");
  const { status, output } = check(repo.root);
  assert.equal(status, 0, output);
});

test("undeclared out-of-root imports, path segments and build scripts fail closed", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/core/src/extra.ts", 'import data from "../../catalog/extra.json";\n');
  repo.write("uifn/core/tsup.config.ts", 'const x = path.join(root, "..", "theme", "tokens.css");\n');
  repo.edit("uifn/react/package.json", (text) => text.replace('"build": "tsup"', '"build": "node ../../scripts/build-react.mjs"'));
  repo.write("scripts/build-react.mjs", "\n");
  repo.edit("uifn/version-bump-inputs.json", (text) => text.replace('"uifn/shared/src":"bundled through a relative import"', ""));
  repo.commit("new undeclared inputs");
  const { status, output } = check(repo.root);
  assert.equal(status, 1);
  assert.match(output, /@uifn\/core: uifn\/core\/src\/extra\.ts refers to uifn\/catalog\/extra\.json, outside uifn\/core/);
  assert.match(output, /@uifn\/core: uifn\/core\/tsup\.config\.ts refers to uifn\/theme\/tokens\.css, outside uifn\/core/);
  assert.match(output, /@uifn\/react: package\.json scripts\.build refers to scripts\/build-react\.mjs, outside uifn\/react/);
  assert.match(output, /@uifn\/react: uifn\/react\/src\/index\.ts refers to uifn\/shared\/src\/index, outside uifn\/react/);
});

test("a relative import a shipped source bundles may not resolve into a path declared only as a reference", (t) => {
  const repo = fixtureRepo(t);
  repo.edit("uifn/version-bump-inputs.json", (text) => text.replace('"@uifn/react":{"inputs"', '"@uifn/react":{"references"'));
  repo.write("uifn/react/tsconfig.json", '{ "compilerOptions": { "paths": { "@uifn/shared": ["../shared/src/index.ts"] } }, "include": ["src"] }\n');
  repo.commit("declare the bundled source as a reference");
  const bundled = check(repo.root);
  assert.equal(bundled.status, 1);
  assert.match(bundled.output, /@uifn\/react: uifn\/react\/src\/index\.ts imports uifn\/shared\/src\/index, which uifn\/version-bump-inputs\.json declares only under "references"/);
  repo.write("uifn/react/src/index.ts", "export const react = 1;\n");
  repo.commit("type-check through tsconfig paths only");
  const typechecked = check(repo.root);
  assert.doesNotMatch(typechecked.output, /declares only under "references"/);
  assert.doesNotMatch(typechecked.output, /refers to uifn\/shared/);
});

test("a bundled directory import counts as declared only when the files it resolves to are inputs", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/shared/src/version.ts", "export const version = 1;\n");
  repo.write("uifn/react/src/index.ts", 'export { shared } from "../../shared/src";\nexport const react = 1;\n');
  repo.edit("uifn/version-bump-inputs.json", (text) => text.replace('"uifn/shared/src":', '"uifn/shared/src/version.ts":'));
  repo.edit("uifn/react/package.json", (text) => text.replace('"1.0.0",', '"1.0.1",'));
  repo.write("uifn/react/CHANGELOG.md", "# Changelog\n\n## 1.0.1\n\n- Narrow the shared input.\n");
  repo.commit("narrow the input below the directory react bundles");
  const { status, output } = check(repo.root);
  assert.equal(status, 1, output);
  assert.match(output, /@uifn\/react: uifn\/react\/src\/index\.ts refers to uifn\/shared\/src, outside uifn\/react/);
});

test("a bundled import of a single-file input passes with a .js or no extension", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/shared/runtime.ts", "export const runtime = 1;\n");
  repo.write("uifn/core/src/index.ts", 'export { runtime } from "../../shared/runtime.js";\nexport const core = 1;\n');
  repo.write("uifn/core/src/again.ts", 'export { runtime } from "../../shared/runtime";\n');
  repo.edit("uifn/version-bump-inputs.json", (text) => text.replace('"uifn/catalog/catalog.json":', '"uifn/shared/runtime.ts":"bundled through a relative import","uifn/catalog/catalog.json":'));
  repo.edit("uifn/core/package.json", (text) => text.replace('"1.0.0"', '"1.0.1"'));
  repo.edit("uifn/core/CHANGELOG.md", (text) => text.replace("## 1.0.0", "## 1.0.1\n\n- Bundle the shared runtime.\n\n## 1.0.0"));
  repo.commit("bundle a single-file input");
  const { status, output } = check(repo.root);
  assert.equal(status, 0, output);
});

// Core ships styles.css through files, compiles src, and keeps a verification helper and a data dir it never ships.
function withExclusions(repo, excluded) {
  repo.edit("uifn/core/package.json", (text) => text.replace('"files": [', '"files": [\n    "styles.css",'));
  repo.write("uifn/core/styles.css", ".a {}\n");
  repo.write("uifn/core/tsconfig.json", '{ "include": ["src/**/*"] }\n');
  repo.write("uifn/core/scripts/verify-helper.mjs", "export const helper = 1;\n");
  repo.write("uifn/core/data/contract.json", "{}\n");
  repo.edit("uifn/version-bump-inputs.json", (text) => {
    const document = JSON.parse(text);
    Object.assign(document.packages["@uifn/core"].excluded, excluded);
    return JSON.stringify(document);
  });
  repo.commit("declare exclusions");
  repo.git("branch", "-f", "base");
}

test("declared verification helpers and data dirs outside files need no bump", (t) => {
  const repo = fixtureRepo(t);
  withExclusions(repo, { "scripts/verify-helper.mjs": "used only by repo verifiers", data: "read only by tests" });
  repo.write("uifn/core/scripts/verify-helper.mjs", "export const helper = 2;\n");
  repo.write("uifn/core/data/contract.json", '{ "parts": 2 }\n');
  repo.commit("helper and data only");
  const { status, output } = check(repo.root);
  assert.equal(status, 0, output);
});

test("build scripts, files-listed assets and undeclared new dirs still need a bump", (t) => {
  const repo = fixtureRepo(t);
  withExclusions(repo, { "scripts/verify-helper.mjs": "used only by repo verifiers", data: "read only by tests" });
  repo.write("uifn/core/scripts/build.mjs", 'const catalog = path.resolve(packageRoot, "..", "catalog", "catalog.json");\nconst x = 2;\n');
  repo.write("uifn/core/styles.css", ".a { color: red }\n");
  repo.write("uifn/core/assets/icons.json", "{}\n");
  repo.commit("shipped changes");
  const { status, output } = check(repo.root);
  assert.equal(status, 1);
  assert.match(output, /@uifn\/core: shipped code changed \(assets\/icons\.json, scripts\/build\.mjs, styles\.css\) but version is still 1\.0\.0/);
});

test("an exclusion that files, a tsconfig include, a shipped file or a lifecycle script uses fails", (t) => {
  const repo = fixtureRepo(t);
  withExclusions(repo, { "styles.css": "x", "src/internal": "x", data: "x", "scripts/verify-helper.mjs": "x", missing: "x", tools: "x" });
  repo.write("uifn/core/src/internal/a.ts", "export const a = 1;\n");
  repo.write("uifn/core/src/index.ts", 'import contract from "../data/contract.json";\nexport const core = 1;\n');
  repo.edit("uifn/core/package.json", (text) => text.replace('"build": "tsup"', '"build": "node scripts/verify-helper.mjs && tsup"').replace('"files"', '"bin": { "core": "./tools/cli.mjs" },\n  "files"'));
  repo.write("uifn/core/tools/cli.mjs", "\n");
  repo.edit("uifn/core/CHANGELOG.md", (text) => text.replace("## 1.0.0", "## 1.0.1\n\n- Build.\n\n## 1.0.0"));
  repo.edit("uifn/core/package.json", (text) => text.replace('"1.0.0"', '"1.0.1"'));
  repo.commit("use excluded paths");
  const { status, output } = check(repo.root);
  assert.equal(status, 1);
  assert.match(output, /@uifn\/core excludes styles\.css, but package\.json files includes uifn\/core\/styles\.css/);
  assert.match(output, /@uifn\/core excludes src\/internal, but uifn\/core\/tsconfig\.json refers to uifn\/core\/src\/internal\/a\.ts/);
  assert.match(output, /@uifn\/core excludes data, but uifn\/core\/src\/index\.ts refers to uifn\/core\/data\/contract\.json/);
  assert.match(output, /@uifn\/core excludes scripts\/verify-helper\.mjs, but package\.json scripts\.build refers to uifn\/core\/scripts\/verify-helper\.mjs/);
  assert.match(output, /@uifn\/core excludes missing, which does not exist in uifn\/core/);
  assert.match(output, /@uifn\/core excludes tools, but package\.json bin refers to uifn\/core\/tools\/cli\.mjs/);
});

// Stable @uifn/theme bundles src/fixtures/data.ts, a path the fixtures rule would exclude, through src/index.ts.
test("a test, fixture or docs path that shipped code imports counts as shipped", (t) => {
  const repo = fixtureRepo(t);
  repo.edit("uifn/package-graph.json", (text) => text.replace('"stable":[', '"stable":[{"name":"@uifn/theme","path":"uifn/theme"},'));
  repo.write("uifn/theme/package.json", manifest("@uifn/theme", "0.0.2"));
  repo.write("uifn/theme/CHANGELOG.md", "# Changelog\n\n## 0.0.2\n\n- Fixtures.\n");
  repo.write("uifn/theme/tsup.config.ts", 'export default { entry: [path.join(root, "./src")] };\n');
  repo.write("uifn/theme/src/index.ts", 'export * from "./fixtures/data";\n');
  repo.write("uifn/theme/src/fixtures/data.ts", 'export { more } from "./more.js";\nexport const data = 1;\n');
  repo.write("uifn/theme/src/fixtures/more.ts", "export const more = 1;\n");
  repo.write("uifn/theme/src/__tests__/theme.test.ts", 'import { data } from "../fixtures/data";\n');
  repo.write("uifn/theme/src/__tests__/fixtures/case.ts", "export const fixture = 1;\n");
  repo.commit("theme bundles a fixtures dir");
  repo.git("branch", "-f", "base");
  repo.write("uifn/theme/src/__tests__/theme.test.ts", 'import { data } from "../fixtures/data";\ntest;\n');
  repo.write("uifn/theme/src/__tests__/fixtures/case.ts", "export const fixture = 2;\n");
  repo.commit("tests only");
  const tests = check(repo.root);
  assert.equal(tests.status, 0, tests.output);
  repo.write("uifn/theme/src/fixtures/data.ts", 'export { more } from "./more.js";\nexport const data = 2;\n');
  repo.write("uifn/theme/src/fixtures/more.ts", "export const more = 2;\n");
  repo.commit("bundled fixture data");
  const bundled = check(repo.root);
  assert.equal(bundled.status, 1);
  assert.match(bundled.output, /@uifn\/theme: shipped code changed \(src\/fixtures\/data\.ts, src\/fixtures\/more\.ts\) but version is still 0\.0\.2/);
});

test("resolveReference names files directly, through globs and through directories", () => {
  const inventory = fileInventory(["src/a.ts", "src/b/index.tsx", "src/c.mts", "src/d.svelte", "src/e.js", "src/fixtures/x.ts", "src/fixtures/deep/y.ts", "src/fixtures/z.json"]);
  const resolve = (target) => resolveReference(target, inventory);
  assert.deepEqual(resolve("src/a"), { files: ["src/a.ts"], direct: true });
  assert.deepEqual(resolve("src/b"), { files: ["src/b/index.tsx"], direct: true });
  assert.deepEqual(resolve("src/c.mjs"), { files: ["src/c.mts"], direct: true });
  assert.deepEqual(resolve("src/d.svelte"), { files: ["src/d.svelte"], direct: true });
  assert.deepEqual(resolve("src/e.js"), { files: ["src/e.js"], direct: true });
  assert.deepEqual(resolve("src/fixtures/*.ts"), { files: ["src/fixtures/x.ts"], direct: false });
  assert.deepEqual(resolve("src/fixtures/**/*.ts"), { files: ["src/fixtures/x.ts", "src/fixtures/deep/y.ts"], direct: false });
  assert.deepEqual(resolve("src/{a,fixtures/z}.{ts,json}"), { files: ["src/a.ts", "src/fixtures/z.json"], direct: false });
  assert.deepEqual(resolve("src/fixtures"), { files: ["src/fixtures/x.ts", "src/fixtures/deep/y.ts", "src/fixtures/z.json"], direct: false });
  assert.deepEqual(resolve("src/missing"), { files: [], direct: false });
});

test("globToRegExp matches *, **, ?, [...] and nested {a,b} without crossing directories by accident", () => {
  const cases = [
    ["src/*.ts", ["src/a.ts"], ["src/x/a.ts", "src/a.tsx"]],
    ["src/**/*.ts", ["src/a.ts", "src/x/y/a.ts"], ["lib/a.ts"]],
    ["src/**", ["src/a.ts", "src/x/a.ts"], ["srcx/a.ts"]],
    ["src/?.[jt]s", ["src/a.ts", "src/b.js"], ["src/ab.ts", "src/a.cs"]],
    ["src/[!a].ts", ["src/b.ts"], ["src/a.ts"]],
    ["src/{a,b/{c,d}}.ts", ["src/a.ts", "src/b/c.ts", "src/b/d.ts"], ["src/b.ts"]],
    ["src/a+b.(x).ts", ["src/a+b.(x).ts"], ["src/aab.x.ts"]],
  ];
  for (const [pattern, matches, misses] of cases) {
    for (const file of matches) assert.ok(globToRegExp(pattern).test(file), `${pattern} ${file}`);
    for (const file of misses) assert.ok(!globToRegExp(pattern).test(file), `${pattern} ${file}`);
  }
});

test("fileReferences reads bare strings only in build files, and marks tsconfig entries with their tsconfig", () => {
  const config = 'export default { entry: ["src/fixtures/runtime.ts", "src/*.ts"], format: ["esm"], external: ["node:fs"] };\n';
  const targets = (file, text, options) => fileReferences(file, text, options).map(({ target, soft }) => `${soft ? "~" : ""}${target}`);
  assert.deepEqual(targets("uifn/react/tsup.config.ts", config, { root: "uifn/react", buildFile: true }), ["~uifn/react/src/fixtures/runtime.ts", "~uifn/react/src/*.ts", "~uifn/react/esm"]);
  assert.deepEqual(targets("uifn/react/src/index.ts", config, { root: "uifn/react" }), []);
  assert.deepEqual(targets("uifn/solid/scripts/build.mjs", "path.join(packageRoot, 'tsconfig.build.json')", { root: "uifn/solid", buildFile: true }), ["~uifn/solid/tsconfig.build.json", "~uifn/solid/scripts/tsconfig.build.json"]);
  assert.deepEqual(targets("uifn/core/tsconfig.json", '{ "extends": "../../tsconfig.base.json", "include": ["src", "./tests/**/*"] }'), ["uifn/core/src", "uifn/core/tests/**/*", "tsconfig.base.json"]);
  assert.ok(fileReferences("uifn/core/tsconfig.json", '{ "include": ["src"] }').every(({ tsconfig }) => tsconfig === "uifn/core/tsconfig.json"));
  assert.deepEqual(targets("uifn/core/tsup.config.ts", 'entry: ["./src/fixtures/runtime.ts", "./src/index.ts"]', { root: "uifn/core" }), ["uifn/core/src/fixtures/runtime.ts", "uifn/core/src/fixtures/runtime.ts/src/index.ts", "uifn/core/src/index.ts"]);
  assert.deepEqual(targets("uifn/core/scripts/build.mjs", 'path.resolve(packageRoot, "..", "catalog", "catalog.json")', { root: "uifn/core", base: "uifn/core" }), ["uifn/core", "uifn/core/catalog/catalog.json", "uifn/catalog/catalog.json"]);
  const bundled = (text) => fileReferences("uifn/core/src/index.ts", text).filter((reference) => reference.bundled).map(({ target }) => target);
  assert.deepEqual(bundled('import a from "../a.js";\nexport * from "./b";\nconst c = await import("./c");\nrequire("./d");\nreadFileSync(path.join(here, "../e.json"));\n'), ["uifn/core/a.js", "uifn/core/src/b", "uifn/core/src/c", "uifn/core/src/d"]);
});

test("scriptReferences keeps glob tokens and names tsconfig.json for a bare tsc", () => {
  const targets = (scripts) => scriptReferences(scripts, "uifn/core").map(({ target }) => target);
  assert.ok(targets({ build: "tsup src/index.ts 'src/fixtures/*.ts'" }).includes("uifn/core/src/fixtures/*.ts"));
  assert.ok(targets({ build: "tsup && tsc --emitDeclarationOnly" }).includes("uifn/core/tsconfig.json"));
  for (const build of ["tsc -p tsconfig.build.json", "tsc --project=tsconfig.build.json", "tsup --tsconfig tsconfig.build.json"]) assert.ok(!targets({ build }).includes("uifn/core/tsconfig.json"), build);
});

test("an exclusion of a build config that tools load implicitly fails", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/react/tsup.config.ts", "export default {};\n");
  repo.write("uifn/react/tsconfig.build.json", "{}\n");
  repo.write("uifn/react/.npmignore", "src\n");
  repo.edit("uifn/version-bump-inputs.json", (text) => {
    const document = JSON.parse(text);
    document.packages["@uifn/react"].excluded = { "tsup.config.ts": "x", "tsconfig.build.json": "x", ".npmignore": "x" };
    return JSON.stringify(document);
  });
  repo.commit("exclude build configs");
  const { status, output } = check(repo.root);
  assert.equal(status, 1);
  for (const config of ["tsup\\.config\\.ts", "tsconfig\\.build\\.json", "\\.npmignore"]) {
    assert.match(output, new RegExp(`@uifn/react excludes ${config}, but the build loads ${config} implicitly`));
  }
});

test("a change cannot loosen its own declarations", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/core/data/contract.json", "{}\n");
  repo.commit("data dir");
  repo.git("branch", "-f", "base");
  repo.edit("uifn/version-bump-inputs.json", (text) => {
    const document = JSON.parse(text);
    document.packages["@uifn/core"] = { references: { "uifn/catalog/catalog.json": "moved" }, excluded: { ...document.packages["@uifn/core"].excluded, data: "new exclusion" } };
    return JSON.stringify(document);
  });
  repo.write("uifn/catalog/catalog.json", '{ "primitives": ["button"] }\n');
  repo.write("uifn/core/data/contract.json", '{ "parts": 2 }\n');
  repo.commit("move the input to references and exclude data in the same change");
  const { status, output } = check(repo.root);
  assert.equal(status, 1);
  assert.match(output, /@uifn\/core: shipped code changed \(uifn\/catalog\/catalog\.json, data\/contract\.json\) but version is still 1\.0\.0/);
});

test("a new path can be excluded in the same change, and a deleted one with its exclusion needs no bump", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/core/newdata/x.json", "{}\n");
  repo.edit("uifn/version-bump-inputs.json", (text) => {
    const document = JSON.parse(text);
    document.packages["@uifn/core"].excluded = { newdata: "read only by repository verifiers" };
    return JSON.stringify(document);
  });
  rmSync(path.join(repo.root, "uifn/core/generated/inventory.json"));
  repo.commit("add excluded data and retire the inventory with its exclusion");
  const { status, output } = check(repo.root);
  assert.equal(status, 0, output);
});

test("a package the change demotes is still judged at its merge-base path, and a removed package is not", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/package-graph.json", JSON.stringify({
    stable: [{ name: "@uifn/core", path: "uifn/core" }],
    experimental: [{ name: "@uifn/patterns", path: "uifn/patterns" }, { name: "@uifn/react", path: "uifn/react" }],
  }));
  repo.edit("uifn/version-bump-inputs.json", (text) => {
    const document = JSON.parse(text);
    delete document.packages["@uifn/react"];
    return JSON.stringify(document);
  });
  repo.write("uifn/react/src/index.ts", "export const react = 2;\n");
  repo.write("uifn/shared/src/index.ts", "export const shared = 2;\n");
  repo.commit("demote react and change it");
  const demoted = check(repo.root);
  assert.equal(demoted.status, 1);
  assert.match(demoted.output, /@uifn\/react: shipped code changed \(src\/index\.ts, uifn\/shared\/src\/index\.ts\) but version is still 1\.0\.0/);
  repo.git("reset", "--quiet", "--hard", "base");
  repo.write("uifn/package-graph.json", JSON.stringify({ stable: [{ name: "@uifn/core", path: "uifn/core" }], experimental: [{ name: "@uifn/patterns", path: "uifn/patterns" }] }));
  repo.edit("uifn/version-bump-inputs.json", (text) => {
    const document = JSON.parse(text);
    delete document.packages["@uifn/react"];
    return JSON.stringify(document);
  });
  rmSync(path.join(repo.root, "uifn/react"), { recursive: true });
  repo.commit("remove react");
  const removed = check(repo.root);
  assert.equal(removed.status, 0, removed.output);
});

// Core ships fixtures/ through files and exports one fixture file as a runtime entry point.
test("a file a manifest entry field names, and what it imports, counts as shipped", (t) => {
  const repo = fixtureRepo(t);
  repo.edit("uifn/core/package.json", (text) =>
    text
      .replace('"files": [', '"exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }, "./runtime": { "import": ["./fixtures/runtime.mjs"] } },\n  "files": [\n    "fixtures",')
      .replace('"1.0.0"', '"1.0.1"'),
  );
  repo.edit("uifn/core/CHANGELOG.md", (text) => text.replace("## 1.0.0", "## 1.0.1\n\n- Runtime entry.\n\n## 1.0.0"));
  repo.write("uifn/core/fixtures/runtime.mjs", 'export { helper } from "./helper.mjs";\n');
  repo.write("uifn/core/fixtures/helper.mjs", "export const helper = 1;\n");
  repo.write("uifn/core/fixtures/sample.json", "{}\n");
  repo.commit("export a fixtures runtime");
  repo.git("branch", "-f", "base");
  repo.write("uifn/core/fixtures/sample.json", '{ "sample": 2 }\n');
  repo.commit("unexported fixture");
  const unexported = check(repo.root);
  assert.equal(unexported.status, 0, unexported.output);
  repo.write("uifn/core/fixtures/runtime.mjs", 'export { helper } from "./helper.mjs";\nexport const runtime = 2;\n');
  repo.write("uifn/core/fixtures/helper.mjs", "export const helper = 2;\n");
  repo.commit("exported runtime");
  const exported = check(repo.root);
  assert.equal(exported.status, 1);
  assert.match(exported.output, /@uifn\/core: shipped code changed \(fixtures\/helper\.mjs, fixtures\/runtime\.mjs\) but version is still 1\.0\.1/);
});

// Core ships docs/ through files, like @uifn/registry, and src imports one table from it.
test("a docs asset needs no bump unless shipped code refers to it", (t) => {
  const repo = fixtureRepo(t);
  repo.edit("uifn/core/package.json", (text) => text.replace('"files": [', '"files": [\n    "docs",'));
  repo.write("uifn/core/docs/diagram.svg", "<svg/>\n");
  repo.write("uifn/core/docs/table.json", "{}\n");
  repo.write("uifn/core/src/index.ts", 'import table from "../docs/table.json";\nexport const core = 1;\n');
  repo.commit("docs assets");
  repo.git("branch", "-f", "base");
  repo.write("uifn/core/docs/diagram.svg", "<svg><g/></svg>\n");
  repo.commit("diagram only");
  const diagram = check(repo.root);
  assert.equal(diagram.status, 0, diagram.output);
  repo.write("uifn/core/docs/table.json", '{ "rows": 2 }\n');
  repo.commit("imported table");
  const table = check(repo.root);
  assert.equal(table.status, 1);
  assert.match(table.output, /@uifn\/core: shipped code changed \(docs\/table\.json\) but version is still 1\.0\.0/);
});

// React's tsup.config.ts names a fixtures file as a bare entry string, and core's build script names a fixtures glob.
test("a test or fixture file a build config or script names through a bare path or glob counts as shipped", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/react/tsup.config.ts", 'export default { entry: ["src/index.ts", "src/fixtures/runtime.ts"], format: ["esm"], external: ["react"] };\n');
  repo.write("uifn/react/src/fixtures/runtime.ts", "export const runtime = 1;\n");
  repo.write("uifn/react/src/fixtures/sample.json", "{}\n");
  repo.write("uifn/react/src/__tests__/react.test.ts", "test;\n");
  repo.edit("uifn/core/package.json", (text) => text.replace('"build": "tsup"', `"build": "tsup src/index.ts 'src/fixtures/*.ts'"`));
  repo.write("uifn/core/src/fixtures/entry.ts", "export const entry = 1;\n");
  repo.write("uifn/core/src/fixtures/notes.json", "{}\n");
  repo.commit("build entries under fixtures");
  repo.git("branch", "-f", "base");
  repo.write("uifn/react/src/fixtures/sample.json", '{ "sample": 2 }\n');
  repo.write("uifn/react/src/__tests__/react.test.ts", "test 2;\n");
  repo.write("uifn/core/src/fixtures/notes.json", '{ "notes": 2 }\n');
  repo.commit("unnamed fixtures and tests");
  const unnamed = check(repo.root);
  assert.equal(unnamed.status, 0, unnamed.output);
  repo.write("uifn/react/src/fixtures/runtime.ts", "export const runtime = 2;\n");
  repo.write("uifn/core/src/fixtures/entry.ts", "export const entry = 2;\n");
  repo.commit("named build entries");
  const named = check(repo.root);
  assert.equal(named.status, 1);
  assert.match(named.output, /@uifn\/react: shipped code changed \(src\/fixtures\/runtime\.ts\) but version is still 1\.0\.0/);
  assert.match(named.output, /@uifn\/core: shipped code changed \(src\/fixtures\/entry\.ts\) but version is still 1\.0\.0/);
});

test("each ./-prefixed entry in a build config array counts, and a joined path stays an extra candidate", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/core/tsup.config.ts", 'export default { entry: ["./src/fixtures/runtime.ts", "./src/index.ts"], format: ["esm"] };\n');
  repo.write("uifn/core/src/fixtures/runtime.ts", "export const runtime = 1;\n");
  repo.edit("uifn/core/package.json", (text) => text.replace('"1.0.0"', '"1.0.1"'));
  repo.edit("uifn/core/CHANGELOG.md", (text) => text.replace("## 1.0.0", "## 1.0.1\n\n- Runtime entry.\n\n## 1.0.0"));
  repo.commit("runtime entry");
  const added = check(repo.root);
  assert.equal(added.status, 0, added.output);
  repo.git("branch", "-f", "base");
  repo.write("uifn/core/src/fixtures/runtime.ts", "export const runtime = 2;\n");
  repo.commit("runtime only");
  const changed = check(repo.root);
  assert.equal(changed.status, 1);
  assert.match(changed.output, /@uifn\/core: shipped code changed \(src\/fixtures\/runtime\.ts\) but version is still 1\.0\.1/);
});

for (const specifier of ["../tools/runtime.js", "../tools/runtime"]) {
  test(`an exclusion that shipped code imports as ${specifier} fails, and a later change to it needs a bump`, (t) => {
    const repo = fixtureRepo(t);
    withExclusions(repo, { tools: "helpers outside files" });
    repo.write("uifn/core/tools/runtime.ts", "export const runtime = 1;\n");
    repo.write("uifn/core/src/index.ts", `export { runtime } from "${specifier}";\nexport const core = 1;\n`);
    repo.edit("uifn/core/package.json", (text) => text.replace('"1.0.0"', '"1.0.1"'));
    repo.edit("uifn/core/CHANGELOG.md", (text) => text.replace("## 1.0.0", "## 1.0.1\n\n- Runtime.\n\n## 1.0.0"));
    repo.commit("import an excluded helper");
    const imported = check(repo.root);
    assert.equal(imported.status, 1);
    assert.match(imported.output, /@uifn\/core excludes tools, but uifn\/core\/src\/index\.ts refers to uifn\/core\/tools\/runtime\.ts/);
    repo.git("branch", "-f", "base");
    repo.write("uifn/core/tools/runtime.ts", "export const runtime = 2;\n");
    repo.commit("helper only");
    const helper = check(repo.root);
    assert.equal(helper.status, 1);
    assert.match(helper.output, /@uifn\/core: shipped code changed \(tools\/runtime\.ts\) but version is still 1\.0\.1/);
  });
}

// tsc emits what tsconfig.build.json includes because the build names it; tsconfig.json only type-checks.
test("a tsconfig's entries count test paths only when the build names that tsconfig", (t) => {
  const repo = fixtureRepo(t);
  repo.edit("uifn/core/package.json", (text) => text.replace('"build": "tsup"', '"build": "tsup && tsc -p tsconfig.build.json"'));
  repo.write("uifn/core/tsconfig.json", '{ "include": ["src", "tests", "vitest.config.ts"] }\n');
  repo.write("uifn/core/tsconfig.build.json", '{ "include": ["src", "src/fixtures/emitted.ts"] }\n');
  repo.write("uifn/core/tests/core.ts", "test;\n");
  repo.write("uifn/core/vitest.config.ts", "export default {};\n");
  repo.write("uifn/core/src/fixtures/emitted.ts", "export const emitted = 1;\n");
  repo.commit("tsconfigs");
  repo.git("branch", "-f", "base");
  repo.write("uifn/core/tests/core.ts", "test 2;\n");
  repo.write("uifn/core/vitest.config.ts", "export default { test: {} };\n");
  repo.commit("type-checked tests only");
  const typechecked = check(repo.root);
  assert.equal(typechecked.status, 0, typechecked.output);
  repo.write("uifn/core/src/fixtures/emitted.ts", "export const emitted = 2;\n");
  repo.commit("emitted fixture");
  const emitted = check(repo.root);
  assert.equal(emitted.status, 1);
  assert.match(emitted.output, /@uifn\/core: shipped code changed \(src\/fixtures\/emitted\.ts\) but version is still 1\.0\.0/);
});

test("entryReferences reads every condition, array fallback and pattern of the entry fields", () => {
  const manifest = {
    main: "./dist/index.cjs",
    exports: { ".": { types: "./dist/index.d.ts", import: ["./dist/index.js"] }, "./themes/*": "./themes/*.css" },
    bin: { cli: "bin/cli.mjs" },
    browser: { "./dist/node.js": false },
    files: ["fixtures"],
  };
  assert.deepEqual(entryReferences(manifest, "uifn/core").map(({ target }) => target), ["uifn/core/dist/index.d.ts", "uifn/core/dist/index.js", "uifn/core/themes/**.css", "uifn/core/dist/index.cjs", "uifn/core/bin/cli.mjs"]);
  assert.ok(globToRegExp("uifn/core/themes/**.css").test("uifn/core/themes/dark/high.css"));
});

test("tsconfigEntries resolves include and files entries from the tsconfig directory, globs kept", () => {
  const text = '{ "compilerOptions": { "outDir": "dist" }, "include": ["src/**/*", "vitest.config.ts", "./lib"], "files": ["**/*.d.ts"] }';
  assert.deepEqual(tsconfigEntries("uifn/core/tsconfig.json", text), ["uifn/core/src/**/*", "uifn/core/vitest.config.ts", "uifn/core/lib", "uifn/core/**/*.d.ts"]);
});

test("a manifest change to a script reached from a lifecycle script needs a bump", (t) => {
  const repo = fixtureRepo(t);
  repo.edit("uifn/core/package.json", (text) => text.replace('"test": "vitest run"', '"test": "vitest run",\n    "prebuild": "npm run clean",\n    "clean": "rm -rf dist"'));
  repo.commit("add prebuild");
  const { status, output } = check(repo.root);
  assert.equal(status, 1);
  assert.match(output, /@uifn\/core: shipped code changed \(package\.json \(published fields\)\)/);
});

test("validation scripts that prepack runs need no bump, while the build it runs still does", (t) => {
  const repo = fixtureRepo(t);
  repo.edit("uifn/core/package.json", (text) =>
    text.replace('"test": "vitest run"', '"test": "vitest run",\n    "typecheck": "tsc --noEmit",\n    "generate:check": "node gen.mjs --check",\n    "prepack": "npm run generate:check && npm run typecheck && npm run test && npm run build"')
  );
  repo.commit("prepack validates before building");
  repo.git("branch", "-f", "base");
  repo.edit("uifn/core/package.json", (text) => text.replace('"vitest run"', '"vitest run --coverage"').replace('"tsc --noEmit"', '"tsc --noEmit --strict"').replace("--check", "--check --verbose"));
  repo.commit("validation scripts only");
  const validation = check(repo.root);
  assert.equal(validation.status, 0, validation.output);
  repo.edit("uifn/core/package.json", (text) => text.replace('"build": "tsup"', '"build": "tsup --minify"'));
  repo.commit("build script");
  const build = check(repo.root);
  assert.equal(build.status, 1);
  assert.match(build.output, /@uifn\/core: shipped code changed \(package\.json \(published fields\)\)/);
});

test("a script an install hook reaches needs a bump whatever its name, while prepack validation does not", (t) => {
  const repo = fixtureRepo(t);
  repo.edit("uifn/core/package.json", (text) => text.replace('"test": "vitest run"', '"test": "vitest run",\n    "postinstall": "npm run check:env",\n    "check:env": "node check-env.mjs",\n    "prepack": "npm run test && npm run build"'));
  repo.commit("install hook");
  repo.git("branch", "-f", "base");
  repo.edit("uifn/core/package.json", (text) => text.replace('"vitest run"', '"vitest run --coverage"'));
  repo.commit("prepack validation only");
  const validation = check(repo.root);
  assert.equal(validation.status, 0, validation.output);
  repo.edit("uifn/core/package.json", (text) => text.replace("node check-env.mjs", "node check-env.mjs --strict"));
  repo.commit("install-time check");
  const install = check(repo.root);
  assert.equal(install.status, 1);
  assert.match(install.output, /@uifn\/core: shipped code changed \(package\.json \(published fields\)\)/);
});

test("a script reached through any runner spelling needs a bump", async (t) => {
  for (const [hook, command] of [["postinstall", "npm --silent run setup"], ["postinstall", "pnpm run setup"], ["postinstall", "yarn setup"], ["prepack", "npm --silent run setup"]]) {
    await t.test(`${hook}: ${command}`, (t) => {
      const repo = fixtureRepo(t);
      repo.edit("uifn/core/package.json", (text) => text.replace('"test": "vitest run"', `"test": "vitest run",\n    "${hook}": "${command}",\n    "setup": "node setup.mjs"`));
      repo.commit("runner");
      repo.git("branch", "-f", "base");
      repo.edit("uifn/core/package.json", (text) => text.replace("node setup.mjs", "node setup.mjs --strict"));
      repo.commit("setup only");
      const result = check(repo.root);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /@uifn\/core: shipped code changed \(package\.json \(published fields\)\)/);
    });
  }
});

test("invokedScripts follows every command word that names a script, whatever the runner", () => {
  const scripts = { setup: "x", build: "x", "build:js": "x", "build:css": "x", test: "x", start: "x", stop: "x", lint: "x" };
  const invoked = (command) => [...invokedScripts(command, scripts)].sort();
  assert.deepEqual(invoked("npm --silent run setup"), ["setup"]);
  assert.deepEqual(invoked("npm -s run setup"), ["setup"]);
  assert.deepEqual(invoked("npm --prefix . run-script setup"), ["setup"]);
  assert.deepEqual(invoked("pnpm run setup && yarn build"), ["build", "setup"]);
  assert.deepEqual(invoked("bun run setup; FOO=1 npm run --silent build"), ["build", "setup"]);
  assert.deepEqual(invoked("npm t || npm --silent restart"), ["start", "stop", "test"]);
  assert.deepEqual(invoked("run-s 'build:*'"), ["build:css", "build:js"]);
  assert.deepEqual(invoked('concurrently "npm:build:js" "npm:lint"'), ["build:js", "lint"]);
  assert.deepEqual(invoked("echo `npm run setup`"), ["setup"]);
  assert.deepEqual(invoked("tsup src/index.ts --format esm"), []);
  assert.deepEqual(invoked("node t.mjs"), []);
});

test("shippedScriptNames follows pre/post hooks and npm run from lifecycle scripts, but not validation scripts", () => {
  const scripts = {
    prepack: "npm run generate:check && npm run --silent build",
    prebuild: "npm run clean",
    build: "tsup",
    postbuild: "npm test",
    clean: "rm -rf dist",
    "generate:check": "node gen.mjs --check",
    test: "vitest run",
    dev: "tsup --watch",
    predev: "npm run lint",
    lint: "tsc",
  };
  assert.deepEqual([...shippedScriptNames(scripts)].sort(), ["build", "clean", "postbuild", "prebuild", "prepack"]);
  assert.deepEqual([...shippedScriptNames({ prepack: "npm run build", build: "npm run test:unit && npm run lint:fix && npm run verify && tsup", "test:unit": "x", "lint:fix": "x", verify: "x" })], ["prepack", "build"]);
  assert.deepEqual([...shippedScriptNames({ postinstall: "npm run check:env", "check:env": "node env.mjs", "precheck:env": "npm test", test: "x", prepack: "npm test" })].sort(), ["check:env", "postinstall", "precheck:env", "prepack", "test"]);
});

test("parseInputDeclarations rejects unknown packages, missing reasons and non-normalized paths", () => {
  const stable = new Map([["@uifn/core", "uifn/core"]]);
  const { errors } = parseInputDeclarations({
    packages: {
      "@uifn/patterns": { inputs: { "uifn/x": "why" } },
      "@uifn/core": { inputs: { "uifn/a": "", ".": "everything", "uifn/../b": "why", "uifn/core/src": "own" }, surprises: {} },
    },
  }, stable);
  assert.equal(errors.length, 6, errors.join("\n"));
  assert.match(errors.join("\n"), /@uifn\/patterns is not a stable package/);
  assert.match(errors.join("\n"), /"uifn\/a" needs a reason/);
  assert.match(errors.join("\n"), /"\." must be a normalized relative path/);
  assert.match(errors.join("\n"), /"uifn\/core\/src" is inside uifn\/core/);
  assert.deepEqual(parseInputDeclarations(null, stable).errors, []);
});

test("a version with leading zeros is not valid semver", () => {
  const base = { name: "@uifn/core", version: "1.0.0" };
  for (const version of ["01.0.1", "1.0.01", "1.0.1-01"]) {
    const result = evaluatePackage({ name: "@uifn/core", packagePath: "uifn/core", baseManifest: base, headManifest: { ...base, version }, shippedFiles: [], headChangelog: `## ${version}\n- x\n` });
    assert.match(result.errors.join(""), /is not valid semver/, version);
  }
  assert.throws(() => compareSemver("00.0.2", "0.0.1"), /Invalid semver/);
  assert.ok(compareSemver("1.0.0-rc.0", "1.0.0-0") > 0);
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
  repo.write("uifn/catalog/catalog.json", '{ "primitives": ["button"] }\n');
  repo.commit("unreleased react and catalog change");
  const report = Object.fromEntries(reportSincePublished({ cwd: repo.root }).map((entry) => [entry.name, entry]));
  assert.equal(report["@uifn/core"].tag, "uifn-core-v1.0.0");
  assert.deepEqual(report["@uifn/core"].shippedFiles, ["uifn/catalog/catalog.json"]);
  assert.deepEqual(report["@uifn/react"].shippedFiles, ["uifn/react/src/index.ts"]);
  const cli = spawnSync(process.execPath, [script, "--since-published"], { cwd: repo.root, encoding: "utf8" });
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /2 of 2 stable packages have shipped changes/);
});

test("a failure to build the since-published report warns without failing, while the gate still fails", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/package-graph.json", "{}\n");
  repo.commit("graph without a stable list");
  const report = spawnSync(process.execPath, [script, "--since-published"], { cwd: repo.root, encoding: "utf8" });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stderr, /warning: could not report changes since the last published tags: .*has no stable package list/);
  const gate = check(repo.root);
  assert.equal(gate.status, 1);
  assert.match(gate.output, /error: .*has no stable package list/);
});

test("classifyPath separates tarball inputs from tests, fixtures, stories and docs", () => {
  for (const file of ["src/index.ts", "lib/Button.svelte", "styles.css", "tsup.config.ts", "tsconfig.json", "migrations/removed.json", "src/fixture.ts", "src/preset/fixtures.ts", ".npmignore"]) {
    assert.equal(classifyPath(file), "shipped", file);
  }
  for (const file of ["src/__tests__/a.ts", "tests/a.ts", "src/test/setup.ts", "src/a.test.tsx", "lib/a.spec.ts", "src/a.stories.tsx", "fixtures/a.json", "src/__tests__/fixtures/a.ts", "README.md", "docs/hooks.md", "docs/diagram.svg", "CHANGELOG.md", "vitest.ssr.config.ts", "playwright.config.ts", "browser/main.ts", "type-tests/a.ts", "stories/a.tsx", "workbenches/react/harness.tsx"]) {
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
