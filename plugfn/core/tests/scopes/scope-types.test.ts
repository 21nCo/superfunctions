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
  type AnyScopeCallbackGrammar,
  type AnyScopeGrammar,
  type NormalizedScope,
  type ScopeCallbackGrammar,
  type ScopeCallbackGrammarDefinition,
  type ScopeDimension,
  type ScopeDimensions,
  type ScopeGrammar,
  type ScopeItem,
  type ScopeRisk,
  type ScopeShape,
} from '../../src/scopes/index.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// An exact definition (literal keys, not a union) keeps precise types.
const vocabulary: string[] = ['contents:read'];
const concrete = defineScopeGrammar({
  provider: 'types',
  dimensions: { names: { kind: 'exactSet', values: vocabulary }, ttl: { kind: 'ttlMax' } },
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

const loose = defineScopeGrammar({ provider: 'loose', dimensions: widened });
const mixedGrammar = defineScopeGrammar({ provider: 'mixed', dimensions: mixed });
const templatedGrammar = defineScopeGrammar({ provider: 'templated', dimensions: templated });
const unionGrammar = defineScopeGrammar({ provider: 'union', dimensions: union });
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

// An explicitly typed definition with an optional key takes the widened types:
// the grammar may not have that dimension at runtime.
type OptionalDims = {
  readonly names: { kind: 'exactSet' };
  readonly labels?: { kind: 'exactSet' };
  readonly limit?: { kind: 'numericMax' };
};
const optionalDims: OptionalDims = { names: { kind: 'exactSet' } };
const optionalGrammar = defineScopeGrammar({ provider: 'optional', dimensions: optionalDims });
// @ts-expect-error an optional dimension may be absent from the published dimensions
void optionalGrammar.dimensions.labels.kind;
// @ts-expect-error even a required key of a definition with an optional key may be undefined
void optionalGrammar.dimensions.names.kind;
const optionalScope = optionalGrammar.normalize({ names: ['a'] });
if (optionalScope.ok) {
  // @ts-expect-error an optional set dimension may be absent from the snapshot
  const labels: readonly string[] | number = optionalScope.scope.labels;
  // @ts-expect-error an optional scalar dimension may be absent from the snapshot
  const limit: readonly string[] | number = optionalScope.scope.limit;
  const maybe: readonly string[] | number | undefined = optionalScope.scope.labels;
  void labels;
  void limit;
  void maybe;
}
// The optional scalar is not required on input (the engine judges its presence).
optionalGrammar.isSubset({ names: ['a'] }, { names: ['a'] });
// Any grammar can be passed where every provider is accepted.
const accepted: AnyScopeGrammar[] = [concrete, loose, mixedGrammar, templatedGrammar, unionGrammar, optionalGrammar];
void accepted;

// Output objects have a null prototype: inherited members are not callable on any of them.
if (normalized.ok) {
  // @ts-expect-error an exact snapshot has no toString at runtime
  normalized.scope.toString();
  const absent: undefined = normalized.scope.hasOwnProperty;
  void absent;
}
// @ts-expect-error exact published dimensions have no hasOwnProperty at runtime
concrete.dimensions.hasOwnProperty('names');
if (looseScope.ok) {
  // @ts-expect-error a widened snapshot has no toString at runtime
  looseScope.scope.toString();
  const member: readonly string[] | number | undefined = looseScope.scope.constructor;
  void member;
}
// @ts-expect-error widened published dimensions have no hasOwnProperty at runtime
loose.dimensions.hasOwnProperty('anything');
const anyGrammar: AnyScopeGrammar = loose;
const anyScope = anyGrammar.normalize({});
if (anyScope.ok) {
  // @ts-expect-error the AnyScopeGrammar snapshot has no valueOf at runtime
  anyScope.scope.valueOf();
}
// A declared dimension that uses an inherited name keeps its own type.
const inheritedNames = defineScopeGrammar({
  provider: 'inherited-names',
  dimensions: { constructor: { kind: 'numericMax' }, toString: { kind: 'exactSet' } },
});
const inheritedScope = inheritedNames.normalize({ constructor: 1, toString: ['a'] });
if (inheritedScope.ok) {
  const ctor: number = inheritedScope.scope.constructor;
  const text: readonly string[] = inheritedScope.scope.toString;
  // @ts-expect-error a name that is neither declared nor present stays absent
  inheritedScope.scope.valueOf();
  void ctor;
  void text;
}
const ctorDimension: { readonly kind: 'numericMax' } = inheritedNames.dimensions.constructor;
void ctorDimension;

// A per-key union of kinds in an exact definition keeps both possibilities.
type Mixed = { readonly d: { kind: 'exactSet' } | { kind: 'numericMax' } };
const mixedSet: ScopeShape<Mixed> = { d: ['a'] };
const mixedNumber: ScopeShape<Mixed> = { d: 1 };
const mixedNormalized: NormalizedScope<Mixed>['d'] = ['a'];
void mixedSet;
void mixedNumber;
void mixedNormalized;

// A data-only definition keeps SFNS-110's grammar: no risk methods.
const dataOnly: ScopeGrammar<{ readonly names: { kind: 'exactSet' } }> = defineScopeGrammar({
  provider: 'data-only',
  dimensions: { names: { kind: 'exactSet' } },
});
// @ts-expect-error a data-only grammar has no classifyRisk
dataOnly.classifyRisk({ names: [] });
// @ts-expect-error normalize needs riskOf
defineScopeGrammar({ provider: 'no-risk', dimensions: { names: { kind: 'exactSet' } }, normalize: (input: { names: string[] }) => input });

// A callback grammar: riskOf sees the exact dimension names, and normalize sets the input type.
const callbacks = defineScopeGrammar({
  provider: 'callbacks',
  dimensions: { names: { kind: 'exactSet' }, ttl: { kind: 'ttlMax' } },
  riskOf: item => {
    const exact: Equal<typeof item.dimension, 'names' | 'ttl'> = true;
    void exact;
    return 'read';
  },
});
const callbackRisk: ScopeRisk = callbacks.classifyRisk({ names: ['a'], ttl: 60 });
void callbackRisk;
const callbackScope = callbacks.normalize({ names: ['a'], ttl: 60 });
if (callbackScope.ok) callbacks.classifyScope(callbackScope.scope);
// @ts-expect-error a scalar dimension is required by the default input type
callbacks.classifyRisk({ names: ['a'] });
interface ProviderInput {
  readonly repos: string[];
}
const shaped = defineScopeGrammar({
  provider: 'shaped',
  dimensions: { repos: { kind: 'prefixGlobSet' } },
  normalize: (input: ProviderInput) => ({ repos: input.repos }),
  riskOf: () => 'write',
});
const shapedGrammar: ScopeCallbackGrammar<{ readonly repos: { kind: 'prefixGlobSet' } }, ProviderInput> = shaped;
void shapedGrammar;
shaped.isSubset({ repos: ['org/a'] }, { repos: ['org/*'] });
// @ts-expect-error input follows normalize's parameter, not the scope shape
shaped.classifyRisk({ repositories: ['org/a'] });
// A provider-shaped input type needs normalize; without one the input is the scope shape.
interface SecondsInput {
  readonly seconds: number;
}
type TtlDims = { readonly ttl: { kind: 'ttlMax' } };
const ttlDims: TtlDims = { ttl: { kind: 'ttlMax' } };
// @ts-expect-error an explicit provider-shaped input type without normalize
defineScopeGrammar<TtlDims, SecondsInput>({ provider: 'no-normalize', dimensions: ttlDims, riskOf: () => 'read' });
// @ts-expect-error an expected provider-shaped grammar without normalize
const contextualNoNormalize: ScopeCallbackGrammar<TtlDims, SecondsInput> = defineScopeGrammar({
  provider: 'no-normalize',
  dimensions: ttlDims,
  riskOf: () => 'read',
});
void contextualNoNormalize;
const riskOnly: ScopeCallbackGrammar<TtlDims> = defineScopeGrammar({ provider: 'risk-only', dimensions: ttlDims, riskOf: () => 'read' });
riskOnly.classifyRisk({ ttl: 60 });
const explicitNormalize = defineScopeGrammar<TtlDims, SecondsInput>({
  provider: 'explicit-normalize',
  dimensions: ttlDims,
  normalize: input => ({ ttl: input.seconds }),
  riskOf: () => 'read',
});
explicitNormalize.classifyRisk({ seconds: 60 });
const contextualNormalize: ScopeCallbackGrammar<TtlDims, SecondsInput> = defineScopeGrammar({
  provider: 'contextual-normalize',
  dimensions: ttlDims,
  normalize: (input: SecondsInput) => ({ ttl: input.seconds }),
  riskOf: () => 'read',
});
contextualNormalize.isSubset({ seconds: 60 }, { seconds: 300 });
// An unannotated normalize takes the scope shape.
const unannotated = defineScopeGrammar({
  provider: 'unannotated',
  dimensions: ttlDims,
  normalize: input => ({ ttl: input.ttl }),
  riskOf: () => 'read',
});
const unannotatedInput: Equal<Parameters<typeof unannotated.classifyRisk>[0], ScopeShape<TtlDims>> = true;
void unannotatedInput;
// An explicit scope-shape input type needs no normalize.
const explicitShape: ScopeCallbackGrammar<TtlDims> = defineScopeGrammar<TtlDims, ScopeShape<TtlDims>>({
  provider: 'explicit-shape',
  dimensions: ttlDims,
  riskOf: () => 'read',
});
void explicitShape;
// The definition type requires normalize for a provider-shaped input and keeps that input when stored.
const storedShaped: ScopeCallbackGrammarDefinition<TtlDims, SecondsInput> = {
  provider: 'stored-shaped',
  dimensions: ttlDims,
  normalize: input => ({ ttl: input.seconds }),
  riskOf: () => 'read',
};
defineScopeGrammar(storedShaped).classifyRisk({ seconds: 60 });
const storedRiskOnly: ScopeCallbackGrammarDefinition<TtlDims> = { provider: 'stored-risk-only', dimensions: ttlDims, riskOf: () => 'read' };
defineScopeGrammar(storedRiskOnly).classifyRisk({ ttl: 60 });
// @ts-expect-error a stored provider-shaped definition without normalize
const storedNoNormalize: ScopeCallbackGrammarDefinition<TtlDims, SecondsInput> = { provider: 'stored', dimensions: ttlDims, riskOf: () => 'read' };
void storedNoNormalize;
// A subtype of the scope shape adds fields the grammar rejects, so it needs normalize too.
type SecondsAndTtl = ScopeShape<TtlDims> & { readonly seconds: number };
// @ts-expect-error a scope-shape subtype without normalize
defineScopeGrammar<TtlDims, SecondsAndTtl>({ provider: 'subtype', dimensions: ttlDims, riskOf: () => 'read' });
// @ts-expect-error an expected scope-shape subtype grammar without normalize
const contextualSubtype: ScopeCallbackGrammar<TtlDims, SecondsAndTtl> = defineScopeGrammar({ provider: 'subtype', dimensions: ttlDims, riskOf: () => 'read' });
void contextualSubtype;
// So does an input that adds only an optional field, in every form.
type OptionalSeconds = { readonly ttl: number; readonly seconds?: number };
// @ts-expect-error an explicit input with an optional extra field, without normalize
defineScopeGrammar<TtlDims, OptionalSeconds>({ provider: 'optional-extra', dimensions: ttlDims, riskOf: () => 'read' });
// @ts-expect-error a stored definition with an optional extra field, without normalize
const storedOptional: ScopeCallbackGrammarDefinition<TtlDims, OptionalSeconds> = { provider: 'optional-extra', dimensions: ttlDims, riskOf: () => 'read' };
void storedOptional;
type SecondsOrMinutes = { readonly ttl: number; readonly seconds?: number } | { readonly ttl: number; readonly minutes?: number };
// @ts-expect-error a union input whose members add fields, without normalize
defineScopeGrammar<TtlDims, SecondsOrMinutes>({ provider: 'union-extra', dimensions: ttlDims, riskOf: () => 'read' });
// @ts-expect-error a stored union input whose members add fields, without normalize
const storedUnion: ScopeCallbackGrammarDefinition<TtlDims, SecondsOrMinutes> = { provider: 'union-extra', dimensions: ttlDims, riskOf: () => 'read' };
void storedUnion;
// Broad input types admit non-scope values even when every dimension is optional.
type NamesDims = { readonly names: { kind: 'exactSet' } };
const namesDims: NamesDims = { names: { kind: 'exactSet' } };
// @ts-expect-error an empty-object input, without normalize
defineScopeGrammar<NamesDims, {}>({ provider: 'broad', dimensions: namesDims, riskOf: () => 'read' });
// @ts-expect-error an object input, without normalize
defineScopeGrammar<NamesDims, object>({ provider: 'broad', dimensions: namesDims, riskOf: () => 'read' });
// @ts-expect-error a union with a broad member, without normalize
const storedBroad: ScopeCallbackGrammarDefinition<NamesDims, ScopeShape<NamesDims> | {}> = { provider: 'broad', dimensions: namesDims, riskOf: () => 'read' };
void storedBroad;
// A narrowed canonical input, such as a literal TTL, needs no normalize.
const literalTtl: ScopeCallbackGrammar<TtlDims, { readonly ttl: 60 }> = defineScopeGrammar({ provider: 'literal-ttl', dimensions: ttlDims, riskOf: () => 'read' });
literalTtl.classifyRisk({ ttl: 60 });
defineScopeGrammar<TtlDims, { readonly ttl: 60 }>({ provider: 'literal-ttl', dimensions: ttlDims, riskOf: () => 'read' });
// Generic factories build risk-only definitions with the canonical input.
function riskOnlyFor<GD extends ScopeDimensions>(dimensions: GD): ScopeCallbackGrammar<GD> {
  return defineScopeGrammar({ provider: 'generic', dimensions, riskOf: () => 'read' });
}
function riskOnlyExplicit<GD extends ScopeDimensions>(dimensions: GD): ScopeCallbackGrammar<GD> {
  return defineScopeGrammar<GD, ScopeShape<GD>>({ provider: 'generic', dimensions, riskOf: () => 'read' });
}
function riskOnlyDefinition<GD extends ScopeDimensions>(dimensions: GD): ScopeCallbackGrammarDefinition<GD> {
  return { provider: 'generic', dimensions, riskOf: () => 'read' };
}
riskOnlyFor(ttlDims).classifyRisk({ ttl: 60 });
riskOnlyExplicit(ttlDims).classifyRisk({ ttl: 60 });
defineScopeGrammar(riskOnlyDefinition(ttlDims)).classifyRisk({ ttl: 60 });
// A generic consumer forwards a definition and keeps its input type.
function buildGrammar<GD extends ScopeDimensions, GInput>(definition: ScopeCallbackGrammarDefinition<GD, GInput>): ScopeCallbackGrammar<GD, GInput> {
  return defineScopeGrammar(definition);
}
buildGrammar(storedShaped).classifyRisk({ seconds: 60 });
buildGrammar(storedRiskOnly).classifyRisk({ ttl: 60 });
// A generic definition type extends the definition by intersection and keeps the normalize requirement.
type TaggedDefinition<GD extends ScopeDimensions, GInput> = ScopeCallbackGrammarDefinition<GD, GInput> & { readonly provider: 'tagged' };
const tagged: TaggedDefinition<TtlDims, SecondsInput> = { provider: 'tagged', dimensions: ttlDims, normalize: input => ({ ttl: input.seconds }), riskOf: () => 'read' };
buildGrammar(tagged).classifyRisk({ seconds: 60 });
// @ts-expect-error a tagged provider-shaped definition without normalize
const taggedNoNormalize: TaggedDefinition<TtlDims, SecondsInput> = { provider: 'tagged', dimensions: ttlDims, riskOf: () => 'read' };
void taggedNoNormalize;
// @ts-expect-error riskOf returns a closed risk level
defineScopeGrammar({ provider: 'bad-risk', dimensions: { names: { kind: 'exactSet' } }, riskOf: () => 'admin' });
const optionalItem: Equal<ScopeItem<OptionalDims>['dimension'], string> = true;
void optionalItem;
const widenedItems: [
  Equal<ScopeItem<ScopeDimensions>['dimension'], string>,
  Equal<ScopeItem<typeof mixed>['dimension'], string>,
  Equal<ScopeItem<typeof templated>['dimension'], string>,
  Equal<ScopeItem<typeof union>['dimension'], string>,
] = [true, true, true, true];
void widenedItems;
const widenedCallbacks = defineScopeGrammar({ provider: 'widened-callbacks', dimensions: widened, riskOf: () => 'read' });
// Every callback grammar is accepted where any callback grammar, or any grammar, is.
const anyCallbacks: AnyScopeCallbackGrammar[] = [callbacks, shaped, widenedCallbacks];
const anyGrammars: AnyScopeGrammar[] = [callbacks, shaped, widenedCallbacks, dataOnly];
void anyCallbacks;
void anyGrammars;
// @ts-expect-error a data-only grammar is not a callback grammar
const notCallbacks: AnyScopeCallbackGrammar = dataOnly;
void notCallbacks;
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
