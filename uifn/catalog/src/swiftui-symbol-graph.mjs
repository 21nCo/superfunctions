// The public UIFnSwiftUI declarations the SwiftUI status lists are checked
// against, read from the Swift compiler's symbol graphs, not from the source
// text: the compiler has already resolved comments, #if branches, access,
// nesting and conformances, implied ones included. scripts/uifn-swiftui-
// inventory.mjs builds UIFnSwiftUI for macOS, iOS devices and the iOS
// simulator, each in debug and release, with SWIFTUI_SYMBOL_GRAPH_FLAGS:
// every access level and SPI, so underscored, @_spi and
// @_documentation(visibility: internal or private) declarations are in the
// graph, and the access filter below drops the non-public ones. It commits
// the result as
// uifn/catalog/swiftui-surface-inventory.json, which the verify script checks
// the lists against on any platform.
//
// A declaration is a symbol declared under Styles or Components, at any
// depth, that is public or open and nested only in public or open
// UIFnSwiftUI types, and that is
// - a struct, class or actor at any nesting depth, by its qualified name
//   (UIFnTimeline.Row);
// - an enum that is a style or a component;
// - a top-level function, variable or type alias;
// - a member of an extension of a UIFnSwiftUI protocol, by protocol and name
//   (UIFnPanelView.uifnGlow), a default implementation of one of its
//   requirements included (the graph links that to the requirement, not to
//   the protocol); or
// - a member of an extension of a type from another module: of View by its
//   name (uifnToast), of any other type by type and name (Text.uifnBold).
// A member of an extension constrained to Self == a UIFnSwiftUI type, such as
// ButtonStyle.uifnPrimary, belongs to that type and is not listed.
// A conformance to a SwiftUI protocol whose name ends in Style makes a style;
// one to View or ViewModifier, which a Shape, a view representable or a
// protocol refining View implies, makes a component, as does a member in
// Components of an extension of View or of a UIFnSwiftUI protocol refining
// it (a member of an extension of another SwiftUI protocol, such as Shape,
// is unclassified). Anything
// else is unclassified, so it has to be listed as a non-surface. Protocols,
// their requirements, the members of UIFnSwiftUI types and the copies of
// protocol-extension members the graph adds to each conforming type
// (::SYNTHESIZED::) are not declarations.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { CatalogError } from './compiler.mjs';
import { SWIFTUI_SOURCES_ROOT } from './swiftui-status.mjs';

export const SWIFTUI_MODULE = 'UIFnSwiftUI';

// The Xcode tools by absolute path, so that PATH cannot substitute them; run
// swift and swiftc through it. DEVELOPER_DIR still selects the Xcode.
export const XCRUN = '/usr/bin/xcrun';

// The swiftc flags, after -emit-symbol-graph-dir <directory>, that both the
// inventory script and the fixture generator emit graphs with. The minimum
// access level is private because @_documentation(visibility: private) hides
// a public declaration from every graph above it.
export const SWIFTUI_SYMBOL_GRAPH_FLAGS = ['-emit-symbol-graph', '-symbol-graph-minimum-access-level', 'private', '-include-spi-symbols'];

const VIEW = 's:7SwiftUI4ViewP';
const COMPONENT_PROTOCOLS = new Set([VIEW, 's:7SwiftUI12ViewModifierP']);
const STYLE_PROTOCOL = /^SwiftUI(?:Core)?\.\w+Style$/;
const TYPE_KINDS = new Set(['swift.struct', 'swift.class', 'swift.actor', 'swift.enum']);
const PARENT_RELATIONSHIPS = new Set(['memberOf', 'requirementOf', 'optionalRequirementOf']);

// Reads every symbol graph file of the module in a directory, the module's own
// graph and one per extended module (UIFnSwiftUI@SwiftUICore.symbols.json).
export async function readSwiftUISymbolGraphs(directory) {
  const names = (await readdir(directory)).filter((name) => name === `${SWIFTUI_MODULE}.symbols.json` || name.startsWith(`${SWIFTUI_MODULE}@`)).sort();
  if (!names.includes(`${SWIFTUI_MODULE}.symbols.json`)) {
    throw new CatalogError('UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT', `No ${SWIFTUI_MODULE}.symbols.json in ${directory}.`, { directory });
  }
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
}

function sourceOf(symbol) {
  if (!symbol.location?.uri) return undefined;
  const file = decodeURIComponent(new URL(symbol.location.uri).pathname);
  const at = file.lastIndexOf(`/${SWIFTUI_SOURCES_ROOT}/`);
  return at < 0 ? undefined : file.slice(at + 1);
}

function surfaceKind(conformances = []) {
  if (conformances.some((relationship) => STYLE_PROTOCOL.test(relationship.targetFallback ?? ''))) return 'style';
  if (conformances.some((relationship) => COMPONENT_PROTOCOLS.has(relationship.target))) return 'component';
  return undefined;
}

function symbolGraphIndex(graphs) {
  const ownGraphs = graphs.filter((graph) => graph.module?.name === SWIFTUI_MODULE);
  const symbols = new Map(ownGraphs.flatMap((graph) => graph.symbols).map((symbol) => [symbol.identifier.precise, symbol]));
  const parents = new Map();
  const conformances = new Map();
  const defaults = [];
  for (const relationship of ownGraphs.flatMap((graph) => graph.relationships ?? [])) {
    if (PARENT_RELATIONSHIPS.has(relationship.kind)) parents.set(relationship.source, relationship);
    if (relationship.kind === 'conformsTo') conformances.set(relationship.source, [...(conformances.get(relationship.source) ?? []), relationship]);
    if (relationship.kind === 'defaultImplementationOf') defaults.push(relationship);
  }
  // A default implementation of a UIFnSwiftUI protocol's requirement is a
  // member of that protocol's extension, though the graph links it only to
  // the requirement. (One of another module's requirement has a memberOf.)
  for (const { source, target } of defaults) {
    const owner = parents.get(target);
    if (!parents.has(source) && owner) parents.set(source, { kind: 'memberOf', source, target: owner.target });
  }
  return { symbols, parents, conformances };
}

// Public or open, and so is every UIFnSwiftUI type it is nested in.
function isEffectivelyPublic(index, precise) {
  const symbol = index.symbols.get(precise);
  if (!symbol) return true;
  if (!['public', 'open'].includes(symbol.accessLevel)) return false;
  const parent = index.parents.get(precise)?.target;
  return parent === undefined || isEffectivelyPublic(index, parent);
}

// The kind of a member of an extension, or undefined when it is not a
// declaration (a requirement, a member of a UIFnSwiftUI type, or Self ==
// sugar for one).
function memberKind(index, symbol, parent, directory) {
  const sugar = (symbol.swiftExtension?.constraints ?? []).some((constraint) => constraint.kind === 'sameType' && constraint.lhs === 'Self' && index.symbols.has(constraint.rhsPrecise));
  const parentSymbol = index.symbols.get(parent.target);
  if (parent.kind !== 'memberOf' || sugar) return undefined;
  if (parentSymbol && parentSymbol.kind.identifier !== 'swift.protocol') return undefined;
  const refinesView = parent.target === VIEW || (parentSymbol !== undefined && surfaceKind(index.conformances.get(parent.target)) === 'component');
  return refinesView && directory === 'Components' ? 'component' : 'unclassified';
}

function symbolDeclaration(index, precise, symbol, source, directory) {
  const kind = symbol.kind.identifier;
  const names = symbol.pathComponents;
  const last = names.at(-1);
  const name = last.includes('(') ? last.slice(0, last.indexOf('(')) : last;
  const qualified = [...names.slice(0, -1), name].join('.');
  if (TYPE_KINDS.has(kind)) {
    const surface = surfaceKind(index.conformances.get(precise));
    return surface || kind !== 'swift.enum' ? { id: names.join('.'), kind: surface ?? 'unclassified', source } : undefined;
  }
  if (kind === 'swift.protocol') return undefined;
  const parent = index.parents.get(precise);
  if (parent === undefined) return { id: qualified, kind: 'unclassified', source };
  const member = memberKind(index, symbol, parent, directory);
  if (member === undefined) return undefined;
  return { id: parent.target === VIEW ? name : qualified, kind: member, source };
}

// `graphs` are the symbol graphs of one build. Returns { id, kind, source }
// per declaration, kind 'style', 'component' or 'unclassified'; an id repeats
// for overloads.
export function swiftUIDeclarationsFromSymbolGraphs(graphs) {
  const index = symbolGraphIndex(graphs);
  const declarations = [];
  for (const [precise, symbol] of index.symbols) {
    const source = sourceOf(symbol);
    const directory = ['Styles', 'Components'].find((name) => source?.startsWith(`${SWIFTUI_SOURCES_ROOT}/${name}/`));
    if (!directory || precise.includes('::SYNTHESIZED::') || !isEffectivelyPublic(index, precise)) continue;
    const declaration = symbolDeclaration(index, precise, symbol, source, directory);
    if (declaration) declarations.push(declaration);
  }
  return declarations;
}

// The inventory builds: macOS, iOS devices and the iOS simulator, each in
// debug (DEBUG defined) and release, one bit each. The symbol graphs cannot
// show code in an #if clause no build compiles, so every #if, #elseif and
// #else clause in Styles and Components has to be compiled by at least one
// build, judged by evaluating its condition, nesting included, over these
// atoms. Any other atom (arch(), swift(), a custom flag, canImport of another
// module) fails, as does an unbalanced directive. The clauses come from the
// Swift parser (scripts/uifn-swiftui-if-clauses.swift), not from the text.
const SWIFT_BUILDS = { macOS: 0b000011, iOS: 0b111100, debug: 0b010101, simulator: 0b110000 };
const ALL_BUILDS = 0b111111;
const SWIFT_CONDITION_ATOMS = new Map([
  ['os(macOS)', SWIFT_BUILDS.macOS],
  ['os(iOS)', SWIFT_BUILDS.iOS],
  ['canImport(AppKit)', SWIFT_BUILDS.macOS],
  ['canImport(UIKit)', SWIFT_BUILDS.iOS],
  ['canImport(SwiftUI)', ALL_BUILDS],
  ['DEBUG', SWIFT_BUILDS.debug],
  ['targetEnvironment(simulator)', SWIFT_BUILDS.simulator],
]);
const SWIFT_CONDITION_TOKEN = /\s*(&&|\|\||!|\(|\)|[A-Za-z]+\([A-Za-z]+\)|[A-Za-z_]\w*)/y;

// Returns the builds a condition is true in, or undefined if it is not one
// the builds can decide.
function swiftConditionBuilds(text) {
  const condition = text.replace(/\s+/g, '');
  const tokens = [];
  SWIFT_CONDITION_TOKEN.lastIndex = 0;
  for (let match = SWIFT_CONDITION_TOKEN.exec(condition); match; match = SWIFT_CONDITION_TOKEN.exec(condition)) tokens.push(match[1]);
  if (tokens.join('') !== condition) return undefined;
  let index = 0;
  const unary = () => {
    const token = tokens[index++];
    if (token === '!') return ALL_BUILDS & ~unary();
    if (token === '(') {
      const inner = or();
      if (tokens[index++] !== ')') throw new Error('unbalanced');
      return inner;
    }
    if (SWIFT_CONDITION_ATOMS.has(token)) return SWIFT_CONDITION_ATOMS.get(token);
    throw new Error('unsupported');
  };
  const and = () => {
    let value = unary();
    while (tokens[index] === '&&') { index += 1; value &= unary(); }
    return value;
  };
  const or = () => {
    let value = and();
    while (tokens[index] === '||') { index += 1; value |= and(); }
    return value;
  };
  try {
    const value = or();
    return index === tokens.length ? value : undefined;
  } catch {
    return undefined;
  }
}

// `clauses` are one file's { line, directive, condition } in source order,
// directive '#if', '#elseif', '#else' or '#endif'. Returns
// { line, condition, reason } for each clause no inventory build compiles or
// whose condition the builds cannot decide.
export function uncoveredSwiftClauses(clauses) {
  const uncovered = [];
  const frames = [];
  let active = ALL_BUILDS;
  for (const { line, directive, condition = '' } of clauses) {
    const report = (reason) => uncovered.push({ line, condition: `${directive} ${condition}`.trim(), reason });
    if (directive === '#if') frames.push({ outer: active, taken: 0 });
    const frame = frames.at(-1);
    if (!frame) {
      report('unbalanced');
      continue;
    }
    if (directive === '#endif') {
      active = frames.pop().outer;
      continue;
    }
    let builds = directive === '#else' ? ALL_BUILDS : swiftConditionBuilds(condition);
    if (builds === undefined) {
      report('unsupported condition');
      builds = ALL_BUILDS;
    }
    active = frame.outer & builds & ~frame.taken;
    frame.taken |= frame.outer & builds;
    if (active === 0) report('no inventory build compiles this branch');
  }
  if (frames.length > 0) uncovered.push({ line: clauses.at(-1).line, condition: '#endif', reason: 'unbalanced' });
  return uncovered;
}
