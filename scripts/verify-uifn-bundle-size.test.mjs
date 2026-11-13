import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BUDGETS_PATH,
  FIXTURE_ROOT,
  budgetFor,
  buildFixture,
  evaluateFixture,
  findRootBarrelImports,
  findUnrelatedPrimitiveCode,
  listFixtures,
  parseArgs,
  parseBudgets,
  recordBudgets,
  verifyBundleSizes,
} from "./verify-uifn-bundle-size.mjs";

const script = fileURLToPath(new URL("./verify-uifn-bundle-size.mjs", import.meta.url));
const repoRoot = path.resolve(path.dirname(script), "..");
const fixtureIds = listFixtures().map((fixture) => fixture.id);

function tempDir(t, prefix, parent = tmpdir()) {
  const directory = mkdtempSync(path.join(parent, prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function requireBuiltAdapters() {
  for (const adapter of ["react", "svelte", "solid"]) {
    assert.ok(existsSync(path.join(repoRoot, "uifn", adapter, "dist")), `build @uifn/${adapter} and its dependencies first`);
  }
}

test("every adapter has a Tabs and a Menu fixture, each with a stored budget", () => {
  assert.deepEqual(fixtureIds, ["react/tabs", "react/menu", "svelte/tabs", "svelte/menu", "solid/tabs", "solid/menu"]);
  const { budgets, errors } = parseBudgets(JSON.parse(readFileSync(DEFAULT_BUDGETS_PATH, "utf8")), fixtureIds);
  assert.deepEqual(errors, []);
  assert.equal(budgets.size, fixtureIds.length);
});

test("a stored budget is the measured size plus 10%, rounded up", () => {
  const document = JSON.parse(readFileSync(DEFAULT_BUDGETS_PATH, "utf8"));
  for (const id of fixtureIds) {
    const entry = document.fixtures[id];
    assert.equal(entry.budgetGzipBytes, budgetFor(entry.measuredGzipBytes), id);
  }
  assert.equal(budgetFor(1000), 1100);
  assert.equal(budgetFor(1001), 1102);
  assert.deepEqual(recordBudgets([{ fixture: "react/tabs", gzipBytes: 1000 }]).fixtures, { "react/tabs": { measuredGzipBytes: 1000, budgetGzipBytes: 1100 } });
});

test("a fixture over its budget fails; one at or under it passes", () => {
  const base = { id: "react/tabs", primitive: "tabs", source: "export{}" };
  assert.deepEqual(evaluateFixture({ ...base, gzipBytes: 1100, budget: 1100 }), []);
  assert.deepEqual(evaluateFixture({ ...base, gzipBytes: 1099, budget: 1100 }), []);
  assert.deepEqual(evaluateFixture({ ...base, gzipBytes: 1101, budget: 1100 }), [
    { code: "UIFN_BUNDLE_BUDGET_EXCEEDED", fixture: "react/tabs", gzipBytes: 1101, budgetGzipBytes: 1100 },
  ]);
  assert.deepEqual(evaluateFixture({ ...base, gzipBytes: 10 }), [{ code: "UIFN_BUNDLE_BUDGET_MISSING", fixture: "react/tabs", gzipBytes: 10 }]);
});

test("QR-code and color-picker markers fail a fixture that does not own them", () => {
  const source = 'const a="--uifn-channel-position";throw new Error("bad maskPattern:"+m)';
  assert.deepEqual(findUnrelatedPrimitiveCode(source, "tabs"), [
    { primitive: "qr-code", markers: ["bad maskPattern:"] },
    { primitive: "color-picker", markers: ["--uifn-channel-position"] },
  ]);
  assert.deepEqual(findUnrelatedPrimitiveCode(source, "qr-code"), [{ primitive: "color-picker", markers: ["--uifn-channel-position"] }]);
  assert.deepEqual(findUnrelatedPrimitiveCode("export const tabs = 1;", "tabs"), []);
  assert.deepEqual(evaluateFixture({ id: "svelte/menu", primitive: "menu", gzipBytes: 1, budget: 2, source: "xMidYMid meet" }), [
    { code: "UIFN_BUNDLE_UNRELATED_PRIMITIVE", fixture: "svelte/menu", primitive: "qr-code", markers: ["xMidYMid meet"] },
  ]);
});

test("the budgets file must cover exactly the fixtures with positive integer budgets", () => {
  const fixtures = Object.fromEntries(fixtureIds.map((id) => [id, { budgetGzipBytes: 100 }]));
  assert.deepEqual(parseBudgets({ schemaVersion: 1, fixtures }, fixtureIds).errors, []);
  assert.deepEqual(parseBudgets({ schemaVersion: 2, fixtures }, fixtureIds).errors, ["budgets file must have schemaVersion 1 and a fixtures object"]);
  const { "solid/menu": _removed, ...missing } = fixtures;
  assert.deepEqual(parseBudgets({ schemaVersion: 1, fixtures: missing }, fixtureIds).errors, ["solid/menu: budgetGzipBytes must be a positive integer"]);
  assert.deepEqual(parseBudgets({ schemaVersion: 1, fixtures: { ...fixtures, "react/tabs": { budgetGzipBytes: 1.5 } } }, fixtureIds).errors, ["react/tabs: budgetGzipBytes must be a positive integer"]);
  assert.deepEqual(parseBudgets({ schemaVersion: 1, fixtures: { ...fixtures, "react/dialog": { budgetGzipBytes: 9 } } }, fixtureIds).errors, ["react/dialog: budget has no fixture"]);
});

test("adapter sources may not import the @uifn/core root barrel, even for types", (t) => {
  const root = tempDir(t, "uifn-root-barrel-");
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  write("uifn/solid/src/internal/compound.tsx", "import {\n  type UIFnController,\n} from '@uifn/core';\nimport { mergePartProps } from '@uifn/core/parts';\n");
  write("uifn/react/src/hooks/use-controller.ts", 'import type { UIFnController } from "@uifn/core";\n');
  write("uifn/svelte/lib/internal/Root.svelte", "<script lang=\"ts\">\n  const core = await import('@uifn/core');\n</script>\n");
  write("uifn/react/src/generated/tabs.tsx", "import { createTabsController } from '@uifn/core/primitives/tabs';\n");
  write("uifn/react/src/__tests__/core.test.tsx", "import { createTabsController } from '@uifn/core';\n");
  write("uifn/react/src/test/setup.ts", "import '@uifn/core';\n");
  write("uifn/solid/src/toggle.test.tsx", "import { createToggleController } from '@uifn/core';\n");
  // The specifier on the line after `from`, or after `import(`, is still a root-barrel import.
  write("uifn/react/src/split-from.ts", "import { type UIFnController } from\n  '@uifn/core';\n");
  write("uifn/solid/src/split-dynamic.ts", "export const load = () => import(\n  '@uifn/core'\n);\n");
  write("uifn/svelte/lib/split.ts", "export * from\n\"@uifn/core\";\nexport type Core = typeof import(\n'@uifn/core');\nimport core = require(\n'@uifn/core');\n");
  write("uifn/svelte/lib/internal/Part.svelte", "<div></div>\n<script lang=\"ts\">\n  import type { UIFnController } from\n    '@uifn/core';\n</script>\n");
  // Template expressions load modules too, and a `generics` attribute may contain `>`.
  write("uifn/svelte/lib/internal/Lazy.svelte", "<script lang=\"ts\" generics=\"T extends Map<string, number>\">\n  let { value }: { value: T } = $props();\n</script>\n<button onclick={async () => console.log(await import('@uifn/core'))}>Load</button>\n{#await import(\n  \"@uifn/core\"\n) then core}{core}{/await}\n");
  // Strings and comments that mention the root barrel load nothing, and subpaths are allowed.
  write("uifn/react/src/text.ts", "// import x from '@uifn/core';\nexport const note = \"from '@uifn/core'\";\nimport { a } from '@uifn/core/parts';\n");
  assert.deepEqual(findRootBarrelImports(root).sort(), [
    "uifn/react/src/hooks/use-controller.ts:1",
    "uifn/react/src/split-from.ts:2",
    "uifn/solid/src/internal/compound.tsx:3",
    "uifn/solid/src/split-dynamic.ts:2",
    "uifn/svelte/lib/internal/Lazy.svelte:4",
    "uifn/svelte/lib/internal/Lazy.svelte:6",
    "uifn/svelte/lib/internal/Part.svelte:4",
    "uifn/svelte/lib/internal/Root.svelte:2",
    "uifn/svelte/lib/split.ts:2",
    "uifn/svelte/lib/split.ts:4",
    "uifn/svelte/lib/split.ts:6",
  ]);
});

test("the current adapter sources import @uifn/core only through subpaths", () => {
  assert.deepEqual(findRootBarrelImports(), []);
});

test("an unknown or missing --fixture fails instead of passing with nothing measured", async () => {
  let builds = 0;
  const build = async () => { builds += 1; return { files: [], source: "export{}" }; };
  const unknown = await verifyBundleSizes({ only: ["react/nope"], build });
  assert.equal(unknown.ok, false);
  assert.equal(builds, 0);
  assert.deepEqual(unknown.measurements, []);
  assert.deepEqual(unknown.failures.map((failure) => failure.code), ["UIFN_BUNDLE_FIXTURE_UNKNOWN", "UIFN_BUNDLE_NO_FIXTURES"]);

  const mixed = await verifyBundleSizes({ only: ["react/tabs", "react/nope"], build });
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.failures.map((failure) => failure.code), ["UIFN_BUNDLE_FIXTURE_UNKNOWN"]);

  assert.throws(() => parseArgs(["--fixture"]), /--fixture needs a value/);
  assert.throws(() => parseArgs(["--fixture", "--json"]), /--fixture needs a value/);
  assert.throws(() => parseArgs(["--budgets"]), /--budgets needs a value/);
  for (const args of [["--fixture", "react/nope"], ["--fixture"]]) {
    const run = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(run.status, 1, `${args.join(" ")}: ${run.stdout}`);
    assert.doesNotMatch(run.stdout, /ok: every fixture/);
  }
});

test("the markers find QR-code and color-picker code in a real minified Vite build", async (t) => {
  requireBuiltAdapters();
  const directory = tempDir(t, ".marker-check-", path.join(FIXTURE_ROOT, "react"));
  const entry = path.join(directory, "entry.tsx");
  writeFileSync(entry, [
    "import { QRCode } from '@uifn/react/qr-code';",
    "import { ColorPicker } from '@uifn/react/color-picker';",
    "console.log(QRCode, ColorPicker);",
    "",
  ].join("\n"));
  const { source } = await buildFixture({ id: "react/marker-check", framework: "react", primitive: "tabs", entry });
  const hits = Object.fromEntries(findUnrelatedPrimitiveCode(source, "tabs").map((hit) => [hit.primitive, hit.markers.length]));
  assert.ok(hits["qr-code"] >= 3, `expected QR-code markers, found ${JSON.stringify(hits)}`);
  assert.ok(hits["color-picker"] >= 2, `expected color-picker markers, found ${JSON.stringify(hits)}`);
});

test("the check exits non-zero when a real fixture build exceeds a lowered budget", (t) => {
  requireBuiltAdapters();
  const document = JSON.parse(readFileSync(DEFAULT_BUDGETS_PATH, "utf8"));
  document.fixtures["react/tabs"].budgetGzipBytes = 1000;
  const budgetsPath = path.join(tempDir(t, "uifn-size-budgets-"), "budgets.json");
  writeFileSync(budgetsPath, JSON.stringify(document));
  const lowered = spawnSync(process.execPath, [script, "--budgets", budgetsPath, "--fixture", "react/tabs"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(lowered.status, 1, lowered.stderr);
  assert.match(lowered.stderr, /error: react\/tabs is \d+ B gzip, over its 1000 B budget/);

  const stored = spawnSync(process.execPath, [script, "--fixture", "react/tabs"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(stored.status, 0, stored.stderr);
  assert.match(stored.stdout, /ok: every fixture is within budget and free of unrelated primitives/);
});

test("the DOM-binding markers find Dialog, Select, Slider and Menu wiring in a real minified build of every adapter", async (t) => {
  requireBuiltAdapters();
  for (const framework of ["react", "svelte", "solid"]) {
    const directory = tempDir(t, ".binding-marker-check-", path.join(FIXTURE_ROOT, framework));
    const entry = path.join(directory, framework === "svelte" ? "entry.ts" : "entry.tsx");
    writeFileSync(entry, [
      `import { Dialog } from '@uifn/${framework}/dialog';`,
      `import { Select } from '@uifn/${framework}/select';`,
      `import { Slider } from '@uifn/${framework}/slider';`,
      `import { Menu } from '@uifn/${framework}/menu';`,
      "console.log(Dialog, Select, Slider, Menu);",
      "",
    ].join("\n"));
    const { source } = await buildFixture({ id: `${framework}/binding-marker-check`, framework, primitive: "tabs", entry });
    const hits = Object.fromEntries(findUnrelatedPrimitiveCode(source, "tabs").map((hit) => [hit.primitive, hit.markers]));
    for (const primitive of ["dialog", "select", "slider", "menu"]) {
      assert.ok(hits[primitive]?.length >= 1, `${framework}: expected ${primitive} markers, found ${JSON.stringify(hits)}`);
    }
  }
});

test("the descriptor markers find other primitives' roving, gesture and popup wiring in a real build of every adapter", async (t) => {
  requireBuiltAdapters();
  const imports = {
    tabs: "Tabs", "pin-input": "PinInput", editable: "Editable", pagination: "Pagination", "tree-view": "TreeView",
    "segment-group": "SegmentGroup", "image-cropper": "ImageCropper", splitter: "Splitter", "date-picker": "DatePicker",
  };
  for (const framework of ["react", "svelte", "solid"]) {
    const directory = tempDir(t, ".binding-marker-check-", path.join(FIXTURE_ROOT, framework));
    const entry = path.join(directory, framework === "svelte" ? "entry.ts" : "entry.tsx");
    writeFileSync(entry, [
      ...Object.entries(imports).map(([id, name]) => `import { ${name} } from '@uifn/${framework}/${id}';`),
      `console.log(${Object.values(imports).join(", ")});`,
      "",
    ].join("\n"));
    const { source } = await buildFixture({ id: `${framework}/descriptor-marker-check`, framework, primitive: "menu", entry });
    const hits = Object.fromEntries(findUnrelatedPrimitiveCode(source, "menu").map((hit) => [hit.primitive, hit.markers]));
    for (const primitive of Object.keys(imports)) {
      assert.ok(hits[primitive]?.length >= 1, `${framework}: expected ${primitive} markers, found ${JSON.stringify(hits)}`);
    }
  }
});

test("a Tabs fixture that bundles another primitive's descriptor fails the check", () => {
  const source = 'const d={name:"Tabs"};const r={parts:["resizeHandle"]};const n="Splitter";';
  assert.deepEqual(evaluateFixture({ id: "solid/tabs", primitive: "tabs", gzipBytes: 1, budget: 2, source }), [
    { code: "UIFN_BUNDLE_UNRELATED_PRIMITIVE", fixture: "solid/tabs", primitive: "splitter", markers: ['"Splitter"', '"resizeHandle"'] },
  ]);
  assert.deepEqual(evaluateFixture({ id: "solid/menu", primitive: "menu", gzipBytes: 1, budget: 2, source: 'x={name:"Tabs"}' }), [
    { code: "UIFN_BUNDLE_UNRELATED_PRIMITIVE", fixture: "solid/menu", primitive: "tabs", markers: ['"Tabs"'] },
  ]);
});
