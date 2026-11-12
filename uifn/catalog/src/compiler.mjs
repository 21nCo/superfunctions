import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CATALOG_SOURCE, EXPECTED_PRIMITIVE_NAMES } from './catalog-source.mjs';
import {
  BEHAVIOR_FAMILIES,
  CATALOG_SCHEMA_VERSION,
  CATALOG_VERSION,
  DOC_SECTIONS,
  DOM_SERVICES,
  FRAMEWORK_TARGETS,
  GENERATOR_VERSION,
  IMPLEMENTATION_KINDS,
  STABLE_FRAMEWORKS,
  STORY_PROFILES,
} from './profiles.mjs';
import {
  SWIFTUI_SOURCES_ROOT,
  SWIFTUI_STATUS_SCHEMA_VERSION,
  SWIFTUI_STATUS_SOURCE,
  SWIFTUI_STATUSES,
  SWIFTUI_SURFACE_KINDS,
} from './swiftui-status.mjs';

export const GENERATED_OUTPUT_NAMES = [
  'adapter-coverage.json',
  'anatomy-types.json',
  'catalog.json',
  'core-exports.json',
  'docs-manifest.json',
  'implementation-ownership.json',
  'package-exports.json',
  'primitive-contracts.d.ts',
  'registry-metadata.json',
  'release-matrix.json',
  'story-manifest.json',
  'swiftui-status.json',
  'test-manifest.json',
];

const PRIMITIVE_REQUIRED_FIELDS = [
  'id', 'name', 'canonicalOrder', 'behaviorFamily', 'implementationKind',
  'requirementIds', 'anatomy', 'inputs', 'events', 'states', 'controlledModel', 'formSemantics',
  'domServices', 'accessibility', 'frameworks', 'vectors', 'docs', 'stories', 'outputs', 'release', 'exceptions',
];
const ALLOWED_CONTROLLED_MODES = ['none', 'native', 'single', 'multiple', 'single-or-multiple', 'compound'];
const DOM_SERVICE_IDS = Object.values(DOM_SERVICES);
const PRIMITIVE_REQUIREMENTS = new Set(['PRIM-001', 'PRIM-002', 'PRIM-003', 'PRIM-004', 'PRIM-005', 'PRIM-006', 'PRIM-007', 'PRIM-008']);

export class CatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    this.details = details;
  }
}

export function stableStringify(value, indentation = 2) {
  function sort(input) {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, sort(input[key])]));
    }
    return input;
  }
  return `${JSON.stringify(sort(value), null, indentation)}\n`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(code, message, details = {}) {
  throw new CatalogError(code, message, details);
}

function assert(condition, code, message, details = {}) {
  if (!condition) fail(code, message, details);
}

function assertUnique(values, label, primitive) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail('UIFN_CATALOG_DUPLICATE', `Duplicate ${label}: ${value}`, { primitive, label, value });
    seen.add(value);
  }
}

function assertExactArray(actual, expected, label, primitive) {
  assert(Array.isArray(actual), 'UIFN_CATALOG_FIELD_MISSING', `${label} must be an array.`, { primitive, label });
  assert(actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    'UIFN_CATALOG_UNSUPPORTED_VALUE', `${label} does not match the canonical contract.`, { primitive, label, actual, expected });
}

function validateAccessibility(primitive) {
  const accessibility = primitive.accessibility;
  assert(accessibility && typeof accessibility === 'object', 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} is missing accessibility.`, { primitive: primitive.name, field: 'accessibility' });
  assert(BEHAVIOR_FAMILIES.includes(accessibility.profile), 'UIFN_CATALOG_UNSUPPORTED_VALUE', `${primitive.name} has an unsupported accessibility profile.`, { primitive: primitive.name, value: accessibility.profile });
  const rules = accessibility.rules;
  const requiredRules = ['normativeBasis', 'nativeSemantics', 'accessibleName', 'description', 'keyboard', 'pointerTouch', 'focus', 'announcements', 'wcag', 'preferences'];
  assert(rules && typeof rules === 'object', 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} is missing accessibility rules.`, { primitive: primitive.name });
  for (const field of requiredRules) {
    assert(Object.hasOwn(rules, field), 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} is missing accessibility.rules.${field}.`, { primitive: primitive.name, field });
  }
  for (const field of ['normativeBasis', 'pointerTouch', 'focus', 'announcements', 'wcag']) {
    assert(Array.isArray(rules[field]) && rules[field].length > 0, 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} requires non-empty accessibility.rules.${field}.`, { primitive: primitive.name, field });
    assertUnique(rules[field], `accessibility.rules.${field}`, primitive.name);
  }
  assert(typeof rules.nativeSemantics === 'string' && rules.nativeSemantics.length > 0, 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} needs native semantics.`, { primitive: primitive.name });
  assert(typeof rules.accessibleName?.required === 'boolean' && rules.accessibleName.sources?.length > 0, 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} needs an accessible-name contract.`, { primitive: primitive.name });
  assert(typeof rules.description?.supported === 'boolean' && Array.isArray(rules.description.relationships), 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} needs a description contract.`, { primitive: primitive.name });
  assert(typeof rules.keyboard?.model === 'string' && rules.keyboard.keys?.length > 0, 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} needs a keyboard contract.`, { primitive: primitive.name });
  assert(['forcedColors', 'reflow', 'reducedMotion', 'rtl'].every((field) => typeof rules.preferences?.[field] === 'string' && rules.preferences[field].length > 0), 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} needs all accessibility preference contracts.`, { primitive: primitive.name });
  assert(Array.isArray(accessibility.primitiveNotes) && accessibility.primitiveNotes.length > 0, 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} needs primitive-specific accessibility notes.`, { primitive: primitive.name });
}

function validatePrimitive(primitive, index) {
  assert(primitive && typeof primitive === 'object', 'UIFN_CATALOG_FIELD_MISSING', `Primitive at index ${index} must be an object.`, { index });
  for (const field of PRIMITIVE_REQUIRED_FIELDS) {
    assert(Object.hasOwn(primitive, field), 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name ?? index} is missing ${field}.`, { primitive: primitive.name, field });
  }
  assert(primitive.name === EXPECTED_PRIMITIVE_NAMES[index], 'UIFN_CATALOG_NAME_SET_INVALID', `Unexpected primitive at canonical position ${index + 1}.`, { actual: primitive.name, expected: EXPECTED_PRIMITIVE_NAMES[index] });
  assert(primitive.canonicalOrder === index + 1, 'UIFN_CATALOG_NAME_SET_INVALID', `${primitive.name} has an invalid canonical order.`, { actual: primitive.canonicalOrder, expected: index + 1 });
  assert(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(primitive.id), 'UIFN_CATALOG_UNSUPPORTED_VALUE', `${primitive.name} has an invalid id.`, { primitive: primitive.name, value: primitive.id });
  assert(BEHAVIOR_FAMILIES.includes(primitive.behaviorFamily), 'UIFN_CATALOG_UNSUPPORTED_VALUE', `${primitive.name} has an unsupported behavior family.`, { primitive: primitive.name, value: primitive.behaviorFamily });
  assert(IMPLEMENTATION_KINDS.includes(primitive.implementationKind), 'UIFN_CATALOG_UNSUPPORTED_VALUE', `${primitive.name} has an unsupported implementation kind.`, { primitive: primitive.name, value: primitive.implementationKind });
  assert(Array.isArray(primitive.requirementIds) && primitive.requirementIds.includes('CAT-001') && primitive.requirementIds.length >= 2, 'UIFN_CATALOG_REQUIREMENT_MAPPING_INVALID', `${primitive.name} must map CAT-001 and a primitive requirement.`, { primitive: primitive.name });
  assertUnique(primitive.requirementIds, 'requirement id', primitive.name);
  const primitiveRequirements = primitive.requirementIds.filter((id) => id.startsWith('PRIM-'));
  assert(primitiveRequirements.length > 0 && primitiveRequirements.every((id) => PRIMITIVE_REQUIREMENTS.has(id)), 'UIFN_CATALOG_REQUIREMENT_MAPPING_INVALID', `${primitive.name} has unsupported primitive requirements.`, { primitive: primitive.name, primitiveRequirements });

  for (const [field, key] of [['anatomy', 'id'], ['inputs', 'name'], ['events', 'type'], ['states', 'name']]) {
    assert(Array.isArray(primitive[field]), 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} is missing ${field}.`, { primitive: primitive.name, field });
    assertUnique(primitive[field].map((entry) => entry?.[key]), field, primitive.name);
  }
  assert(primitive.anatomy.length > 0 && primitive.inputs.length > 0 && primitive.states.length > 0, 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} needs anatomy, inputs, and states.`, { primitive: primitive.name });
  assert(primitive.implementationKind === 'typed-static-contract' || primitive.events.length > 0, 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} interactive controllers need events.`, { primitive: primitive.name });

  const model = primitive.controlledModel;
  assert(model && ALLOWED_CONTROLLED_MODES.includes(model.mode), 'UIFN_CATALOG_UNSUPPORTED_VALUE', `${primitive.name} has an unsupported controlled model.`, { primitive: primitive.name, value: model?.mode });
  const inputNames = new Set(primitive.inputs.map((input) => input.name));
  for (const field of ['valueInputs', 'defaultInputs']) {
    assert(Array.isArray(model[field]), 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} controlledModel.${field} must be an array.`, { primitive: primitive.name, field });
    assertUnique(model[field], `controlledModel.${field}`, primitive.name);
    for (const input of model[field]) assert(inputNames.has(input), 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} controlledModel references missing input ${input}.`, { primitive: primitive.name, field, input });
  }
  assert(Array.isArray(model.changeEvents), 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} controlledModel.changeEvents must be an array.`, { primitive: primitive.name });
  assertUnique(model.changeEvents, 'controlledModel.changeEvents', primitive.name);
  if (model.mode === 'none') assert(model.valueInputs.length === 0 && model.defaultInputs.length === 0 && model.changeEvents.length === 0, 'UIFN_CATALOG_UNSUPPORTED_VALUE', `${primitive.name} none model cannot declare bindings.`, { primitive: primitive.name });
  else assert(model.valueInputs.length > 0 && model.changeEvents.length > 0, 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} controlled model needs value inputs and change events.`, { primitive: primitive.name });

  assert(Array.isArray(primitive.domServices), 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} domServices must be an array.`, { primitive: primitive.name });
  assertUnique(primitive.domServices, 'DOM service', primitive.name);
  for (const service of primitive.domServices) assert(DOM_SERVICE_IDS.includes(service), 'UIFN_CATALOG_UNSUPPORTED_VALUE', `${primitive.name} has an unsupported DOM service.`, { primitive: primitive.name, value: service });
  validateAccessibility(primitive);

  assertExactArray(Object.keys(primitive.frameworks), STABLE_FRAMEWORKS, 'framework keys', primitive.name);
  for (const framework of STABLE_FRAMEWORKS) {
    const target = primitive.frameworks[framework];
    const expected = FRAMEWORK_TARGETS[framework];
    assert(target?.headlessPackage === expected.headlessPackage && target?.styledPackage === expected.styledPackage && target?.compoundRoot === primitive.name && target?.support === 'required', 'UIFN_CATALOG_UNSUPPORTED_VALUE', `${primitive.name} has invalid ${framework} target metadata.`, { primitive: primitive.name, framework });
    assert(target.implementationStatus === 'implemented', 'UIFN_CATALOG_IMPLEMENTATION_STATUS_INVALID', `${primitive.name} ${framework} must identify its implemented stable adapter.`, { primitive: primitive.name, framework });
  }

  const expectedVectors = primitive.requirementIds.flatMap((id) => [`TV-${id}-P`, `TV-${id}-N`]);
  assertExactArray(primitive.vectors, expectedVectors, 'vectors', primitive.name);
  assert(primitive.docs?.page === `primitives/${primitive.id}`, 'UIFN_CATALOG_UNSUPPORTED_VALUE', `${primitive.name} has an invalid docs page.`, { primitive: primitive.name });
  assertExactArray(primitive.docs?.requiredSections, DOC_SECTIONS, 'docs required sections', primitive.name);
  assert(primitive.docs?.implementationStatus === 'implemented', 'UIFN_CATALOG_IMPLEMENTATION_STATUS_INVALID', `${primitive.name} docs must identify their implemented catalog page.`, { primitive: primitive.name });
  assertExactArray(primitive.stories?.requiredScenarios, STORY_PROFILES[primitive.implementationKind], 'story scenarios', primitive.name);
  assert(primitive.stories?.implementationStatus === 'implemented', 'UIFN_CATALOG_IMPLEMENTATION_STATUS_INVALID', `${primitive.name} stories must identify their implemented scenario suite.`, { primitive: primitive.name });

  const expectedCore = primitive.implementationKind === 'interactive-controller'
    ? [`${primitive.name}Controller`, `create${primitive.name}Controller`]
    : [`${primitive.name}Contract`];
  assertExactArray(primitive.outputs?.core, expectedCore, 'core outputs', primitive.name);
  assertExactArray(primitive.outputs?.headlessPackages, STABLE_FRAMEWORKS.map((framework) => FRAMEWORK_TARGETS[framework].headlessPackage), 'headless package outputs', primitive.name);
  assertExactArray(primitive.outputs?.styledPackages, STABLE_FRAMEWORKS.map((framework) => FRAMEWORK_TARGETS[framework].styledPackage), 'styled package outputs', primitive.name);
  assert(primitive.release?.channel === 'stable-1.0' && primitive.release?.catalogStatus === 'ga-required', 'UIFN_CATALOG_RELEASE_MAPPING_INVALID', `${primitive.name} release metadata is invalid.`, { primitive: primitive.name });
  assert(primitive.release?.implementationStatus === 'implemented', 'UIFN_CATALOG_IMPLEMENTATION_STATUS_INVALID', `${primitive.name} release status must identify the implemented primitive.`, { primitive: primitive.name });
  assert(Array.isArray(primitive.exceptions), 'UIFN_CATALOG_FIELD_MISSING', `${primitive.name} exceptions must be an array.`, { primitive: primitive.name });
}

export function validateCatalogSource(source = CATALOG_SOURCE) {
  assert(source?.schemaVersion === CATALOG_SCHEMA_VERSION, 'UIFN_CATALOG_SCHEMA_INVALID', 'Catalog schema version is unsupported.', { actual: source?.schemaVersion });
  assert(source?.catalogVersion === CATALOG_VERSION && source?.generatorVersion === GENERATOR_VERSION, 'UIFN_CATALOG_SCHEMA_INVALID', 'Catalog or generator version is unsupported.');
  assert(source?.sourcePolicy === 'clean-room-original-definition', 'UIFN_CATALOG_UNSUPPORTED_VALUE', 'Catalog source policy must be clean-room original definition.');
  assertExactArray(source?.frameworks, STABLE_FRAMEWORKS, 'catalog frameworks', 'catalog');
  assert(source?.implementationStatusPolicy?.allowedCurrentStatus === 'implemented' && source?.implementationStatusPolicy?.generatedMetadataIsImplementationEvidence === true, 'UIFN_CATALOG_IMPLEMENTATION_STATUS_INVALID', 'The current catalog must describe the implemented stable package graph.');
  assert(Array.isArray(source?.primitives), 'UIFN_CATALOG_FIELD_MISSING', 'Catalog primitives must be an array.');
  assert(source.primitives.length === EXPECTED_PRIMITIVE_NAMES.length && EXPECTED_PRIMITIVE_NAMES.length === 69, 'UIFN_CATALOG_NAME_SET_INVALID', 'Catalog must contain exactly 69 canonical primitives.', { actual: source.primitives.length });
  assertUnique(source.primitives.map((primitive) => primitive.id), 'primitive id', 'catalog');
  assertUnique(source.primitives.map((primitive) => primitive.name), 'primitive name', 'catalog');
  assertUnique(source.primitives.map((primitive) => primitive.canonicalOrder), 'canonical order', 'catalog');
  source.primitives.forEach(validatePrimitive);
  return { ok: true, primitiveCount: source.primitives.length };
}

const SWIFTUI_ENTRY_FIELDS = new Set(['status', 'controls', 'surfaces', 'note']);
const SWIFTUI_SURFACE_FIELDS = new Set(['id', 'kind', 'issue', 'source']);
const SWIFTUI_NON_SURFACE_FIELDS = new Set(['id', 'source', 'reason']);
const SWIFTUI_CONTROL_PATTERN = /^\.?[A-Za-z][A-Za-z0-9]*$/;
// A Swift name, qualified for a nested type (UIFnTimeline.Row): every id the
// declaration scan reports can be listed.
const SWIFTUI_SURFACE_ID_PATTERN = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const SWIFTUI_SURFACE_DIRECTORIES = ['Styles', 'Components'];
const SWIFTUI_SOURCE_PATTERN = new RegExp(String.raw`^${SWIFTUI_SOURCES_ROOT}/(?:${SWIFTUI_SURFACE_DIRECTORIES.join('|')})/(?:[A-Za-z0-9+]+/)*[A-Za-z0-9+]+\.swift$`);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateSwiftUINames(entry, field, primitive, pattern) {
  const values = entry[field];
  assert(Array.isArray(values), 'UIFN_CATALOG_FIELD_MISSING', `${primitive} swiftui.${field} must be an array.`, { primitive, field: `swiftui.${field}` });
  for (const value of values) {
    assert(typeof value === 'string' && pattern.test(value), 'UIFN_CATALOG_UNSUPPORTED_VALUE', `${primitive} has an invalid swiftui.${field} entry.`, { primitive, field: `swiftui.${field}`, value });
  }
  assertUnique(values, `swiftui.${field}`, primitive);
}

function validateSwiftUIListEntry(entry, fields, label, byId) {
  assert(isPlainObject(entry) && typeof entry.id === 'string' && SWIFTUI_SURFACE_ID_PATTERN.test(entry.id), 'UIFN_CATALOG_UNSUPPORTED_VALUE', `A SwiftUI ${label} has an invalid id.`, { value: entry?.id });
  assert(!byId.has(entry.id), 'UIFN_CATALOG_DUPLICATE', `Duplicate SwiftUI ${label}: ${entry.id}`, { value: entry.id });
  const extra = Object.keys(entry).filter((field) => !fields.has(field));
  assert(extra.length === 0, 'UIFN_CATALOG_UNSUPPORTED_VALUE', `SwiftUI ${label} ${entry.id} has unknown fields.`, { id: entry.id, fields: extra });
  assert(typeof entry.source === 'string' && SWIFTUI_SOURCE_PATTERN.test(entry.source), 'UIFN_CATALOG_UNSUPPORTED_VALUE', `SwiftUI ${label} ${entry.id} has an invalid source path.`, { id: entry.id, value: entry.source });
  byId.set(entry.id, entry);
}

function validateSwiftUISurfaces(surfaces) {
  assert(Array.isArray(surfaces) && surfaces.length > 0, 'UIFN_CATALOG_FIELD_MISSING', 'SwiftUI status needs the UIFnSwiftUI style and component list.', { field: 'surfaces' });
  const byId = new Map();
  for (const surface of surfaces) {
    validateSwiftUIListEntry(surface, SWIFTUI_SURFACE_FIELDS, 'surface', byId);
    assert(SWIFTUI_SURFACE_KINDS.includes(surface.kind), 'UIFN_CATALOG_UNSUPPORTED_VALUE', `SwiftUI surface ${surface.id} has an unknown kind.`, { surface: surface.id, value: surface.kind });
    assert(typeof surface.issue === 'string' && /^UIF-\d+$/.test(surface.issue), 'UIFN_CATALOG_UNSUPPORTED_VALUE', `SwiftUI surface ${surface.id} has an invalid issue.`, { surface: surface.id, value: surface.issue });
  }
  return byId;
}

function validateSwiftUINonSurfaces(nonSurfaces, surfaces) {
  assert(Array.isArray(nonSurfaces), 'UIFN_CATALOG_FIELD_MISSING', 'SwiftUI status needs the UIFnSwiftUI non-surface list.', { field: 'nonSurfaces' });
  const byId = new Map(surfaces);
  for (const entry of nonSurfaces) {
    validateSwiftUIListEntry(entry, SWIFTUI_NON_SURFACE_FIELDS, 'non-surface', byId);
    assert(typeof entry.reason === 'string' && entry.reason.trim().length > 0, 'UIFN_CATALOG_FIELD_MISSING', `SwiftUI non-surface ${entry.id} needs a reason.`, { id: entry.id, field: 'reason' });
  }
}

function validateSwiftUIEntry(primitive, entry, surfaces) {
  assert(isPlainObject(entry), 'UIFN_CATALOG_FIELD_MISSING', `${primitive} is missing its SwiftUI status.`, { primitive, field: 'swiftui' });
  for (const field of SWIFTUI_ENTRY_FIELDS) {
    assert(Object.hasOwn(entry, field) && entry[field] !== undefined && entry[field] !== null, 'UIFN_CATALOG_FIELD_MISSING', `${primitive} is missing swiftui.${field}.`, { primitive, field: `swiftui.${field}` });
  }
  const extra = Object.keys(entry).filter((field) => !SWIFTUI_ENTRY_FIELDS.has(field));
  assert(extra.length === 0, 'UIFN_CATALOG_UNSUPPORTED_VALUE', `${primitive} has unknown swiftui fields.`, { primitive, fields: extra });
  assert(SWIFTUI_STATUSES.includes(entry.status), 'UIFN_CATALOG_UNSUPPORTED_VALUE', `${primitive} has an unknown SwiftUI status.`, { primitive, field: 'swiftui.status', value: entry.status, allowed: SWIFTUI_STATUSES });
  validateSwiftUINames(entry, 'controls', primitive, SWIFTUI_CONTROL_PATTERN);
  validateSwiftUINames(entry, 'surfaces', primitive, SWIFTUI_SURFACE_ID_PATTERN);
  for (const id of entry.surfaces) {
    assert(surfaces.has(id), 'UIFN_CATALOG_UNSUPPORTED_VALUE', `${primitive} names an unknown SwiftUI surface.`, { primitive, field: 'swiftui.surfaces', value: id });
  }
  assert(typeof entry.note === 'string' && entry.note.trim().length > 0, 'UIFN_CATALOG_FIELD_MISSING', `${primitive} needs a SwiftUI note.`, { primitive, field: 'swiftui.note' });

  const kinds = new Set(entry.surfaces.map((id) => surfaces.get(id).kind));
  const consistent = {
    native: entry.controls.length > 0 && !kinds.has('style'),
    'uifn-style': entry.controls.length > 0 && kinds.has('style'),
    'uifn-component': kinds.has('component'),
    none: entry.controls.length === 0 && entry.surfaces.length === 0,
  }[entry.status];
  assert(consistent, 'UIFN_CATALOG_SWIFTUI_STATUS_INCONSISTENT', `${primitive} SwiftUI status ${entry.status} does not match its controls and surfaces.`, { primitive, status: entry.status, controls: entry.controls, surfaces: entry.surfaces });
}

export function validateSwiftUIStatus(source = SWIFTUI_STATUS_SOURCE) {
  assert(isPlainObject(source) && source.schemaVersion === SWIFTUI_STATUS_SCHEMA_VERSION, 'UIFN_CATALOG_SCHEMA_INVALID', 'SwiftUI status schema version is unsupported.', { actual: source?.schemaVersion });
  assertExactArray(source.statuses, SWIFTUI_STATUSES, 'SwiftUI statuses', 'swiftui');
  const surfaces = validateSwiftUISurfaces(source.surfaces);
  validateSwiftUINonSurfaces(source.nonSurfaces, surfaces);
  assert(isPlainObject(source.primitives), 'UIFN_CATALOG_FIELD_MISSING', 'SwiftUI status needs an entry per primitive.', { field: 'primitives' });
  const unknown = Object.keys(source.primitives).filter((name) => !EXPECTED_PRIMITIVE_NAMES.includes(name));
  assert(unknown.length === 0, 'UIFN_CATALOG_NAME_SET_INVALID', 'SwiftUI status names primitives outside the catalog.', { unknown });
  const referenced = new Set();
  for (const name of EXPECTED_PRIMITIVE_NAMES) {
    validateSwiftUIEntry(name, Object.hasOwn(source.primitives, name) ? source.primitives[name] : undefined, surfaces);
    for (const id of source.primitives[name].surfaces) referenced.add(id);
  }
  const unmapped = [...surfaces.keys()].filter((id) => !referenced.has(id));
  assert(unmapped.length === 0, 'UIFN_CATALOG_SWIFTUI_SURFACE_UNMAPPED', 'Every UIFnSwiftUI style and component must map to at least one primitive.', { unmapped });
  return { ok: true, primitiveCount: EXPECTED_PRIMITIVE_NAMES.length, surfaceCount: surfaces.size };
}

// The UIFnSwiftUI declarations the verify script checks the SwiftUI surface
// and non-surface lists against. Every .swift file under Styles and
// Components, at any depth, is read as the compiler sees it: comments and
// string literals are blanked first, so a commented-out type does not count.
// A scope walk then finds
// - each public struct, class or actor at any nesting depth, by its qualified
//   name (UIFnTimeline.Row). A member of a public extension is public unless
//   it says otherwise, and a type nested in a non-public type is not public;
// - each public func or var in an extension of View (a view modifier).
// The kind follows the declaration, not the directory. A conformance to a
// SwiftUI style protocol (`...Style`) makes a style. View, ViewModifier,
// Shape, InsettableShape, the view and view controller representables, or a
// protocol declared in these sources that refines one of them, makes a
// component, as does a View-extension member in Components. Conformances
// added by an extension in any scanned file count. An enum counts only as a
// style or component; a protocol is never listed, it only passes its
// refinement on to the types that conform to it. Any other public struct, class or actor, and
// any View-extension member in Styles, is unclassified and has to be listed
// as a non-surface, so the scan fails closed.
const SWIFT_STYLE_PROTOCOL = /^[A-Z]\w*Style$/;
const SWIFT_COMPONENT_PROTOCOLS = new Set(['View', 'ViewModifier', 'Shape', 'InsettableShape', 'ShapeView', 'DynamicViewContent', 'GeometryEffect', 'AnimatableModifier', 'EnvironmentalModifier', 'UIViewRepresentable', 'NSViewRepresentable', 'UIViewControllerRepresentable', 'NSViewControllerRepresentable']);
const SWIFT_TYPE_KEYWORDS = new Set(['struct', 'class', 'actor', 'enum', 'protocol', 'extension']);
const SWIFT_SURFACE_TYPE_KEYWORDS = new Set(['struct', 'class', 'actor']);
const SWIFT_MEMBER_KEYWORDS = new Set(['func', 'var', 'let', 'case', 'typealias', 'associatedtype', 'init', 'subscript']);
const SWIFT_ACCESS_MODIFIERS = new Set(['open', 'public', 'package', 'internal', 'fileprivate', 'private']);
const SWIFT_MODIFIER_WORDS = new Set([...SWIFT_ACCESS_MODIFIERS, 'class', 'static', 'final', 'override', 'nonisolated', 'mutating', 'nonmutating', 'convenience', 'required', 'dynamic', 'lazy', 'weak', 'unowned', 'indirect', 'optional', 'distributed', 'prefix', 'postfix', 'infix']);
const SWIFT_DECLARATION_WORDS = new Set([...SWIFT_MEMBER_KEYWORDS, ...SWIFT_MODIFIER_WORDS]);
const SWIFT_IMPORT_KINDS = new Set(['struct', 'class', 'enum', 'protocol', 'typealias', 'func', 'var', 'let']);
// Identifiers may use any letter, so a non-ASCII name is read, not skipped.
const SWIFT_TOKEN = /`[^`\n]+`|[\p{L}_][\p{L}\p{M}\p{N}_]*|#\w+|->|\d[\w.]*|[^\s\p{L}\p{M}\p{N}_]/gu;
const SWIFT_IDENTIFIER = /^[\p{L}_][\p{L}\p{M}\p{N}_]*$/u;
const SWIFT_NAMED_KEYWORDS = new Set(['struct', 'class', 'enum', 'protocol', 'extension']);
const SWIFT_STRING_START = /#*"/y;

// Swift's lexical forms that hold arbitrary text: comments, string literals
// (multi-line, raw and interpolated ones too) and regex literals. A bare
// `/.../` counts as a regex only where an operand is expected, as in Swift.
const SWIFT_REGEX_START = /#+\/|\/(?![\s/*])/y;
const SWIFT_OPERAND_BEFORE = new Set(['', '=', '(', '[', '{', ',', ':', ';', '!', '&', '|', '?', '^', '~', '<', '>', '+', '-', '*', '%']);

function blankSwift(context, from, to) {
  for (let index = from; index < to; index += 1) if (context.out[index] !== '\n') context.out[index] = ' ';
}

function swiftCommentEnd(text, start) {
  if (text.startsWith('//', start)) return text.includes('\n', start) ? text.indexOf('\n', start) : text.length;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text.startsWith('/*', index)) depth += 1;
    else if (text.startsWith('*/', index)) depth -= 1;
    else continue;
    index += 1;
    if (depth === 0) return index + 1;
  }
  return text.length;
}

function swiftStringEnd(context, start) {
  const { text } = context;
  let index = start;
  while (text[index] === '#') index += 1;
  const hashes = text.slice(start, index);
  const multiline = text.startsWith('"""', index);
  const close = `${multiline ? '"""' : '"'}${hashes}`;
  const escape = `\\${hashes}`;
  index += multiline ? 3 : 1;
  while (index < text.length && (multiline || text[index] !== '\n')) {
    if (text.startsWith(close, index)) return index + close.length;
    if (!text.startsWith(escape, index)) index += 1;
    else if (text[index + escape.length] === '(') index = swiftCodeEnd(context, index + escape.length + 1, true);
    else index += escape.length + 1;
  }
  return index;
}

function swiftRegexEnd(context, start) {
  const { text } = context;
  let index = start;
  while (text[index] === '#') index += 1;
  const close = `/${text.slice(start, index)}`;
  const bare = close === '/';
  if (bare) {
    // The code before it, with comments already blanked.
    const before = context.out.slice(0, start).join('').trimEnd();
    if (!SWIFT_OPERAND_BEFORE.has(before.at(-1) ?? '') && !/\b(?:return|in|throw|try|await|case|where|if|guard|while)$/.test(before)) return 0;
  }
  for (index += 1; index < text.length && !(bare && text[index] === '\n'); index += 1) {
    if (text.startsWith(close, index)) return index + close.length;
    if (text[index] === '\\') index += 1;
  }
  return bare ? 0 : text.length;
}

function swiftLiteralEnd(context, index) {
  const { text } = context;
  if (text.startsWith('//', index) || text.startsWith('/*', index)) return swiftCommentEnd(text, index);
  SWIFT_STRING_START.lastIndex = index;
  if (SWIFT_STRING_START.test(text)) return swiftStringEnd(context, index);
  SWIFT_REGEX_START.lastIndex = index;
  return SWIFT_REGEX_START.test(text) ? swiftRegexEnd(context, index) : 0;
}

// Scans code from `start`; in a string interpolation, stops after its `)`.
function swiftCodeEnd(context, start, interpolation) {
  let depth = 0;
  for (let index = start; index < context.text.length;) {
    const end = swiftLiteralEnd(context, index);
    if (end) {
      blankSwift(context, index, end);
      index = end;
      continue;
    }
    const char = context.text[index];
    if (interpolation && char === ')' && depth === 0) return index + 1;
    if (interpolation) depth += { '(': 1, ')': -1 }[char] ?? 0;
    index += 1;
  }
  return context.text.length;
}

// The text with comments and string and regex literals replaced by spaces;
// line breaks are kept.
function swiftCodeOnly(text) {
  const context = { text, out: text.split('') };
  swiftCodeEnd(context, 0, false);
  return context.out.join('');
}

function skipBalanced(tokens, index, open, close) {
  let depth = 0;
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor] === open) depth += 1;
    if (tokens[cursor] === close) depth -= 1;
    if (depth === 0) return cursor + 1;
  }
  return tokens.length + 1;
}

function swiftTypeName(value) {
  return value.replace(/^SwiftUI(?:Core)?\./, '');
}

// `where Self: View` refines a protocol as `: View` does.
function readSwiftSelfConstraints(tokens, start) {
  const constraints = [];
  for (let index = start; index < tokens.length && tokens[index] !== '{'; index += 1) {
    if (tokens[index] !== 'Self' || tokens[index + 1] !== ':') continue;
    let name = '';
    for (index += 2; SWIFT_IDENTIFIER.test(tokens[index] ?? '') || ['.', '&'].includes(tokens[index]); index += 1) {
      if (tokens[index] !== '&') name += tokens[index];
      else {
        constraints.push(name);
        name = '';
      }
    }
    constraints.push(name);
    index -= 1;
  }
  return constraints;
}

// Reads `Name<...>: A, B & C<...> where ... {` from the name on, and returns
// the name, its conformances and the index after `{`.
function readSwiftTypeHeader(tokens, index) {
  let cursor = index + 1;
  while (tokens[cursor] === '.' && SWIFT_IDENTIFIER.test(tokens[cursor + 1] ?? '')) cursor += 2;
  const name = swiftTypeName(tokens.slice(index, cursor).join(''));
  if (tokens[cursor] === '<') cursor = skipBalanced(tokens, cursor, '<', '>');
  const conformances = [];
  let current = '';
  let depth = 0;
  for (cursor += tokens[cursor] === ':' ? 1 : 0; cursor < tokens.length && tokens[cursor] !== '{'; cursor += 1) {
    const token = tokens[cursor];
    if (token === '<' || token === '>') depth += token === '<' ? 1 : -1;
    else if (depth > 0) continue;
    else if (token === 'where') break;
    else if (token === '@') cursor += 1;
    else if (token === ',' || token === '&') {
      conformances.push(current);
      current = '';
    } else current += token;
  }
  conformances.push(current, ...readSwiftSelfConstraints(tokens, cursor));
  while (cursor < tokens.length && tokens[cursor] !== '{') cursor += 1;
  return { name, conformances: conformances.filter(Boolean).map(swiftTypeName), next: cursor + 1 };
}

function isSwiftPublic(modifiers, scope) {
  const access = modifiers.find((value) => SWIFT_ACCESS_MODIFIERS.has(value));
  if (access) return access === 'public' || access === 'open';
  return scope?.kind === 'extension' && scope.membersPublic;
}

function readSwiftTypeDeclaration(state, index) {
  const { tokens, scopes, model, source } = state;
  const keyword = tokens[index];
  const scope = scopes.at(-1);
  const header = readSwiftTypeHeader(tokens, index + 1);
  if (keyword === 'extension') {
    model.extensions.set(header.name, [...(model.extensions.get(header.name) ?? []), ...header.conformances]);
    scopes.push({ kind: 'extension', name: header.name, isPublic: true, membersPublic: state.modifiers.includes('public') || state.modifiers.includes('open') });
    return header.next;
  }
  const id = [...scopes.map((entry) => entry.name), header.name].join('.');
  const isPublic = isSwiftPublic(state.modifiers, scope) && scopes.every((entry) => entry.isPublic);
  if (keyword === 'protocol') {
    // #if alternatives add up; a nested protocol keeps its qualified name.
    model.protocols.set(id, [...(model.protocols.get(id) ?? []), ...header.conformances]);
  } else if (isPublic) model.found.push({ id, keyword, source, conformances: header.conformances });
  else model.hidden.add(id);
  if (isPublic) model.visible.add(id);
  scopes.push({ kind: 'type', name: header.name, isPublic });
  return header.next;
}

function readSwiftMember(state, index) {
  const { tokens, scopes, model, source } = state;
  const scope = scopes.at(-1);
  const name = (tokens[index + 1] ?? '').replaceAll('`', '');
  if (['func', 'var'].includes(tokens[index]) && scope?.kind === 'extension' && scope.name === 'View' && SWIFT_IDENTIFIER.test(name) && isSwiftPublic(state.modifiers, scope)) {
    model.found.push({ id: name, keyword: tokens[index], source, member: true });
  }
  if (!['func', 'init', 'subscript'].includes(tokens[index])) return index + 2;
  // Skips the name (an operator's too), generic clause and parameter list, so
  // a parameter label such as `class` is not read as a declaration.
  let cursor = tokens[index] === 'func' ? index + 2 : index + 1;
  while (!SWIFT_IDENTIFIER.test(name) && tokens[index] === 'func' && cursor < tokens.length && tokens[cursor] !== '(') cursor += 1;
  while (['?', '!'].includes(tokens[cursor])) cursor += 1;
  if (tokens[cursor] === '<') cursor = skipBalanced(tokens, cursor, '<', '>');
  return tokens[cursor] === '(' ? skipBalanced(tokens, cursor, '(', ')') : cursor;
}

function stepSwiftBrace(state, index) {
  const { scopes, source } = state;
  assert(state.tokens[index] === '{' || scopes.length > 0, 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT', `Cannot read the declarations in ${source}: a } has no {.`, { source });
  if (state.tokens[index] === '{') scopes.push({ kind: 'body' });
  else scopes.pop();
  state.modifiers = [];
  return index + 1;
}

// Skips text that qualifies no declaration: `import struct Foundation.URL`,
// a member name such as `.private` in a default value, an attribute, and the
// `(set)` of `private(set)`. Returns undefined for any other token.
function skipSwiftNonDeclaration(state, index) {
  const { tokens } = state;
  const token = tokens[index];
  const next = tokens[index + 1] ?? '';
  if (token === '@') return next && tokens[index + 2] === '(' ? skipBalanced(tokens, index + 2, '(', ')') : index + 2;
  if (SWIFT_ACCESS_MODIFIERS.has(token) && next === '(') return skipBalanced(tokens, index + 1, '(', ')');
  if (token !== '.' && token !== 'import') return undefined;
  state.modifiers = [];
  if (token === '.') return SWIFT_IDENTIFIER.test(next) ? index + 2 : index + 1;
  let end = SWIFT_IMPORT_KINDS.has(next) ? index + 2 : index + 1;
  while (tokens[end + 1] === '.') end += 2;
  return end + 1;
}

// Reads one token in a type or extension body (or at file level); skips
// function and property bodies. Modifiers gather up to the declaration they
// qualify.
function stepSwiftDeclarations(state, index) {
  const { tokens, scopes } = state;
  const token = tokens[index];
  const next = tokens[index + 1] ?? '';
  if (token === '{' || token === '}') return stepSwiftBrace(state, index);
  if (scopes.at(-1)?.kind === 'body') return index + 1;
  const skipped = skipSwiftNonDeclaration(state, index);
  if (skipped !== undefined) return skipped;
  // No declaration starts inside parentheses: argument and tuple labels
  // such as `class:` in a call, an enum case's values or a function type.
  if (token === '(') {
    const end = skipBalanced(tokens, index, '(', ')');
    assert(end <= tokens.length, 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT', `Cannot read the declarations in ${state.source}: a ( is not closed.`, { source: state.source });
    state.modifiers = [];
    return end;
  }
  // A name the scan cannot read (`Raw Name`, an emoji) fails closed.
  assert(!SWIFT_NAMED_KEYWORDS.has(token) || SWIFT_IDENTIFIER.test(next), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT', `Cannot read the name after ${token} in ${state.source}: ${next}`, { source: state.source, name: next });
  // Only `class` and `actor` can also open a member (`class func`); after the
  // other keywords any name, `dynamic` too, is the type's.
  const isTypeKeyword = SWIFT_TYPE_KEYWORDS.has(token) && SWIFT_IDENTIFIER.test(next) && !(['class', 'actor'].includes(token) && SWIFT_DECLARATION_WORDS.has(next));
  if (isTypeKeyword || SWIFT_MEMBER_KEYWORDS.has(token)) {
    const end = isTypeKeyword ? readSwiftTypeDeclaration(state, index) : readSwiftMember(state, index);
    state.modifiers = [];
    return end;
  }
  if (SWIFT_MODIFIER_WORDS.has(token)) state.modifiers.push(token);
  else state.modifiers = [];
  return index + 1;
}

function walkSwiftDeclarations(text, source, model) {
  // A backticked keyword (`class`) stays a name, never a keyword.
  const unquote = (token) => (SWIFT_DECLARATION_WORDS.has(token.slice(1, -1)) || SWIFT_TYPE_KEYWORDS.has(token.slice(1, -1)) ? token : token.replaceAll('`', ''));
  const tokens = (swiftCodeOnly(text).match(SWIFT_TOKEN) ?? []).map(unquote);
  const state = { tokens, scopes: [], model, source, modifiers: [] };
  let index = 0;
  while (index < tokens.length) index = stepSwiftDeclarations(state, index);
  // Text the scan cannot model (an unclosed scope or group) fails closed.
  assert(state.scopes.length === 0 && index === tokens.length, 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT', `Cannot read the declarations in ${source}: a { or ( is not closed.`, { source });
}

function swiftOuter(id) {
  return id.split('.').slice(0, -1).join('.');
}

// A protocol name resolves as Swift looks it up: in the enclosing scopes
// first, innermost out, then at file level.
function resolveSwiftProtocol(value, outer, protocols) {
  const parts = outer ? outer.split('.') : [];
  for (let size = parts.length; size >= 0; size -= 1) {
    const key = [...parts.slice(0, size), value].join('.');
    if (protocols.has(key)) return key;
  }
  return undefined;
}

function swiftSurfaceKind(conformances, protocols, outer = '', seen = new Set()) {
  if (conformances.some((value) => SWIFT_STYLE_PROTOCOL.test(value))) return 'style';
  if (conformances.some((value) => SWIFT_COMPONENT_PROTOCOLS.has(value))) return 'component';
  const refined = conformances.map((value) => resolveSwiftProtocol(value, outer, protocols)).filter((key) => key && !seen.has(key));
  for (const key of refined) seen.add(key);
  return refined.map((key) => swiftSurfaceKind(protocols.get(key), protocols, swiftOuter(key), seen)).find(Boolean);
}

function swiftSurfaceDirectory(relativePath) {
  return SWIFTUI_SURFACE_DIRECTORIES.find((name) => relativePath.startsWith(`${SWIFTUI_SOURCES_ROOT}/${name}/`));
}

// `files` is a list of { path, text }, path relative to the repository root.
// Returns every public declaration in scan order as { id, kind, source }, kind
// 'style', 'component' or 'unclassified'. An id repeats when it is declared
// more than once, as #if alternatives or overloads are.
export function parseSwiftUISurfaceDeclarations(files) {
  const model = { found: [], extensions: new Map(), protocols: new Map(), hidden: new Set(), visible: new Set() };
  for (const { path: relativePath, text } of files) {
    if (swiftSurfaceDirectory(relativePath)) walkSwiftDeclarations(text, relativePath, model);
  }
  // A type nested, through an extension too, in a type that no #if
  // alternative declares public is not public.
  const isHidden = (outer) => model.hidden.has(outer) && !model.visible.has(outer);
  const hidden = (id) => id.split('.').slice(0, -1).some((_, index, outer) => isHidden(outer.slice(0, index + 1).join('.')));
  const declarations = model.found.filter(({ id }) => !hidden(id)).flatMap(({ id, keyword, source, conformances, member }) => {
    if (member) return [{ id, kind: swiftSurfaceDirectory(source) === 'Components' ? 'component' : 'unclassified', source }];
    const kind = swiftSurfaceKind([...conformances, ...(model.extensions.get(id) ?? [])], model.protocols, swiftOuter(id));
    if (kind) return [{ id, kind, source }];
    return SWIFT_SURFACE_TYPE_KEYWORDS.has(keyword) ? [{ id, kind: 'unclassified', source }] : [];
  });
  for (const { id, source } of declarations) {
    assert(SWIFTUI_SURFACE_ID_PATTERN.test(id), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT', `UIFnSwiftUI declares ${id} in ${source}, a name the SwiftUI status lists cannot hold. Give public UIFnSwiftUI types and modifiers ASCII names.`, { id, source });
    assert(SWIFTUI_SOURCE_PATTERN.test(source), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT', `UIFnSwiftUI declares ${id} in ${source}, a path the SwiftUI status lists cannot hold. Use letters, digits and + in its directory and file names.`, { id, source });
  }
  return declarations;
}

async function listSwiftFiles(repoRoot, relativeDirectory) {
  const entries = await readdir(path.join(repoRoot, relativeDirectory), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const nested = await Promise.all(entries.map((entry) => {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) return listSwiftFiles(repoRoot, relativePath);
    return entry.isFile() && entry.name.endsWith('.swift') ? [relativePath] : [];
  }));
  return nested.flat();
}

export async function readSwiftUISurfaceDeclarations(repoRoot) {
  const paths = await Promise.all(SWIFTUI_SURFACE_DIRECTORIES.map(async (directory) => {
    const relativeDirectory = `${SWIFTUI_SOURCES_ROOT}/${directory}`;
    try {
      return await listSwiftFiles(repoRoot, relativeDirectory);
    } catch (error) {
      if (error.code === 'ENOENT') fail('UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT', `UIFnSwiftUI source directory is missing: ${relativeDirectory}`, { directory: relativeDirectory });
      throw error;
    }
  }));
  const files = await Promise.all(paths.flat().map(async (relativePath) => ({ path: relativePath, text: await readFile(path.join(repoRoot, relativePath), 'utf8') })));
  return parseSwiftUISurfaceDeclarations(files);
}

// Repeats of one id with the same kind and source (#if alternatives,
// overloads) are one declaration; a repeat with another kind or source is drift.
function coalesceSwiftUIDeclarations(declarations) {
  const declared = new Map();
  for (const declaration of declarations) {
    const earlier = declared.get(declaration.id);
    assert(!earlier || (earlier.kind === declaration.kind && earlier.source === declaration.source), 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT', `UIFnSwiftUI declares ${declaration.id} more than once, with a different kind or source. Keep the #if alternatives and overloads of one declaration in one file, with one kind.`, { id: declaration.id, declarations: [earlier, declaration] });
    declared.set(declaration.id, { id: declaration.id, kind: declaration.kind, source: declaration.source });
  }
  return declared;
}

export function verifySwiftUISurfaceDeclarations(declarations, source = SWIFTUI_STATUS_SOURCE) {
  const declared = coalesceSwiftUIDeclarations(declarations);
  const listed = new Map([
    ...source.surfaces.map((surface) => [surface.id, { kind: surface.kind, source: surface.source }]),
    ...source.nonSurfaces.map((entry) => [entry.id, { kind: 'unclassified', source: entry.source }]),
  ]);
  const notListed = [...declared.values()].filter((declaration) => !listed.has(declaration.id));
  const unlisted = notListed.filter((declaration) => declaration.kind !== 'unclassified').map((declaration) => declaration.id);
  const unclassified = notListed.filter((declaration) => declaration.kind === 'unclassified').map((declaration) => declaration.id);
  const undeclared = [...listed.keys()].filter((id) => !declared.has(id));
  const moved = [...listed]
    .filter(([id, entry]) => declared.has(id) && (declared.get(id).source !== entry.source || declared.get(id).kind !== entry.kind))
    .map(([id, entry]) => ({ id, listed: entry, declared: { kind: declared.get(id).kind, source: declared.get(id).source } }));
  assert(unlisted.length === 0 && unclassified.length === 0 && undeclared.length === 0 && moved.length === 0, 'UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT', 'The SwiftUI status lists differ from the UIFnSwiftUI sources. List a public style, view or view modifier as a surface, and any other public type or Styles View-extension member as a non-surface.', { unlisted, unclassified, undeclared, moved });
  return { ok: true, surfaceCount: source.surfaces.length, nonSurfaceCount: source.nonSurfaces.length };
}

function swiftuiStatusOutput(catalog, source, metadata) {
  const byName = source.primitives;
  return {
    ...metadata,
    swiftuiStatusSchemaVersion: source.schemaVersion,
    statuses: [...source.statuses],
    statusCounts: Object.fromEntries(source.statuses.map((status) => [status, catalog.primitives.filter((primitive) => byName[primitive.name].status === status).length])),
    surfaces: source.surfaces.map(({ id, kind, issue, source: file }) => ({
      id,
      kind,
      issue,
      source: file,
      primitives: catalog.primitives.filter((primitive) => byName[primitive.name].surfaces.includes(id)).map((primitive) => primitive.id),
    })),
    primitives: catalog.primitives.map((primitive) => ({ id: primitive.id, name: primitive.name, swiftui: structuredClone(byName[primitive.name]) })),
  };
}

export function compileCatalog(source = CATALOG_SOURCE) {
  validateCatalogSource(source);
  const cloned = structuredClone(source);
  const sourceSha256 = sha256(stableStringify(cloned, 0));
  const withoutCatalogHash = {
    $schema: '../schema/catalog.schema.json',
    ...cloned,
    primitiveCount: cloned.primitives.length,
    sourceSha256,
  };
  const catalogSha256 = sha256(stableStringify(withoutCatalogHash, 0));
  return { ...withoutCatalogHash, catalogSha256 };
}

function definitionHeader() {
  return [
    '// Generated by @uifn/catalog. Do not hand edit.',
    '// Current stable catalog output. Runtime evidence is owned by the package and browser verification suites.',
    '',
  ].join('\n');
}

function primitiveContractsDts(catalog) {
  const names = catalog.primitives.map((primitive) => `'${primitive.name}'`).join(' | ');
  const ids = catalog.primitives.map((primitive) => `'${primitive.id}'`).join(' | ');
  return `${definitionHeader()}export type UifnPrimitiveName = ${names};\nexport type UifnPrimitiveId = ${ids};\nexport type UifnStableFramework = 'react' | 'svelte' | 'solid';\nexport type UifnImplementationStatus = 'implemented';\n\nexport interface UifnPrimitiveDefinitionStub {\n  readonly id: UifnPrimitiveId;\n  readonly name: UifnPrimitiveName;\n  readonly implementationStatus: UifnImplementationStatus;\n}\n`;
}

export function createGeneratedOutputs(source = CATALOG_SOURCE, swiftuiSource = SWIFTUI_STATUS_SOURCE) {
  const catalog = compileCatalog(source);
  validateSwiftUIStatus(swiftuiSource);
  const metadata = { schemaVersion: catalog.schemaVersion, catalogVersion: catalog.catalogVersion, generatorVersion: catalog.generatorVersion, sourceSha256: catalog.sourceSha256, catalogSha256: catalog.catalogSha256, implementationEvidence: true };
  const coreExports = catalog.primitives.flatMap((primitive) => primitive.outputs.core.map((symbol) => ({ primitiveId: primitive.id, primitiveName: primitive.name, symbol, kind: primitive.implementationKind, implementationStatus: 'implemented' })));
  const packageNames = ['@uifn/core', ...STABLE_FRAMEWORKS.flatMap((framework) => [FRAMEWORK_TARGETS[framework].headlessPackage, FRAMEWORK_TARGETS[framework].styledPackage])];
  const packageExports = packageNames.map((packageName) => ({
    packageName,
    implementationStatus: 'implemented',
    primitives: catalog.primitives.map((primitive) => ({ primitiveId: primitive.id, primitiveName: primitive.name, target: packageName === '@uifn/core' ? primitive.outputs.core : [primitive.name] })),
  }));
  const outputs = {
    'catalog.json': stableStringify(catalog),
    'core-exports.json': stableStringify({ ...metadata, exports: coreExports }),
    'package-exports.json': stableStringify({ ...metadata, packages: packageExports }),
    'anatomy-types.json': stableStringify({ ...metadata, primitives: catalog.primitives.map((primitive) => ({ id: primitive.id, name: primitive.name, anatomy: primitive.anatomy, inputs: primitive.inputs, events: primitive.events, states: primitive.states, controlledModel: primitive.controlledModel, formSemantics: primitive.formSemantics })) }),
    'primitive-contracts.d.ts': primitiveContractsDts(catalog),
    'adapter-coverage.json': stableStringify({ ...metadata, frameworks: STABLE_FRAMEWORKS, primitives: catalog.primitives.map((primitive) => ({ id: primitive.id, name: primitive.name, frameworks: primitive.frameworks })) }),
    'registry-metadata.json': stableStringify({ ...metadata, writePolicy: 'metadata-targets-only-no-registry-write', primitives: catalog.primitives.map((primitive) => ({ id: primitive.id, name: primitive.name, outputs: primitive.outputs, implementationStatus: primitive.release.implementationStatus })) }),
    'story-manifest.json': stableStringify({ ...metadata, manifestStatus: 'implemented', primitives: catalog.primitives.map((primitive) => ({ id: primitive.id, name: primitive.name, ...primitive.stories })) }),
    'swiftui-status.json': stableStringify(swiftuiStatusOutput(catalog, swiftuiSource, metadata)),
    'docs-manifest.json': stableStringify({ ...metadata, manifestStatus: 'implemented', primitives: catalog.primitives.map((primitive) => ({ id: primitive.id, name: primitive.name, ...primitive.docs })) }),
    'test-manifest.json': stableStringify({ ...metadata, primitiveCount: catalog.primitiveCount, vectors: ['TV-CAT-001-P', 'TV-CAT-001-N'], primitives: catalog.primitives.map((primitive) => ({ id: primitive.id, name: primitive.name, requirementIds: primitive.requirementIds, vectors: primitive.vectors })) }),
    'release-matrix.json': stableStringify({ ...metadata, releaseChannel: 'stable-1.0', allImplementationsImplemented: true, primitives: catalog.primitives.map((primitive) => ({ id: primitive.id, name: primitive.name, release: primitive.release, frameworkStatuses: Object.fromEntries(STABLE_FRAMEWORKS.map((framework) => [framework, primitive.frameworks[framework].implementationStatus])) })) }),
    'implementation-ownership.json': stableStringify({ ...metadata, domServices: DOM_SERVICE_IDS, primitives: catalog.primitives.map((primitive) => ({ id: primitive.id, name: primitive.name, requirements: primitive.requirementIds, domServices: primitive.domServices })) }),
  };
  assertExactArray(Object.keys(outputs).sort(), GENERATED_OUTPUT_NAMES, 'generated output names', 'compiler');
  const outputRecords = Object.entries(outputs).sort(([left], [right]) => left.localeCompare(right)).map(([outputPath, contents]) => ({ path: outputPath, sha256: sha256(contents), bytes: Buffer.byteLength(contents) }));
  const manifest = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    catalogVersion: CATALOG_VERSION,
    sourceSha256: catalog.sourceSha256,
    catalogSha256: catalog.catalogSha256,
    outputCount: outputRecords.length,
    outputs: outputRecords,
    deterministic: true,
    implementationEvidence: true,
  };
  outputs['generation-manifest.json'] = stableStringify(manifest);
  return { catalog, outputs, manifest };
}

export function compareGeneratedOutputs(left, right) {
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  if (leftNames.length !== rightNames.length || leftNames.some((name, index) => name !== rightNames[index])) {
    fail('UIFN_CATALOG_GENERATED_DRIFT', 'Generated output file sets differ.', { leftNames, rightNames });
  }
  for (const name of leftNames) {
    if (left[name] !== right[name]) fail('UIFN_CATALOG_GENERATED_DRIFT', `Generated output differs: ${name}`, { path: name, leftSha256: sha256(left[name]), rightSha256: sha256(right[name]) });
  }
  return { ok: true, outputCount: leftNames.length };
}

export async function writeGeneratedOutputs(directory, outputs) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  for (const [name, contents] of Object.entries(outputs).sort(([left], [right]) => left.localeCompare(right))) {
    await writeFile(path.join(directory, name), contents, 'utf8');
  }
}

async function readDirectoryOutputs(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const outputs = {};
  for (const entry of entries) {
    if (!entry.isFile()) fail('UIFN_CATALOG_GENERATED_DRIFT', `Unexpected generated directory entry: ${entry.name}`, { path: entry.name });
    outputs[entry.name] = await readFile(path.join(directory, entry.name), 'utf8');
  }
  return outputs;
}

export async function verifyGeneratedDirectory(directory, expectedOutputs) {
  let actual;
  try {
    actual = await readDirectoryOutputs(directory);
  } catch (error) {
    if (error.code === 'ENOENT') fail('UIFN_CATALOG_GENERATED_DRIFT', 'Generated catalog directory is missing.', { directory });
    throw error;
  }
  if (actual['core-exports.json']) {
    try {
      const parsed = JSON.parse(actual['core-exports.json']);
      const expected = JSON.parse(expectedOutputs['core-exports.json']);
      const expectedPrimitiveIds = new Set(expected.exports.map((entry) => entry.primitiveId));
      const expectedSymbols = new Set(expected.exports.map((entry) => `${entry.primitiveId}:${entry.symbol}`));
      const actualSymbols = new Set(parsed.exports?.map((entry) => `${entry.primitiveId}:${entry.symbol}`) ?? []);
      const undocumented = (parsed.exports ?? []).filter((entry) => !expectedPrimitiveIds.has(entry.primitiveId) || !expectedSymbols.has(`${entry.primitiveId}:${entry.symbol}`));
      const missing = [...expectedSymbols].filter((entry) => !actualSymbols.has(entry));
      if (undocumented.length || missing.length) fail('UIFN_CATALOG_EXPORT_DRIFT', 'Core exports contain undocumented or missing catalog exports.', { undocumented, missing });
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      fail('UIFN_CATALOG_EXPORT_DRIFT', 'Core exports are not valid catalog JSON.', { message: error.message });
    }
  }
  return compareGeneratedOutputs(actual, expectedOutputs);
}
