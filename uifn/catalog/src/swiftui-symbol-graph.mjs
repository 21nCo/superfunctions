// The public UIFnSwiftUI declarations the SwiftUI status lists are checked
// against, read from the Swift compiler's symbol graphs, not from the source
// text: the compiler has already resolved comments, #if branches, access,
// nesting and conformances, implied ones included. scripts/uifn-swiftui-
// inventory.mjs builds UIFnSwiftUI for macOS and the iOS simulator with
// -emit-symbol-graph and commits the result as
// uifn/catalog/swiftui-surface-inventory.json, which the verify script checks
// the lists against on any platform.
//
// A declaration is a public or open symbol declared under Styles or
// Components, at any depth, that is
// - a struct, class or actor at any nesting depth, by its qualified name
//   (UIFnTimeline.Row);
// - an enum that is a style or a component;
// - a top-level function, variable or type alias; or
// - a member of an extension of a type from another module: of View by its
//   name (uifnToast), of any other type by type and name (Text.uifnBold). A
//   member of an extension constrained to Self == a UIFnSwiftUI type, such as
//   ButtonStyle.uifnPrimary, belongs to that type and is not listed.
// A conformance to a SwiftUI protocol whose name ends in Style makes a style;
// one to View or ViewModifier, which a Shape, a view representable or a
// protocol refining View implies, makes a component, as does a View-extension
// member in Components. Anything else is unclassified, so it has to be listed
// as a non-surface. Protocols, the members of UIFnSwiftUI types and the copies
// of protocol-extension members the graph adds to each conforming type
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

// `graphs` are the symbol graphs of one build (one platform). Returns
// { id, kind, source } per declaration, kind 'style', 'component' or
// 'unclassified'; an id repeats for overloads.
export function swiftUIDeclarationsFromSymbolGraphs(graphs) {
  const symbols = graphs.filter((graph) => graph.module?.name === SWIFTUI_MODULE).flatMap((graph) => graph.symbols);
  const relationships = graphs.filter((graph) => graph.module?.name === SWIFTUI_MODULE).flatMap((graph) => graph.relationships ?? []);
  const own = new Set(symbols.map((symbol) => symbol.identifier.precise));
  const parents = new Map();
  const conformances = new Map();
  for (const relationship of relationships) {
    if (relationship.kind === 'memberOf') parents.set(relationship.source, relationship.target);
    if (relationship.kind === 'conformsTo') conformances.set(relationship.source, [...(conformances.get(relationship.source) ?? []), relationship]);
  }
  const declarations = [];
  for (const symbol of symbols) {
    const precise = symbol.identifier.precise;
    const source = sourceOf(symbol);
    const directory = ['Styles', 'Components'].find((name) => source?.startsWith(`${SWIFTUI_SOURCES_ROOT}/${name}/`));
    if (!directory || precise.includes('::SYNTHESIZED::') || !['public', 'open'].includes(symbol.accessLevel)) continue;
    const kind = symbol.kind.identifier;
    const names = symbol.pathComponents;
    const name = names.at(-1).replace(/\(.*$/s, '');
    if (TYPE_KINDS.has(kind)) {
      const surface = surfaceKind(conformances.get(precise));
      if (surface || kind !== 'swift.enum') declarations.push({ id: names.join('.'), kind: surface ?? 'unclassified', source });
      continue;
    }
    if (kind === 'swift.protocol') continue;
    const parent = parents.get(precise);
    if (parent === undefined) {
      declarations.push({ id: name, kind: 'unclassified', source });
      continue;
    }
    const sugar = (symbol.swiftExtension?.constraints ?? []).some((constraint) => constraint.kind === 'sameType' && constraint.lhs === 'Self' && own.has(constraint.rhsPrecise));
    if (own.has(parent) || sugar) continue;
    if (parent === VIEW) declarations.push({ id: name, kind: directory === 'Components' ? 'component' : 'unclassified', source });
    else declarations.push({ id: [...names.slice(0, -1), name].join('.'), kind: 'unclassified', source });
  }
  return declarations;
}
