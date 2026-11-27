import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Type-level contract of the published scope types. The package's tsconfig
 * does not type-check tests, so this compiles an in-memory fixture against
 * src/scopes with the TypeScript compiler. Every `@ts-expect-error` line must
 * be an error and every other line must compile: an unused directive is
 * itself a diagnostic, so the check fails in both directions.
 */
const fixtureName = fileURLToPath(new URL('./__scope-types-fixture__.ts', import.meta.url));

const fixture = `
import {
  defineScopeGrammar,
  type AnyScopeGrammar,
  type NormalizedScope,
  type ScopeDimension,
  type ScopeDimensions,
  type ScopeItem,
  type ScopeShape,
} from '../../src/scopes/index.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// An exact definition (literal keys, not a union) keeps precise types.
const vocabulary: string[] = ['contents:read'];
const concrete = defineScopeGrammar({
  provider: 'types',
  dimensions: { names: { kind: 'exactSet', values: vocabulary }, ttl: { kind: 'ttlMax' } },
  riskOf: item => {
    const exact: Equal<typeof item.dimension, 'names' | 'ttl'> = true;
    void exact;
    return 'read';
  },
});
const names = concrete.dimensions.names;
// @ts-expect-error published vocabulary arrays are readonly
names.values?.push('admin');
// @ts-expect-error published dimension fields are readonly
concrete.dimensions.ttl.kind = 'ttlMax';
const declaredDimension: { readonly kind: 'ttlMax' } = concrete.dimensions.ttl;
void declaredDimension;
concrete.isSubset({ names: ['a'], ttl: 60 }, { ttl: 60 });
// @ts-expect-error a scalar dimension is required
concrete.isSubset({ names: ['a'] }, { ttl: 60 });
// @ts-expect-error a set dimension holds strings
concrete.isSubset({ names: [1], ttl: 60 }, { ttl: 60 });
// @ts-expect-error a misspelled dimension is not part of the shape
concrete.isSubset({ ttl: 60, nmaes: ['a'] }, { ttl: 60 });
const normalized = concrete.normalize({ ttl: 60 });
if (normalized.ok) {
  const ttl: number = normalized.scope.ttl;
  const members: readonly string[] = normalized.scope.names;
  // @ts-expect-error a misspelled lookup is a type error
  void normalized.scope.nmaes;
  void ttl;
  void members;
}

// Every definition that is not exact takes the widened types as a whole.
declare const widened: ScopeDimensions;
declare const mixed: { readonly names: { kind: 'exactSet' } } & Readonly<Record<string, ScopeDimension>>;
declare const templated: Readonly<Record<\`limit\${string}\`, { kind: 'numericMax' }>>;
declare const union: { readonly names: { kind: 'exactSet' } } | { readonly ttl: { kind: 'ttlMax' } };

const loose = defineScopeGrammar({ provider: 'loose', dimensions: widened, riskOf: () => 'read' });
const mixedGrammar = defineScopeGrammar({ provider: 'mixed', dimensions: mixed, riskOf: () => 'read' });
const templatedGrammar = defineScopeGrammar({ provider: 'templated', dimensions: templated, riskOf: () => 'read' });
const unionGrammar = defineScopeGrammar({ provider: 'union', dimensions: union, riskOf: () => 'read' });
const looseScope = loose.normalize({});
if (looseScope.ok) {
  // @ts-expect-error a widened lookup may find no dimension (undefined at runtime)
  const unchecked: readonly string[] | number = looseScope.scope['anything'];
  void unchecked;
}
// @ts-expect-error a widened dimension lookup may find nothing
void loose.dimensions['anything'].kind;
// @ts-expect-error a template-literal dimension lookup may find nothing
void templatedGrammar.dimensions.limitRate.kind;
// @ts-expect-error a union dimension lookup may find nothing
void unionGrammar.dimensions['names'].kind;
loose.isSubset({ anything: ['a'] }, { anything: 5 });
loose.isSubset({}, {});
mixedGrammar.isSubset({}, {});
templatedGrammar.isSubset({}, { limitRate: 5 });
unionGrammar.isSubset({}, {});

const mixedScope = mixedGrammar.normalize({});
if (mixedScope.ok) {
  // @ts-expect-error even a declared key of a mixed definition may be undefined
  const declared: readonly string[] = mixedScope.scope.names;
  void declared;
  const narrowed = mixedScope.scope['names'];
  if (narrowed !== undefined) {
    // @ts-expect-error a widened member may be a set, so number methods are not available
    narrowed.toFixed();
    const either: readonly string[] | number = narrowed;
    void either;
  }
}
const templatedScope = templatedGrammar.normalize({});
if (templatedScope.ok) {
  // @ts-expect-error a template-literal key may be undefined
  const limit: number | readonly string[] = templatedScope.scope.limitRate;
  void limit;
}
const unionScope = unionGrammar.normalize({});
if (unionScope.ok) {
  // @ts-expect-error a union definition may lack any key
  const ttl: number | readonly string[] = unionScope.scope['ttl'];
  void ttl;
}
// @ts-expect-error a widened dimension lookup may find nothing
void mixedGrammar.dimensions.names.kind;
const mixedDimension = mixedGrammar.dimensions['names'];
if (mixedDimension !== undefined) {
  const kind: 'exactSet' | 'prefixGlobSet' | 'numericMax' | 'ttlMax' = mixedDimension.kind;
  void kind;
}

const widenedItems: [
  Equal<ScopeItem<ScopeDimensions>['dimension'], string>,
  Equal<ScopeItem<typeof mixed>['dimension'], string>,
  Equal<ScopeItem<typeof templated>['dimension'], string>,
  Equal<ScopeItem<typeof union>['dimension'], string>,
] = [true, true, true, true];
void widenedItems;

// Any grammar can be passed where every provider is accepted.
const accepted: AnyScopeGrammar[] = [concrete, loose, mixedGrammar, templatedGrammar, unionGrammar];
void accepted;

// A per-key union of kinds in an exact definition keeps both possibilities.
type Mixed = { readonly d: { kind: 'exactSet' } | { kind: 'numericMax' } };
const mixedSet: ScopeShape<Mixed> = { d: ['a'] };
const mixedNumber: ScopeShape<Mixed> = { d: 1 };
const mixedNormalized: NormalizedScope<Mixed>['d'] = ['a'];
void mixedSet;
void mixedNumber;
void mixedNormalized;
`;

function diagnosticsFor(source: string): string[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    isolatedModules: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = file => (file === fixtureName ? source : readFile(file));
  host.fileExists = file => file === fixtureName || fileExists(file);
  host.getSourceFile = (file, languageVersion, ...rest) =>
    file === fixtureName ? ts.createSourceFile(file, source, languageVersion, true) : getSourceFile(file, languageVersion, ...rest);
  const program = ts.createProgram([fixtureName], options, host);
  return ts.getPreEmitDiagnostics(program).map(diagnostic => {
    const where = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : 0;
    return `${diagnostic.file?.fileName ?? ''}:${where} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
  });
}

describe('published scope types', () => {
  it('are precise only for exact definitions and widened as a whole otherwise', () => {
    expect(diagnosticsFor(fixture)).toEqual([]);
  }, 30_000);

  it('detects a violation of the contract (the check is not vacuous)', () => {
    const broken = `${fixture}\nconcrete.isSubset({ names: ['a'] }, { ttl: 60 });\n`;
    expect(diagnosticsFor(broken)).toEqual([expect.stringMatching(/not assignable to parameter of type .*readonly ttl: number/)]);
  }, 30_000);
});
