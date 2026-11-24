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

import { findReadsInSource } from "./turbo-inputs-guard.mjs";

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
    ext: "mjs",
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
    name: "build-fixture", // A fixtures/ file that the build script runs reads for build, not only for tests.
    file: "fixtures/generate.mjs",
    task: "build",
    scripts: { build: "node fixtures/generate.mjs" },
    source: `import { readFileSync } from "node:fs";\nreadFileSync(new URL("${toTarget}/data/build-fixture.json", import.meta.url));\n`,
  },
];
const targetOf = (form) => form.target ?? `${TARGET_DIR}/data/${form.name}.${form.ext ?? "json"}`;

const manifest = (name, scripts, dependencies = {}) =>
  `${JSON.stringify({ name, version: "0.0.0", private: true, type: "module", scripts, dependencies }, null, 2)}\n`;
const READER_SCRIPTS = { test: "node -e 0" };

let copyRoot = "";
let undeclaredRun;
let declaredRun;
let symlinkedRun;

function write(file, contents) {
  mkdirSync(path.dirname(path.join(copyRoot, file)), { recursive: true });
  writeFileSync(path.join(copyRoot, file), contents);
}

function gitInCopy(args) {
  execFileSync("git", args, { cwd: copyRoot, stdio: "ignore", maxBuffer: 256 * 1024 * 1024 });
}

function runGuard(packages, root = copyRoot) {
  const result = spawnSync(
    process.execPath,
    [guardScript, "--root", root, "--turbo", turboBin, "--json", ...packages.flatMap((name) => ["--package", name])],
    { encoding: "utf8", env: TURBO_ENV, maxBuffer: 64 * 1024 * 1024 }
  );
  assert.ok(result.status === 0 || result.status === 1, `guard failed to run (${result.status}): ${result.stderr}`);
  return { status: result.status, ...JSON.parse(result.stdout) };
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
    write(`packages/zz-guard-${form.name}/package.json`, manifest(`@guard/${form.name}`, form.scripts ?? READER_SCRIPTS));
    write(`packages/zz-guard-${form.name}/${form.file}`, form.source);
  }
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
  // Builds paths on another package's directory (packages/errors, which the guard runs are not given with --package):
  // a base for other paths, not a read.
  write("packages/zz-guard-base/package.json", manifest("@guard/base", READER_SCRIPTS));
  write("packages/zz-guard-base/src/index.mjs", `import path from "node:path";\nexport const base = path.join(import.meta.dirname, "../../errors");\n`);
  // Turbo hashes no "$TURBO_ROOT$/…" input in a repository without a commit.
  gitInCopy(["init", "-q"]);
  gitInCopy(["add", "-A"]);
  gitInCopy(["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "--no-verify", "--no-gpg-sign", "-m", "copy"]);
  undeclaredRun = runGuard(FIXTURE_PACKAGES);

  for (const form of FORMS) {
    const task = form.task ?? "test";
    const declared = { extends: ["//"], tasks: { [task]: { inputs: ["$TURBO_DEFAULT$", `$TURBO_ROOT$/${form.declare ?? targetOf(form)}`] } } };
    write(`packages/zz-guard-${form.name}/turbo.json`, `${JSON.stringify(declared, null, 2)}\n`);
  }
  gitInCopy(["add", "-A"]);
  declaredRun = runGuard(FIXTURE_PACKAGES);
  // The same repository reached through a symlink.
  const link = path.join(realpathSync(tmpdir()), `${path.basename(copyRoot)}-link`);
  symlinkSync(copyRoot, link);
  try {
    symlinkedRun = runGuard(FIXTURE_PACKAGES, link);
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
      [{ file: `packages/zz-guard-${form.name}/${form.file}`, target: targetOf(form) }]
    );
    if (form.name === "package-require") {
      assert.ok(failures[0].missing.includes(`${TARGET_DIR}/src/index.cjs`), "the package's main file is a read");
    } else {
      assert.deepEqual(failures[0].missing, form.files ?? [targetOf(form)]);
    }
    assert.equal(undeclaredRun.status, 1);
    assert.ok(declaredRun.reads.some((read) => read.package === `@guard/${form.name}` && read.target === targetOf(form)));
    assert.deepEqual(declaredRun.undeclared.filter((entry) => entry.taskId === taskId), []);
  });
}

test("the guard passes once every read is declared, also when the root is reached through a symlink", () => {
  assert.deepEqual(declaredRun.undeclared, []);
  assert.equal(declaredRun.status, 0);
  assert.deepEqual(symlinkedRun.undeclared, []);
  assert.equal(symlinkedRun.status, 0);
});

test("a read of a dependency package's file passes without a declaration", () => {
  assert.ok(undeclaredRun.reads.some((read) => read.package === "@guard/dependent" && read.target === `${TARGET_DIR}/src/index.mjs`));
  assert.deepEqual(undeclaredRun.undeclared.filter((entry) => entry.taskId.startsWith("@guard/dependent#")), []);
});

test("a read inside the package is ignored", () => {
  assert.deepEqual(undeclaredRun.reads.filter((read) => read.package === "@guard/inside"), []);
});

test("a path on another package's directory is a base, also when that package is not selected", () => {
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
    'export const B = () => <span>a</span><span>{import("../../other/same-line.mjs")}</span>;',
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
    ["uifn/catalog/generated/catalog.json", ["@uifn/core#build", "@uifn/core#test"]],
    ["authfn/docs/static/llms-full.txt", ["authfn#test"]],
    ["packages/cli/src/utils/schema-generators.ts", ["authfn#test"]],
    ["datafn/docs/content/docs/cli/drizzle-codegen.mdx", ["@datafn/server#test"]],
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
