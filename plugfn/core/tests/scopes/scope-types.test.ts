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
import { defineScopeGrammar, type NormalizedScope, type ScopeDimensions, type ScopeShape } from '../../src/scopes/index.js';

// A definition built from mutable variables.
const vocabulary: string[] = ['contents:read'];
const concrete = defineScopeGrammar({
  provider: 'types',
  dimensions: { names: { kind: 'exactSet', values: vocabulary }, ttl: { kind: 'ttlMax' } },
  riskOf: () => 'read',
});
const names = concrete.dimensions.names;
// @ts-expect-error published vocabulary arrays are readonly
names.values?.push('admin');
// @ts-expect-error published dimension fields are readonly
concrete.dimensions.ttl.kind = 'ttlMax';

// Concrete kinds keep precise shapes.
concrete.isSubset({ names: ['a'], ttl: 60 }, { ttl: 60 });
// @ts-expect-error a scalar dimension is required
concrete.isSubset({ names: ['a'] }, { ttl: 60 });
// @ts-expect-error a set dimension holds strings
concrete.isSubset({ names: [1], ttl: 60 }, { ttl: 60 });
const normalized = concrete.normalize({ ttl: 60 });
if (normalized.ok) {
  const ttl: number = normalized.scope.ttl;
  const members: readonly string[] = normalized.scope.names;
  void ttl;
  void members;
}

// A definition widened to ScopeDimensions keeps both possibilities.
declare const widened: ScopeDimensions;
const loose = defineScopeGrammar({ provider: 'loose', dimensions: widened, riskOf: () => 'read' });
loose.isSubset({ anything: ['a'] }, { anything: 5 });
loose.isSubset({}, {});
const looseScope = loose.normalize({});
if (looseScope.ok) {
  const value = looseScope.scope['anything'];
  // @ts-expect-error a widened member may be a set, so number methods are not available
  value.toFixed();
  const either: readonly string[] | number = value;
  void either;
}

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
  it('are deeply readonly and keep set and scalar values for a widened kind', () => {
    expect(diagnosticsFor(fixture)).toEqual([]);
  }, 30_000);

  it('detects a violation of the contract (the check is not vacuous)', () => {
    const broken = `${fixture}\nconcrete.isSubset({ names: ['a'] }, { ttl: 60 });\n`;
    expect(diagnosticsFor(broken)).toEqual([expect.stringContaining("Property 'ttl' is missing")]);
  }, 30_000);
});
