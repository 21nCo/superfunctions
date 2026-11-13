#!/usr/bin/env node
// Builds each uifn size fixture (an app that imports one primitive from one headless adapter) with Vite in
// production mode, records the gzip size of its JavaScript, and fails when a fixture exceeds its budget or
// ships code from an unrelated primitive. Budgets live in uifn/examples/size-fixtures/budgets.json.
//
//   node scripts/verify-uifn-bundle-size.mjs                  check every fixture against its budget
//   node scripts/verify-uifn-bundle-size.mjs --budgets <file> check against another budgets file
//   node scripts/verify-uifn-bundle-size.mjs --record         rewrite budgets as measured size + headroom
//   node scripts/verify-uifn-bundle-size.mjs --json           print the machine-readable report
//
// The adapters and their @uifn dependencies must be built first (their dist output is what an app consumes).

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_ROOT = path.join(repoRoot, "uifn/examples/size-fixtures");
export const DEFAULT_BUDGETS_PATH = path.join(FIXTURE_ROOT, "budgets.json");
export const DEFAULT_HEADROOM = 0.1;

// Strings that survive minification and occur only in the named primitive's code (or the library it bundles).
export const UNRELATED_PRIMITIVE_MARKERS = Object.freeze({
  "qr-code": Object.freeze([
    "QRCode value and accessible label are required.", // @uifn/core QRCode contract
    "xMidYMid meet", // @uifn/core QRCode SVG parts
    "bad maskPattern:", // qrcode-generator
    "code length overflow", // qrcode-generator
  ]),
  "color-picker": Object.freeze([
    "--uifn-channel-position", // @uifn/core ColorPicker channel parts
    "area-thumb", // @uifn/core ColorPicker area part
  ]),
  // The @uifn/dom bindings other primitives wire. An adapter that installs every binding for every primitive
  // ships these in a Tabs-only app even though the QR-code and color-picker markers stay clean.
  dialog: Object.freeze([
    "create overlay DOM binding", // @uifn/dom overlay binding (Dialog, AlertDialog, Drawer, Popover, Tooltip, ...)
    "Overlay DOM binding requires a content element.",
  ]),
  select: Object.freeze([
    "create popup DOM binding", // @uifn/dom popup binding (Select, Combobox, Autocomplete, DatePicker, ColorPicker)
    "Popup DOM binding requires content and floating elements.",
  ]),
  slider: Object.freeze([
    "resizeCancel", // @uifn/dom range-gesture binding (Slider, Splitter, Carousel, AngleSlider, ...)
    "dragCancel",
  ]),
  menu: Object.freeze([
    "create menu DOM binding", // @uifn/dom menu binding (Menu, ContextMenu)
    "Menu DOM binding requires a content element.",
  ]),
  // Primitive names and part names from the definitions that carry their own roving-focus, gesture or popup
  // descriptors. An adapter that looks those up by primitive name ships every one of them in a one-primitive app.
  tabs: Object.freeze(['"Tabs"']),
  "pin-input": Object.freeze(['"PinInput"']),
  editable: Object.freeze(['"Editable"']),
  pagination: Object.freeze(['"Pagination"', '"pageTrigger"']),
  "tree-view": Object.freeze(['"TreeView"']),
  "segment-group": Object.freeze(['"SegmentGroup"']),
  "image-cropper": Object.freeze(['"ImageCropper"', '"cropArea"']),
  splitter: Object.freeze(['"Splitter"', '"resizeHandle"']),
  "date-picker": Object.freeze(['"DatePicker"']),
});

// Each adapter's fixtures build with the Vite and framework plugin its Workbench declares. The framework runtime
// is external: every app pays it once whatever it imports, so the budget tracks the uifn code a primitive adds.
export const FRAMEWORKS = Object.freeze({
  react: {
    workspace: "uifn/examples/react-workbench",
    plugin: { specifier: "@vitejs/plugin-react", options: {} },
    entryExtension: ".tsx",
    external: /^(?:react|react-dom)(?:\/|$)/,
  },
  svelte: {
    workspace: "uifn/examples/svelte-workbench",
    plugin: { specifier: "@uifn/vite-plugin-svelte", exportName: "svelte", options: {} },
    entryExtension: ".ts",
    external: /^svelte(?:\/|$)/,
  },
  solid: {
    workspace: "uifn/examples/solid-workbench",
    plugin: { specifier: "vite-plugin-solid", options: {} },
    entryExtension: ".tsx",
    external: /^solid-js(?:\/|$)/,
  },
});

export const PRIMITIVES = Object.freeze(["tabs", "menu"]);

/** Every fixture id (`<framework>/<primitive>`) with its entry file. */
export function listFixtures(root = FIXTURE_ROOT) {
  const fixtures = [];
  for (const framework of Object.keys(FRAMEWORKS)) {
    const files = new Set(readdirSync(path.join(root, framework)));
    for (const primitive of PRIMITIVES) {
      const entry = `${primitive}${FRAMEWORKS[framework].entryExtension}`;
      if (!files.has(entry)) throw new Error(`size fixture ${framework}/${primitive} is missing ${path.join(root, framework, entry)}`);
      fixtures.push({ id: `${framework}/${primitive}`, framework, primitive, entry: path.join(root, framework, entry) });
    }
  }
  return fixtures;
}

/** Marker hits per unrelated primitive; a fixture's own primitive is never unrelated. */
export function findUnrelatedPrimitiveCode(source, ownPrimitive, markers = UNRELATED_PRIMITIVE_MARKERS) {
  const hits = [];
  for (const [primitive, needles] of Object.entries(markers)) {
    if (primitive === ownPrimitive) continue;
    const found = needles.filter((needle) => source.includes(needle));
    if (found.length) hits.push({ primitive, markers: found });
  }
  return hits;
}

export function gzipBytes(source) {
  return gzipSync(Buffer.from(source, "utf8"), { level: 9 }).length;
}

export function budgetFor(measuredGzipBytes, headroom = DEFAULT_HEADROOM) {
  return Math.ceil(measuredGzipBytes * (1 + headroom));
}

/** Validates the budgets document; returns `{ budgets, errors }` with budgets keyed by fixture id. */
export function parseBudgets(document, fixtureIds) {
  const errors = [];
  const budgets = new Map();
  if (document?.schemaVersion !== 1 || typeof document.fixtures !== "object" || document.fixtures === null) {
    return { budgets, errors: ["budgets file must have schemaVersion 1 and a fixtures object"] };
  }
  for (const id of fixtureIds) {
    const entry = document.fixtures[id];
    if (!Number.isInteger(entry?.budgetGzipBytes) || entry.budgetGzipBytes <= 0) {
      errors.push(`${id}: budgetGzipBytes must be a positive integer`);
      continue;
    }
    budgets.set(id, entry.budgetGzipBytes);
  }
  for (const id of Object.keys(document.fixtures)) {
    if (!fixtureIds.includes(id)) errors.push(`${id}: budget has no fixture`);
  }
  return { budgets, errors };
}

/** Failures for one measured fixture: over budget, or carrying an unrelated primitive's code. */
export function evaluateFixture({ id, primitive, gzipBytes: measured, source, budget }) {
  const failures = [];
  if (budget === undefined) failures.push({ code: "UIFN_BUNDLE_BUDGET_MISSING", fixture: id, gzipBytes: measured });
  else if (measured > budget) failures.push({ code: "UIFN_BUNDLE_BUDGET_EXCEEDED", fixture: id, gzipBytes: measured, budgetGzipBytes: budget });
  for (const hit of findUnrelatedPrimitiveCode(source, primitive)) {
    failures.push({ code: "UIFN_BUNDLE_UNRELATED_PRIMITIVE", fixture: id, primitive: hit.primitive, markers: hit.markers });
  }
  return failures;
}

/** The ESM entry of `specifier` as the workspace at `workspace` resolves it (node_modules lookup upward). */
export function resolveModuleFrom(workspace, specifier) {
  for (let directory = path.join(repoRoot, workspace); ; directory = path.dirname(directory)) {
    const packageRoot = path.join(directory, "node_modules", specifier);
    if (existsSync(path.join(packageRoot, "package.json"))) {
      const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
      return path.join(packageRoot, esmEntry(manifest.exports?.["."] ?? manifest.exports) ?? manifest.module ?? manifest.main ?? "index.js");
    }
    if (directory === repoRoot || directory === path.dirname(directory)) break;
  }
  throw new Error(`${workspace} cannot resolve ${specifier}; run npm ci`);
}

function esmEntry(target) {
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object") return undefined;
  for (const condition of ["import", "module", "default"]) {
    const entry = esmEntry(target[condition]);
    if (entry) return entry;
  }
  return undefined;
}

async function loadFrom(workspace, specifier) {
  return import(pathToFileURL(resolveModuleFrom(workspace, specifier)).href);
}

/** Builds one fixture with Vite in production mode; returns its emitted JavaScript (all chunks, in name order). */
export async function buildFixture(fixture) {
  const framework = FRAMEWORKS[fixture.framework];
  const vite = await loadFrom(framework.workspace, "vite");
  const pluginModule = await loadFrom(framework.workspace, framework.plugin.specifier);
  const createPlugin = framework.plugin.exportName ? pluginModule[framework.plugin.exportName] : pluginModule.default;
  const outDir = mkdtempSync(path.join(tmpdir(), "uifn-size-fixture-"));
  try {
    const result = await vite.build({
      configFile: false,
      root: path.dirname(fixture.entry),
      mode: "production",
      logLevel: "silent",
      plugins: [createPlugin(framework.plugin.options)],
      build: {
        outDir,
        emptyOutDir: true,
        write: false,
        modulePreload: false,
        reportCompressedSize: false,
        minify: "esbuild",
        target: "es2020",
        rollupOptions: {
          input: fixture.entry,
          external: (id) => framework.external.test(id),
        },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output);
    const chunks = outputs
      .filter((output) => output.type === "chunk")
      .sort((left, right) => left.fileName.localeCompare(right.fileName));
    if (!chunks.length) throw new Error(`size fixture ${fixture.id} produced no JavaScript`);
    return { files: chunks.map((chunk) => chunk.fileName), source: chunks.map((chunk) => chunk.code).join("\n") };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// Adapter sources import @uifn/core through the subpath that owns each binding, never the root barrel: a root
// import that keeps no binding (`import { type X }` under verbatimModuleSyntax) still loads every primitive.
export const ADAPTER_SOURCE_ROOTS = Object.freeze(["uifn/react/src", "uifn/solid/src", "uifn/svelte/lib"]);
const ADAPTER_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".svelte"]);
const ROOT_BARREL = "@uifn/core";
// A Svelte <script> element; quoted attribute values (`generics="T extends A<B>"`) may contain `>`.
const SVELTE_SCRIPT = /<script\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script>/g;
// Markup can load a module only through an `import(...)` expression; the specifier may follow on a later line.
const MARKUP_ROOT_BARREL = /\bimport\s*\(\s*["']@uifn\/core["']/g;

function adapterSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return ["__tests__", "test", "node_modules"].includes(entry.name) ? [] : adapterSources(target);
    if (/\.test\.[^.]+$/.test(entry.name)) return [];
    return ADAPTER_SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [target] : [];
  });
}

/** The module specifier a node loads, for static and dynamic imports, re-exports, `import =` and import types. */
function loadedSpecifier(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return node.moduleReference.expression;
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return node.arguments[0];
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal;
  return undefined;
}

/** 1-based lines, within `code`, of every specifier that loads the @uifn/core root barrel. */
function rootBarrelLines(code, fileName) {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = [];
  const visit = (node) => {
    const specifier = loadedSpecifier(node);
    if (specifier && ts.isStringLiteralLike(specifier) && specifier.text === ROOT_BARREL) {
      lines.push(source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

/** `path:line` of every adapter import of the @uifn/core root barrel, however its statement is laid out. */
export function findRootBarrelImports(root = repoRoot, sourceRoots = ADAPTER_SOURCE_ROOTS) {
  const hits = [];
  for (const sourceRoot of sourceRoots) {
    for (const file of adapterSources(path.join(root, sourceRoot))) {
      const text = readFileSync(file, "utf8");
      const lineAt = (offset) => text.slice(0, offset).split("\n").length;
      const scripts = file.endsWith(".svelte")
        ? [...text.matchAll(SVELTE_SCRIPT)].map((match) => ({ code: match[1], offset: match.index + match[0].length - match[1].length - "</script>".length }))
        : [{ code: text, offset: 0 }];
      const lines = scripts.flatMap(({ code, offset }) => rootBarrelLines(code, file).map((line) => line + lineAt(offset) - 1));
      if (file.endsWith(".svelte")) {
        // Blank the script blocks (keeping offsets), then scan the template expressions that remain.
        const markup = text.replace(SVELTE_SCRIPT, (block) => block.replace(/[^\n]/g, " "));
        for (const match of markup.matchAll(MARKUP_ROOT_BARREL)) lines.push(lineAt(match.index + match[0].indexOf("@uifn/core")));
      }
      for (const line of lines.sort((left, right) => left - right)) hits.push(`${path.relative(root, file)}:${line}`);
    }
  }
  return hits;
}

/** Measures every fixture and evaluates it against the budgets file. */
export async function verifyBundleSizes({ budgetsPath = DEFAULT_BUDGETS_PATH, fixtureRoot = FIXTURE_ROOT, only, build = buildFixture } = {}) {
  const known = listFixtures(fixtureRoot);
  const knownIds = known.map((fixture) => fixture.id);
  const fixtures = known.filter((fixture) => !only?.length || only.includes(fixture.id));
  const document = JSON.parse(readFileSync(budgetsPath, "utf8"));
  const { budgets, errors } = parseBudgets(document, knownIds);
  const failures = [
    ...(only ?? []).filter((id) => !knownIds.includes(id)).map((id) => ({
      code: "UIFN_BUNDLE_FIXTURE_UNKNOWN",
      message: `--fixture ${id} names no fixture; expected one of ${knownIds.join(", ")}`,
    })),
    // A check that measured nothing proves nothing, so it never passes.
    ...(fixtures.length === 0 ? [{ code: "UIFN_BUNDLE_NO_FIXTURES", message: "no fixture was selected for measurement" }] : []),
    ...errors.map((message) => ({ code: "UIFN_BUNDLE_BUDGETS_INVALID", message })),
    ...findRootBarrelImports().map((location) => ({ code: "UIFN_ADAPTER_ROOT_BARREL_IMPORT", location })),
  ];
  const measurements = [];
  for (const fixture of fixtures) {
    const { files, source } = await build(fixture);
    const measured = gzipBytes(source);
    const budget = budgets.get(fixture.id);
    measurements.push({ fixture: fixture.id, files, rawBytes: Buffer.byteLength(source, "utf8"), gzipBytes: measured, budgetGzipBytes: budget ?? null });
    failures.push(...evaluateFixture({ id: fixture.id, primitive: fixture.primitive, gzipBytes: measured, source, budget }));
  }
  return { ok: failures.length === 0, command: "verify-uifn-bundle-size", budgetsPath: path.relative(repoRoot, budgetsPath), measurements, failures };
}

/** The budgets document for a set of measurements: measured size plus headroom, rounded up. */
export function recordBudgets(measurements, headroom = DEFAULT_HEADROOM) {
  return {
    schemaVersion: 1,
    headroom,
    note: "budgetGzipBytes is the measured gzip size plus headroom. Raising a budget means editing this file in the pull request that needs it.",
    fixtures: Object.fromEntries(measurements.map((entry) => [
      entry.fixture,
      { measuredGzipBytes: entry.gzipBytes, budgetGzipBytes: budgetFor(entry.gzipBytes, headroom) },
    ])),
  };
}

function formatReport(report) {
  const lines = ["uifn per-primitive bundle size (gzip, framework runtime excluded)"];
  for (const entry of report.measurements) {
    const budget = entry.budgetGzipBytes === null ? "no budget" : `budget ${entry.budgetGzipBytes} B`;
    lines.push(`  ${entry.fixture.padEnd(14)} ${String(entry.gzipBytes).padStart(7)} B gzip  ${String(entry.rawBytes).padStart(8)} B raw  ${budget}`);
  }
  for (const failure of report.failures) {
    if (failure.code === "UIFN_BUNDLE_BUDGET_EXCEEDED") lines.push(`  error: ${failure.fixture} is ${failure.gzipBytes} B gzip, over its ${failure.budgetGzipBytes} B budget`);
    else if (failure.code === "UIFN_BUNDLE_UNRELATED_PRIMITIVE") lines.push(`  error: ${failure.fixture} contains ${failure.primitive} code (${failure.markers.join(", ")})`);
    else if (failure.code === "UIFN_BUNDLE_BUDGET_MISSING") lines.push(`  error: ${failure.fixture} has no budget`);
    else if (failure.code === "UIFN_ADAPTER_ROOT_BARREL_IMPORT") lines.push(`  error: ${failure.location} imports the @uifn/core root barrel; import the subpath that owns the binding`);
    else lines.push(`  error: ${failure.message}`);
  }
  lines.push(report.ok ? "  ok: every fixture is within budget and free of unrelated primitives" : `  ${report.failures.length} failure(s)`);
  return lines.join("\n");
}

function optionValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

export function parseArgs(argv) {
  const options = { budgetsPath: DEFAULT_BUDGETS_PATH, json: false, record: false, only: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--record") options.record = true;
    else if (arg === "--budgets") options.budgetsPath = path.resolve(optionValue(argv, ++index, arg));
    else if (arg === "--fixture") options.only.push(optionValue(argv, ++index, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.record) {
    const fixtures = listFixtures();
    if (fixtures.length === 0) throw new Error("no fixture to record a budget for");
    const measurements = [];
    for (const fixture of fixtures) {
      const { source } = await buildFixture(fixture);
      const failures = evaluateFixture({ id: fixture.id, primitive: fixture.primitive, gzipBytes: gzipBytes(source), source, budget: Number.POSITIVE_INFINITY });
      if (failures.length) {
        console.error(JSON.stringify({ ok: false, command: "verify-uifn-bundle-size --record", failures }, null, 2));
        process.exit(1);
      }
      measurements.push({ fixture: fixture.id, gzipBytes: gzipBytes(source) });
    }
    writeFileSync(options.budgetsPath, `${JSON.stringify(recordBudgets(measurements), null, 2)}\n`);
    console.log(`Recorded ${measurements.length} budgets in ${path.relative(repoRoot, options.budgetsPath)}`);
    return;
  }
  const report = await verifyBundleSizes({ budgetsPath: options.budgetsPath, only: options.only });
  console[report.ok ? "log" : "error"](options.json ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  }
}
