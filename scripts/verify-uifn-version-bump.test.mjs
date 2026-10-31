import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { gitBinary } from "./verify-package-lockfiles.mjs";
import { changelogHasEntry, classifyPath, compareSemver, entryReferences, evaluatePackage, fileInventory, fileReferences, findConsumedExclusions, findUndeclaredReferences, globToRegExp, invokedScripts, parseInputDeclarations, reportSincePublished, resolveReference, scriptReferences, shippedClosure, shippedScriptNames, tscProjects, tsconfigEntries, tsconfigRoots } from "./verify-uifn-version-bump.mjs";

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

// npm always packs package.json, so its changes count only through the published fields, whatever files says.
for (const [label, files] of [["no files list", undefined], ["files lists package.json", ["dist", "package.json"]]]) {
  test(`a manifest change outside the published fields needs no bump, and a published one does: ${label}`, (t) => {
    const repo = fixtureRepo(t);
    repo.edit("uifn/core/package.json", (text) => JSON.stringify({ ...JSON.parse(text), files }, null, 2));
    // Without a files list npm packs generated/, so the fixture's exclusion of it would fail on its own.
    repo.edit("uifn/version-bump-inputs.json", (text) => JSON.stringify({ packages: { ...JSON.parse(text).packages, "@uifn/core": { inputs: { "uifn/catalog/catalog.json": "build reads it" } } } }));
    repo.commit("files");
    repo.git("branch", "-f", "base");
    repo.edit("uifn/core/package.json", (text) => JSON.stringify({ ...JSON.parse(text), devDependencies: { vitest: "3.0.0" }, scripts: { build: "tsup", test: "vitest run --coverage" } }, null, 2));
    repo.commit("development fields");
    assert.equal(check(repo.root).status, 0, check(repo.root).output);
    for (const [field, value] of [["dependencies", { "left-pad": "1.0.0" }], ["scripts", { build: "tsup --minify", test: "vitest run --coverage" }]]) {
      repo.edit("uifn/core/package.json", (text) => JSON.stringify({ ...JSON.parse(text), [field]: value }, null, 2));
      repo.commit(field);
      const { status, output } = check(repo.root);
      assert.equal(status, 1, field);
      assert.match(output, /@uifn\/core: shipped code changed \(package\.json \(published fields\)\)/, field);
    }
  });
}

test("reordering manifest keys needs no bump, while reordering export conditions or changing a pin does", () => {
  const base = { name: "@uifn/core", version: "1.0.0", main: "dist/index.js", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.cjs" } }, dependencies: { "left-pad": "1.0.0", "right-pad": "2.0.0" }, peerDependencies: { react: "^19.0.0" } };
  const changed = (headManifest) => evaluatePackage({ name: "@uifn/core", packagePath: "uifn/core", baseManifest: base, headManifest, shippedFiles: [] }).manifestChanged;
  const { main, dependencies, ...rest } = base;
  assert.equal(changed({ dependencies: { "right-pad": "2.0.0", "left-pad": "1.0.0" }, ...rest, main }), false);
  assert.equal(changed({ ...base, dependencies: { ...dependencies, "left-pad": "1.0.1" } }), true);
  assert.equal(changed({ ...base, exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts", default: "./dist/index.cjs" } } }), true);
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

// The tsconfig sweep is additive: a build-file tsc project outside the package, named as a string or argv, a file or a directory, is still guarded.
const sharedProject = '{ "compilerOptions": { "outDir": "dist" }, "include": ["src"] }';
for (const run of [
  "execSync('tsc -p ../shared/tsconfig.json');",
  "execFileSync('tsc', ['-p', '../shared/tsconfig.json']);",
  "execSync('tsc --noEmit -b ../shared');",
  "execFileSync('npx', ['tsc', '--project', '../shared'], { cwd: process.env.ROOT });",
]) {
  test(`a build-file tsc project outside the package must be declared, and then its sources need a bump: ${run}`, (t) => {
    const repo = fixtureRepo(t);
    repo.write("uifn/shared/tsconfig.json", sharedProject);
    repo.write("uifn/core/scripts/build.mjs", `${run}\n`);
    repo.commit("external tsc project");
    const undeclared = check(repo.root);
    assert.equal(undeclared.status, 1, undeclared.output);
    assert.match(undeclared.output, /@uifn\/core: uifn\/core\/scripts\/build\.mjs refers to uifn\/shared\/tsconfig\.json, outside uifn\/core; declare it/);
    repo.git("branch", "-f", "base");
    repo.edit("uifn/version-bump-inputs.json", (text) => text.replace('"inputs":{"uifn/catalog/catalog.json":"build reads it"', '"inputs":{"uifn/catalog/catalog.json":"build reads it","uifn/shared/tsconfig.json":"tsc builds it","uifn/shared/src":"tsc compiles it"'));
    repo.commit("declare the external project");
    repo.git("branch", "-f", "base");
    repo.write("uifn/shared/src/index.ts", "export const shared = 2;\n");
    repo.commit("change the external project's source");
    const changed = check(repo.root);
    assert.equal(changed.status, 1, changed.output);
    assert.match(changed.output, /@uifn\/core: shipped code changed \(uifn\/shared\/src\/index\.ts\) but version is still 1\.0\.0/);
    assert.doesNotMatch(changed.output, /outside uifn\/core/);
  });
}

test("a build-file tsc run keeps in-package projects, and a .. path that is no tsconfig or project, or does not exist, is not an outside reference", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/shared/tsconfig.json", sharedProject);
  repo.write("uifn/core/tsconfig.json", '{ "compilerOptions": { "outDir": "dist" }, "include": ["src"] }');
  // From scripts/, ../../shared/tsconfig.json is uifn/shared/tsconfig.json, declared below; from the package root it would not exist.
  repo.write("uifn/core/scripts/build.mjs", "const pkg = require('../package.json');\nexecSync('tsc -p ./tsconfig.json');\nexecFileSync('tsc', ['-p', path.join(here, '../../shared/tsconfig.json')]);\n");
  repo.edit("uifn/version-bump-inputs.json", (text) => text.replace('"@uifn/core":{', '"@uifn/core":{"references":{"uifn/shared/tsconfig.json":"type-checked only"},'));
  repo.commit("in-package and declared projects");
  repo.git("branch", "-f", "base");
  repo.write("uifn/core/docs/notes.md", "Notes.\n");
  repo.commit("docs-only change");
  const { status, output } = check(repo.root);
  assert.equal(status, 0, output);
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
  assert.deepEqual(targets("uifn/core/tsup.config.ts", 'entry: ["./src/fixtures/runtime.ts", "./src/index.ts"]', { root: "uifn/core" }), ["uifn/core/src/fixtures/runtime.ts", "uifn/core/src/index.ts"]);
  assert.deepEqual(targets("uifn/core/scripts/build.mjs", 'path.resolve(packageRoot, "..", "catalog", "catalog.json")', { root: "uifn/core", base: "uifn/core" }), ["uifn/core", "uifn/core/catalog/catalog.json", "uifn/catalog/catalog.json"]);
  const bundled = (text) => fileReferences("uifn/core/src/index.ts", text).filter((reference) => reference.bundled).map(({ target }) => target);
  assert.deepEqual(bundled('import a from "../a.js";\nexport * from "./b";\nconst c = await import("./c");\nrequire("./d");\nreadFileSync(path.join(here, "../e.json"));\n'), ["uifn/core/a.js", "uifn/core/src/b", "uifn/core/src/c", "uifn/core/src/d"]);
});

test("array elements are separate paths, while path.join and path.resolve arguments still join", () => {
  const config = 'const here = path.dirname(fileURLToPath(import.meta.url));\nexport default { entry: ["../shared/first.ts", "../shared/second.ts"], define: { catalog: path.join(here, "..", "catalog", "catalog.json") } };\n';
  const references = fileReferences("uifn/core/tsup.config.ts", config, { root: "uifn/core", base: "uifn/core", buildFile: true });
  const targets = references.filter(({ soft }) => !soft).map(({ target }) => target);
  assert.deepEqual(targets, ["uifn/shared/first.ts", "uifn/shared/second.ts", "uifn", "uifn/catalog/catalog.json"]);
  const inventory = fileInventory(["uifn/core/tsup.config.ts", "uifn/shared/first.ts", "uifn/shared/second.ts", "uifn/catalog/catalog.json"]);
  const declaration = { inputs: ["uifn/shared/first.ts", "uifn/shared/second.ts", "uifn/catalog/catalog.json"], references: [] };
  assert.deepEqual(findUndeclaredReferences({ name: "@uifn/core", packagePath: "uifn/core", references: references.map((reference) => ({ from: "uifn/core/tsup.config.ts", ...reference })), declaration, inventory }), []);
});

test("scriptReferences keeps glob tokens and names tsconfig.json for a bare tsc", () => {
  const targets = (scripts) => scriptReferences(scripts, "uifn/core").map(({ target }) => target);
  assert.ok(targets({ build: "tsup src/index.ts 'src/fixtures/*.ts'" }).includes("uifn/core/src/fixtures/*.ts"));
  assert.ok(targets({ build: "tsup && tsc --emitDeclarationOnly" }).includes("uifn/core/tsconfig.json"));
  for (const build of ["tsc -p tsconfig.build.json", "tsc --project=tsconfig.build.json", "tsup --tsconfig tsconfig.build.json"]) assert.ok(!targets({ build }).includes("uifn/core/tsconfig.json"), build);
});

// npm's packlist matches a `files` entry without an inner slash at any depth, and includes everything under a directory it names.
test("an exclusion fails only when a files entry matches the excluded path or a file in it", () => {
  const packageFiles = ["uifn/components/package.json", "uifn/components/styles.css", "uifn/components/registry/button.json", "uifn/components/registry/theme/base.json"];
  const errors = (files) => findConsumedExclusions({ name: "@uifn/components", packagePath: "uifn/components", manifest: { files }, excluded: ["registry"], packageFiles, promoted: new Map() });
  for (const files of [["dist", "*.css", "README.md"], ["./*.css", "dist/"], ["registry-*.json"], ["!registry"]]) assert.deepEqual(errors(files), [], JSON.stringify(files));
  assert.match(errors(["dist", "registry"])[0], /excludes registry, but package\.json files includes uifn\/components\/registry;/);
  assert.match(errors(["registry/**"])[0], /package\.json files includes uifn\/components\/registry\/button\.json/);
  assert.match(errors(["./registry/"])[0], /package\.json files includes uifn\/components\/registry;/);
  assert.match(errors(["base.json"])[0], /package\.json files includes uifn\/components\/registry\/theme\/base\.json/);
});

test("an exclusion fails when the manifest has no files list, since npm packs the whole package", () => {
  const errors = (manifest) => findConsumedExclusions({ name: "@uifn/core", packagePath: "uifn/core", manifest, excluded: ["data"], packageFiles: ["uifn/core/package.json", "uifn/core/data/payload.json"], promoted: new Map() });
  for (const manifest of [{}, { files: "dist" }]) assert.match(errors(manifest)[0], /excludes data, but package\.json has no files list, so npm packs uifn\/core\/data;/, JSON.stringify(manifest));
  assert.deepEqual(errors({ files: ["dist"] }), []);
});

test("without a files list a test change ships and needs a bump", (t) => {
  const repo = fixtureRepo(t);
  repo.edit("uifn/core/package.json", (text) => JSON.stringify({ ...JSON.parse(text), files: undefined }));
  repo.write("uifn/core/src/__tests__/core.test.ts", "test;\n");
  repo.commit("no files list");
  repo.git("branch", "-f", "base");
  repo.write("uifn/core/src/__tests__/core.test.ts", "test 2;\n");
  repo.commit("test only");
  const { status, output } = check(repo.root);
  assert.equal(status, 1);
  assert.match(output, /@uifn\/core: shipped code changed \(src\/__tests__\/core\.test\.ts\) but version is still 1\.0\.0/);
});

// A file the packlist matches is scanned like shipped code: its out-of-root imports must be declared, and a change to them needs a bump.
for (const [label, files] of [["files lists fixtures", (list) => [...list, "fixtures"]], ["no files list", () => undefined]]) {
  test(`a packed fixture's out-of-root import must be declared, and its change needs a bump: ${label}`, (t) => {
    const repo = fixtureRepo(t);
    repo.edit("uifn/react/package.json", (text) => JSON.stringify({ ...JSON.parse(text), files: files(JSON.parse(text).files) }));
    repo.write("uifn/react/fixtures/runtime.mjs", 'export { runtime } from "../../shared/runtime.mjs";\n');
    repo.write("uifn/shared/runtime.mjs", "export const runtime = 1;\n");
    repo.commit("packed fixture");
    repo.git("branch", "-f", "base");
    const undeclared = check(repo.root);
    assert.equal(undeclared.status, 1);
    assert.match(undeclared.output, /@uifn\/react: uifn\/react\/fixtures\/runtime\.mjs refers to uifn\/shared\/runtime\.mjs, outside uifn\/react/);
    repo.edit("uifn/version-bump-inputs.json", (text) => text.replace('"uifn/shared/src":', '"uifn/shared/runtime.mjs": "a packed fixture re-exports it", "uifn/shared/src":'));
    repo.commit("declare the input");
    repo.git("branch", "-f", "base");
    const declared = check(repo.root);
    assert.equal(declared.status, 0, declared.output);
    repo.write("uifn/shared/runtime.mjs", "export const runtime = 2;\n");
    repo.commit("change the input");
    const changed = check(repo.root);
    assert.equal(changed.status, 1);
    assert.match(changed.output, /@uifn\/react: shipped code changed \(uifn\/shared\/runtime\.mjs\) but version is still 1\.0\.0/);
  });
}

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
      .replace('"files": [', '"exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }, "./runtime": { "import": ["./fixtures/runtime.mjs"] } },\n  "files": [\n    "fixtures/runtime.mjs",')
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
test("a docs asset outside files needs no bump unless shipped code refers to it", (t) => {
  const repo = fixtureRepo(t);
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

test("a test, asset or fixture that a files entry matches ships, while Markdown and tests outside files stay exempt", (t) => {
  const repo = fixtureRepo(t);
  repo.edit("uifn/core/package.json", (text) => text.replace('"files": [', '"files": [\n    "bin",\n    "docs",'));
  for (const file of ["bin/__tests__/probe.test.cjs", "docs/diagram.svg", "docs/guide.md", "src/__tests__/core.test.ts"]) repo.write(`uifn/core/${file}`, "one\n");
  repo.commit("files-listed bin and docs");
  repo.git("branch", "-f", "base");
  repo.write("uifn/core/docs/guide.md", "two\n");
  repo.write("uifn/core/src/__tests__/core.test.ts", "two\n");
  repo.commit("Markdown and a test outside files");
  const exempt = check(repo.root);
  assert.equal(exempt.status, 0, exempt.output);
  repo.write("uifn/core/bin/__tests__/probe.test.cjs", "two\n");
  repo.write("uifn/core/docs/diagram.svg", "two\n");
  repo.commit("files-listed test and asset");
  const listed = check(repo.root);
  assert.equal(listed.status, 1);
  assert.match(listed.output, /@uifn\/core: shipped code changed \(bin\/__tests__\/probe\.test\.cjs, docs\/diagram\.svg\) but version is still 1\.0\.0/);
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

// tsup builds every file its entry globs match, and tsc emits declarations for every source its tsconfig includes, minus that tsconfig's exclude.
test("a test or story file that a build-entry glob or an emitting tsconfig include matches counts as shipped", (t) => {
  const repo = fixtureRepo(t);
  repo.write("uifn/react/tsup.config.ts", "export default { entry: ['src/index.ts', 'src/generated/*.tsx', 'src/hooks/*.ts'], format: ['esm'] };\n");
  repo.write("uifn/react/src/hooks/use-media.ts", "export const useMedia = 1;\n");
  repo.edit("uifn/core/package.json", (text) => text.replace('"build": "tsup"', `"build": "tsup 'src/**/*.ts' '!src/**/*.test.ts' && tsc -p tsconfig.build.json"`));
  repo.write("uifn/core/tsconfig.json", '{ "include": ["src/**/*"], "exclude": ["dist"] }\n');
  repo.write("uifn/core/tsconfig.build.json", '{ "extends": "./tsconfig.json", "include": ["src/**/*"], "exclude": ["src/__tests__/**", "**/*.test.ts"] }\n');
  repo.write("uifn/core/src/__tests__/core.test.ts", "test;\n");
  repo.write("uifn/core/src/__tests__/helpers.tsx", "export const helper = 1;\n");
  repo.commit("entry globs and an emitting tsconfig");
  repo.git("branch", "-f", "base");
  repo.write("uifn/core/src/__tests__/core.test.ts", "test 2;\n");
  repo.write("uifn/core/src/__tests__/helpers.tsx", "export const helper = 2;\n");
  repo.commit("excluded tests only");
  const excluded = check(repo.root);
  assert.equal(excluded.status, 0, excluded.output);
  repo.write("uifn/react/src/hooks/use-probe.test.ts", "export const probe = 1;\n");
  repo.write("uifn/react/src/generated/probe.stories.tsx", "export const shipped = 1;\n");
  repo.write("uifn/core/src/button.stories.tsx", "export const story = 1;\n");
  repo.commit("files the build consumes");
  const consumed = check(repo.root);
  assert.equal(consumed.status, 1);
  assert.match(consumed.output, /@uifn\/react: shipped code changed \(src\/generated\/probe\.stories\.tsx, src\/hooks\/use-probe\.test\.ts\) but version is still 1\.0\.0/);
  assert.match(consumed.output, /@uifn\/core: shipped code changed \(src\/button\.stories\.tsx\) but version is still 1\.0\.0/);
});

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

// The test, fixture and story files @uifn/core's shipped closure promotes, over an in-memory tree of core files, with
// tsconfigRoots reading the same tree, when the package builds with `build`.
function promotedBy(build, tree) {
  const files = Object.keys(tree).map((file) => `uifn/core/${file}`);
  const read = (file) => tree[file.slice("uifn/core/".length)] ?? null;
  const inventory = fileInventory(files);
  const manifest = { name: "@uifn/core", version: "1.0.0", scripts: { build } };
  const { promoted } = shippedClosure({ packagePath: "uifn/core", manifest, files, read: (paths) => new Map(paths.map((file) => [file, read(file)])), tsconfigRoots: (file, emit) => tsconfigRoots(file, inventory, read, emit) });
  return [...promoted.keys()].map((file) => file.slice("uifn/core/".length)).sort();
}

const sources = { "src/index.ts": "export const core = 1;\n", "src/__tests__/core.test.ts": "test;\n", "src/__tests__/fixtures/tree.ts": "export const tree = 1;\n", "src/fixtures/runtime.ts": "export const runtime = 1;\n", "src/fixtures/legacy.js": "export const legacy = 1;\n" };

// tsc compiles what TypeScript resolves for the tsconfig the build names, not what its own include and exclude strings say.
const base = '{ "include": ["src", "tests"], "exclude": ["src/__tests__"] }';
for (const [cell, build, tsconfigs, expected] of [
  ["files entries compile whatever exclude says", "tsc -p tsconfig.json", { "tsconfig.json": '{ "include": ["src"], "exclude": ["src/__tests__/**"], "files": ["src/__tests__/fixtures/tree.ts"] }' }, ["src/__tests__/fixtures/tree.ts", "src/fixtures/runtime.ts"]],
  ["no include or files means the default include **/*", "tsc -p tsconfig.json", { "tsconfig.json": '{ "compilerOptions": { "outDir": "dist" } }' }, ["src/__tests__/core.test.ts", "src/__tests__/fixtures/tree.ts", "src/fixtures/runtime.ts"]],
  ["a child that overrides exclude inherits the include", "tsc -p tsconfig.build.json", { "tsconfig.json": base, "tsconfig.build.json": '{ "extends": "./tsconfig.json", "exclude": ["dist"] }' }, ["src/__tests__/core.test.ts", "src/__tests__/fixtures/tree.ts", "src/fixtures/runtime.ts"]],
  ["a child include keeps the inherited exclude", "tsc -p tsconfig.build.json", { "tsconfig.json": base, "tsconfig.build.json": '{ "extends": "./tsconfig.json", "include": ["src"] }' }, ["src/fixtures/runtime.ts"]],
  ["allowJs compiles .js files", "tsc -p tsconfig.json", { "tsconfig.json": '{ "compilerOptions": { "allowJs": true }, "include": ["src/fixtures"] }' }, ["src/fixtures/legacy.js", "src/fixtures/runtime.ts"]],
  ["tsc -b builds referenced projects", "tsc -b tsconfig.json", { "tsconfig.json": '{ "include": ["src/index.ts"], "references": [{ "path": "./tsconfig.fixtures.json" }] }', "tsconfig.fixtures.json": '{ "compilerOptions": { "composite": true }, "include": ["src/fixtures"] }' }, ["src/fixtures/runtime.ts"]],
  ["an extends TypeScript cannot read fails closed", "tsc -p tsconfig.json", { "tsconfig.json": '{ "extends": "@missing/tsconfig", "include": ["src/index.ts"] }' }, ["src/__tests__/core.test.ts", "src/__tests__/fixtures/tree.ts", "src/fixtures/legacy.js", "src/fixtures/runtime.ts"]],
  ["a tsconfig no build names only type-checks", "tsup", { "tsconfig.json": '{ "include": ["src"] }' }, []],
]) {
  test(`an emitting tsconfig consumes what TypeScript resolves: ${cell}`, () => {
    assert.deepEqual(promotedBy(build, { ...sources, ...tsconfigs }), expected);
  });
}

test("tscProjects maps every tsc spelling to the tsconfigs it emits from", () => {
  for (const command of ["tsc", "npx tsc --emitDeclarationOnly", "tsc -b", "tsc --build --verbose", "tsc -p .", "tsc --project ./", "tsc -b .", "tsc -p tsconfig.json"]) assert.deepEqual(tscProjects(command), ["tsconfig.json"], command);
  assert.deepEqual(tscProjects("tsc -p config/tsconfig.build.json"), ["config/tsconfig.build.json"]);
  assert.deepEqual(tscProjects("tsc --project=packages/a"), ["packages/a/tsconfig.json"]);
  assert.deepEqual(tscProjects("tsc -b packages/a tsconfig.types.json --force"), ["packages/a/tsconfig.json", "tsconfig.types.json"]);
  assert.deepEqual(tscProjects("tsc --noEmit -p tsconfig.json"), []);
  assert.deepEqual(tscProjects("tsc -b > build.log 2>&1"), ["tsconfig.json"]);
  assert.deepEqual(tscProjects("tsc -b --noEmit false"), ["tsconfig.json"]);
  assert.deepEqual(tscProjects("tsc -p tsconfig.json --noEmit=false"), ["tsconfig.json"]);
  assert.equal(tscProjects("tsup src/index.ts"), null);
});

// tsc emits the default-include fixtures in each spelling, from a script or a build file; a script's --noEmit emits nothing.
const emitted = ["src/__tests__/core.test.ts", "src/__tests__/fixtures/tree.ts", "src/fixtures/runtime.ts"];
for (const [build, extra, expected] of [
  ["tsc -b", {}, emitted],
  ["tsc --build", {}, emitted],
  ["tsc -p .", {}, emitted],
  ["tsc --project ./", {}, emitted],
  ["tsc -b .", {}, emitted],
  ["node scripts/build.mjs", { "scripts/build.mjs": "execSync('tsc');\n" }, emitted],
  ["node scripts/build.mjs", { "scripts/build.mjs": "execSync('tsc -p .');\n" }, emitted],
  ["node scripts/build.mjs", { "scripts/build.mjs": "execSync('pnpm exec tsc -b');\n" }, emitted],
  ["node scripts/build.mjs", { "scripts/build.mjs": "execSync(\"yarn tsc\");\n" }, emitted],
  ["node scripts/build.mjs", { "scripts/build.mjs": "execSync(`node_modules/.bin/tsc -p . 2>&1`);\n" }, emitted],
  ...["node node_modules/typescript/bin/tsc -p .", "npx --no-install tsc", "npx -p typescript tsc", "npm exec -- tsc", "npm x tsc", "bun x tsc", "pnpm dlx tsc", "yarn run tsc", "pnpm -C . exec tsc"].map((command) => ["node scripts/build.mjs", { "scripts/build.mjs": `execSync('${command}');\n` }, emitted]),
  ["tsc --noEmit && tsup src/index.ts", {}, []],
  // A build file's tsc run sweeps every tsconfig even with its own --noEmit, as a command string or an argv element (owner ruling).
  ["node scripts/build.mjs", { "scripts/build.mjs": 'execSync("tsc --noEmit");\nawait build({ entry: ["src/index.ts"] });\n' }, emitted],
  ["node scripts/build.mjs", { "scripts/build.mjs": "execFileSync('tsc', ['--noEmit']);\n" }, emitted],
  ["node scripts/build.mjs", { "scripts/build.mjs": "execFileSync('npx', ['tsc', '--noEmit', '-p', '.']);\n" }, emitted],
  // An emitting tsc run beside a --noEmit one, --noEmitOnError and a --noEmit in a comment still compile.
  ["node scripts/build.mjs", { "scripts/build.mjs": "execSync('tsc --noEmit');\nexecFileSync('tsc', ['-p', '.']);\n" }, emitted],
  ["node scripts/build.mjs", { "scripts/build.mjs": "execSync('tsc --noEmitOnError');\n" }, emitted],
  ["node scripts/build.mjs", { "scripts/build.mjs": "// not --noEmit\nexecFileSync('tsc', ['-p', '.']);\n" }, emitted],
  // A --noEmit outside a tsc run (a message, a quoted comment, another run's flag) does not stop an emitting run.
  ["node scripts/build.mjs", { "scripts/build.mjs": "console.log('Building without --noEmit');\nexecSync('tsc');\n" }, emitted],
  ["node scripts/build.mjs", { "scripts/build.mjs": "/* \"--noEmit\" is for typecheck only */\nexecFileSync('tsc', ['-p', '.']);\n" }, emitted],
  ["node scripts/build.mjs", { "config/tsconfig.emit.json": '{ "include": ["../src"] }', "scripts/build.mjs": "execSync('tsc --noEmit');\nconsole.log('--noEmit');\nexecSync('tsc -p config/tsconfig.emit.json');\n" }, emitted],
  // A run whose project cannot be read still names every tsconfig, whatever --noEmit literals sit beside it.
  ["node scripts/build.mjs", { "scripts/build.mjs": "const dir = 'lib';\nconsole.log('--noEmit');\nexecSync(`tsc -p ${dir}`);\n" }, emitted],
  ["node scripts/build.mjs", { "scripts/build.mjs": "console.log('--noEmit');\nexecFileSync('tsc', ['-p', dir]);\n" }, emitted],
  // A --noEmit false anywhere in the file turns emission on for every swept tsconfig, a noEmit tsconfig.json beside the run's own one too.
  ...["execSync('tsc -p tsconfig.build.json --noEmit false');", "execFileSync('tsc', ['-p', 'tsconfig.build.json', '--noEmit', 'false']);"].map((line) => ["node scripts/build.mjs", { "tsconfig.json": '{ "compilerOptions": { "noEmit": true }, "include": ["src"] }', "tsconfig.build.json": '{ "compilerOptions": { "noEmit": true }, "include": ["src/index.ts"] }', "scripts/build.mjs": `${line}\n` }, emitted]),
  // The real @uifn/solid shape: the message and the bare tsc path name tsconfig.json, which is noEmit; the -p argument names the emitting build config.
  ["node scripts/build.mjs", { "tsconfig.json": '{ "compilerOptions": { "noEmit": true }, "include": ["src/**/*"] }', "tsconfig.build.json": '{ "include": ["src/index.ts"] }', "scripts/build.mjs": "execFileSync(path.join(root, 'node_modules/typescript/bin/tsc'), ['-p', 'tsconfig.build.json']);\nfail('typescript tsc not found');\n" }, []],
]) {
  test(`a shipped tsc invocation consumes its tsconfig: ${[build, ...Object.values(extra)].join(" with ").trim()}`, () => {
    assert.deepEqual(promotedBy(build, { ...sources, "tsconfig.json": '{ "compilerOptions": { "outDir": "dist" } }', ...extra }), expected);
  });
}

// A build file that runs tsc names every tsconfig in its package, whatever the run's project, cwd, options or quoting.
const libProject = { "tsconfig.json": '{ "compilerOptions": { "noEmit": true }, "include": ["src"] }', "lib/tsconfig.json": '{ "compilerOptions": { "outDir": "../dist/lib" } }', "lib/index.ts": "export const lib = 1;\n", "lib/__tests__/fixtures/data.ts": "export const data = 1;\n" };
for (const script of [
  "execFileSync('tsc', ['-p', 'lib']);",
  "execFileSync('npx', ['tsc', '--project', 'lib']);",
  "const tsc = 'node_modules/typescript/bin/tsc';\nspawnSync(process.execPath, [tsc, '--project', path.join(root, 'lib')]);",
  "const tsc = 'node_modules/typescript/bin/tsc';\nspawnSync(process.execPath, [tsc, '-b', 'lib']);",
  `execSync("tsc -p lib && echo 'built'");`,
  'execSync(`tsc -p lib --outDir "dist"`);',
  // A run whose working directory is set, to a literal or not: its -p tsconfig.json is lib's, not the noEmit root one.
  "execFileSync('tsc', ['-p', 'tsconfig.json'], { cwd: 'lib' });",
  "const sub = process.env.SUB;\nexecFileSync('tsc', ['-p', 'tsconfig.json'], { cwd: sub });",
  "const sub = process.env.SUB;\nexecSync('tsc -p tsconfig.json', { cwd: sub });",
  "execFileSync('tsc', ['-p', 'tsconfig.json'], { ...options });",
  "execFileSync('tsc', ['-p', 'tsconfig.json'], { shell: true });",
  "execFileSync('tsc', ['-p', 'lib/tsconfig.json'], { stdio: 'inherit' });",
  "execFileSync('tsc', ['--project=lib']);",
  // A run naming only the noEmit root project, or with its own --noEmit, still sweeps, so lib's emitting tsconfig counts.
  "execFileSync('tsc', ['-p', 'tsconfig.json']);",
  "execSync('tsc -p tsconfig.json', { stdio: 'inherit' });",
  "execSync('tsc --noEmit -p lib');",
  "execFileSync('tsc', ['-p', 'lib', '--noEmit']);",
]) {
  test(`a build file that runs tsc consumes every tsconfig in its package: ${script.split("\n").at(-1)}`, () => {
    assert.deepEqual(promotedBy("node scripts/build.mjs", { ...sources, ...libProject, "scripts/build.mjs": `${script}\n` }), ["lib/__tests__/fixtures/data.ts"]);
  });
}

// A --noEmit beside a run, not in its own call, never stops it: semicolonless code and a variable argv keep the run, which emits.
for (const script of ["execSync('tsc')\nconsole.log('--noEmit')\n", "const args = process.argv.slice(2)\nexecFileSync('tsc', args)\nconsole.log('--noEmit')\nconst x = [1]\n", "execFileSync('tsc', [...args, '--noEmit'])\n", "run(execSync('tsc --noEmit'))\nexecFileSync('tsc', args)\n"]) {
  test(`a build-file tsc run is not stopped by a --noEmit outside its own call: ${JSON.stringify(script)}`, () => {
    assert.deepEqual(promotedBy("node scripts/build.mjs", { ...sources, "tsconfig.json": '{ "compilerOptions": { "outDir": "dist" } }', "scripts/build.mjs": script }), emitted);
  });
}

// A tsconfig in a directory with a space is swept like any other, whichever project the run names.
const spaced = { "tsconfig.json": '{ "compilerOptions": { "noEmit": true }, "include": ["src"] }', "my lib/tsconfig.json": '{ "compilerOptions": { "outDir": "../dist" }, "include": ["../src/fixtures"] }' };
for (const script of ["execFileSync('tsc', ['-p', 'my lib/tsconfig.json']);", `execSync('tsc -p "my lib/tsconfig.json"');`, "execFileSync('tsc', ['-p', 'tsconfig.json']);"]) {
  test(`a build-file tsc run sweeps a tsconfig path with spaces: ${script}`, () => {
    assert.deepEqual(promotedBy("node scripts/build.mjs", { ...sources, ...spaced, "scripts/build.mjs": `${script}\n` }), ["src/fixtures/runtime.ts"]);
  });
}

// Swept noEmit tsconfigs emit nothing unless the build file has an argv or string --noEmit false, and a build file without tsc names none.
test("a build file's --noEmit false makes every swept noEmit tsconfig emit, and a build file without tsc names none", () => {
  const lib = { ...libProject, "lib/tsconfig.json": '{ "compilerOptions": { "noEmit": true } }' };
  assert.deepEqual(promotedBy("node scripts/build.mjs", { ...sources, ...lib, "scripts/build.mjs": "execFileSync('tsc', ['-p', 'lib']);\n" }), []);
  for (const script of ["execFileSync('tsc', ['-p', 'lib', '--noEmit', 'false']);", "execSync('tsc -p lib --noEmit false');"]) assert.deepEqual(promotedBy("node scripts/build.mjs", { ...sources, ...lib, "scripts/build.mjs": `${script}\n` }), ["lib/__tests__/fixtures/data.ts", ...emitted]);
  assert.deepEqual(promotedBy("node scripts/build.mjs", { ...sources, ...libProject, "scripts/build.mjs": "execFileSync('tsup', ['lib/index.ts']);\n" }), []);
});

// tsup in a nested build script resolves ./ entries from the working directory, the package root.
for (const [entries, expected] of [
  ["'./src/fixtures/runtime.ts'", ["src/fixtures/runtime.ts"]],
  ["'./src/fixtures/*.ts'", ["src/fixtures/runtime.ts"]],
  ["'./src/**/*.ts'", ["src/__tests__/core.test.ts", "src/__tests__/fixtures/tree.ts", "src/fixtures/runtime.ts"]],
  ["'./src/**/*.ts', '!./src/__tests__/**'", ["src/fixtures/runtime.ts"]],
  ["'./src/index.ts'", []],
]) {
  test(`a ./ entry in a nested build script resolves from the package root: ${entries}`, () => {
    assert.deepEqual(promotedBy("node scripts/build.mjs", { ...sources, "scripts/build.mjs": `await build({ entry: [${entries}] });\n` }), expected);
  });
}

// Build-file status follows execution: a file a shipped script or shell build script runs or names as a tool config, and every local module a build file imports, is read with the package root as cwd.
const globEntry = "await build({ entry: ['src/**/*.ts'] });\n";
const argvTsc = "execFileSync('tsc', ['-p', 'lib']);\n";
const globConfig = "export default { input: ['src/**/*.ts'] };\n";
for (const [cell, build, tree, expected] of [
  ["a root build.mjs glob entry", "node build.mjs", { "build.mjs": globEntry }, emitted],
  ["a tools/build.mjs glob entry", "node tools/build.mjs", { "tools/build.mjs": globEntry }, emitted],
  ["a tsx-run tools/build.ts glob entry", "tsx tools/build.ts", { "tools/build.ts": globEntry }, emitted],
  ["an entry list in a helper a build script imports", "node scripts/build.mjs", { "scripts/build.mjs": "import { entries } from '../tools/entries.mjs';\nawait build({ entry: entries });\n", "tools/entries.mjs": "export const entries = ['src/**/*.ts'];\n" }, emitted],
  ["a root build.mjs argv tsc", "node build.mjs", { ...libProject, "build.mjs": argvTsc }, ["lib/__tests__/fixtures/data.ts"]],
  ["a tools/build.mjs argv tsc", "node tools/build.mjs", { ...libProject, "tools/build.mjs": argvTsc }, ["lib/__tests__/fixtures/data.ts"]],
  ["an argv tsc in a helper a build script imports", "node scripts/build.mjs", { ...libProject, "scripts/build.mjs": "await import('../tools/compile.mjs');\n", "tools/compile.mjs": argvTsc }, ["lib/__tests__/fixtures/data.ts"]],
  ["tsc -p lib in a root build.sh", "sh build.sh", { ...libProject, "build.sh": "#!/bin/sh\nset -e\ntsc -p lib\n" }, ["lib/__tests__/fixtures/data.ts"]],
  ["tsc -p lib in scripts/build.sh", "bash scripts/build.sh", { ...libProject, "scripts/build.sh": "tsc -p lib\n" }, ["lib/__tests__/fixtures/data.ts"]],
  // A shell build file's tsc run sweeps too: its own --noEmit, project and cwd are not read.
  ["tsc --noEmit -p tsconfig.json in build.sh", "sh build.sh", { ...libProject, "build.sh": "tsc --noEmit -p tsconfig.json\n" }, ["lib/__tests__/fixtures/data.ts"]],
  ["cd lib && tsc -p tsconfig.json in build.sh", "sh build.sh", { ...libProject, "build.sh": "cd lib && tsc -p tsconfig.json\n" }, ["lib/__tests__/fixtures/data.ts"]],
  ["a build file a shell build script runs", "./build.sh", { "build.sh": "node tools/build.mjs\n", "tools/build.mjs": globEntry }, emitted],
  ["control: a tools/build.mjs no script runs", "tsup src/index.ts", { "tools/build.mjs": globEntry }, []],
  ["control: a build.sh no script runs", "tsup src/index.ts", { ...libProject, "build.sh": "tsc -p lib\n" }, []],
  ["rollup -c tools/rollup.config.mjs", "rollup -c tools/rollup.config.mjs", { "tools/rollup.config.mjs": globConfig }, emitted],
  ["rollup --config build/rollup.mjs", "rollup --config build/rollup.mjs", { "build/rollup.mjs": globConfig }, emitted],
  ["tsup --config tools/tsup.config.ts", "tsup --config tools/tsup.config.ts", { "tools/tsup.config.ts": globConfig }, emitted],
  ["vite build --config tools/vite.config.ts", "vite build --config tools/vite.config.ts", { "tools/vite.config.ts": globConfig }, emitted],
  ["webpack --config=build/webpack.mjs", "webpack --config=build/webpack.mjs", { "build/webpack.mjs": globConfig }, emitted],
  ["an entry list in a helper a tool-loaded config imports", "rollup -c tools/rollup.config.mjs", { "tools/rollup.config.mjs": "import { input } from './inputs.mjs';\nexport default { input };\n", "tools/inputs.mjs": "export const input = ['src/**/*.ts'];\n" }, emitted],
  ["control: a root rollup.config.mjs rollup -c loads", "rollup -c", { "rollup.config.mjs": globConfig }, emitted],
  ["control: a tools/rollup.config.mjs no script loads", "rollup -c", { "tools/rollup.config.mjs": globConfig }, []],
  ["control: a ./ option value is not run", "svelte-package -i lib -o dist --tsconfig ./tsconfig.json", { "lib/index.ts": "export const lib = 1;\n", "tsconfig.json": '{ "compilerOptions": { "noEmit": true }, "exclude": ["src/**/*.test.ts"] }' }, []],
]) {
  test(`a file the build runs is a build file: ${cell}`, () => {
    assert.deepEqual(promotedBy(build, { ...sources, ...tree }), expected);
  });
}

// A noEmit tsconfig, set directly or inherited, puts nothing in dist unless the command line turns emission back on; its project references still build.
const noEmit = '{ "compilerOptions": { "noEmit": true } }';
for (const [cell, build, tsconfigs, expected] of [
  ["noEmit set directly", "tsc -p tsconfig.json && tsup src/index.ts", { "tsconfig.json": noEmit }, []],
  ["noEmit inherited through extends", "tsc -p tsconfig.build.json", { "tsconfig.json": noEmit, "tsconfig.build.json": '{ "extends": "./tsconfig.json", "include": ["src"] }' }, []],
  ["a script's --noEmit false overrides it", "tsc -p tsconfig.json --noEmit false", { "tsconfig.json": noEmit }, emitted],
  ["a build file's --noEmit=false overrides it", "node scripts/build.mjs", { "tsconfig.json": noEmit, "scripts/build.mjs": "execSync('tsc --noEmit=false');\n" }, emitted],
  ["project references still build", "tsc -b", { "tsconfig.json": '{ "compilerOptions": { "noEmit": true }, "files": [], "references": [{ "path": "./tsconfig.fixtures.json" }] }', "tsconfig.fixtures.json": '{ "compilerOptions": { "composite": true }, "include": ["src/fixtures"] }' }, ["src/fixtures/runtime.ts"]],
]) {
  test(`a tsconfig's effective noEmit decides what it consumes: ${cell}`, () => {
    assert.deepEqual(promotedBy(build, { ...sources, ...tsconfigs }), expected);
  });
}

// svelte-package copies every file under its input directory into dist, even the package root; a build config's directory reference does not.
test("a directory argument of a shipped script consumes every file under it", () => {
  const tree = { "lib/index.ts": "export const core = 1;\n", "lib/__tests__/probe.test.ts": "test;\n", "lib/Probe.stories.svelte": "<p />\n", "src/__tests__/core.test.ts": "test;\n" };
  assert.deepEqual(promotedBy("svelte-package -i lib -o dist", tree), ["lib/Probe.stories.svelte", "lib/__tests__/probe.test.ts"]);
  assert.deepEqual(promotedBy("svelte-package -i . -o dist", tree), ["lib/Probe.stories.svelte", "lib/__tests__/probe.test.ts", "src/__tests__/core.test.ts"]);
  assert.deepEqual(promotedBy("node scripts/build.mjs", { ...tree, "scripts/build.mjs": "const input = path.join(packageRoot, 'lib');\n" }), []);
});

test("a directory argument naming a declared input root consumes every file under it, while a bundled import of the root does not", () => {
  const files = ["uifn/core/package.json", "uifn/core/src/index.ts", "uifn/shared/src/index.ts", "uifn/shared/src/__tests__/shared.test.ts"];
  const texts = { "uifn/core/src/index.ts": 'export * from "../../shared/src";\n', "uifn/shared/src/index.ts": "export const shared = 1;\n" };
  const promoted = (build) => [...shippedClosure({ packagePath: "uifn/core", manifest: { scripts: { build } }, files, inputs: ["uifn/shared/src"], read: (paths) => new Map(paths.map((file) => [file, texts[file] ?? ""])) }).promoted.keys()];
  for (const build of ["svelte-package -i ../shared/src -o dist", "cp -r ../shared/src dist/shared && tsup src/index.ts"]) assert.deepEqual(promoted(build), ["uifn/shared/src/__tests__/shared.test.ts"], build);
  assert.deepEqual(promoted("tsup src/index.ts"), []);
});

test("a ! glob drops only the matches of its own entry array or script command", () => {
  const tree = { "src/index.ts": "export const core = 1;\n", "src/fixtures/data.ts": "export const data = 1;\n", "src/core.test.ts": "test;\n" };
  assert.deepEqual(promotedBy("tsup", { ...tree, "tsup.config.ts": 'export default [{ entry: ["src/fixtures/*.ts"] }, { entry: ["src/**/*.ts", "!src/fixtures/**", "!src/**/*.test.ts"] }];\n' }), ["src/fixtures/data.ts"]);
  assert.deepEqual(promotedBy("tsup", { ...tree, "tsup.config.ts": 'export default { entry: ["src/**/*.ts", "!src/fixtures/**", "!src/**/*.test.ts"] };\n' }), []);
  assert.deepEqual(promotedBy("tsup 'src/fixtures/*.ts' && tsup 'src/**/*.ts' '!src/fixtures/**' '!src/**/*.test.ts'", tree), ["src/fixtures/data.ts"]);
  assert.deepEqual(promotedBy("tsup 'src/**/*.ts' '!src/fixtures/**' '!src/**/*.test.ts'", tree), []);
});

test("a package the change demotes but keeps needs a bump for a shipped file the change adds", (t) => {
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
  repo.write("uifn/react/src/added.ts", "export const added = 1;\n");
  repo.commit("demote react and add a source");
  const { status, output } = check(repo.root);
  assert.equal(status, 1);
  assert.match(output, /@uifn\/react: shipped code changed \(src\/added\.ts\) but version is still 1\.0\.0/);
  assert.doesNotMatch(output, /is not a stable package/);
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

test("--base and --head resolve branches, tags, revisions and ids, and a ref that git could read as an option does not", (t) => {
  const repo = fixtureRepo(t);
  repo.git("tag", "v-base", "base");
  repo.write("uifn/core/README.md", "# Core docs\n");
  repo.commit("docs only");
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: repo.root, encoding: "utf8" });
  for (const args of [["--base", "base"], ["--base", "v-base"], ["--base", "HEAD~1"], ["--base", repo.git("rev-parse", "base"), "--head", repo.git("rev-parse", "HEAD")]]) {
    const result = run(...args);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  }
  for (const ref of ["missing-branch", "--output=/tmp/x", "-p"]) {
    const result = run(`--base=${ref}`);
    assert.equal(result.status, 1, ref);
    assert.match(result.stderr, new RegExp(`Cannot resolve ${ref.replace(/[/.*+?^${}()|[\]\\-]/g, "\\$&")} to a commit`), ref);
  }
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

// CI reports the base revision (--head <base.sha>) from a PR's merge checkout: dev's unpublished changes count, the PR's own do not.
test("since-published --head reports that revision, not the checked-out PR", (t) => {
  const repo = fixtureRepo(t);
  repo.git("tag", "uifn-core-v1.0.0");
  repo.git("tag", "uifn-react-v1.0.0");
  repo.git("checkout", "--quiet", "-b", "feature");
  repo.write("uifn/core/src/index.ts", "export const core = 2;\n");
  repo.commit("PR-only core change");
  repo.git("checkout", "--quiet", "base");
  repo.write("uifn/react/src/index.ts", 'export { shared } from "../../shared/src/index";\nexport const react = 2;\n');
  repo.commit("base-only react change");
  repo.git("checkout", "--quiet", "feature");
  const shipped = (head) => Object.fromEntries(reportSincePublished({ cwd: repo.root, ...(head ? { head } : {}) }).map((entry) => [entry.name, entry.shippedFiles]));
  assert.deepEqual(shipped("base"), { "@uifn/core": [], "@uifn/react": ["uifn/react/src/index.ts"] });
  assert.deepEqual(shipped(), { "@uifn/core": ["uifn/core/src/index.ts"], "@uifn/react": [] });
  const cli = spawnSync(process.execPath, [script, "--since-published", "--head", "base"], { cwd: repo.root, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /@uifn\/core: uifn-core-v1\.0\.0 -> HEAD: no shipped changes/);
  assert.match(cli.stdout, /@uifn\/react: uifn-react-v1\.0\.0 -> HEAD: 1 shipped file\(s\) changed/);
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
