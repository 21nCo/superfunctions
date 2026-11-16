import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PUBLIC_MANIFEST } from "./owners.mjs";
import { gitBinary } from "./verify-package-lockfiles.mjs";
import {
  ALLOW_FILE,
  BoundaryError,
  RULES,
  dependencyNames,
  importSpecifiers,
  isFnPackage,
  packageNameOf,
  parseAllowFile,
  verifyPublicBoundary,
  workspacePatterns,
} from "./verify-public-boundary.mjs";

const script = fileURLToPath(new URL("./verify-public-boundary.mjs", import.meta.url));

const manifest = () => ({
  version: 1,
  paths: { datafn: "public", scripts: "public" },
  rootFiles: { public: ["package.json", "release-packages.json", PUBLIC_MANIFEST], generated: ["package-lock.json"] },
  releases: { "datafn-core": "public" },
  python: { datafn: "public" },
});

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function fixture(t, { owners = manifest(), releases, allow = {}, workspaces = ["datafn/*"], files = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "verify-public-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const all = {
    "package.json": json({ name: "root", private: true, workspaces }),
    "package-lock.json": "{}\n",
    "release-packages.json": json(releases ?? [{ slug: "datafn-core", path: "datafn/core", name: "@datafn/core" }]),
    [PUBLIC_MANIFEST]: json(owners),
    [ALLOW_FILE]: json({ version: 1, packages: allow }),
    "datafn/core/package.json": json({ name: "@datafn/core", dependencies: { zod: "^3.0.0" } }),
    "datafn/core/src/index.ts": 'import { z } from "zod";\nexport const schema = z.string();\n',
    "datafn/client/package.json": json({ name: "@datafn/client", dependencies: { "@datafn/core": "*" } }),
    "datafn/client/src/index.ts": 'export * from "@datafn/core";\n',
    "datafn/python/pyproject.toml": '[project]\nname = "datafn"\nversion = "0.1.0"\n',
    ...files,
  };
  for (const [file, content] of Object.entries(all)) {
    if (content === null) continue;
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  execFileSync(gitBinary(), ["init", "-q"], { cwd: root });
  execFileSync(gitBinary(), ["add", "-A"], { cwd: root });
  return root;
}

const run = (root) => spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
const findings = (root) => verifyPublicBoundary({ root }).map(({ file, rule }) => `${file} ${rule}`);

test("a tree inside the public boundary passes", (t) => {
  const result = run(fixture(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Public boundary holds/);
});

test("an unlisted top-level directory fails, naming the directory and the rule", (t) => {
  const result = run(fixture(t, { files: { "flowfn/core/index.ts": "export {};\n" } }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /flowfn\/: \[top-level-path\] top-level directory is not listed in superfunctions\.owners\.json paths/);
});

test("an unlisted root file fails, naming the file and the rule", (t) => {
  const root = fixture(t, { files: { "superfunctions.owners.next.json": "{}\n" } });
  assert.deepEqual(findings(root), [`superfunctions.owners.next.json ${RULES.topLevelPath}`]);
});

test("a release entry for an unlisted directory fails, naming the release file, entry and rule", (t) => {
  const owners = { ...manifest(), releases: { "datafn-core": "public", "flowfn-core": "public" } };
  const releases = [
    { slug: "datafn-core", path: "datafn/core", name: "@datafn/core" },
    { slug: "flowfn-core", path: "flowfn/core", name: "@flowfn/core" },
  ];
  const result = run(fixture(t, { owners, releases }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release-packages\.json: \[public-release\] release "flowfn-core" \(flowfn\/core\) is not under a top-level directory listed/);
});

test("a release entry the manifest does not list as public fails", (t) => {
  const releases = [
    { slug: "datafn-core", path: "datafn/core", name: "@datafn/core" },
    { slug: "datafn-client", path: "datafn/client", name: "@datafn/client" },
  ];
  const result = run(fixture(t, { releases }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release-packages\.json: \[public-release\] release "datafn-client" \(datafn\/client\) is not listed as public/);
});

test("a Python project the manifest does not list fails, naming its pyproject.toml", (t) => {
  const root = fixture(t, { files: { "datafn/agent/pyproject.toml": '[project]\nname = "datafn-agent"\n' } });
  assert.deepEqual(findings(root), [`datafn/agent/pyproject.toml ${RULES.publicRelease}`]);
});

test("a workspace package in an unlisted directory fails as a workspace package and as a top-level path", (t) => {
  const root = fixture(t, {
    workspaces: ["datafn/*", "flowfn/*"],
    files: { "flowfn/core/package.json": json({ name: "@flowfn/core" }) },
  });
  assert.deepEqual(findings(root).sort(), [`flowfn/ ${RULES.topLevelPath}`, `flowfn/core/package.json ${RULES.workspacePackage}`]);
});

test("workspace package names must resolve to exactly one directory", (t) => {
  const root = fixture(t, {
    files: {
      "datafn/server/package.json": json({ name: "@datafn/client" }),
      "datafn/cli/package.json": json({ private: true }),
    },
  });
  assert.deepEqual(findings(root).sort(), [
    `datafn/cli/package.json ${RULES.workspacePackage}`,
    `datafn/client/package.json ${RULES.workspacePackage}`,
    `datafn/server/package.json ${RULES.workspacePackage}`,
  ]);
});

test("an import of an unlisted *fn package fails, naming the file, line and rule", (t) => {
  const source = 'import { z } from "zod";\n\nimport { flow } from "@flowfn/core/runtime";\n';
  const result = run(fixture(t, { files: { "datafn/core/src/flow.ts": source } }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /datafn\/core\/src\/flow\.ts:3: \[fn-dependency\] imports "@flowfn\/core\/runtime": package "@flowfn\/core", which is neither a public workspace package nor allowed/);
});

test("a package.json dependency on an unlisted *fn package fails, naming the file, field and rule", (t) => {
  const pkg = json({ name: "@datafn/server", devDependencies: { flowfn: "^1.0.0" } });
  const result = run(fixture(t, { files: { "datafn/server/package.json": pkg } }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /datafn\/server\/package\.json: \[fn-dependency\] devDependencies depends on "flowfn"/);
});

test("allow-listed *fn packages pass as imports and dependencies", (t) => {
  const root = fixture(t, {
    allow: { "@flowfn/core": { reason: "published flow engine" }, flowfn: { reason: "published CLI" } },
    files: {
      "datafn/server/package.json": json({ name: "@datafn/server", dependencies: { "@flowfn/core": "^1.0.0", flowfn: "^1.0.0" } }),
      "datafn/server/src/index.ts": 'import { flow } from "@flowfn/core";\nconst cli = require("flowfn/bin");\n',
    },
  });
  assert.deepEqual(findings(root), []);
});

test("an allow entry with paths applies only under those directories", (t) => {
  const root = fixture(t, {
    allow: { "@flowfn/core": { reason: "alias in the server", paths: ["datafn/server"] } },
    files: {
      "datafn/server/src/index.ts": 'import "@flowfn/core";\n',
      "datafn/serverless/src/index.ts": 'import "@flowfn/core";\n',
    },
  });
  assert.deepEqual(findings(root), [`datafn/serverless/src/index.ts:1 ${RULES.fnDependency}`]);
});

test("an allow entry naming a public workspace package is refused", (t) => {
  const root = fixture(t, { allow: { "@datafn/core": { reason: "redundant" } } });
  assert.deepEqual(findings(root), [`${ALLOW_FILE} ${RULES.fnDependency}`]);
});

test("prose, comments and strings that mention *fn packages are not checked", (t) => {
  const root = fixture(t, {
    files: {
      "datafn/README.md": 'import { flow } from "@flowfn/core";\n',
      "datafn/core/src/notes.ts": '// import { flow } from "@flowfn/core";\nconst doc = `import { flow } from "@flowfn/core"`;\nexport const name = "flowfn";\n',
      "datafn/docs/guide.mdx": '# Guide\n\nimport flowfn from the registry when it ships.\n\n```ts\nimport { flow } from "@flowfn/core";\n```\n',
    },
  });
  assert.deepEqual(findings(root), []);
});

test("imports in svelte, html and mdx module code are checked", (t) => {
  const root = fixture(t, {
    files: {
      "datafn/svelte/src/View.svelte": '<script lang="ts">\n  import { flow } from "@flowfn/svelte";\n</script>\n<p>import "@flowfn/text"</p>\n',
      "datafn/site/index.html": '<script type="module">\nimport "@flowfn/web";\n</script>\n<script type="application/json">{"a":"@flowfn/data"}</script>\n',
      "datafn/docs/page.mdx": '# Page\n\nimport { Demo } from "@flowfn/docs";\n\nText.\n',
    },
  });
  assert.deepEqual(findings(root), [
    `datafn/docs/page.mdx:3 ${RULES.fnDependency}`,
    `datafn/site/index.html:2 ${RULES.fnDependency}`,
    `datafn/svelte/src/View.svelte:2 ${RULES.fnDependency}`,
  ]);
});

test("every import form is read", () => {
  const source = [
    '/// <reference types="ffn" />',
    'import type { A } from "@a-fn/x";',
    'export * from "bfn";',
    'const c = await import("cfn/sub");',
    'const d = require("@dfn/y");',
    'import e = require("efn");',
    'import "./local";',
    'import "node:fs";',
  ].join("\n");
  assert.deepEqual(
    importSpecifiers("x.ts", source).map(({ specifier, line }) => `${line} ${specifier}`).sort(),
    ["1 ffn", "2 @a-fn/x", "3 bfn", "4 cfn/sub", "5 @dfn/y", "6 efn", "7 ./local", "8 node:fs"].sort(),
  );
});

test("*fn package names and specifiers", () => {
  assert.equal(packageNameOf("@flowfn/core/runtime"), "@flowfn/core");
  assert.equal(packageNameOf("flowfn/bin"), "flowfn");
  for (const specifier of ["./x", "../x", "/abs", "#internal", "node:fs", "npm:flowfn", "https://x/flowfn"]) {
    assert.equal(packageNameOf(specifier), null, specifier);
  }
  for (const name of ["@flowfn/core", "flowfn", "@a.fn/x", "FlowFn"]) assert.equal(isFnPackage(name), true, name);
  for (const name of ["@superfunctions/core", "fn", "@fn/x", "fnord", "@flowfn", "zod"]) assert.equal(isFnPackage(name), false, name);
});

test("npm aliases count by both their alias and their target", () => {
  assert.deepEqual(
    dependencyNames({ dependencies: { local: "npm:@flowfn/core@^1" }, bundleDependencies: ["flowfn"] }).map(({ name }) => name),
    ["local", "@flowfn/core", "flowfn"],
  );
});

test("a malformed allow file or workspace pattern fails closed", () => {
  const bad = [
    [],
    { version: 2, packages: {} },
    { version: 1, packages: {}, extra: true },
    { version: 1, packages: { zod: { reason: "not an fn package" } } },
    { version: 1, packages: { flowfn: {} } },
    { version: 1, packages: { flowfn: { reason: " " } } },
    { version: 1, packages: { flowfn: { reason: "x", note: "y" } } },
    { version: 1, packages: { flowfn: { reason: "x", paths: [] } } },
    { version: 1, packages: { flowfn: { reason: "x", paths: ["../outside"] } } },
    { version: 1, packages: { flowfn: { reason: "x", paths: ["datafn/"] } } },
  ];
  for (const data of bad) assert.throws(() => parseAllowFile(data), BoundaryError, JSON.stringify(data));
  for (const pattern of ["datafn/**", "!datafn/x", "datafn/{a,b}", "./datafn", "/datafn", "datafn/", "datafn/../x"]) {
    assert.throws(() => workspacePatterns({ workspaces: [pattern] }), BoundaryError, pattern);
  }
  assert.deepEqual(workspacePatterns({ workspaces: { packages: [".github/actions/*", "datafn/*"] } }), [".github/actions/*", "datafn/*"]);
});

test("a missing allow file fails with an error", (t) => {
  const result = run(fixture(t, { files: { [ALLOW_FILE]: null } }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scripts\/public-boundary\.allow\.json not found/);
});
