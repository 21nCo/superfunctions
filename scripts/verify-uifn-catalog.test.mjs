import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CATALOG_SOURCE, EXPECTED_PRIMITIVE_NAMES } from '../uifn/catalog/src/catalog-source.mjs';
import { compareGeneratedOutputs, createGeneratedOutputs, createSwiftUISurfaceInventory, stableStringify, validateCatalogSource, validateSwiftUIStatus, validateSwiftUISurfaceInventory, verifyGeneratedDirectory, verifySwiftUISurfaceDeclarations, writeGeneratedOutputs } from '../uifn/catalog/src/compiler.mjs';
import { migrateCatalogDocument } from '../uifn/catalog/src/migrations.mjs';
import { SWIFTUI_STATUS_SOURCE, SWIFTUI_STATUSES } from '../uifn/catalog/src/swiftui-status.mjs';
import { readSwiftUISymbolGraphs, swiftUIDeclarationsFromSymbolGraphs, uncoveredSwiftConditions } from '../uifn/catalog/src/swiftui-symbol-graph.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(repoRoot, 'uifn/catalog/fixtures/negative');
const generatedRoot = path.join(repoRoot, 'uifn/catalog/generated');

async function fixture(name) {
  return JSON.parse(await readFile(path.join(fixtureRoot, name), 'utf8'));
}

function expectCatalogCode(action, expected) {
  assert.throws(action, (error) => error.code === expected, `expected ${expected}`);
}

test('TV-CAT-001-P: canonical catalog is exact, complete, deterministic, and checked in cleanly', async () => {
  const first = createGeneratedOutputs();
  const second = createGeneratedOutputs();
  assert.equal(first.catalog.primitiveCount, 69);
  assert.deepEqual(first.catalog.primitives.map((primitive) => primitive.name), EXPECTED_PRIMITIVE_NAMES);
  assert.equal(new Set(first.catalog.primitives.map((primitive) => primitive.id)).size, 69);
  assert.ok(first.catalog.primitives.every((primitive) => primitive.requirementIds.length >= 2));
  assert.ok(first.catalog.primitives.every((primitive) => primitive.domServices.every(Boolean)));
  assert.ok(first.catalog.primitives.every((primitive) => Object.keys(primitive.frameworks).join(',') === 'react,svelte,solid'));
  assert.ok(first.catalog.primitives.every((primitive) => primitive.release.implementationStatus === 'implemented'));
  assert.ok(first.catalog.primitives.every((primitive) => !Object.hasOwn(primitive.accessibility.rules, 'review')));
  compareGeneratedOutputs(first.outputs, second.outputs);
  await verifyGeneratedDirectory(generatedRoot, first.outputs);
});

test('TV-CAT-001-N: missing required accessibility metadata fails closed', async () => {
  const descriptor = await fixture('missing-tooltip-accessibility.json');
  const source = structuredClone(CATALOG_SOURCE);
  const target = source.primitives.find((primitive) => primitive.name === descriptor.mutation.primitive);
  const [parent, field] = descriptor.mutation.deletePath;
  delete target[parent][field];
  expectCatalogCode(() => validateCatalogSource(source), descriptor.expectedErrorCodes[0]);
});

test('duplicate primitive identifiers fail closed', async () => {
  const descriptor = await fixture('duplicate-primitive-id.json');
  const source = structuredClone(CATALOG_SOURCE);
  source.primitives.find((primitive) => primitive.name === descriptor.mutation.primitive)[descriptor.mutation.setField] = descriptor.mutation.value;
  expectCatalogCode(() => validateCatalogSource(source), descriptor.expectedErrorCodes[0]);
});

test('unsupported catalog enum values fail closed', async () => {
  const descriptor = await fixture('unsupported-family.json');
  const source = structuredClone(CATALOG_SOURCE);
  source.primitives.find((primitive) => primitive.name === descriptor.mutation.primitive)[descriptor.mutation.setField] = descriptor.mutation.value;
  expectCatalogCode(() => validateCatalogSource(source), descriptor.expectedErrorCodes[0]);
});

test('undocumented generated exports receive a stable export-drift code', async () => {
  const descriptor = await fixture('undocumented-export.json');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'uifn-catalog-export-test-'));
  try {
    const expected = createGeneratedOutputs().outputs;
    const actual = structuredClone(expected);
    const core = JSON.parse(actual[descriptor.mutation.generatedFile]);
    core.exports.push({ primitiveId: 'not-canonical', primitiveName: 'NotCanonical', symbol: 'NotCanonicalContract' });
    actual[descriptor.mutation.generatedFile] = `${JSON.stringify(core, null, 2)}\n`;
    await writeGeneratedOutputs(temporary, actual);
    await assert.rejects(verifyGeneratedDirectory(temporary, expected), (error) => error.code === descriptor.expectedErrorCodes[0]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('hand-edited generated output receives a stable generated-drift code', async () => {
  const descriptor = await fixture('hand-edited-output.json');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'uifn-catalog-hand-edit-test-'));
  try {
    const expected = createGeneratedOutputs().outputs;
    const actual = structuredClone(expected);
    actual[descriptor.mutation.generatedFile] += ' ';
    await writeGeneratedOutputs(temporary, actual);
    await assert.rejects(verifyGeneratedDirectory(temporary, expected), (error) => error.code === descriptor.expectedErrorCodes[0]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('catalog v0 migrates losslessly to schema v1 and unsupported versions fail closed', () => {
  const component = { id: 'example', nested: { value: true } };
  const migrated = migrateCatalogDocument({ schemaVersion: 0, catalogId: 'test', components: [component] });
  assert.equal(migrated.ok, true);
  assert.deepEqual(migrated.document.primitives, [component]);
  assert.deepEqual(migrated.applied, ['catalog-v0-to-v1']);
  const unsupported = migrateCatalogDocument({ schemaVersion: 2, primitives: [] });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.failures[0].code, 'UIFN_CATALOG_SCHEMA_VERSION_UNSUPPORTED');
});

function swiftuiSourceWith(mutate) {
  const source = structuredClone(SWIFTUI_STATUS_SOURCE);
  mutate(source);
  return source;
}

function applySwiftUIFixture(descriptor) {
  return swiftuiSourceWith((source) => {
    const entry = source.primitives[descriptor.mutation.swiftuiPrimitive];
    if (descriptor.mutation.deleteField) delete entry[descriptor.mutation.deleteField];
    else entry[descriptor.mutation.setField] = descriptor.mutation.value;
  });
}

test('every primitive has a SwiftUI status and every UIFnSwiftUI style and component maps to a primitive', async () => {
  const { outputs } = createGeneratedOutputs();
  const status = JSON.parse(outputs['swiftui-status.json']);
  assert.deepEqual(status.primitives.map((primitive) => primitive.name), EXPECTED_PRIMITIVE_NAMES);
  assert.ok(status.primitives.every((primitive) => SWIFTUI_STATUSES.includes(primitive.swiftui.status)));
  assert.equal(Object.values(status.statusCounts).reduce((total, count) => total + count, 0), 69);
  assert.deepEqual([...new Set(status.surfaces.map((surface) => surface.issue))].sort(), ['UIF-24', 'UIF-25', 'UIF-26']);
  assert.deepEqual(status.surfaces.filter((surface) => surface.primitives.length === 0), []);
  const declarations = await committedDeclarations();
  assert.deepEqual(
    [...new Set(declarations.map((declaration) => declaration.id))].sort(),
    [...status.surfaces, ...SWIFTUI_STATUS_SOURCE.nonSurfaces].map((entry) => entry.id).sort(),
  );
  verifySwiftUISurfaceDeclarations(declarations);
  // One platform policy: a control on only one platform is native, with the
  // limit in its note (Menubar and Splitter on macOS, Carousel on iOS).
  for (const name of ['Carousel', 'Menubar', 'Splitter']) assert.equal(SWIFTUI_STATUS_SOURCE.primitives[name].status, 'native', name);
  assert.deepEqual(SWIFTUI_STATUS_SOURCE.primitives.Carousel.controls, ['TabView']);
});

test('SwiftUI status lives outside the hashed catalog definition', () => {
  const baseline = createGeneratedOutputs().outputs;
  const changed = createGeneratedOutputs(CATALOG_SOURCE, swiftuiSourceWith((source) => {
    source.primitives.Tooltip.note = 'A different note.';
  })).outputs;
  for (const name of Object.keys(baseline).filter((file) => !['swiftui-status.json', 'generation-manifest.json'].includes(file))) {
    assert.equal(changed[name], baseline[name], name);
  }
  assert.notEqual(changed['swiftui-status.json'], baseline['swiftui-status.json']);
});

test('missing, unknown, and unmapped SwiftUI status values fail closed', async () => {
  for (const file of ['missing-swiftui-status.json', 'unknown-swiftui-status.json', 'unmapped-swiftui-surface.json']) {
    const descriptor = await fixture(file);
    const source = applySwiftUIFixture(descriptor);
    expectCatalogCode(() => validateSwiftUIStatus(source), descriptor.expectedErrorCodes[0]);
    expectCatalogCode(() => createGeneratedOutputs(CATALOG_SOURCE, source), descriptor.expectedErrorCodes[0]);
  }
  expectCatalogCode(() => validateSwiftUIStatus(swiftuiSourceWith((source) => { delete source.primitives.Tooltip; })), 'UIFN_CATALOG_FIELD_MISSING');
  expectCatalogCode(() => validateSwiftUIStatus(swiftuiSourceWith((source) => { source.primitives.Tooltip.status = null; })), 'UIFN_CATALOG_FIELD_MISSING');
  expectCatalogCode(() => validateSwiftUIStatus(swiftuiSourceWith((source) => { source.primitives.Tooltip.note = ' '; })), 'UIFN_CATALOG_FIELD_MISSING');
  expectCatalogCode(() => validateSwiftUIStatus(swiftuiSourceWith((source) => { source.primitives.Tooltip.statsu = 'native'; })), 'UIFN_CATALOG_UNSUPPORTED_VALUE');
  expectCatalogCode(() => validateSwiftUIStatus(swiftuiSourceWith((source) => { source.primitives.Tooltipp = structuredClone(source.primitives.Tooltip); })), 'UIFN_CATALOG_NAME_SET_INVALID');
  expectCatalogCode(() => validateSwiftUIStatus(swiftuiSourceWith((source) => { source.primitives.Tooltip.surfaces = ['UIFnTooltipStyle']; })), 'UIFN_CATALOG_UNSUPPORTED_VALUE');
  expectCatalogCode(() => validateSwiftUIStatus(swiftuiSourceWith((source) => { source.surfaces[0].kind = 'modifier'; })), 'UIFN_CATALOG_UNSUPPORTED_VALUE');
});

test('a SwiftUI status must agree with the controls and surfaces it names', () => {
  const inconsistent = [
    ['Tooltip', { status: 'native', surfaces: ['UIFnButtonStyle'] }],
    ['Tooltip', { status: 'native', controls: [] }],
    ['Tooltip', { status: 'uifn-style', surfaces: [] }],
    ['Tooltip', { status: 'uifn-component', surfaces: ['UIFnButtonStyle'] }],
    ['Tooltip', { status: 'none' }],
    ['Avatar', { status: 'none', surfaces: ['UIFnEmptyState'] }],
  ];
  for (const [name, change] of inconsistent) {
    const source = swiftuiSourceWith((draft) => Object.assign(draft.primitives[name], change));
    expectCatalogCode(() => validateSwiftUIStatus(source), 'UIFN_CATALOG_SWIFTUI_STATUS_INCONSISTENT');
  }
});

const inventoryPath = path.join(repoRoot, 'uifn/catalog/swiftui-surface-inventory.json');
const symbolGraphRoot = path.join(repoRoot, 'uifn/catalog/fixtures/swiftui-symbol-graph');
const swiftRoot = 'uifn/swift/Sources/UIFnSwiftUI';

async function committedDeclarations() {
  return validateSwiftUISurfaceInventory(JSON.parse(await readFile(inventoryPath, 'utf8')));
}

// The macOS debug and iOS device release graphs swiftc emits for
// fixtures/swiftui-symbol-graph/sources.
const fixturePlatforms = ['macos-debug', 'ios-release'];

async function fixtureGraphs() {
  return Promise.all(fixturePlatforms.map((platform) => readSwiftUISymbolGraphs(path.join(symbolGraphRoot, platform))));
}

async function fixtureInventory() {
  return createSwiftUISurfaceInventory((await fixtureGraphs()).flatMap((graphs) => swiftUIDeclarationsFromSymbolGraphs(graphs)));
}

function listedWith(entries) {
  return swiftuiSourceWith((source) => {
    for (const entry of entries) {
      if (entry.kind === 'unclassified') source.nonSurfaces.push({ id: entry.id, source: entry.source, reason: 'Test.' });
      else source.surfaces.push({ id: entry.id, kind: entry.kind, issue: 'UIF-28', source: entry.source });
    }
  });
}

test('the SwiftUI surface list must match the styles and components UIFnSwiftUI declares', async () => {
  const declarations = await committedDeclarations();
  const descriptor = await fixture('unlisted-swiftui-surface.json');
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations([...declarations, descriptor.mutation.addDeclaration]), descriptor.expectedErrorCodes[0]);
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations(declarations.filter((declaration) => declaration.id !== 'UIFnGaugeStyle')), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations(declarations.filter((declaration) => declaration.id !== 'UIFnToast')), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations(declarations.map((declaration) => (
    declaration.id === 'UIFnBanner' ? { ...declaration, source: `${swiftRoot}/Components/UIFnToast.swift` } : declaration
  ))), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  // A listed kind must match the declaration: UIFnSegmentedPicker lives in
  // Styles but is a View, so listing it as a style is drift.
  assert.equal(declarations.find((declaration) => declaration.id === 'UIFnSegmentedPicker').kind, 'component');
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations(declarations, swiftuiSourceWith((source) => {
    source.surfaces.find((surface) => surface.id === 'UIFnSegmentedPicker').kind = 'style';
  })), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  // A listed surface may move into a subdirectory once it is listed with
  // that path, and only then.
  const moved = `${swiftRoot}/Components/Feedback/UIFnBanner.swift`;
  const movedDeclarations = declarations.map((declaration) => (declaration.id === 'UIFnBanner' ? { ...declaration, source: moved } : declaration));
  const movedSource = swiftuiSourceWith((source) => {
    source.surfaces.find((surface) => surface.id === 'UIFnBanner').source = moved;
  });
  validateSwiftUIStatus(movedSource);
  verifySwiftUISurfaceDeclarations(movedDeclarations, movedSource);
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations(movedDeclarations), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
});

test('the compiler symbol graphs give every public declaration in Styles and Components, fail closed', async () => {
  const inventory = await fixtureInventory();
  const at = (file) => `${swiftRoot}/${file}`;
  assert.deepEqual(inventory.declarations, [
    // A member of an extension of another module's type, by type and name.
    { id: 'EnvironmentValues.uifnFlag', kind: 'unclassified', source: at('Styles/UIFnCR.swift') },
    { id: 'Text.uifnBold', kind: 'unclassified', source: at('Components/UIFnProbe.swift') },
    // Subdirectories count.
    { id: 'UIFnAlert', kind: 'component', source: at('Components/Feedback/UIFnAlert.swift') },
    { id: 'UIFnAlias', kind: 'unclassified', source: at('Components/UIFnProbe.swift') },
    // Nested types by qualified name, a public extension's access, and a
    // conformance to the file-scope protocol that refines View, not the
    // shadowing UIFnBox.UIFnRenderable.
    { id: 'UIFnBox.Bar', kind: 'component', source: at('Components/UIFnProbe.swift') },
    { id: 'UIFnBox.Item', kind: 'component', source: at('Components/UIFnProbe.swift') },
    { id: 'UIFnBox.Panel', kind: 'component', source: at('Components/UIFnProbe.swift') },
    // After a line comment that ends at a carriage return.
    { id: 'UIFnCRView', kind: 'component', source: at('Styles/UIFnCR.swift') },
    { id: 'UIFnChipStyle', kind: 'style', source: at('Styles/UIFnCR.swift') },
    // #if DEBUG, in the debug build only.
    { id: 'UIFnDebugOnly', kind: 'component', source: at('Components/UIFnProbe.swift') },
    // #if os(iOS) && !targetEnvironment(simulator).
    { id: 'UIFnDeviceOnly', kind: 'component', source: at('Components/UIFnProbe.swift') },
    { id: 'UIFnDim', kind: 'component', source: at('Components/UIFnProbe.swift') },
    // @_documentation(visibility: internal) is still public.
    { id: 'UIFnDocCard', kind: 'component', source: at('Components/UIFnProbe.swift') },
    { id: 'UIFnFlow', kind: 'unclassified', source: at('Components/UIFnProbe.swift') },
    // The iOS UIViewRepresentable and the macOS NSViewRepresentable.
    { id: 'UIFnHosted', kind: 'component', source: at('Components/UIFnProbe.swift') },
    { id: 'UIFnList', kind: 'component', source: at('Components/UIFnProbe.swift') },
    { id: 'UIFnPager', kind: 'component', source: at('Components/UIFnProbe.swift') },
    // Declared only in the #if os(iOS) branch.
    { id: 'UIFnPhoneOnly', kind: 'component', source: at('Components/UIFnProbe.swift') },
    { id: 'UIFnPlaceholder', kind: 'component', source: at('Components/UIFnProbe.swift') },
    // #else of #if DEBUG, in the release build only.
    { id: 'UIFnReleaseOnly', kind: 'component', source: at('Components/UIFnProbe.swift') },
    // Members of extensions of UIFnSwiftUI protocols: a View modifier for a
    // protocol refining View, unclassified otherwise.
    { id: 'UIFnRenderable.uifnGlow', kind: 'component', source: at('Components/UIFnProbe.swift') },
    { id: 'UIFnRing', kind: 'component', source: at('Components/UIFnProbe.swift') },
    { id: 'UIFnSizing.uifnDoubled', kind: 'unclassified', source: at('Components/UIFnProbe.swift') },
    // @_spi and an underscored name are public API too.
    { id: 'UIFnSpiCard', kind: 'component', source: at('Components/UIFnProbe.swift') },
    { id: 'UIFnWorker', kind: 'unclassified', source: at('Components/UIFnProbe.swift') },
    { id: '_UIFnRow', kind: 'component', source: at('Components/UIFnProbe.swift') },
    // public nonisolated(unsafe) static var in extension View.
    { id: 'uifnDefault', kind: 'component', source: at('Components/UIFnProbe.swift') },
    { id: 'uifnDim', kind: 'component', source: at('Components/UIFnProbe.swift') },
    { id: 'uifnMakeView', kind: 'unclassified', source: at('Components/UIFnProbe.swift') },
    { id: 'uifnStyled', kind: 'unclassified', source: at('Styles/UIFnCR.swift') },
  ]);
  // Not declarations: internal and commented-out types, a public type nested
  // in an internal one (UIFnInternal.Inner), protocols and their
  // requirements, a plain enum, Tokens, ButtonStyle.uifnChip (Self ==
  // UIFnChipStyle) and the copies of uifnDim the graph adds to each view.
  const [mac, ios] = await fixtureGraphs();
  const has = (graphs, id) => graphs[0].symbols.some((symbol) => symbol.pathComponents.join('.') === id);
  assert.ok(mac[0].symbols.some((symbol) => symbol.identifier.precise.includes('::SYNTHESIZED::') && symbol.pathComponents.at(-1).startsWith('uifnDim')));
  assert.ok(has(mac, 'UIFnInternal.Inner') && has(mac, 'UIFnSizing.size()'));
  for (const id of ['UIFnPhoneOnly', 'UIFnDeviceOnly', 'UIFnReleaseOnly']) assert.ok(has(ios, id) && !has(mac, id), id);
  assert.ok(has(mac, 'UIFnDebugOnly') && !has(ios, 'UIFnDebugOnly'));
  // Each one has to be listed: unlisted it is drift against the real lists.
  const real = await committedDeclarations();
  for (const declaration of inventory.declarations) {
    expectCatalogCode(() => verifySwiftUISurfaceDeclarations([...real, declaration]), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  }
  const listed = listedWith(inventory.declarations);
  validateSwiftUIStatus(swiftuiSourceWith((source) => { source.nonSurfaces = listed.nonSurfaces; }));
  verifySwiftUISurfaceDeclarations([...real, ...inventory.declarations], listed);
});

test('repeats of one declaration coalesce; a conflicting kind or source is drift', async () => {
  const [mac] = await fixtureGraphs();
  const declarations = swiftUIDeclarationsFromSymbolGraphs(mac);
  assert.equal(declarations.filter((declaration) => declaration.id === 'uifnDim').length, 2);
  const uifnDim = declarations.find((declaration) => declaration.id === 'uifnDim');
  expectCatalogCode(() => createSwiftUISurfaceInventory([...declarations, { ...uifnDim, kind: 'unclassified' }]), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  expectCatalogCode(() => createSwiftUISurfaceInventory([...declarations, { ...uifnDim, source: `${swiftRoot}/Components/Other.swift` }]), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
});

test('a declared name or path the lists cannot hold fails closed', async () => {
  const [mac] = await fixtureGraphs();
  const renamed = (change) => {
    const graphs = structuredClone(mac);
    change(graphs[0].symbols.find((symbol) => symbol.pathComponents.join('.') === 'UIFnRing'));
    return swiftUIDeclarationsFromSymbolGraphs(graphs);
  };
  for (const name of ['Ünit', '🙂Card', 'UIFn Row']) {
    expectCatalogCode(() => createSwiftUISurfaceInventory(renamed((symbol) => { symbol.pathComponents = [name]; })), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  }
  for (const file of ['UIFn_Grid.swift', 'Data-Views/UIFnGrid.swift']) {
    expectCatalogCode(() => createSwiftUISurfaceInventory(renamed((symbol) => { symbol.location.uri = `file:///checkout/${swiftRoot}/Components/${file}`; })), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  }
});

test('an #if clause no inventory build compiles is reported', () => {
  const check = (lines) => uncoveredSwiftConditions(lines.join('\n')).map(({ line, reason }) => [line, reason]);
  const none = 'no inventory build compiles this branch';
  // Covered: every clause is compiled by some build.
  assert.deepEqual(check(['#if os(iOS) && !targetEnvironment(simulator)', '#elseif canImport(AppKit) // macOS', '  #if !DEBUG', '  #endif', '#endif']), []);
  assert.deepEqual(check(['#if os(macOS) /* supported OS */', '#elseif canImport(UIKit)', '#else', '  #if DEBUG', '  #endif', '#endif']).slice(0, 1), [[3, none]]);
  assert.deepEqual(check(['#if os(macOS)', '#elseif canImport(UIKit)', '#endif']), []);
  // Branches no build compiles, nesting included.
  assert.deepEqual(check(['#if !os(macOS) && !os(iOS)', '#endif']), [[1, none]]);
  assert.deepEqual(check(['#if os(macOS) || os(iOS)', '#else', '#endif']), [[2, none]]);
  assert.deepEqual(check(['#if os(macOS)', '  #if os(iOS)', '  #endif', '#endif']), [[2, none]]);
  // Conditions the builds cannot decide, after a block comment too.
  assert.deepEqual(check(['/* platform */ #if arch(x86_64)', '#endif']), [[1, 'unsupported condition']]);
  assert.deepEqual(check(['/*', ' note', '*/ #if canImport(WatchKit)', '#endif']), [[3, 'unsupported condition']]);
  assert.deepEqual(check(['#if swift(>=6)', '#endif', '#if UIFN_EXPERIMENTAL', '#endif']), [[1, 'unsupported condition'], [3, 'unsupported condition']]);
  // Unbalanced directives.
  assert.deepEqual(check(['#endif']), [[1, 'unbalanced']]);
  assert.deepEqual(check(['#if DEBUG']), [[1, 'unbalanced']]);
});

test('the committed inventory is canonical and the verifier rejects a malformed one', async () => {
  const text = await readFile(inventoryPath, 'utf8');
  const committed = JSON.parse(text);
  assert.equal(stableStringify(createSwiftUISurfaceInventory(committed.declarations)), text);
  const invalid = [
    [(inventory) => { inventory.inventoryVersion = 2; }, 'UIFN_CATALOG_SCHEMA_INVALID'],
    [(inventory) => { inventory.declarations[0].notes = 'stray'; }, 'UIFN_CATALOG_UNSUPPORTED_VALUE'],
    [(inventory) => { inventory.declarations[0].kind = 'modifier'; }, 'UIFN_CATALOG_UNSUPPORTED_VALUE'],
    [(inventory) => { inventory.declarations.reverse(); }, 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT'],
    [(inventory) => { inventory.declarations.push(structuredClone(inventory.declarations[0])); }, 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT'],
    [(inventory) => { inventory.extra = true; }, 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT'],
  ];
  for (const [mutate, code] of invalid) {
    const inventory = structuredClone(committed);
    mutate(inventory);
    expectCatalogCode(() => validateSwiftUISurfaceInventory(inventory), code);
  }
});

test('the inventory script reports a stale inventory from symbol graphs', async () => {
  const run = (directories) => spawnSync(process.execPath, [path.join(repoRoot, 'scripts/uifn-swiftui-inventory.mjs'), '--symbol-graphs', ...directories], { encoding: 'utf8' });
  const stale = run(fixturePlatforms.map((platform) => path.join(symbolGraphRoot, platform)));
  assert.equal(stale.status, 1);
  const report = JSON.parse(stale.stderr);
  assert.equal(report.code, 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  assert.ok(report.details.added.some((entry) => entry.id === 'UIFnPhoneOnly'));
  assert.ok(report.details.removed.some((entry) => entry.id === 'UIFnBanner'));
  const missing = run([path.join(symbolGraphRoot, 'sources')]);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).code, 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
});

test('SwiftUI surface and non-surface metadata reject unknown fields', () => {
  const invalid = [
    (source) => { source.surfaces[0].notes = 'stray'; },
    (source) => { source.surfaces[0].id = 'UIFn Button'; },
    (source) => { source.nonSurfaces[0].kind = 'component'; },
    (source) => { source.nonSurfaces[0].source = 'uifn/swift/Sources/UIFnSwiftUI/Tokens/UIFnTheme.swift'; },
    (source) => { source.nonSurfaces.push({ id: 'UIFnButtonStyle', source: source.surfaces[0].source, reason: 'Twice.' }); },
  ];
  for (const mutate of invalid) {
    assert.throws(() => createGeneratedOutputs(CATALOG_SOURCE, swiftuiSourceWith(mutate)), (error) => ['UIFN_CATALOG_UNSUPPORTED_VALUE', 'UIFN_CATALOG_DUPLICATE'].includes(error.code));
  }
  expectCatalogCode(() => validateSwiftUIStatus(swiftuiSourceWith((source) => { source.nonSurfaces[0].reason = ' '; })), 'UIFN_CATALOG_FIELD_MISSING');
  expectCatalogCode(() => validateSwiftUIStatus(swiftuiSourceWith((source) => { delete source.nonSurfaces; })), 'UIFN_CATALOG_FIELD_MISSING');
});

// Checks a value against the JSON Schema keywords swiftui-status.schema.json
// uses, and returns the paths that fail.
function schemaErrors(schema, value, at = '$') {
  const errors = [];
  const fail = (message) => errors.push(`${at}: ${message}`);
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) fail('const');
  if (schema.enum && !schema.enum.includes(value)) fail('enum');
  if (schema.type === 'string' && (typeof value !== 'string' || (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) || value.length < (schema.minLength ?? 0))) fail('string');
  if (schema.type === 'integer' && !(Number.isInteger(value) && value >= (schema.minimum ?? -Infinity))) fail('integer');
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail('array');
    else if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) fail('uniqueItems');
    else value.forEach((item, index) => errors.push(...schemaErrors(schema.items ?? {}, item, `${at}[${index}]`)));
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [...errors, `${at}: object`];
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...schemaErrors(schema.properties[key], item, `${at}.${key}`));
      else if (schema.additionalProperties === false) fail(`unknown ${key}`);
    }
  }
  return errors;
}

test('the generated SwiftUI status conforms to its schema', async () => {
  const schema = JSON.parse(await readFile(path.join(repoRoot, 'uifn/catalog/schema/swiftui-status.schema.json'), 'utf8'));
  const generated = JSON.parse(createGeneratedOutputs().outputs['swiftui-status.json']);
  assert.deepEqual(schemaErrors(schema, generated), []);
  assert.deepEqual(schemaErrors(schema, JSON.parse(await readFile(path.join(generatedRoot, 'swiftui-status.json'), 'utf8'))), []);
  const nested = structuredClone(generated);
  nested.surfaces[0].id = 'UIFnTimeline.Row';
  assert.deepEqual(schemaErrors(schema, nested), []);
  const blank = structuredClone(generated);
  blank.primitives[0].swiftui.note = '   ';
  blank.surfaces[0].notes = 'stray';
  assert.deepEqual(schemaErrors(schema, blank).sort(), ['$.primitives[0].swiftui.note: string', '$.surfaces[0]: unknown notes']);
  const repeated = structuredClone(generated);
  repeated.surfaces[0].primitives.push(repeated.surfaces[0].primitives[0]);
  assert.deepEqual(schemaErrors(schema, repeated), ['$.surfaces[0].primitives: uniqueItems']);
});
