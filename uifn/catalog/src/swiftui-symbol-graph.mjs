// The public UIFnSwiftUI declarations the SwiftUI status lists are checked
// against, read from the Swift compiler's symbol graphs, not from the source
// text: the compiler has already resolved comments, #if branches, access,
// nesting and conformances, implied ones included. scripts/uifn-swiftui-
// inventory.mjs builds UIFnSwiftUI for macOS, iOS devices and the iOS
// simulator, each in debug and release, with -emit-symbol-graph down to
// internal access and SPI included (so underscored, @_spi and
// @_documentation-hidden declarations are seen), and commits the result as
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
//   (UIFnPanelView.uifnGlow); or
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

// `graphs` are the symbol graphs of one build. Returns { id, kind, source }
// per declaration, kind 'style', 'component' or 'unclassified'; an id repeats
// for overloads.
export function swiftUIDeclarationsFromSymbolGraphs(graphs) {
  const ownGraphs = graphs.filter((graph) => graph.module?.name === SWIFTUI_MODULE);
  const symbols = new Map(ownGraphs.flatMap((graph) => graph.symbols).map((symbol) => [symbol.identifier.precise, symbol]));
  const parents = new Map();
  const conformances = new Map();
  for (const relationship of ownGraphs.flatMap((graph) => graph.relationships ?? [])) {
    if (PARENT_RELATIONSHIPS.has(relationship.kind)) parents.set(relationship.source, relationship);
    if (relationship.kind === 'conformsTo') conformances.set(relationship.source, [...(conformances.get(relationship.source) ?? []), relationship]);
  }
  // Public or open, and so is every UIFnSwiftUI type it is nested in.
  const isPublic = (precise) => {
    const symbol = symbols.get(precise);
    if (!symbol) return true;
    const parent = parents.get(precise)?.target;
    return ['public', 'open'].includes(symbol.accessLevel) && (parent === undefined || isPublic(parent));
  };
  const declarations = [];
  for (const [precise, symbol] of symbols) {
    const source = sourceOf(symbol);
    const directory = ['Styles', 'Components'].find((name) => source?.startsWith(`${SWIFTUI_SOURCES_ROOT}/${name}/`));
    if (!directory || precise.includes('::SYNTHESIZED::') || !isPublic(precise)) continue;
    const kind = symbol.kind.identifier;
    const names = symbol.pathComponents;
    const name = names.at(-1).replace(/\(.*$/s, '');
    const qualified = [...names.slice(0, -1), name].join('.');
    if (TYPE_KINDS.has(kind)) {
      const surface = surfaceKind(conformances.get(precise));
      if (surface || kind !== 'swift.enum') declarations.push({ id: names.join('.'), kind: surface ?? 'unclassified', source });
      continue;
    }
    if (kind === 'swift.protocol') continue;
    const parent = parents.get(precise);
    if (parent === undefined) {
      declarations.push({ id: qualified, kind: 'unclassified', source });
      continue;
    }
    const sugar = (symbol.swiftExtension?.constraints ?? []).some((constraint) => constraint.kind === 'sameType' && constraint.lhs === 'Self' && symbols.has(constraint.rhsPrecise));
    const parentSymbol = symbols.get(parent.target);
    if (parent.kind !== 'memberOf' || sugar || (parentSymbol && parentSymbol.kind.identifier !== 'swift.protocol')) continue;
    const refinesView = parent.target === VIEW || (parentSymbol && surfaceKind(conformances.get(parent.target)) === 'component');
    const memberKind = refinesView && directory === 'Components' ? 'component' : 'unclassified';
    declarations.push({ id: parent.target === VIEW ? name : qualified, kind: memberKind, source });
  }
  return declarations;
}

// The inventory builds: macOS, iOS devices and the iOS simulator, each in
// debug (DEBUG defined) and release, one bit each. The symbol graphs cannot
// show code in an #if clause no build compiles, so every #if, #elseif and
// #else clause in Styles and Components has to be compiled by at least one
// build, judged by evaluating its condition, nesting included, over these
// atoms. Any other atom (arch(), swift(), a custom flag, canImport of another
// module) fails, as does an unbalanced directive. A directive is a line whose
// first token, after any block comments, is #if, #elseif, #else or #endif; a
// line inside a multi-line string or comment that reads like one is checked
// too, which can only fail closed.
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
function swiftConditionBuilds(condition) {
  const tokens = [];
  SWIFT_CONDITION_TOKEN.lastIndex = 0;
  for (let match = SWIFT_CONDITION_TOKEN.exec(condition); match; match = SWIFT_CONDITION_TOKEN.exec(condition)) tokens.push(match[1]);
  if (tokens.join('') !== condition.replace(/\s/g, '')) return undefined;
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

const SWIFT_DIRECTIVE = /^(?:.*?\*\/)?\s*(?:\/\*.*?\*\/\s*)*#(if|elseif|else|endif)\b(.*)$/;

// Returns { line, condition, reason } for each clause in one file's text that
// no inventory build compiles or that the builds cannot decide.
export function uncoveredSwiftConditions(text) {
  const uncovered = [];
  const frames = [];
  let active = ALL_BUILDS;
  text.split(/\r\n|\r|\n/).forEach((line, index) => {
    const match = SWIFT_DIRECTIVE.exec(line);
    if (!match) return;
    const [, directive, rest] = match;
    const condition = rest.replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/, '').trim();
    const report = (reason) => uncovered.push({ line: index + 1, condition: `#${directive} ${condition}`.trim(), reason });
    if (directive === 'if') frames.push({ outer: active, taken: 0 });
    const frame = frames.at(-1);
    if (!frame) return report('unbalanced');
    if (directive === 'endif') {
      active = frames.pop().outer;
      return undefined;
    }
    let builds = directive === 'else' ? ALL_BUILDS : swiftConditionBuilds(condition);
    if (builds === undefined) {
      report('unsupported condition');
      builds = ALL_BUILDS;
    }
    active = frame.outer & builds & ~frame.taken;
    frame.taken |= frame.outer & builds;
    if (active === 0) report('no inventory build compiles this branch');
    return undefined;
  });
  if (frames.length > 0) uncovered.push({ line: text.split(/\r\n|\r|\n/).length, condition: '#endif', reason: 'unbalanced' });
  return uncovered;
}
