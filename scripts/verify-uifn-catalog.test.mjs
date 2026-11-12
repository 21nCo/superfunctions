import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('the SwiftUI surface list must match the styles and components UIFnSwiftUI declares', async () => {
  const declarations = await readSwiftUISurfaceDeclarations(repoRoot);
  const descriptor = await fixture('unlisted-swiftui-surface.json');
  const added = parseSwiftUISurfaceDeclarations([{ path: descriptor.mutation.swiftSource, text: descriptor.mutation.text }]);
  assert.deepEqual(added.map((declaration) => declaration.id), ['UIFnSliderStyle']);
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations([...declarations, ...added]), descriptor.expectedErrorCodes[0]);
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations(declarations.filter((declaration) => declaration.id !== 'UIFnGaugeStyle')), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations(declarations.map((declaration) => (
    declaration.id === 'UIFnBanner' ? { ...declaration, source: 'uifn/swift/Sources/UIFnSwiftUI/Components/UIFnToast.swift' } : declaration
  ))), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  // A listed kind must match the declaration: UIFnSegmentedPicker lives in
  // Styles but is a View, so listing it as a style is drift.
  assert.equal(declarations.find((declaration) => declaration.id === 'UIFnSegmentedPicker').kind, 'component');
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations(declarations, swiftuiSourceWith((source) => {
    source.surfaces.find((surface) => surface.id === 'UIFnSegmentedPicker').kind = 'style';
  })), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
});

function parseOne(relativePath, lines) {
  return parseSwiftUISurfaceDeclarations([{ path: relativePath, text: lines.join('\n') }]).map((declaration) => [declaration.id, declaration.kind]);
}

test('Swift declarations count only public styles, views, and component view modifiers', () => {
  const components = 'uifn/swift/Sources/UIFnSwiftUI/Components/Example.swift';
  assert.deepEqual(parseOne(components, [
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
  ]), [
    ['UIFnCard', 'component'],
    ['UIFnCardModel', 'unclassified'],
    ['uifnCardOverlay', 'component'],
    ['uifnCardBadge', 'component'],
    ['UIFnCardList', 'component'],
  ]);
  assert.deepEqual(parseOne('uifn/swift/Sources/UIFnSwiftUI/Styles/Example.swift', ['public struct UIFnRowStyle: LabelStyle {', '}']), [['UIFnRowStyle', 'style']]);
  assert.deepEqual(parseOne('uifn/swift/Sources/UIFnSwiftUI/Tokens/Example.swift', ['public struct UIFnThemeView: View {', '}']), []);
});

test('a surface kind follows its Swift declaration, not its directory', () => {
  // A View in Styles is a component; a style protocol conformance in
  // Components is a style. View-extension functions count only in Components.
  assert.deepEqual(parseOne('uifn/swift/Sources/UIFnSwiftUI/Styles/Example.swift', [
    'public struct UIFnChipPicker<Label: View>: View {',
    '}',
    'public extension View {',
    '    func uifnTheme(_ theme: Int) -> some View { self }',
    '}',
  ]), [['UIFnChipPicker', 'component'], ['uifnTheme', 'unclassified']]);
  assert.deepEqual(parseOne('uifn/swift/Sources/UIFnSwiftUI/Components/Example.swift', [
    'public struct UIFnChipStyle: SwiftUI.ButtonStyle {',
    '}',
  ]), [['UIFnChipStyle', 'style']]);
});

test('public ViewModifiers, extension conformances, and nested public structs are surfaces', () => {
  const components = 'uifn/swift/Sources/UIFnSwiftUI/Components/Example.swift';
  assert.deepEqual(parseOne(components, [
    'public struct UIFnHighlight: ViewModifier {',
    '    public func body(content: Content) -> some View { content }',
    '}',
    'public struct UIFnTag<Label: View> {',
    '    let label: Label',
    '}',
    'extension UIFnTag: View {',
    '    public var body: some View { label }',
    '}',
    'public struct UIFnTimeline {',
    '    public struct Row:',
    '        View {',
    '        public var body: some View { EmptyView() }',
    '    }',
    '    struct Hidden: View {',
    '    }',
    '}',
    'public struct UIFnTagModel {',
    '}',
    'extension UIFnTagModel where Self: Equatable {',
    '}',
    'struct UIFnInternalModifier: ViewModifier {',
    '}',
    'extension UIFnInternalModifier: View {',
    '}',
  ]), [
    ['UIFnHighlight', 'component'],
    ['UIFnTag', 'component'],
    ['UIFnTimeline', 'unclassified'],
    ['UIFnTimeline.Row', 'component'],
    ['UIFnTagModel', 'unclassified'],
  ]);
  // A conformance added in another file, in either directory, also counts.
  assert.deepEqual(parseSwiftUISurfaceDeclarations([
    { path: 'uifn/swift/Sources/UIFnSwiftUI/Styles/UIFnChip.swift', text: 'public struct UIFnChipStyle {\n}\n' },
    { path: 'uifn/swift/Sources/UIFnSwiftUI/Components/UIFnChip+Style.swift', text: 'extension UIFnChipStyle: ToggleStyle {\n}\n' },
    { path: 'uifn/swift/Sources/UIFnSwiftUI/Tokens/UIFnIgnored.swift', text: 'public struct UIFnIgnored: View {\n}\n' },
  ]), [{ id: 'UIFnChipStyle', kind: 'style', source: 'uifn/swift/Sources/UIFnSwiftUI/Styles/UIFnChip.swift' }]);
});

test('Shapes and view representables are components', () => {
  assert.deepEqual(parseOne('uifn/swift/Sources/UIFnSwiftUI/Components/Example.swift', [
    'public struct UIFnNotch: Shape {',
    '}',
    'public struct UIFnRing: SwiftUI.InsettableShape {',
    '}',
    '#if canImport(UIKit)',
    'public struct UIFnHostedView: UIViewRepresentable {',
    '}',
    'public struct UIFnHostedController: UIViewControllerRepresentable {',
    '}',
    '#else',
    'public struct UIFnHostedView: NSViewRepresentable {',
    '}',
    'public struct UIFnHostedController: NSViewControllerRepresentable {',
    '}',
    '#endif',
    'public struct UIFnSpacing: Equatable {',
    '}',
  ]), [
    ['UIFnNotch', 'component'],
    ['UIFnRing', 'component'],
    ['UIFnHostedView', 'component'],
    ['UIFnHostedController', 'component'],
    ['UIFnHostedView', 'component'],
    ['UIFnHostedController', 'component'],
    ['UIFnSpacing', 'unclassified'],
  ]);
});

test('Swift files in subdirectories of Styles and Components are scanned', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uifn-swiftui-surfaces-'));
  try {
    const sources = path.join(root, 'uifn/swift/Sources/UIFnSwiftUI');
    const write = async (relativePath, text) => {
      await mkdir(path.dirname(path.join(sources, relativePath)), { recursive: true });
      await writeFile(path.join(sources, relativePath), text);
    };
    await write('Styles/UIFnChipStyle.swift', 'public struct UIFnChipStyle: ButtonStyle {\n}\n');
    await write('Components/Feedback/UIFnAlert.swift', 'public struct UIFnAlert: View {\n}\n');
    await write('Components/Feedback/Deep/UIFnNotch.swift', 'public struct UIFnNotch: Shape {\n}\n');
    await write('Components/Feedback/README.md', 'public struct UIFnNotSwift: View {\n}\n');
    await write('Tokens/Nested/UIFnIgnored.swift', 'public struct UIFnIgnored: View {\n}\n');
    const declarations = await readSwiftUISurfaceDeclarations(root);
    assert.deepEqual(declarations, [
      { id: 'UIFnChipStyle', kind: 'style', source: 'uifn/swift/Sources/UIFnSwiftUI/Styles/UIFnChipStyle.swift' },
      { id: 'UIFnNotch', kind: 'component', source: 'uifn/swift/Sources/UIFnSwiftUI/Components/Feedback/Deep/UIFnNotch.swift' },
      { id: 'UIFnAlert', kind: 'component', source: 'uifn/swift/Sources/UIFnSwiftUI/Components/Feedback/UIFnAlert.swift' },
    ]);
    // An unlisted view in a subdirectory is drift against the real list.
    const real = await readSwiftUISurfaceDeclarations(repoRoot);
    expectCatalogCode(() => verifySwiftUISurfaceDeclarations([...real, declarations[2]]), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
    // A listed surface may move into a subdirectory once it is listed with
    // that path, and only then.
    const moved = 'uifn/swift/Sources/UIFnSwiftUI/Components/Feedback/UIFnBanner.swift';
    const movedDeclarations = real.map((declaration) => (declaration.id === 'UIFnBanner' ? { ...declaration, source: moved } : declaration));
    const movedSource = swiftuiSourceWith((source) => {
      source.surfaces.find((surface) => surface.id === 'UIFnBanner').source = moved;
    });
    validateSwiftUIStatus(movedSource);
    verifySwiftUISurfaceDeclarations(movedDeclarations, movedSource);
    expectCatalogCode(() => verifySwiftUISurfaceDeclarations(movedDeclarations), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const swiftComponents = 'uifn/swift/Sources/UIFnSwiftUI/Components';

function listedWith(entries) {
  return swiftuiSourceWith((source) => {
    for (const entry of entries) {
      if (entry.kind === 'unclassified') source.nonSurfaces.push({ id: entry.id, source: entry.source, reason: 'Test.' });
      else source.surfaces.push({ id: entry.id, kind: entry.kind, issue: 'UIF-28', source: entry.source });
    }
  });
}

test('every public view, modifier, style or other type in Styles and Components has to be listed', async () => {
  const real = await readSwiftUISurfaceDeclarations(repoRoot);
  const cases = [
    ['nested generics', 'public struct UIFnList<Data: RandomAccessCollection<Int>, Row: View>: View {\n    public var body: some View { EmptyView() }\n}\n', [['UIFnList', 'component']]],
    ['access from a public extension', 'public extension UIFnNS {\n    struct UIFnBar: View { public var body: some View { EmptyView() } }\n    internal struct UIFnHidden: View {}\n}\n', [['UIFnNS.UIFnBar', 'component']]],
    ['indented View extension under #if', 'enum NS {\n  }\n#if os(iOS)\n  public extension SwiftUI.View {\n    @ViewBuilder func uifnWrapped() -> some View { self }\n    public private(set) var uifnLabel: String { "" }\n  }\n#endif\n', [['uifnWrapped', 'component'], ['uifnLabel', 'component']]],
    ['a View-refining protocol declared in the sources', 'public protocol UIFnPanelView: View {}\nprotocol UIFnInsetPanel: UIFnPanelView {}\npublic struct UIFnPanel: UIFnInsetPanel {\n    public var body: some View { EmptyView() }\n}\n', [['UIFnPanel', 'component']]],
    ['a Layout is unclassified', 'public struct UIFnFlow: Layout {\n}\npublic final class UIFnModel: ObservableObject {\n}\n', [['UIFnFlow', 'unclassified'], ['UIFnModel', 'unclassified']]],
    ['a nested type by its qualified name', 'public struct UIFnTimeline: View {\n    public struct Row: View { public var body: some View { EmptyView() } }\n    struct Hidden: View {}\n    public var body: some View { EmptyView() }\n}\nstruct UIFnInternal {\n    public struct Inner: View {}\n}\n', [['UIFnTimeline', 'component'], ['UIFnTimeline.Row', 'component']]],
  ];
  for (const [name, text, expected] of cases) {
    const declarations = parseSwiftUISurfaceDeclarations([{ path: `${swiftComponents}/UIFnProbe.swift`, text }]);
    assert.deepEqual(declarations.map((declaration) => [declaration.id, declaration.kind]), expected, name);
    expectCatalogCode(() => verifySwiftUISurfaceDeclarations([...real, ...declarations]), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
    const listed = listedWith(declarations);
    validateSwiftUIStatus(swiftuiSourceWith((source) => { source.nonSurfaces = listed.nonSurfaces; }));
    verifySwiftUISurfaceDeclarations([...real, ...declarations], listed);
  }
});

test('comments and string literals declare nothing', async () => {
  const text = [
    '// public struct UIFnLine: View {}',
    '/* public struct UIFnBlock: View {} /* nested */ public struct UIFnStillComment: View {} */',
    'let a = "public struct UIFnString: View {"',
    'let b = """',
    '    public struct UIFnMultiline: View {',
    '    """',
    'let c = #"public struct UIFnRaw: View { \\(x) "#',
    'let d = "\\(items.map { "public struct UIFnInterpolated: View {" }) public struct UIFnAfter: View {"',
    'let e = "escaped \\" public struct UIFnEscaped: View {"',
    'public struct UIFnReal: View {}',
  ].join('\n');
  assert.deepEqual(parseOne(`${swiftComponents}/UIFnProbe.swift`, [text]), [['UIFnReal', 'component']]);
  // A listed style whose source is commented out is no longer declared.
  const gauge = 'uifn/swift/Sources/UIFnSwiftUI/Styles/UIFnGaugeStyle.swift';
  const real = await readSwiftUISurfaceDeclarations(repoRoot);
  const commented = parseSwiftUISurfaceDeclarations([{ path: gauge, text: `/*\n${await readFile(path.join(repoRoot, gauge), 'utf8')}\n*/\n` }]);
  assert.deepEqual(commented, []);
  assert.throws(
    () => verifySwiftUISurfaceDeclarations([...real.filter((declaration) => declaration.source !== gauge), ...commented]),
    (error) => error.code === 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT' && error.details.undeclared.includes('UIFnGaugeStyle'),
  );
});

test('repeats of one declaration verify once listed; a conflicting kind or source is drift', async () => {
  const real = await readSwiftUISurfaceDeclarations(repoRoot);
  const declarations = parseSwiftUISurfaceDeclarations([{
    path: `${swiftComponents}/UIFnHosted.swift`,
    text: '#if canImport(UIKit)\npublic struct UIFnHostedView: UIViewRepresentable {\n}\n#else\npublic struct UIFnHostedView: NSViewRepresentable {\n}\n#endif\npublic extension View {\n    func uifnBadge(_ count: Int) -> some View { self }\n    func uifnBadge(_ text: String) -> some View { self }\n}\n',
  }]);
  assert.equal(declarations.length, 4);
  const listed = listedWith([declarations[0], declarations[2]]);
  verifySwiftUISurfaceDeclarations([...real, ...declarations], listed);
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations([...real, ...declarations, { ...declarations[0], kind: 'unclassified' }], listed), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations([...real, ...declarations, { ...declarations[2], source: `${swiftComponents}/Other.swift` }], listed), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  // A listed non-surface that the sources no longer declare is drift too.
  expectCatalogCode(() => verifySwiftUISurfaceDeclarations(real.filter((declaration) => declaration.id !== 'UIFnToast')), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
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
});

test('imports, default values and unreadable text do not hide a public declaration', async () => {
  const real = await readSwiftUISurfaceDeclarations(repoRoot);
  const probe = `${swiftComponents}/UIFnProbe.swift`;
  const cases = [
    ['selective imports', 'import SwiftUI\nimport struct Foundation.URL\n@testable import class Foundation.NSObject\nimport protocol Swift.Equatable\npublic struct UIFnProbe: View {}\n', [['UIFnProbe', 'component']]],
    ['access-qualified imports', 'internal import Foundation\npublic struct UIFnProbe: View {}\npublic import SwiftUI\nstruct UIFnInternal: View {}\nextension View {\n    func uifnHidden() -> some View { self }\n}\n', [['UIFnProbe', 'component']]],
    ['a default value of .private', 'public let uifnDefault: Access = .internal\npublic struct UIFnPager: View {\n    var scope: Access = .private\n    public struct Row: View {}\n}\n', [['UIFnPager', 'component'], ['UIFnPager.Row', 'component']]],
    ['SwiftUI refinements of View and ViewModifier', 'public struct UIFnShake: GeometryEffect {}\npublic struct UIFnFade: SwiftUI.AnimatableModifier {}\n', [['UIFnShake', 'component'], ['UIFnFade', 'component']]],
    ['an extension of a non-public type', 'struct UIFnInternal {}\nextension UIFnInternal {\n    public struct Inner: View {}\n}\npublic struct UIFnProbe: View {}\n', [['UIFnProbe', 'component']]],
    ['a non-public #if alternative', '#if os(iOS)\npublic struct UIFnOuter {\n    public struct Row: View {}\n}\n#else\nstruct UIFnOuter {}\n#endif\nextension UIFnOuter {\n    public struct Cell: View {}\n}\n', [['UIFnOuter', 'unclassified'], ['UIFnOuter.Row', 'component'], ['UIFnOuter.Cell', 'component']]],
    ['parameter labels that are keywords', 'public struct UIFnProbe: View {\n    public init?(`class` value: AnyClass, struct kind: Int) {}\n    public func uifnSet<T: Equatable>(class: String, _ `protocol`: T) {}\n    public static func <(lhs: Self, rhs: Self) -> Bool { false }\n    public static func <<=(lhs: inout Self, struct rhs: Int) {}\n    public subscript(enum index: Int) -> Int { index }\n}\npublic extension View {\n    func uifnBadge(struct kind: Int, `extension`: String) -> some View { self }\n}\n', [['UIFnProbe', 'component'], ['uifnBadge', 'component']]],
    ['keyword labels outside parameter lists', 'private enum UIFnModel {\n    case payload(`struct`: Int, class: String)\n    case plain, `class`, other\n}\nprivate typealias UIFnHandler = (_ `struct`: Int) -> Void\npublic struct UIFnProbe: View {\n    static let preset = UIFnPreset(struct: 1, enum: 2)\n    var pair: (protocol: Int, extension: Int)\n}\n', [['UIFnProbe', 'component']]],
    ['protocol refinements across #if alternatives and where clauses', '#if os(iOS)\npublic protocol UIFnPanelProtocol: View {}\n#else\npublic protocol UIFnPanelProtocol {}\n#endif\nprivate enum Helpers { protocol UIFnPanelProtocol {} }\npublic protocol UIFnCardView where Self: SwiftUI.View {}\npublic struct UIFnProbe: UIFnPanelProtocol {}\npublic struct UIFnCard: UIFnCardView {}\npublic struct dynamic: View {}\npublic protocol UIFnRenderable where Self: Equatable & View {}\npublic struct UIFnRendered: UIFnRenderable {}\npublic enum UIFnList {\n    public protocol RowView: View {}\n    public struct Row: RowView {}\n}\npublic struct UIFnCore: SwiftUICore.View {}\n', [['UIFnProbe', 'component'], ['UIFnCard', 'component'], ['dynamic', 'component'], ['UIFnRendered', 'component'], ['UIFnList.Row', 'component'], ['UIFnCore', 'component']]],
    ['a regex after in', 'private let matcher = { () -> Regex<Substring> in /["{]/ }\npublic struct UIFnProbe: View {}\npublic extension View {\n    func `lazy`() -> some View { self }\n}\n', [['UIFnProbe', 'component'], ['lazy', 'component']]],
    ['a regex after a comment', 'private let quotes = /* comment */ /["""]/\nprivate let brace = /* comment */ /[{]/\npublic struct UIFnProbe: View {}\n', [['UIFnProbe', 'component']]],
    ['regex literals', 'let opening = #/[{]/#\nlet closing = /[}]/\nlet ratio = width/2 + height / 2\npublic struct UIFnProbe: View { public var body: some View { EmptyView() } }\nlet multi = #/\n  [}]\n/#\n', [['UIFnProbe', 'component']]],
  ];
  for (const [name, text, expected] of cases) {
    const declarations = parseSwiftUISurfaceDeclarations([{ path: probe, text }]);
    assert.deepEqual(declarations.map((declaration) => [declaration.id, declaration.kind]), expected, name);
    expectCatalogCode(() => verifySwiftUISurfaceDeclarations([...real, ...declarations]), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  }
  // Text the scan cannot read, and a public name the lists cannot hold, fail
  // closed rather than drop the declaration.
  for (const text of ['let pattern = foo(/[{]\npublic struct UIFnAfter: View {}\n', '}\npublic struct UIFnAfter: View {}\n', 'public struct Ünit: View {}\n', 'public extension View {\n    func uifnÜbersicht() -> some View { self }\n}\n', 'public struct `UIFn Row`: View {}\n', 'public struct 🙂Card: View {}\n', 'public struct UIFne\u0301Card: View {}\n', 'let value = foo(\npublic struct UIFnAfter: View {}\n', 'func helper(\npublic struct UIFnAfter: View {}\n', '@available(iOS 16\npublic struct UIFnAfter: View {}\n']) {
    expectCatalogCode(() => parseSwiftUISurfaceDeclarations([{ path: probe, text }]), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  }
  for (const file of ['UIFn_Grid.swift', 'Data-Views/UIFnGrid.swift']) {
    expectCatalogCode(() => parseSwiftUISurfaceDeclarations([{ path: `${swiftComponents}/${file}`, text: 'public struct UIFnGrid: View {}\n' }]), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT');
  }
});
