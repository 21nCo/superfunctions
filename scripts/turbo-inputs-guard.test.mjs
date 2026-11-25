import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { findReadsInSource, resolveTarget } from "./turbo-inputs-guard.mjs";

// SFNS-311: scripts/turbo-inputs-guard.mjs fails when a cacheable Turbo task reads a file outside its package that is
// not in its Turbo hash. These tests add fixture packages to a copy of the repository, run the guard on them before and
// after declaring their reads, and ask Turbo for real task hashes and definitions.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const guardScript = path.join(repoRoot, "scripts", "turbo-inputs-guard.mjs");
const turboBin = process.env.TURBO_BIN || path.join(repoRoot, "node_modules", "turbo", "bin", "turbo");
const TURBO_ENV = { ...process.env, TURBO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", TURBO_NO_UPDATE_NOTIFIER: "1" };

const TARGET_DIR = "packages/zz-guard-target";
const toTarget = "../../zz-guard-target"; // From a reader package's src/ directory.

// One reader package per case. Each reads its own file of the target package, which none of them depends on, and has
// only a test script (so the guard checks only its test task) unless the case says otherwise. `target` is the path the
// guard reports (by default data/<name>.json in the target package), `declare` the input that declares it.
const FORMS = [
  // Form 1: relative import, export … from, require() and import() specifiers.
  { name: "import", file: "src/index.mjs", ext: "mjs", source: `import value from "${toTarget}/data/import.mjs";\nexport { value };\n` },
  { name: "export-from", file: "src/index.mjs", ext: "mjs", source: `export { value } from "${toTarget}/data/export-from.mjs";\n` },
  { name: "require", file: "src/index.cjs", ext: "cjs", source: `module.exports = require("${toTarget}/data/require.cjs");\n` },
  { name: "dynamic-import", file: "src/index.mjs", ext: "mjs", source: `export const load = () => import("${toTarget}/data/dynamic-import.mjs");\n` },
  // Form 2: literal segments given to path.join, path.resolve, fileURLToPath(new URL(…)) and new URL(…).
  {
    name: "path-join",
    file: "src/index.mjs",
    source: `import path from "node:path";\nexport const file = path.join(import.meta.dirname, "${toTarget}/data/path-join.json");\n`,
  },
  {
    name: "path-resolve",
    file: "src/index.mjs",
    source:
      `import { resolve } from "node:path";\nconst here = import.meta.dirname;\n` +
      `export const file = resolve(here, "..", "..", "zz-guard-target", "data", "path-resolve.json");\n`,
  },
  {
    name: "file-url",
    file: "src/index.mjs",
    source:
      `import { fileURLToPath } from "node:url";\n` +
      `export const file = fileURLToPath(new URL("${toTarget}/data/file-url.json", import.meta.url));\n`,
  },
  {
    name: "new-url",
    file: "src/index.mjs",
    source: `import { readFileSync } from "node:fs";\nexport const read = () => readFileSync(new URL("${toTarget}/data/new-url.json", import.meta.url));\n`,
  },
  // Form 3: alias values in Vitest and Vite configs, including quoted property names.
  {
    name: "vitest-alias",
    file: "vitest.config.mjs",
    ext: "mjs",
    source: `export default {\n  resolve: { alias: { "@guard/aliased": "../zz-guard-target/data/vitest-alias.mjs" } },\n};\n`,
  },
  {
    name: "vite-alias",
    file: "vite.config.mjs",
    ext: "mjs",
    source:
      `export default {\n  resolve: {\n    alias: [{ find: "@guard/aliased", replacement: "../zz-guard-target/data/vite-alias.mjs" }],\n  },\n};\n`,
  },
  {
    name: "vitest-alias-suffixed", // A suffixed config name, and a target without its file extension.
    file: "vitest.workerd.config.mjs",
    target: `${TARGET_DIR}/data/vitest-alias-suffixed`,
    files: [`${TARGET_DIR}/data/vitest-alias-suffixed.mjs`],
    source: `export default {\n  resolve: { alias: { "@guard/aliased": "../zz-guard-target/data/vitest-alias-suffixed" } },\n};\n`,
  },
  {
    name: "vite-alias-quoted",
    file: "vite.config.mjs",
    ext: "mjs",
    source: `export default {\n  "resolve": {\n    "alias": [{ "find": "@guard/aliased", "replacement": "../zz-guard-target/data/vite-alias-quoted.mjs" }],\n  },\n};\n`,
  },
  // Variants of the closed set's forms.
  {
    name: "path-join-cwd", // Relative to the package directory, where Turbo runs the task.
    file: "src/index.mjs",
    source: `import path from "node:path";\nimport { readFileSync } from "node:fs";\nexport const read = () => readFileSync(path.join("..", "zz-guard-target", "data", "path-join-cwd.json"));\n`,
  },
  {
    name: "file-url-encoded",
    file: "src/index.mjs",
    target: `${TARGET_DIR}/data/file url encoded.json`,
    source: `import { readFileSync } from "node:fs";\nexport const read = () => readFileSync(new URL("${toTarget}/data/file%20url%20encoded.json", import.meta.url));\n`,
  },
  {
    name: "path-join-directory",
    file: "src/index.mjs",
    target: `${TARGET_DIR}/data/directory`,
    files: [`${TARGET_DIR}/data/directory/entry.json`],
    declare: `${TARGET_DIR}/data/directory/**`,
    source: `import path from "node:path";\nexport const directory = path.join(import.meta.dirname, "${toTarget}/data/directory/");\n`,
  },
  {
    name: "package-require", // A package directory: its main file, so any of the package's files.
    file: "src/index.cjs",
    target: TARGET_DIR,
    files: [],
    declare: `${TARGET_DIR}/**`,
    source: `module.exports = require("${toTarget}");\n`,
  },
  {
    name: "jsx-text", // JSX text that looks like a comment opener does not hide the read after it.
    file: "src/view.jsx",
    ext: "mjs",
    source: `export const View = () => <code>src/*.ts</code>;\nexport const load = () => import("${toTarget}/data/jsx-text.mjs");\n`,
  },
  {
    name: "jsx-default-export", // JSX after `export default`, whose text looks like a comment opener.
    file: "src/view.jsx",
    ext: "mjs",
    source: `export default <code>src/*.ts</code>;\nexport const load = () => import("${toTarget}/data/jsx-default-export.mjs");\n`,
  },
  {
    name: "new-url-directory", // A URL that names a directory resolves the next URL inside it.
    file: "src/index.mjs",
    source:
      `import { readFileSync } from "node:fs";\nconst data = new URL("${toTarget}/data/", import.meta.url);\n` +
      `export const read = () => readFileSync(new URL("new-url-directory.json", data));\n`,
  },
  {
    name: "path-base", // A name used only as the base of other paths is not itself a read; the path built on it is.
    file: "src/index.mjs",
    source:
      `import path from "node:path";\nconst target = path.join(import.meta.dirname, "${toTarget}");\n` +
      `export const file = path.join(target, "data", "path-base.json");\n`,
  },
  {
    name: "package-root-path", // Another package's directory read by path: that package's files.
    file: "src/index.mjs",
    target: TARGET_DIR,
    files: [],
    missingIncludes: [`${TARGET_DIR}/src/index.cjs`, `${TARGET_DIR}/data/directory/entry.json`],
    declare: `${TARGET_DIR}/**`,
    source: `import path from "node:path";\nimport { readdirSync } from "node:fs";\nexport const list = () => readdirSync(path.join(import.meta.dirname, "${toTarget}"));\n`,
  },
  {
    name: "build-fixture", // A fixtures/ file that the build script runs reads for build, not only for tests.
    file: "fixtures/generate.mjs",
    task: "build",
    scripts: { build: "node fixtures/generate.mjs" },
    source: `import { readFileSync } from "node:fs";\nreadFileSync(new URL("${toTarget}/data/build-fixture.json", import.meta.url));\n`,
  },
  {
    name: "build-fixture-extensionless", // The build script names the file without its extension.
    file: "fixtures/generate.mjs",
    task: "build",
    scripts: { build: "tsx fixtures/generate" },
    source: `import { readFileSync } from "node:fs";\nreadFileSync(new URL("${toTarget}/data/build-fixture-extensionless.json", import.meta.url));\n`,
  },
  {
    name: "build-fixture-imported", // A fixtures/ file that a build source imports, through another fixtures/ file.
    file: "fixtures/data.mjs",
    task: "build",
    scripts: { build: "node -e 0" },
    extra: {
      "src/index.mjs": 'export { helper } from "../fixtures/helper.mjs";\n',
      "fixtures/helper.mjs": 'export { read as helper } from "./data.mjs";\n',
    },
    source: `import { readFileSync } from "node:fs";\nexport const read = () => readFileSync(new URL("${toTarget}/data/build-fixture-imported.json", import.meta.url));\n`,
  },
  // Build checks every read of a package that has a build task, whatever the file's name or how the build reaches it.
  {
    name: "build-test-file", // A test-named file that a `tsc -p` build may include.
    file: "src/index.test.mjs",
    task: "build",
    scripts: { build: "tsc -p ." },
    source: `import { readFileSync } from "node:fs";\nexport const read = () => readFileSync(new URL("${toTarget}/data/build-test-file.json", import.meta.url));\n`,
  },
  {
    name: "build-directory-edge", // A fixtures/ file the build reaches only through a read of its directory.
    file: "fixtures/generate.mjs",
    task: "build",
    scripts: { build: "node src/index.mjs" },
    extra: { "src/index.mjs": 'import path from "node:path";\nimport { readdirSync } from "node:fs";\nexport const list = () => readdirSync(path.join(import.meta.dirname, "../fixtures"));\n' },
    source: `import { readFileSync } from "node:fs";\nexport const read = () => readFileSync(new URL("${toTarget}/data/build-directory-edge.json", import.meta.url));\n`,
  },
  // A module read names every file a resolver could load for it: x.js also names x.ts, x.mjs also x.d.mts.
  {
    name: "import-js-ts",
    file: "src/index.mjs",
    ext: "js",
    files: [`${TARGET_DIR}/data/import-js-ts.js`, `${TARGET_DIR}/data/import-js-ts.ts`],
    source: `export { value } from "${toTarget}/data/import-js-ts.js";\n`,
  },
  {
    name: "import-mjs-dmts",
    file: "src/index.mjs",
    ext: "mjs",
    files: [`${TARGET_DIR}/data/import-mjs-dmts.mjs`, `${TARGET_DIR}/data/import-mjs-dmts.d.mts`],
    source: `export { value } from "${toTarget}/data/import-mjs-dmts.mjs";\n`,
  },
  // An alias of a directory that holds the package, and an import of a parent package, read their files.
  {
    name: "alias-ancestor",
    dir: "zz-guard-nest/packages/alias-ancestor",
    file: "vitest.config.mjs",
    target: "zz-guard-nest/packages",
    files: ["zz-guard-nest/packages/shared.mjs"],
    outside: { "zz-guard-nest/packages/shared.mjs": "export const shared = 1;\n" },
    source: `export default {\n  resolve: { alias: { "@guard/up": ".." } },\n};\n`,
  },
  {
    name: "require-parent",
    dir: "zz-guard-parent/typescript/child",
    file: "index.cjs",
    target: "zz-guard-parent/typescript",
    files: [],
    missingIncludes: ["zz-guard-parent/typescript/index.cjs", "zz-guard-parent/typescript/package.json"],
    declare: "zz-guard-parent/typescript/*",
    source: `module.exports = require("..");\n`,
  },
  // What a file outside every package goes on to import is read too.
  {
    name: "import-closure",
    file: "src/index.mjs",
    target: "zz-guard-nonpkg/closure-x.mjs",
    files: ["zz-guard-nonpkg/closure-x.mjs", "zz-guard-nonpkg/closure-y.mjs"],
    outside: {
      "zz-guard-nonpkg/closure-x.mjs": 'export { y } from "./closure-y.mjs";\n',
      "zz-guard-nonpkg/closure-y.mjs": "export const y = 1;\n",
    },
    source: `export { y } from "../../../zz-guard-nonpkg/closure-x.mjs";\n`,
  },
  // Form 4: a relative path in the script that runs a task or in its npm pre/post hook runs that file, so what the file
  // reads is read by the task: here a root script (a global input) that a prebuild hook runs, quoted because its name has
  // a space, reads a target file.
  {
    name: "lifecycle-script",
    file: "package.json",
    task: "build",
    target: "scripts/zz-guard lifecycle.mjs",
    files: [`${TARGET_DIR}/data/lifecycle-script.json`],
    outside: {
      "scripts/zz-guard lifecycle.mjs": `import path from "node:path";\nexport const file = path.join(import.meta.dirname, "../${TARGET_DIR}/data/lifecycle-script.json");\n`,
    },
    scripts: { prebuild: `node "../../scripts/zz-guard lifecycle.mjs" && node -e 0`, build: "node -e 0" },
    get source() {
      return manifest("@guard/lifecycle-script", this.scripts);
    },
  },
  // Reads in the markup expressions of components and in MDX expressions and export blocks.
  {
    name: "svelte-template",
    file: "src/View.svelte",
    ext: "mjs",
    source: `<p>{#await import("${toTarget}/data/svelte-template.mjs") then m}{m.value}{/await}</p>\n`,
  },
  {
    name: "vue-template",
    file: "src/View.vue",
    ext: "mjs",
    source: `<template>\n  <button @click="import('${toTarget}/data/vue-template.mjs')">Load</button>\n</template>\n`,
  },
  {
    name: "astro-template",
    file: "src/page.astro",
    ext: "mjs",
    source: `---\nconst title = "Page";\n---\n<h1>{title}</h1>\n<p>{import("${toTarget}/data/astro-template.mjs")}</p>\n`,
  },
  {
    name: "mdx-expression",
    file: "docs/page.mdx",
    ext: "mjs",
    source: `# Page\n\nIt's loaded by {import("${toTarget}/data/mdx-expression.mjs")}.\n`,
  },
  {
    name: "mdx-export-block",
    file: "docs/page.mdx",
    ext: "mjs",
    source: `export function load() {\n  const name = "x";\n  return import("${toTarget}/data/mdx-export-block.mjs");\n}\n\n# Page\n`,
  },
];
// Packages that declare only part of what they read: each still fails, naming what is left.
const PARTIAL = [
  { name: "partial-js-ts", reads: "import-js-ts", declare: [`${TARGET_DIR}/data/import-js-ts.js`], missing: [`${TARGET_DIR}/data/import-js-ts.ts`] },
  { name: "partial-mjs-dmts", reads: "import-mjs-dmts", declare: [`${TARGET_DIR}/data/import-mjs-dmts.mjs`], missing: [`${TARGET_DIR}/data/import-mjs-dmts.d.mts`] },
  { name: "partial-closure", reads: "import-closure", declare: ["zz-guard-nonpkg/closure-x.mjs"], missing: ["zz-guard-nonpkg/closure-y.mjs"] },
];
const dirOf = (form) => form.dir ?? `packages/zz-guard-${form.name}`;
const declaredOf = (form) => (Array.isArray(form.declare) ? form.declare : [form.declare ?? targetOf(form)]);
function targetOf(form) {
  return form.target ?? `${TARGET_DIR}/data/${form.name}.${form.ext ?? "json"}`;
}

const manifest = (name, scripts, dependencies = {}) =>
  `${JSON.stringify({ name, version: "0.0.0", private: true, type: "module", scripts, dependencies }, null, 2)}\n`;
const READER_SCRIPTS = { test: "node -e 0" };

let copyRoot = "";
let undeclaredRun;
let declaredRun;
let symlinkedRun;
let symlinkedUndeclaredRun;
let brokenRun;
let partialRun;

function write(file, contents) {
  mkdirSync(path.dirname(path.join(copyRoot, file)), { recursive: true });
  writeFileSync(path.join(copyRoot, file), contents);
}

function gitInCopy(args) {
  execFileSync("git", args, { cwd: copyRoot, stdio: "ignore", maxBuffer: 256 * 1024 * 1024 });
}

function runGuard(packages, root = copyRoot, script = guardScript) {
  const result = spawnSync(
    process.execPath,
    [script, "--root", root, "--turbo", turboBin, "--json", ...packages.flatMap((name) => ["--package", name])],
    { encoding: "utf8", env: TURBO_ENV, maxBuffer: 64 * 1024 * 1024 }
  );
  assert.ok(result.status === 0 || result.status === 1, `guard failed to run (${result.status}): ${result.stderr}`);
  // No output at all is a guard that did not run, which the tests report as a failure.
  return { status: result.status, reads: [], undeclared: [], ...(result.stdout ? JSON.parse(result.stdout) : {}) };
}

const FIXTURE_PACKAGES = [
  "@guard/target",
  ...FORMS.map((form) => `@guard/${form.name}`),
  "@guard/dependent",
  "@guard/inside",
  "@guard/base",
];

before(() => {
  assert.ok(existsSync(turboBin), `Turbo is not installed at ${turboBin}; run npm ci or set TURBO_BIN`);
  // The real path: Turbo matches no "$TURBO_ROOT$/…" input when the root is reached through a symlink (macOS /var).
  copyRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "turbo-inputs-guard-")));
  // Every file of this working tree that git does not ignore, committed or not.
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  for (const file of new Set(files.split("\0").filter(Boolean))) {
    const source = path.join(repoRoot, file);
    let stats;
    try {
      stats = lstatSync(source);
    } catch {
      continue; // Tracked but deleted in this working tree.
    }
    mkdirSync(path.dirname(path.join(copyRoot, file)), { recursive: true });
    if (stats.isSymbolicLink()) symlinkSync(readlinkSync(source), path.join(copyRoot, file));
    else copyFileSync(source, path.join(copyRoot, file));
  }

  write(`${TARGET_DIR}/package.json`, `${JSON.stringify({ name: "@guard/target", version: "0.0.0", private: true, main: "src/index.cjs", scripts: { build: "node -e 0" } }, null, 2)}\n`);
  write(`${TARGET_DIR}/src/index.mjs`, "export const value = 1;\n");
  write(`${TARGET_DIR}/src/index.cjs`, "module.exports = 1;\n");
  for (const form of FORMS) {
    for (const file of form.files ?? [targetOf(form)]) write(file, file.endsWith(".json") ? "{}\n" : "// A file a fixture package reads.\n");
    for (const [file, source] of Object.entries(form.outside ?? {})) write(file, source);
    write(`${dirOf(form)}/package.json`, manifest(`@guard/${form.name}`, form.scripts ?? READER_SCRIPTS));
    write(`${dirOf(form)}/${form.file}`, form.source);
    for (const [file, source] of Object.entries(form.extra ?? {})) write(`${dirOf(form)}/${file}`, source);
  }
  for (const partial of PARTIAL) {
    const form = FORMS.find((entry) => entry.name === partial.reads);
    write(`packages/zz-guard-${partial.name}/package.json`, manifest(`@guard/${partial.name}`, READER_SCRIPTS));
    write(`packages/zz-guard-${partial.name}/${form.file}`, form.source);
  }
  // The parent package that @guard/require-parent, nested in it, requires.
  write("zz-guard-parent/typescript/package.json", manifest("@guard/parent", {}).replace('"type": "module"', '"main": "index.cjs"'));
  write("zz-guard-parent/typescript/index.cjs", "module.exports = 1;\n");
  // Turbo hashes no symlink to a directory: a read of the target package counts this one as the directory's files.
  symlinkSync("directory", path.join(copyRoot, TARGET_DIR, "data", "directory-link"));
  // Reads a file of a package it depends on: its test task depends on that package's build through "^build".
  write("packages/zz-guard-dependent/package.json", manifest("@guard/dependent", READER_SCRIPTS, { "@guard/target": "*" }));
  write("packages/zz-guard-dependent/src/index.mjs", `export { value } from "${toTarget}/src/index.mjs";\n`);
  // Reads only its own files.
  write("packages/zz-guard-inside/package.json", manifest("@guard/inside", READER_SCRIPTS));
  write("packages/zz-guard-inside/data/own.json", "{}\n");
  write("packages/zz-guard-inside/src/local.mjs", "export const local = 1;\n");
  write(
    "packages/zz-guard-inside/src/index.mjs",
    `import path from "node:path";\nimport "./local.mjs";\nexport const file = path.join(import.meta.dirname, "../data/own.json");\n`
  );
  // Paths of directories that hold the package: the repository root and packages/. Bases, not reads.
  write("packages/zz-guard-base/package.json", manifest("@guard/base", READER_SCRIPTS));
  write(
    "packages/zz-guard-base/src/index.mjs",
    `import path from "node:path";\nexport const root = path.resolve(import.meta.dirname, "../../..");\nexport const packages = path.join(import.meta.dirname, "../..");\n`
  );
  // A file the tokenizer cannot read, in a package of its own (not in FIXTURE_PACKAGES).
  write("packages/zz-guard-broken/package.json", manifest("@guard/broken", READER_SCRIPTS));
  write("packages/zz-guard-broken/src/view.tsx", `export const View = () => <p>text</p>;\n/* never closed\nimport "${toTarget}/data/import.mjs";\n`);
  // Turbo hashes no "$TURBO_ROOT$/…" input in a repository without a commit.
  gitInCopy(["init", "-q"]);
  gitInCopy(["add", "-A"]);
  gitInCopy(["add", "-f", `${TARGET_DIR}/data/import-js-ts.js`]); // The repository ignores *.js files.
  gitInCopy(["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "--no-verify", "--no-gpg-sign", "-m", "copy"]);
  undeclaredRun = runGuard(FIXTURE_PACKAGES);
  brokenRun = spawnSync(process.execPath, [guardScript, "--root", copyRoot, "--turbo", turboBin, "--package", "@guard/broken"], {
    encoding: "utf8",
    env: TURBO_ENV,
  });
  // The same repository, and the guard script in it, reached through a symlink: before and after declaring.
  const link = path.join(realpathSync(tmpdir()), `${path.basename(copyRoot)}-link`);
  const linkedScript = path.join(link, "scripts", "turbo-inputs-guard.mjs");
  symlinkSync(copyRoot, link);
  try {
    symlinkedUndeclaredRun = runGuard(["@guard/import"], link, linkedScript);
    const declare = (directory, task, inputs) => {
      const declared = { extends: ["//"], tasks: { [task]: { inputs: ["$TURBO_DEFAULT$", ...inputs.map((input) => `$TURBO_ROOT$/${input}`)] } } };
      write(`${directory}/turbo.json`, `${JSON.stringify(declared, null, 2)}\n`);
    };
    for (const form of FORMS) declare(dirOf(form), form.task ?? "test", form.files && !form.declare ? form.files : declaredOf(form));
    for (const partial of PARTIAL) declare(`packages/zz-guard-${partial.name}`, "test", partial.declare);
    gitInCopy(["add", "-A"]);
    declaredRun = runGuard(FIXTURE_PACKAGES);
    partialRun = runGuard(PARTIAL.map((partial) => `@guard/${partial.name}`));
    symlinkedRun = runGuard(FIXTURE_PACKAGES, link, linkedScript);
  } finally {
    unlinkSync(link);
  }
});

after(() => {
  if (copyRoot) rmSync(copyRoot, { recursive: true, force: true, maxRetries: 5 });
});

for (const form of FORMS) {
  test(`${form.name}: an undeclared read fails the guard and passes once declared`, () => {
    const taskId = `@guard/${form.name}#${form.task ?? "test"}`;
    const failures = undeclaredRun.undeclared.filter((entry) => entry.taskId === taskId);
    assert.deepEqual(
      failures.map(({ file, target }) => ({ file, target })),
      [{ file: `${dirOf(form)}/${form.file}`, target: targetOf(form) }]
    );
    if (form.name === "package-require" || form.missingIncludes) {
      for (const file of form.missingIncludes ?? [`${TARGET_DIR}/src/index.cjs`]) assert.ok(failures[0].missing.includes(file), `${file} is read`);
      assert.ok(!failures[0].missing.includes(`${TARGET_DIR}/data/directory-link`), "a symlink to a directory is not itself a file to hash");
    } else {
      assert.deepEqual(failures[0].missing, form.files ?? [targetOf(form)]);
    }
    assert.equal(undeclaredRun.status, 1);
    assert.ok(declaredRun.reads.some((read) => read.package === `@guard/${form.name}` && read.target === targetOf(form)));
    assert.deepEqual(declaredRun.undeclared.filter((entry) => entry.taskId === taskId), []);
  });
}

test("a read declared only in part still fails, naming each file left undeclared", () => {
  for (const partial of PARTIAL) {
    const failures = partialRun.undeclared.filter((entry) => entry.taskId === `@guard/${partial.name}#test`);
    assert.equal(failures.length, 1, partial.name);
    assert.deepEqual(failures[0].missing, partial.missing, partial.name);
  }
  assert.equal(partialRun.status, 1);
});

test("the guard passes once every read is declared, also when the root is reached through a symlink", () => {
  assert.deepEqual(declaredRun.undeclared, []);
  assert.equal(declaredRun.status, 0);
  assert.deepEqual(symlinkedRun.undeclared, []);
  assert.equal(symlinkedRun.status, 0);
  assert.equal(symlinkedRun.reads.length, declaredRun.reads.length);
});

test("the guard runs when launched through a symlinked checkout, and fails on an undeclared read there", () => {
  assert.equal(symlinkedUndeclaredRun.status, 1);
  assert.deepEqual(
    symlinkedUndeclaredRun.undeclared.map(({ taskId, target }) => ({ taskId, target })),
    [{ taskId: "@guard/import#test", target: `${TARGET_DIR}/data/import.mjs` }]
  );
});

test("a file the guard cannot tokenize fails the guard with its file and line", () => {
  assert.equal(brokenRun.status, 2, brokenRun.stdout);
  assert.match(brokenRun.stderr, /packages\/zz-guard-broken\/src\/view\.tsx:2: cannot read an unterminated block comment/);
});

test("a read of a dependency package's file passes without a declaration", () => {
  assert.ok(undeclaredRun.reads.some((read) => read.package === "@guard/dependent" && read.target === `${TARGET_DIR}/src/index.mjs`));
  assert.deepEqual(undeclaredRun.undeclared.filter((entry) => entry.taskId.startsWith("@guard/dependent#")), []);
});

test("a read inside the package is ignored", () => {
  assert.deepEqual(undeclaredRun.reads.filter((read) => read.package === "@guard/inside"), []);
});

test("a path of a directory that holds the package (the repository root or an ancestor) is not a read", () => {
  assert.deepEqual(undeclaredRun.reads.filter((read) => read.package === "@guard/base"), []);
});

test("paths the closed set does not cover, comments and base directories are not reads", () => {
  const source = [
    'import path from "node:path";',
    'const repoRoot = path.resolve(import.meta.dirname, "../../..");',
    'export const docs = path.join(repoRoot, "other/docs/guide.md");', // A literal path on a resolved base: a read.
    'export const computed = path.join(import.meta.dirname, "..", "..", name);', // Computed: deferred to SFNS-306.
    '// import "../../other/commented.mjs";',
    'export const text = "../../other/not-a-path.json";',
  ].join("\n");
  const reads = findReadsInSource("pkg/a/src/index.mjs", source, "pkg/a");
  assert.deepEqual(reads, [
    { line: 1, form: "import", specifier: "node:path" }, // Not relative, so the guard skips it.
    { line: 3, form: "path", target: "/other/docs/guide.md" },
  ]);
});

test("JSX text, closing tags and TypeScript generics do not hide the reads after them", () => {
  const source = [
    "export const A = () => <p>Matches src/*.ts and `backticks`</p>;", // Neither a comment nor a template.
    'export const B = () => <><span>a</span><span>{import("../../other/same-line.mjs")}</span></>;',
    "export const C = () => <div>",
    "</div>",
    'export const late = () => import("../../other/next-line.mjs");',
    "export const id = <T extends unknown>(value: T) => value;", // A generic arrow function, not an element.
    'export const after = () => import("../../other/after-generic.mjs");',
    "export const less = (a: number, b: number) => a < b;",
    'export const last = () => import("../../other/last.mjs");',
  ].join("\n");
  const specifiers = findReadsInSource("pkg/a/src/view.tsx", source, "pkg/a").map(({ line, specifier }) => [line, specifier]);
  assert.deepEqual(specifiers, [
    [2, "../../other/same-line.mjs"],
    [5, "../../other/next-line.mjs"],
    [7, "../../other/after-generic.mjs"],
    [9, "../../other/last.mjs"],
  ]);
});

test("JSX after export default, generic components and comments in a tag do not hide the reads after them", () => {
  const source = [
    "export default <code>src/*.ts</code>;", // `default` starts an expression: JSX, not a comparison.
    "export const List = () => <Table<string>>rows /* of text</Table>;", // A generic component.
    'export const Tag = () => <div /* a comment */ id="x" // another',
    ">/* text</div>;",
    'export const late = () => import("../../other/late.mjs");',
    "export const half = (row: { default: number }) => row.default / 2 / 1;", // A property named default: division.
    "let i = 0;",
    'export const next = () => [i++ / 2, import("../../other/next.mjs")];', // Division after a postfix increment.
  ].join("\n");
  const specifiers = findReadsInSource("pkg/a/src/view.tsx", source, "pkg/a").map(({ line, specifier }) => [line, specifier]);
  assert.deepEqual(specifiers, [
    [5, "../../other/late.mjs"],
    [8, "../../other/next.mjs"],
  ]);
});

test("code the tokenizer cannot read is an error with the file and line, not a silent skip", () => {
  const cases = [
    ["src/view.tsx", "const a = 1;\n/* never closed\nimport '../../other/x.mjs';", 2, "an unterminated block comment"],
    ["src/view.tsx", "const a = b.match(/never closed\nimport '../../other/x.mjs';", 1, "an unterminated regular expression"],
    ["src/view.tsx", "const a = `never closed ${b}\nimport '../../other/x.mjs';", 1, "an unterminated template literal"],
    ["src/view.tsx", "const a = 'never closed\nimport '../../other/x.mjs';", 1, "an unterminated string"],
    ["src/view.jsx", "const a = 1;\nexport const V = () => <div>\nimport '../../other/x.mjs';", 2, "an unclosed JSX element"],
    ["src/index.ts", "const a = 1;\n/* never closed\nimport '../../other/x.mjs';", 2, "an unterminated block comment"],
  ];
  for (const [file, source, line, what] of cases) {
    assert.throws(() => findReadsInSource(`pkg/a/${file}`, source, "pkg/a"), { message: `pkg/a/${file}:${line}: cannot read ${what}` });
  }
});

test("URLs resolve as the WHATWG URL parser does, and string escapes are decoded", () => {
  const source = [
    'import path from "node:path";',
    'const data = new URL("../../b/data/", import.meta.url);', // A directory URL: the next URL resolves inside it.
    'export const a = new URL("a.json", data);',
    'export const b = new URL("  ../../b/b.json?raw#top\\t", import.meta.url);', // Spaces, a tab, query and fragment.
    'export const c = path.join(import.meta.dirname, "\\x2e\\u002e/\\u{2e}./b/c.json");', // Escaped dots.
    'export const d = new URL("/etc/hosts", import.meta.url);', // Absolute: outside the repository.
  ].join("\n");
  const targets = findReadsInSource("pkg/a/src/index.mjs", source, "pkg/a").flatMap(({ line, target }) => (target ? [[line, target]] : []));
  assert.deepEqual(targets, [
    [3, "/pkg/b/data/a.json"],
    [4, "/pkg/b/b.json"],
    [5, "/pkg/b/c.json"],
  ]);
});

test("a module read names every file a resolver could load for it", () => {
  const files = ["b/x.ts", "b/x.d.ts", "b/x/index.ts", "b/x/util.ts", "b/y.mjs", "b/y.d.mts", "b/z.js", "b/z.tsx"];
  const tracked = new Set(files);
  const trackedDirs = new Map([
    ["b", files],
    ["b/x", ["b/x/index.ts", "b/x/util.ts"]],
  ]);
  const resolve = (read) => resolveTarget(read, "a/index.ts", tracked, trackedDirs).files;
  // Extensionless: every extension, declarations included, and the directory's index files.
  assert.deepEqual(resolve({ form: "import", specifier: "../b/x" }), ["b/x.ts", "b/x.d.ts", "b/x/index.ts"]);
  // A trailing slash: the directory's index files only, never the file of the same name.
  assert.deepEqual(resolve({ form: "import", specifier: "../b/x/" }), ["b/x/index.ts"]);
  // An alias of a directory: every file under it, and the files a prefix of the same name resolves to.
  assert.deepEqual(resolve({ form: "alias", target: "/b/x" }), ["b/x.ts", "b/x.d.ts", "b/x/index.ts", "b/x/util.ts"]);
  // A JavaScript name also names its TypeScript sources and declarations.
  assert.deepEqual(resolve({ form: "import", specifier: "../b/y.mjs" }), ["b/y.mjs", "b/y.d.mts"]);
  assert.deepEqual(resolve({ form: "import", specifier: "../b/z.js" }), ["b/z.js", "b/z.tsx"]);
});

test("reads in component markup and MDX expressions are found; comments, prose and code examples are not reads", () => {
  const svelte = [
    '<script lang="ts" generics="T extends Record<string, number>">', // A ">" inside an attribute value.
    '  import B from "../../b/B.svelte";',
    "</script>",
    '<!-- {import("../../b/comment.mjs")} -->',
    '<p>Don\'t {#await import("../../b/await.mjs") then m}{m}{/await}</p>',
    '<button on:click={() => import("../../b/click.mjs")} class="x {y}">x</button>',
    "<style>p { color: red; }</style>",
  ].join("\n");
  const vue = [
    "<template>",
    '  <button @click="import(\'../../b/click.mjs\')" :a="b">{{ import(\'../../b/mustache.mjs\') }}</button>',
    "  <p>it's { not code</p>",
    "</template>",
    '<script setup lang="ts">',
    'import X from "../../b/x.ts";',
    "</script>",
  ].join("\n");
  const astro = [
    "---",
    'import X from "../../b/x.ts";',
    "---",
    "<ul>{items.map((i) => <li>{i}</li>)}</ul>",
    '<p>{import("../../b/expr.mjs")}</p>',
    '<!-- {import("../../b/comment.mjs")} -->',
    '<script>import "../../b/client.ts";</script>',
  ].join("\n");
  const mdx = [
    "---",
    "title: It's { not code",
    "---",
    "import A from '../../b/a.mjs'",
    "export const meta = {",
    "  a: [1, 2].map((n) => { const m = n; return m; }),", // A semicolon does not end the export block.
    "  b: import('../../b/meta.mjs'),",
    "};",
    "",
    "It's prose with `{import('../../b/inline.mjs')}` and {import('../../b/expr.mjs')}.",
    "",
    "```js",
    "import x from '../../b/fenced.mjs'",
    "```",
    "",
    "<Card href={import('../../b/attr.mjs')} />",
    "\\{not an expression}",
  ].join("\n");
  const specifiers = (file, source) => findReadsInSource(file, source, "pkg/a").map(({ line, specifier }) => [line, specifier]);
  assert.deepEqual(specifiers("pkg/a/src/A.svelte", svelte), [
    [2, "../../b/B.svelte"],
    [5, "../../b/await.mjs"],
    [6, "../../b/click.mjs"],
  ]);
  assert.deepEqual(specifiers("pkg/a/src/A.vue", vue), [
    [2, "../../b/click.mjs"],
    [2, "../../b/mustache.mjs"],
    [6, "../../b/x.ts"],
  ]);
  assert.deepEqual(specifiers("pkg/a/src/A.astro", astro), [
    [2, "../../b/x.ts"],
    [5, "../../b/expr.mjs"],
    [7, "../../b/client.ts"],
  ]);
  assert.deepEqual(specifiers("pkg/a/docs/a.mdx", mdx), [
    [4, "../../b/a.mjs"],
    [7, "../../b/meta.mjs"],
    [10, "../../b/expr.mjs"],
    [16, "../../b/attr.mjs"],
  ]);
  // Markup the guard cannot read is an error too.
  assert.throws(() => findReadsInSource("pkg/a/src/A.svelte", '<p>{import("../../b/x.mjs")\n</p>', "pkg/a"), {
    message: /^pkg\/a\/src\/A\.svelte:[12]: cannot read /,
  });
  assert.throws(() => findReadsInSource("pkg/a/src/A.vue", "<template>\n<!-- never closed\n</template>", "pkg/a"), {
    message: "pkg/a/src/A.vue:2: cannot read an unterminated HTML comment",
  });
});

// Hash of each task in a dry run of the copy, with the given file's contents changed (none when file is null).
function hashesAfterEditing(file, taskIds) {
  const target = file && path.join(copyRoot, file);
  const original = file && readFileSync(target);
  if (file) writeFileSync(target, Buffer.concat([original, Buffer.from("\n")]));
  try {
    const packages = [...new Set(taskIds.map((taskId) => taskId.split("#")[0]))];
    const tasks = [...new Set(taskIds.map((taskId) => taskId.split("#")[1]))];
    const output = execFileSync(
      process.execPath,
      [turboBin, "run", ...tasks, "--dry=json", ...packages.map((name) => `--filter=${name}`)],
      { cwd: copyRoot, encoding: "utf8", env: TURBO_ENV, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
    );
    const byId = new Map(JSON.parse(output).tasks.map((task) => [task.taskId, task.hash]));
    return Object.fromEntries(taskIds.map((taskId) => [taskId, byId.get(taskId)]));
  } finally {
    if (file) writeFileSync(target, original);
  }
}

// The reads the issue names: uifn/core build and test read the UIFn catalog, authfn/core tests read the authfn docs'
// llms-full.txt and packages/cli/src, and datafn/server tests read datafn/docs MDX.
test("changing a declared outside file changes the hash of each task that reads it", () => {
  const examples = [
    // @uifn/examples-shared's prebuild hook runs scripts/generate-uifn-catalog-accessibility.mjs, which reads it.
    ["uifn/catalog/generated/catalog.json", ["@uifn/core#build", "@uifn/core#test", "@uifn/examples-shared#build"]],
    ["authfn/docs/static/llms-full.txt", ["authfn#test"]],
    ["packages/cli/src/utils/schema-generators.ts", ["authfn#test"]],
    ["datafn/docs/content/docs/cli/drizzle-codegen.mdx", ["@datafn/server#test"]],
    // The declarations TypeScript resolves for uifn/parity/src/trace.mjs.
    ["uifn/parity/src/trace.d.mts", ["@uifn/solid#typecheck", "@uifn/react#typecheck", "@uifn/svelte#typecheck"]],
    // CSS @import reads, outside the guard's closed set: the Solid and Svelte workbench stylesheets import the React
    // workbench's, and Vite bundles them into both workbenches and both catalogs; searchfn/docs imports the docs theme
    // tokens, covered by its dependency on @superfunctions/docs-theme#build.
    ...["styles.css", "catalog.css"].map((file) => [
      `uifn/examples/react-workbench/src/${file}`,
      [
        "@uifn/example-solid-workbench#build",
        "@uifn/example-svelte-workbench#build",
        "@uifn/catalog-solid#build",
        "@uifn/catalog-svelte#build",
      ],
    ]),
    ["packages/docs-theme/src/tokens.css", ["@searchfn/docs#build"]],
  ];
  const taskIds = [...new Set(examples.flatMap(([, ids]) => ids))];
  const baseline = hashesAfterEditing(null, taskIds);
  for (const taskId of taskIds) assert.ok(baseline[taskId], `turbo --dry=json reports no hash for ${taskId}`);
  for (const [file, ids] of examples) {
    const changed = hashesAfterEditing(file, taskIds);
    for (const taskId of ids) assert.notEqual(changed[taskId], baseline[taskId], `${file} must change the hash of ${taskId}`);
  }
});

test("every DevFn package's build, typecheck, test and lint tasks are uncacheable", () => {
  const packages = JSON.parse(
    execFileSync(process.execPath, [turboBin, "ls", "--output=json"], { cwd: copyRoot, encoding: "utf8", env: TURBO_ENV })
  ).packages.items.filter((pkg) => pkg.path.startsWith("devfn/"));
  assert.ok(packages.length > 0, "no DevFn packages found");
  const output = execFileSync(
    process.execPath,
    [turboBin, "run", "build", "typecheck", "test", "lint", "--dry=json", ...packages.map((pkg) => `--filter=${pkg.name}`)],
    { cwd: copyRoot, encoding: "utf8", env: TURBO_ENV, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
  );
  const tasks = new Map(JSON.parse(output).tasks.map((task) => [task.taskId, task]));
  for (const pkg of packages) {
    for (const name of ["build", "typecheck", "test", "lint"]) {
      const task = tasks.get(`${pkg.name}#${name}`);
      assert.ok(task, `turbo --dry=json lists no ${pkg.name}#${name}`);
      assert.equal(task.resolvedTaskDefinition.cache, false, `${pkg.name}#${name} must not be cached`);
    }
  }
});

// A root "<package>#<task>" entry replaces the generic task rather than extending it.
test("every root <package>#<task> entry keeps the generic task's dependencies and outputs", () => {
  const rootTasks = JSON.parse(readFileSync(path.join(repoRoot, "turbo.json"), "utf8")).tasks;
  const entries = Object.entries(rootTasks).filter(([name]) => name.includes("#"));
  assert.ok(entries.length > 0);
  for (const [name, task] of entries) {
    const generic = rootTasks[name.split("#")[1]];
    assert.ok(generic, `${name} has no generic task`);
    assert.deepEqual(task.dependsOn, generic.dependsOn, `${name} dependsOn`);
    if (task.cache !== false) assert.deepEqual(task.outputs, generic.outputs, `${name} outputs`);
  }
});

// A cache hit of @uifn/examples-shared#build restores the data its prebuild hook generates from the catalog, which the
// workbenches bundle from shared/src, not only dist.
test("the examples-shared build caches the catalog accessibility data its prebuild generates", () => {
  const output = execFileSync(process.execPath, [turboBin, "run", "build", "--dry=json", "--filter=@uifn/examples-shared"], {
    cwd: copyRoot,
    encoding: "utf8",
    env: TURBO_ENV,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const task = JSON.parse(output).tasks.find((entry) => entry.taskId === "@uifn/examples-shared#build");
  assert.ok(task, "turbo --dry=json reports @uifn/examples-shared#build");
  assert.deepEqual(task.resolvedTaskDefinition.outputs, ["dist/**", "src/catalog-accessibility.generated.json"]);
  assert.deepEqual(task.resolvedTaskDefinition.dependsOn, ["^build"]);
});
