import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { gitBinary } from "./verify-package-lockfiles.mjs";
import { changelogHasEntry, classifyPath, compareSemver, entryReferences, evaluatePackage, parseInputDeclarations, reportSincePublished, resolveTarget, shippedScriptNames, tsconfigRoots } from "./verify-uifn-version-bump.mjs";

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
  assert.match(output, /@uifn\/core excludes src\/internal, but uifn\/core\/tsconfig\.json include includes uifn\/core\/src/);
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

test("resolveTarget tries implied extensions, index files and the TypeScript source of a .js specifier", () => {
  const files = new Set(["src/a.ts", "src/b/index.tsx", "src/c.mts", "src/d.svelte", "src/e.js"]);
  assert.deepEqual(resolveTarget("src/a", files), ["src/a.ts"]);
  assert.deepEqual(resolveTarget("src/b", files), ["src/b/index.tsx"]);
  assert.deepEqual(resolveTarget("src/c.mjs", files), ["src/c.mts"]);
  assert.deepEqual(resolveTarget("src/d.svelte", files), ["src/d.svelte"]);
  assert.deepEqual(resolveTarget("src/e.js", files), ["src/e.js"]);
  assert.deepEqual(resolveTarget("src/missing", files), []);
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

test("entryReferences reads every condition, array fallback and pattern of the entry fields", () => {
  const manifest = {
    main: "./dist/index.cjs",
    exports: { ".": { types: "./dist/index.d.ts", import: ["./dist/index.js"] }, "./themes/*": "./themes/*.css" },
    bin: { cli: "bin/cli.mjs" },
    browser: { "./dist/node.js": false },
    files: ["fixtures"],
  };
  assert.deepEqual(entryReferences(manifest, "uifn/core").map(({ target }) => target), ["uifn/core/dist/index.d.ts", "uifn/core/dist/index.js", "uifn/core/themes", "uifn/core/dist/index.cjs", "uifn/core/bin/cli.mjs"]);
});

test("tsconfigRoots resolves the static prefix of include and files entries", () => {
  const text = '{ "compilerOptions": { "outDir": "dist" }, "include": ["src/**/*", "vitest.config.ts", "./lib"], "files": ["**/*.d.ts"] }';
  assert.deepEqual(tsconfigRoots("uifn/core/tsconfig.json", text), ["uifn/core/src", "uifn/core/vitest.config.ts", "uifn/core/lib", "uifn/core"]);
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
