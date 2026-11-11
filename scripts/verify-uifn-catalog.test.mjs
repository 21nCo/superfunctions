import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CATALOG_SOURCE, EXPECTED_PRIMITIVE_NAMES } from '../uifn/catalog/src/catalog-source.mjs';
import { compareGeneratedOutputs, createGeneratedOutputs, parseSwiftUISurfaceDeclarations, readSwiftUISurfaceDeclarations, validateCatalogSource, validateSwiftUIStatus, verifyGeneratedDirectory, verifySwiftUISurfaceDeclarations, writeGeneratedOutputs } from '../uifn/catalog/src/compiler.mjs';
import { migrateCatalogDocument } from '../uifn/catalog/src/migrations.mjs';
import { SWIFTUI_STATUS_SOURCE, SWIFTUI_STATUSES } from '../uifn/catalog/src/swiftui-status.mjs';

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
  const declarations = await readSwiftUISurfaceDeclarations(repoRoot);
  assert.deepEqual(declarations.map((declaration) => declaration.id).sort(), status.surfaces.map((surface) => surface.id).sort());
  verifySwiftUISurfaceDeclarations(declarations);
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

test('the SwiftUI surface list must match the styles and components UIFnSwiftUI declares', async () => {
  const declarations = await readSwiftUISurfaceDeclarations(repoRoot);
  const descriptor = await fixture('unlisted-swiftui-surface.json');
  const added = parseSwiftUISurfaceDeclarations(descriptor.mutation.swiftSource, descriptor.mutation.text);
  assert.deepEqual(added.map((declaration) => declaration.id), ['UIFnSliderStyle']);
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations([...declarations, ...added]), descriptor.expectedErrorCodes[0]);
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations(declarations.filter((declaration) => declaration.id !== 'UIFnGaugeStyle')), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations(declarations.map((declaration) => (
    declaration.id === 'UIFnBanner' ? { ...declaration, source: 'uifn/swift/Sources/UIFnSwiftUI/Components/UIFnToast.swift' } : declaration
  ))), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
});

test('Swift declarations count only public styles, views, and component view modifiers', () => {
  const components = 'uifn/swift/Sources/UIFnSwiftUI/Components/Example.swift';
  const text = [
    'public struct UIFnCard<Content: View, Footer: View>: View {',
    '}',
    'public struct UIFnCardModel: Identifiable, Equatable {',
    '}',
    'struct UIFnInternalView: View {',
    '}',
    'public extension View {',
    '    /// Docs.',
    '    @MainActor',
    '    func uifnCardOverlay(_ value: Int) -> some View { self }',
    '    private func uifnHelper() -> some View { self }',
    '}',
    'extension View {',
    '    func uifnInternal() -> some View { self }',
    '    public func uifnCardBadge() -> some View { self }',
    '}',
    '@MainActor public struct UIFnCardList: View {',
    '}',
  ].join('\n');
  assert.deepEqual(parseSwiftUISurfaceDeclarations(components, text).map((declaration) => [declaration.id, declaration.kind]), [
    ['UIFnCard', 'component'],
    ['UIFnCardList', 'component'],
    ['uifnCardOverlay', 'component'],
    ['uifnCardBadge', 'component'],
  ]);
  assert.deepEqual(parseSwiftUISurfaceDeclarations('uifn/swift/Sources/UIFnSwiftUI/Styles/Example.swift', 'public struct UIFnRowStyle: LabelStyle {\n}\n').map((declaration) => [declaration.id, declaration.kind]), [['UIFnRowStyle', 'style']]);
  assert.deepEqual(parseSwiftUISurfaceDeclarations('uifn/swift/Sources/UIFnSwiftUI/Tokens/Example.swift', 'public struct UIFnThemeView: View {\n}\n'), []);
});
