import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  loadParsers,
  packageNameOf,
  packageNamesOf,
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

function fixture(t, { owners = manifest(), releases, allow = {}, workspaces = ["datafn/*"], files = {}, links = {}, gitlinks = [] } = {}) {
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
  for (const [link, target] of Object.entries(links)) {
    mkdirSync(path.dirname(path.join(root, link)), { recursive: true });
    symlinkSync(target, path.join(root, link));
  }
  execFileSync(gitBinary(), ["init", "-q"], { cwd: root });
  execFileSync(gitBinary(), ["add", "-A"], { cwd: root });
  for (const gitlink of gitlinks) {
    execFileSync(gitBinary(), ["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},${gitlink}`], { cwd: root });
  }
  return root;
}

const run = (root) => spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
const findings = async (root) => (await verifyPublicBoundary({ root })).map(({ file, rule }) => `${file} ${rule}`);
const parsers = await loadParsers();
const specifiers = (file, source) => importSpecifiers(file, source, parsers).map(({ specifier, line }) => `${line} ${specifier}`);

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

test("an unlisted root file fails, naming the file and the rule", async (t) => {
  const root = fixture(t, { files: { "superfunctions.owners.next.json": "{}\n" } });
  assert.deepEqual(await findings(root), [`superfunctions.owners.next.json ${RULES.topLevelPath}`]);
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

test("a Python project the manifest does not list fails, naming its pyproject.toml", async (t) => {
  const root = fixture(t, { files: { "datafn/agent/pyproject.toml": '[project]\nname = "datafn-agent"\n' } });
  assert.deepEqual(await findings(root), [`datafn/agent/pyproject.toml ${RULES.publicRelease}`]);
});

test("a workspace package in an unlisted directory fails as a workspace package and as a top-level path", async (t) => {
  const root = fixture(t, {
    workspaces: ["datafn/*", "flowfn/*"],
    files: { "flowfn/core/package.json": json({ name: "@flowfn/core" }) },
  });
  assert.deepEqual((await findings(root)).sort(), [`flowfn/ ${RULES.topLevelPath}`, `flowfn/core/package.json ${RULES.workspacePackage}`]);
});

test("workspace package names must resolve to exactly one directory", async (t) => {
  const root = fixture(t, {
    files: {
      "datafn/server/package.json": json({ name: "@datafn/client" }),
      "datafn/cli/package.json": json({ private: true }),
    },
  });
  assert.deepEqual((await findings(root)).sort(), [
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

test("allow-listed *fn packages pass as imports and dependencies", async (t) => {
  const root = fixture(t, {
    allow: { "@flowfn/core": { reason: "published flow engine" }, flowfn: { reason: "published CLI" } },
    files: {
      "datafn/server/package.json": json({ name: "@datafn/server", dependencies: { "@flowfn/core": "^1.0.0", flowfn: "^1.0.0" } }),
      "datafn/server/src/index.ts": 'import { flow } from "@flowfn/core";\nconst cli = require("flowfn/bin");\n',
    },
  });
  assert.deepEqual(await findings(root), []);
});

test("an allow entry with paths applies only under those directories", async (t) => {
  const root = fixture(t, {
    allow: { "@flowfn/core": { reason: "alias in the server", paths: ["datafn/server"] } },
    files: {
      "datafn/server/src/index.ts": 'import "@flowfn/core";\n',
      "datafn/serverless/src/index.ts": 'import "@flowfn/core";\n',
    },
  });
  assert.deepEqual(await findings(root), [`datafn/serverless/src/index.ts:1 ${RULES.fnDependency}`]);
});

test("an allow entry naming a public workspace package is refused", async (t) => {
  const root = fixture(t, { allow: { "@datafn/core": { reason: "redundant" } } });
  assert.deepEqual(await findings(root), [`${ALLOW_FILE} ${RULES.fnDependency}`]);
});

test("prose, comments and strings that mention *fn packages are not checked", async (t) => {
  const root = fixture(t, {
    files: {
      "datafn/README.md": 'import { flow } from "@flowfn/core";\n',
      "datafn/core/src/notes.ts": '// import { flow } from "@flowfn/core";\nconst doc = `import { flow } from "@flowfn/core"`;\nexport const name = "flowfn";\n',
      "datafn/docs/guide.mdx": '# Guide\n\nYou can import flowfn from the registry when it ships.\n\n```ts\nimport { flow } from "@flowfn/core";\n```\n',
    },
  });
  assert.deepEqual(await findings(root), []);
});

test("imports in svelte, html and mdx module code are checked", async (t) => {
  const root = fixture(t, {
    files: {
      "datafn/svelte/src/View.svelte": '<script lang="ts">\n  import { flow } from "@flowfn/svelte";\n</script>\n<p>import "@flowfn/text"</p>\n',
      "datafn/site/index.html": '<script type="module">\nimport "@flowfn/web";\n</script>\n<script type="application/json">{"a":"@flowfn/data"}</script>\n',
      "datafn/docs/page.mdx": '# Page\n\nimport { Demo } from "@flowfn/docs";\n\nText.\n',
    },
  });
  assert.deepEqual(await findings(root), [
    `datafn/docs/page.mdx:3 ${RULES.fnDependency}`,
    `datafn/site/index.html:2 ${RULES.fnDependency}`,
    `datafn/svelte/src/View.svelte:2 ${RULES.fnDependency}`,
  ]);
});

test("imports in svelte templates, mdx expressions and html handlers are checked", async (t) => {
  const root = fixture(t, {
    files: {
      "datafn/svelte/src/Await.svelte": '<script>\n  let x = 1;\n</script>\n{#await import("@flowfn/await") then m}{/await}\n<button onclick={() => import("@flowfn/click")}>go</button>\n',
      "datafn/docs/jsx.mdx": '# Page\n\n<button onClick={() => import("@flowfn/jsx")}>go</button>\n\n{await import("@flowfn/expr")}\n',
      "datafn/docs/frontmatter.mdx": '---\ntitle: Page\n---\nimport { Demo } from "@flowfn/esm";\n',
      "datafn/docs/heading.mdx": '# Page\nimport { Demo } from "@flowfn/heading";\n',
      "datafn/site/handler.html": '<button\n  onclick="import(\'@flowfn/handler\')">go</button>\n',
      "datafn/core/src/registry.ts": 'import "npm:@flowfn/npm@^1";\nimport "jsr:@flowfn/jsr";\n',
    },
  });
  assert.deepEqual(await findings(root), [
    `datafn/core/src/registry.ts:1 ${RULES.fnDependency}`,
    `datafn/core/src/registry.ts:2 ${RULES.fnDependency}`,
    `datafn/docs/frontmatter.mdx:4 ${RULES.fnDependency}`,
    `datafn/docs/heading.mdx:2 ${RULES.fnDependency}`,
    `datafn/docs/jsx.mdx:3 ${RULES.fnDependency}`,
    `datafn/docs/jsx.mdx:5 ${RULES.fnDependency}`,
    `datafn/site/handler.html:2 ${RULES.fnDependency}`,
    `datafn/svelte/src/Await.svelte:4 ${RULES.fnDependency}`,
    `datafn/svelte/src/Await.svelte:5 ${RULES.fnDependency}`,
  ]);
});

test("html comments, jsx text and regex literals that look like imports are not code", async (t) => {
  const root = fixture(t, {
    files: {
      "datafn/site/comment.html": '<!-- <script type="module">import "@flowfn/comment";</script> -->\n<p>x</p>\n',
      "datafn/svelte/src/Comment.svelte": '<!-- <script>import "@flowfn/comment";</script> -->\n<p>import "@flowfn/text"</p>\n',
      "datafn/core/src/View.tsx": 'export const View = () => <p>import "@flowfn/core"</p>;\n',
      "datafn/core/src/pattern.ts": 'export const pattern = /import("@flowfn\\/core")/;\n',
    },
  });
  assert.deepEqual(await findings(root), []);
});

test("parentheses, as, satisfies, type assertions and ! around a specifier do not hide it", async (t) => {
  const root = fixture(t, {
    files: {
      "datafn/core/src/wrapped.ts": [
        'await import(("@flowfn/paren"));',
        'require(("@flowfn/require"));',
        'await import("@flowfn/as" as string);',
        'await import("@flowfn/satisfies" satisfies string);',
        'await import("@flowfn/bang"!);',
        'await import(<string>"@flowfn/assertion");',
        'require.resolve((("@flowfn/resolve") as string)!);',
      ].join("\n"),
      "datafn/svelte/src/Wrapped.svelte": [
        '<script lang="ts">',
        '  await import(("@flowfn/paren"));',
        '  await import("@flowfn/as" as string);',
        '  await import("@flowfn/satisfies" satisfies string);',
        '  await import("@flowfn/bang"!);',
        '  require(("@flowfn/require") as string);',
        "</script>",
        '<button onclick={() => import("@flowfn/template" as string)}>go</button>',
      ].join("\n"),
    },
  });
  assert.deepEqual(await findings(root), [
    ...[1, 2, 3, 4, 5, 6, 7].map((line) => `datafn/core/src/wrapped.ts:${line} ${RULES.fnDependency}`),
    ...[2, 3, 4, 5, 6, 8].map((line) => `datafn/svelte/src/Wrapped.svelte:${line} ${RULES.fnDependency}`),
  ]);
});

test("every module loader form is read; unrelated calls and plain strings are not", async (t) => {
  const root = fixture(t, {
    files: {
      "datafn/core/src/loaders.mts": [
        'import { createRequire } from "node:module";',
        'import { createRequire as makeRequire } from "module";',
        'import * as nodeModule from "node:module";',
        "const r = createRequire(import.meta.url);",
        'r("@flowfn/a");',
        'createRequire(import.meta.url).resolve("@flowfn/b");',
        'import.meta.resolve("@flowfn/c");',
        '(require)("@flowfn/d");',
        '(require.resolve)("@flowfn/e");',
        'require["resolve"]("@flowfn/f");',
        '(require as NodeRequire)("@flowfn/g");',
        'makeRequire(import.meta.url)("@flowfn/h");',
        'nodeModule.createRequire(import.meta.url)("@flowfn/i");',
        "const resolveFrom = r.resolve;",
        'resolveFrom("@flowfn/j");',
        "let later; later = createRequire(import.meta.url);",
        'later("@flowfn/k");',
        "const copy = r;",
        'copy("@flowfn/l");',
        '(createRequire(import.meta.url) as NodeRequire)["resolve"]!("@flowfn/m");',
        'unrelated("@flowfn/n"); other.resolve("@flowfn/o"); createRequire("@flowfn/p"); const s = "@flowfn/q";',
      ].join("\n"),
      "datafn/svelte/src/Loaders.svelte": [
        '<script lang="ts">',
        '  import { createRequire } from "node:module";',
        "  const load = createRequire(import.meta.url);",
        '  load("@flowfn/a");',
        '  import.meta.resolve("@flowfn/b");',
        '  unrelated("@flowfn/c");',
        "</script>",
        '<button onclick={() => (require as any)["resolve"]("@flowfn/d")}>go</button>',
      ].join("\n"),
      "datafn/docs/loaders.mdx": [
        'import { createRequire } from "node:module";',
        "",
        "export const load = createRequire(import.meta.url);",
        "",
        '{load.resolve("@flowfn/a")} and {import.meta.resolve("@flowfn/b")} and {unrelated("@flowfn/c")}',
        "",
      ].join("\n"),
    },
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /datafn\/core\/src\/loaders\.mts:5: \[fn-dependency\] imports "@flowfn\/a"/);
  assert.deepEqual(await findings(root), [
    ...[5, 7, 6, 8, 9, 10, 11, 12, 13, 15, 17, 19, 20].sort((a, b) => a - b).map((line) => `datafn/core/src/loaders.mts:${line} ${RULES.fnDependency}`),
    ...[5, 5].map((line) => `datafn/docs/loaders.mdx:${line} ${RULES.fnDependency}`),
    ...[4, 5, 8].map((line) => `datafn/svelte/src/Loaders.svelte:${line} ${RULES.fnDependency}`),
  ]);
});

test("svelte static on* attributes are read as inline handlers; other static attributes are not", async (t) => {
  const root = fixture(t, {
    files: {
      "datafn/svelte/src/Handlers.svelte": [
        "<button onclick={() => import(\"@flowfn/expression\")}>a</button>",
        "<button onclick=\"import('@flowfn/static')\">b</button>",
        "<button title=\"import('@flowfn/title')\" data-x=\"require('@flowfn/data')\">c</button>",
        "<svelte:element this=\"div\" onmouseover=\"require('@flowfn/element')\">d</svelte:element>",
      ].join("\n"),
    },
  });
  assert.deepEqual(await findings(root), [1, 2, 4].map((line) => `datafn/svelte/src/Handlers.svelte:${line} ${RULES.fnDependency}`));
});

test("html scripts of every JavaScript MIME type and legacy language are read; data blocks are not", async (t) => {
  const types = ["application/ecmascript", "text/jscript", "TEXT/JavaScript; charset=utf-8", "application/x-javascript", "text/livescript", "module", ""];
  const scripts = types.map((type) => `<script type="${type}">import("@flowfn/core")</script>`);
  const root = fixture(t, {
    files: {
      "datafn/site/types.html": [
        ...scripts,
        '<script language="JavaScript1.5">import("@flowfn/core")</script>',
        '<script language="">import("@flowfn/core")</script>',
        '<script type="application/json">{"a": "import(\'@flowfn/json\')"}</script>',
        '<script type="text/template">import("@flowfn/template")</script>',
        '<script language="vbscript">import("@flowfn/vbscript")</script>',
        '<script type="text/plain" language="javascript">import("@flowfn/plain")</script>',
      ].join("\n"),
    },
  });
  assert.deepEqual(
    await findings(root),
    Array.from({ length: types.length + 2 }, (_, index) => `datafn/site/types.html:${index + 1} ${RULES.fnDependency}`),
  );
});

test("svelte <script> elements inside the markup, such as in <svelte:head>, are read", async (t) => {
  const root = fixture(t, {
    files: {
      "datafn/svelte/src/Head.svelte": [
        "<svelte:head>",
        '  <script type="module">import "@flowfn/head";</script>',
        '  <script type="application/ld+json">{"x": "import(\'@flowfn/json\')"}</script>',
        "</svelte:head>",
        "<div>",
        "  <script>",
        '    import("@flowfn/inline");',
        "  </script>",
        "</div>",
      ].join("\n"),
      "datafn/svelte/src/BrokenHead.svelte": "<svelte:head>\n  <script>\n    let = ;\n  </script>\n</svelte:head>\n",
    },
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.deepEqual(await findings(root), [
    `datafn/svelte/src/BrokenHead.svelte:3 ${RULES.fnDependency}`,
    `datafn/svelte/src/Head.svelte:2 ${RULES.fnDependency}`,
    `datafn/svelte/src/Head.svelte:7 ${RULES.fnDependency}`,
  ]);
  assert.match(result.stderr, /datafn\/svelte\/src\/BrokenHead\.svelte:3: \[fn-dependency\] cannot be parsed/);
});

test("bundler queries, fragments and loader requests name their packages", async (t) => {
  const root = fixture(t, {
    files: {
      "datafn/core/src/bundler.ts": [
        'import a from "@flowfn/core?inline";',
        'import b from "flowfn?raw";',
        'import c from "raw-loader!@flowfn/x";',
        'import d from "@flowfn/core#fragment";',
        'import e from "@flowfn/loader?mode=1!./local.txt";',
        'import f from "raw-loader!./local.txt?raw";',
        'import g from "#internal?raw";',
      ].join("\n"),
    },
  });
  assert.deepEqual(
    await findings(root),
    [1, 2, 3, 4, 5].map((line) => `datafn/core/src/bundler.ts:${line} ${RULES.fnDependency}`),
  );
});

test("a source file that does not parse fails, naming the file, line and rule", async (t) => {
  const root = fixture(t, {
    files: {
      "datafn/core/src/broken.ts": 'export const a = 1;\nimport { from "@flowfn/core";\n',
      "datafn/svelte/src/Broken.svelte": "<script>\n</script>\n{#if x}\n",
      "datafn/docs/broken.mdx": "# Page\n\n{import(\n",
    },
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /datafn\/core\/src\/broken\.ts:2: \[fn-dependency\] cannot be parsed \(.+\); its imports cannot be checked/);
  assert.match(result.stderr, /datafn\/svelte\/src\/Broken\.svelte(:\d+)?: \[fn-dependency\] cannot be parsed/);
  assert.match(result.stderr, /datafn\/docs\/broken\.mdx(:\d+)?: \[fn-dependency\] cannot be parsed/);
});

test("tracked symlinks and submodules at the top level are checked as top-level paths", async (t) => {
  const root = fixture(t, {
    files: { "notes.txt": "x\n" },
    links: { "LINKED.md": "notes.txt", privatefn: "datafn" },
    gitlinks: ["vendorfn"],
    owners: { ...manifest(), rootFiles: { ...manifest().rootFiles, public: [...manifest().rootFiles.public, "notes.txt"] } },
  });
  assert.deepEqual(await findings(root), [`privatefn/ ${RULES.topLevelPath}`, `vendorfn/ ${RULES.topLevelPath}`, `LINKED.md ${RULES.topLevelPath}`]);
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /privatefn\/: \[top-level-path\] top-level directory is not listed/);
  assert.match(result.stderr, /vendorfn\/: \[top-level-path\] top-level directory is not listed/);
  assert.match(result.stderr, /LINKED\.md: \[top-level-path\] root file is not listed/);
});

test("a symlinked source file or package.json is read through its link", async (t) => {
  const root = fixture(t, {
    files: {
      "datafn/core/src/source.txt": 'import { flow } from "@flowfn/core";\n',
      "datafn/server/manifest.txt": json({ name: "@datafn/server", dependencies: { flowfn: "^1.0.0" } }),
    },
    links: { "datafn/core/src/flow.ts": "source.txt", "datafn/server/package.json": "manifest.txt" },
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /datafn\/core\/src\/flow\.ts:1: \[fn-dependency\] imports "@flowfn\/core"/);
  assert.match(result.stderr, /datafn\/server\/package\.json: \[fn-dependency\] dependencies depends on "flowfn"/);
});

test("a symlinked source file or package.json that cannot be read in the tree fails", async (t) => {
  const outside = mkdtempSync(path.join(tmpdir(), "verify-public-boundary-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, "secret.ts"), 'import "@flowfn/core";\n');
  const root = fixture(t, {
    links: {
      "datafn/core/src/outside.ts": path.join(outside, "secret.ts"),
      "datafn/core/src/dangling.ts": "missing.ts",
      "datafn/core/src/folder.ts": "../src",
      "datafn/linked/package.json": "../../gone/package.json",
    },
  });
  assert.deepEqual((await findings(root)).sort(), [
    `datafn/core/src/dangling.ts ${RULES.fnDependency}`,
    `datafn/core/src/folder.ts ${RULES.fnDependency}`,
    `datafn/core/src/outside.ts ${RULES.fnDependency}`,
    `datafn/linked/package.json ${RULES.fnDependency}`,
    `datafn/linked/package.json ${RULES.workspacePackage}`,
  ]);
});

test("a symlinked or submodule workspace directory fails; a symlinked directory without a package passes", async (t) => {
  const root = fixture(t, {
    files: { "datafn/swift/Package.swift": "// swift\n", "scripts/private/package.json": json({ name: "@private/x" }) },
    links: { "datafn/swift-package": "swift", "datafn/private": "../scripts/private" },
    gitlinks: ["datafn/vendored"],
  });
  assert.deepEqual((await findings(root)).sort(), [`datafn/private ${RULES.workspacePackage}`, `datafn/vendored ${RULES.workspacePackage}`]);
});

test("symlinks and submodules at an ancestor of a workspace match fail, naming the link and rule", async (t) => {
  const root = fixture(t, {
    workspaces: ["datafn/core", "datafn/client", "datafn/nested/*", "datafn/deep/*/*", "datafn/gone/*", "*/packages/*"],
    files: {
      "scripts/deep/a/b/package.json": json({ name: "@private/deep" }),
      "scripts/private/x/package.json": json({ name: "@private/x" }),
      "scripts/private-shallow/package.json": json({ name: "@private/shallow" }),
      "scripts/docs/readme.md": "# docs\n",
    },
    links: {
      // Ancestors npm expands workspaces through: each fails.
      "datafn/deep": "../scripts/deep",
      "datafn/packages": "../scripts/private",
      "datafn/gone": "../scripts/missing",
      // Reached by */packages/*, but no tracked package.json lies at a workspace match through it: passes.
      "scripts/packages": "docs",
      // Reached by datafn/deep/*/*, but its package.json is one level too shallow: passes.
      "datafn/shallow": "../scripts/private-shallow",
      // No workspace pattern reaches it: passes.
      "datafn/other": "../scripts/private",
    },
    gitlinks: ["datafn/nested"],
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /datafn\/nested: \[workspace-package\] is a submodule \(gitlink\) that npm expands workspace pattern "datafn\/nested\/\*" through/);
  assert.match(result.stderr, /datafn\/packages: \[workspace-package\] is a symlink to "\.\.\/scripts\/private"; npm reads workspace "datafn\/packages\/x" through it from scripts\/private\/x\/package\.json/);
  assert.deepEqual((await findings(root)).sort(), [
    `datafn/deep ${RULES.workspacePackage}`,
    `datafn/gone ${RULES.workspacePackage}`,
    `datafn/nested ${RULES.workspacePackage}`,
    `datafn/packages ${RULES.workspacePackage}`,
  ]);
});

test("python importlib.import_module and __import__ calls with a literal *fn name are checked", async (t) => {
  const root = fixture(t, {
    files: {
      "datafn/python/datafn/dynamic.py": [
        "import importlib",
        "from importlib import import_module",
        'importlib.import_module("flowfn")',
        'import_module("flowfn.core")',
        '__import__("flowfn")',
        'importlib.import_module(".flowfn", "datafn")',
        'importlib.import_module("datafn.client")',
        '"""importlib.import_module("flowfn") in a docstring"""',
        'name = "flowfn"',
        "",
      ].join("\n"),
    },
  });
  assert.deepEqual((await findings(root)).sort(), [3, 4, 5].map((line) => `datafn/python/datafn/dynamic.py:${line} ${RULES.fnDependency}`));
});

test("python imports of *fn modules must name a public Python project or an allowed package", async (t) => {
  const root = fixture(t, {
    allow: { pinnedfn: { reason: "published on PyPI" } },
    files: {
      "datafn/python/datafn/__init__.py": '"""import flowfn is not code here."""\n# import flowfn\nimport datafn.client\nfrom . import flowfn\nimport pinnedfn\n',
      "datafn/python/datafn/flow.py": "import os\nimport flowfn\nfrom flowfn.core import run\n",
      "datafn/python/datafn/broken.py": "def broken(:\n",
    },
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /datafn\/python\/datafn\/flow\.py:2: \[fn-dependency\] imports Python module "flowfn": "flowfn" is neither a public Python project nor allowed/);
  assert.match(result.stderr, /datafn\/python\/datafn\/flow\.py:3: \[fn-dependency\] imports Python module "flowfn\.core"/);
  assert.match(result.stderr, /datafn\/python\/datafn\/broken\.py:1: \[fn-dependency\] cannot be parsed/);
  assert.deepEqual((await findings(root)).sort(), [
    `datafn/python/datafn/broken.py:1 ${RULES.fnDependency}`,
    `datafn/python/datafn/flow.py:2 ${RULES.fnDependency}`,
    `datafn/python/datafn/flow.py:3 ${RULES.fnDependency}`,
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
    'type G = import("gfn").G;',
    'const h = require.resolve("hfn/package.json");',
    'export { i } from "ifn";',
  ].join("\n");
  assert.deepEqual(
    specifiers("x.ts", source).sort(),
    ["1 ffn", "2 @a-fn/x", "3 bfn", "4 cfn/sub", "5 @dfn/y", "6 efn", "7 ./local", "8 node:fs", "9 gfn", "10 hfn/package.json", "11 ifn"].sort(),
  );
});

test("*fn package names and specifiers", () => {
  assert.equal(packageNameOf("@flowfn/core/runtime"), "@flowfn/core");
  assert.equal(packageNameOf("flowfn/bin"), "flowfn");
  assert.equal(packageNameOf("npm:@flowfn/core@^1.2/runtime"), "@flowfn/core");
  assert.equal(packageNameOf("npm:flowfn@1"), "flowfn");
  assert.equal(packageNameOf("jsr:@flowfn/core"), "@flowfn/core");
  assert.equal(packageNameOf("@flowfn/core/sub?inline"), "@flowfn/core");
  assert.equal(packageNameOf("flowfn#hash"), "flowfn");
  assert.equal(packageNameOf("raw-loader!@flowfn/x?raw"), "@flowfn/x");
  assert.equal(packageNameOf("!!style-loader!./x.css"), null);
  assert.deepEqual(packageNamesOf("-!@flowfn/loader?x=1!css-loader!@flowfn/x"), ["@flowfn/loader", "css-loader", "@flowfn/x"]);
  assert.deepEqual(packageNamesOf("./x?raw"), []);
  for (const specifier of ["./x", "../x", "/abs", "#internal", "node:fs", "https://x/flowfn", "npm:", "npm:./x", "@flowfn"]) {
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

test("npm aliases in overrides, including nested ones, count as dependencies on their target", () => {
  assert.deepEqual(
    dependencyNames({
      overrides: { nanoid: "npm:@flowfn/core@1", zod: "3.0.0", react: { ".": "npm:flowfn@2", scheduler: "npm:@flowfn/scheduler" } },
    }).map(({ name, field }) => `${field} ${name}`),
    ["overrides.nanoid (npm alias) @flowfn/core", "overrides.react.. (npm alias) flowfn", "overrides.react.scheduler (npm alias) @flowfn/scheduler"],
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
  for (const pattern of ["datafn/**", "!datafn/x", "datafn/{a,b}", "datafn/@(core|client)", "datafn/+(a)", "datafn/(a)", "./datafn", "/datafn", "datafn/", "datafn/../x"]) {
    assert.throws(() => workspacePatterns({ workspaces: [pattern] }), BoundaryError, pattern);
  }
  assert.deepEqual(workspacePatterns({ workspaces: { packages: [".github/actions/*", "datafn/*"] } }), [".github/actions/*", "datafn/*"]);
});

test("a missing allow file fails with an error", (t) => {
  const result = run(fixture(t, { files: { [ALLOW_FILE]: null } }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scripts\/public-boundary\.allow\.json not found/);
});
