/**
 * Scope-envelope engine types.
 *
 * A scope grammar describes the dimensions a provider credential request can
 * carry. Requests and envelopes are both expressed in that grammar, and the
 * engine answers whether a request stays inside an envelope and how risky it
 * is. Only the four dimension kinds below exist (a closed set).
 */

/** Risk levels, ordered from least to most risky. Frozen; the engine keeps its own copy. */
export const SCOPE_RISK_LEVELS = Object.freeze(['read', 'write', 'destructive'] as const);

export type ScopeRisk = (typeof SCOPE_RISK_LEVELS)[number];

/**
 * Input bounds. A set with more items, or a member with more characters, does
 * not normalise (it is rejected as `malformed`), which keeps every evaluation
 * linear in the input size.
 */
export const SCOPE_LIMITS = Object.freeze({
  /** Most items one set dimension may hold, on either side. */
  maxSetItems: 100_000,
  /** Longest set member, in UTF-16 code units. */
  maxMemberLength: 4096,
} as const);

/** A set of literal strings. Values never contain `*`. */
export interface ExactSetDimension {
  readonly kind: 'exactSet';
  /** Optional closed vocabulary; a value outside it does not normalise. */
  readonly values?: readonly string[];
}

/** A set of literals or prefix globs with a single trailing `*` only. */
export interface PrefixGlobSetDimension {
  readonly kind: 'prefixGlobSet';
}

/** A finite number; the request must not exceed the envelope's number. */
export interface NumericMaxDimension {
  readonly kind: 'numericMax';
  /** Smallest value the grammar accepts (inclusive). */
  readonly min?: number;
  /** Largest value the grammar accepts (inclusive). */
  readonly max?: number;
  /** Require a safe integer. */
  readonly integer?: boolean;
}

/** A lifetime in whole seconds (> 0); the request must not exceed the envelope's. */
export interface TtlMaxDimension {
  readonly kind: 'ttlMax';
  /** Shortest lifetime the grammar accepts, in seconds (inclusive). */
  readonly minSeconds?: number;
  /** Longest lifetime the grammar accepts, in seconds (inclusive). */
  readonly maxSeconds?: number;
}

export type ScopeDimension =
  | ExactSetDimension
  | PrefixGlobSetDimension
  | NumericMaxDimension
  | TtlMaxDimension;

export type ScopeDimensionKind = ScopeDimension['kind'];

export type ScopeDimensions = Readonly<Record<string, ScopeDimension>>;

type SetDimension = ExactSetDimension | PrefixGlobSetDimension;

/**
 * The value a dimension holds: a string set for set kinds, a number for scalar
 * kinds. Distributes over a union of kinds, so a dimension typed as the whole
 * {@link ScopeDimension} union holds either.
 */
export type ScopeDimensionValue<T> = T extends SetDimension ? readonly string[] : number;

/** `true` for a key that stands for many names: `string`, `number` or a template-literal pattern. */
type IsIndexKey<K extends PropertyKey> = Record<never, never> extends Record<K, 1> ? true : false;

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * `true` only for an exact definition: not a union, and every key a single
 * literal name. Exact definitions get precise types; every other definition
 * (one widened to {@link ScopeDimensions}, a mixed declared-and-index one, a
 * template-literal key or a union) gets the widened types as a whole, because
 * the type cannot tell which names the grammar really has.
 */
export type IsExactDimensions<D> = [true] extends [IsUnion<D>]
  ? false
  : [true] extends [{ [K in keyof D]-?: IsIndexKey<K> }[keyof D]]
    ? false
    : true;

/** Keys of an exact definition whose dimension may be a set kind; these may be omitted (an empty set). */
type SetKeys<D> = { [K in keyof D]-?: [Extract<D[K], SetDimension>] extends [never] ? never : K }[keyof D];

/** A widened scope: any name may be looked up, and only the grammar's dimensions are present. */
export type WidenedScope = { readonly [dimension: string]: readonly string[] | number | undefined };

/**
 * The engine's output objects (scope snapshots, `grammar.dimensions`) have a
 * null prototype, so the members every object normally inherits
 * (`toString`, `hasOwnProperty`, ...) are absent at runtime. For an exact
 * definition, each such name that is not a declared dimension is typed
 * `undefined`; a dimension that happens to use one of these names keeps its
 * own type. For a widened definition any of them may be a dimension, so each
 * is typed as the lookup value `V`. Either way, calling one is a type error.
 * Applied to output types only: input types keep ordinary object types, so a
 * plain object literal stays assignable.
 */
type InheritedMember = 'constructor' | 'hasOwnProperty' | 'isPrototypeOf' | 'propertyIsEnumerable' | 'toLocaleString' | 'toString' | 'valueOf';
type NoInheritedMembers<Declared extends PropertyKey, V> = { readonly [K in Exclude<InheritedMember, Declared>]?: V };

/** A scope as the engine returns it for a definition that is not exact. */
export type WidenedNormalizedScope = WidenedScope & NoInheritedMembers<never, readonly string[] | number | undefined>;

/**
 * Canonical scope input. Set dimensions may be omitted (an empty set); scalar
 * dimensions are required, because an absent limit would mean "unbounded".
 * For a definition that is not exact every key is optional: the type cannot
 * tell which are scalars, and the engine still rejects a missing one as
 * `malformed`.
 */
export type ScopeShape<D extends ScopeDimensions> =
  IsExactDimensions<D> extends true
    ? { readonly [K in SetKeys<D>]?: ScopeDimensionValue<D[K]> } & {
        readonly [K in Exclude<keyof D, SetKeys<D>>]: ScopeDimensionValue<D[K]>;
      }
    : WidenedScope;

/**
 * A scope after validation: every dimension present, sets de-duplicated. A
 * frozen object with a null prototype, so it holds no inherited names. For a
 * definition that is not exact, a lookup may yield `undefined`.
 */
export type NormalizedScope<D extends ScopeDimensions> =
  IsExactDimensions<D> extends true
    ? { readonly [K in keyof D]-?: ScopeDimensionValue<D[K]> } & NoInheritedMembers<keyof D, undefined>
    : WidenedNormalizedScope;

type ReadonlyArrays<T> = T extends readonly (infer U)[] ? readonly U[] : T;

/** A dimension definition as published on a grammar: frozen, arrays included. */
export type PublishedScopeDimension<T> = { readonly [P in keyof T]: ReadonlyArrays<T[P]> };

/**
 * The frozen dimension definitions a grammar publishes, in a null-prototype
 * object. For a definition that is not exact, a lookup may yield `undefined`.
 */
export type PublishedScopeDimensions<D extends ScopeDimensions> =
  IsExactDimensions<D> extends true
    ? { readonly [K in keyof D]-?: PublishedScopeDimension<D[K]> } & NoInheritedMembers<keyof D, undefined>
    : { readonly [dimension: string]: ScopeDimension | undefined } & NoInheritedMembers<never, ScopeDimension | undefined>;

/** One requested item, as passed to `riskOf`. */
export interface ScopeItem<D extends ScopeDimensions = ScopeDimensions> {
  readonly dimension: IsExactDimensions<D> extends true ? keyof D & string : string;
  readonly kind: ScopeDimensionKind;
  /** A set member (string) or a scalar value (number). */
  readonly value: string | number;
}

export type ScopeViolationCode =
  /** The request or envelope does not normalise to the grammar. */
  | 'malformed'
  /** A requested set member is not covered by the envelope. */
  | 'not_in_envelope'
  /** A requested scalar is larger than the envelope allows. */
  | 'exceeds_envelope';

export interface ScopeViolation {
  readonly code: ScopeViolationCode;
  /** Which input the violation is about. */
  readonly side: 'request' | 'envelope';
  readonly dimension?: string;
  /** The offending string or number, when it is one. */
  readonly item?: string | number;
  /** The envelope limit for `exceeds_envelope`. */
  readonly limit?: number;
  readonly message: string;
}

/**
 * The result of `isSubset`. When `ok`, `scope` is the engine's frozen snapshot
 * of the request: exactly the values the verdict covers. Mint from it, never
 * by reading the raw request again.
 */
export type ScopeSubsetResult<D extends ScopeDimensions = ScopeDimensions> =
  | { readonly ok: true; readonly violations: readonly ScopeViolation[]; readonly scope: NormalizedScope<D> }
  | { readonly ok: false; readonly violations: readonly ScopeViolation[]; readonly scope?: undefined };

export type ScopeNormalizeResult<D extends ScopeDimensions> =
  | { readonly ok: true; readonly scope: NormalizedScope<D> }
  | { readonly ok: false; readonly violations: readonly ScopeViolation[] };

export interface ScopeGrammarDefinition<D extends ScopeDimensions, TInput> {
  /** Provider identifier, for example `github`. */
  readonly provider: string;
  /**
   * The dimension definitions, read once as their structured clone: own
   * enumerable data only.
   */
  readonly dimensions: D;
  /**
   * Maps provider-shaped input to {@link ScopeShape}. Applied to requests and
   * envelopes alike. It receives the engine's structured clone of the input,
   * never the caller's object, and its result is cloned again and validated:
   * a throw, or a result that is not plain data or does not fit the grammar,
   * is `malformed`. Defaults to the identity.
   *
   * Callback boundary (applies to `normalize` and `riskOf`): callbacks are
   * trusted grammar-author code and must be synchronous. An `async` function
   * (or async generator) is rejected with `TypeError` when the grammar is
   * defined. The engine never waits for, subscribes to or creates a promise: a
   * plain function that returns a promise fails closed at once (`normalize`:
   * `malformed`; `riskOf`: `ScopeError`), and handling that promise's
   * rejection is the grammar author's responsibility.
   */
  readonly normalize?: (input: TInput) => ScopeShape<D>;
  /**
   * Risk of one requested item. Must return one of {@link SCOPE_RISK_LEVELS};
   * any other result, or a throw, makes `classifyRisk` throw `ScopeError`.
   * See the callback boundary on `normalize`.
   */
  readonly riskOf: (item: ScopeItem<D>) => ScopeRisk;
}

/**
 * A defined scope grammar.
 *
 * Trust boundary: the grammar definition and its callbacks are trusted; every
 * request and envelope is untrusted data. The engine reads untrusted input
 * exactly once, as `structuredClone(input)`, and decides only from that clone:
 * own enumerable string-keyed data is what counts, getters run once during the
 * clone, non-enumerable and symbol keys are dropped (so they can only narrow a
 * request), and anything that cannot be cloned (a Proxy, a promise, a
 * function) is `malformed`. Without `normalize`, a clone holding anything
 * other than plain objects, arrays, strings and numbers (a Map, Set, Date or
 * boxed value) is `malformed`; with `normalize`, the clone is passed to it as
 * it is, and only its result is cloned again and checked for plain data. The verdict
 * covers only that clone. A caller that mints a credential must mint from the
 * frozen `scope` that `isSubset` or `normalize` returns, and classify it with
 * `classifyScope`, never by reading the raw input again.
 */
export interface ScopeGrammar<D extends ScopeDimensions = ScopeDimensions, TInput = ScopeShape<D>> {
  readonly provider: string;
  /**
   * Frozen copies of the dimension definitions, as given (their `values`
   * arrays included). The engine evaluates from its own private copy, so these
   * are informational only.
   */
  readonly dimensions: PublishedScopeDimensions<D>;
  /**
   * Normalises and validates input without comparing it to anything. Never
   * throws: input that cannot be read yields a `malformed` violation.
   */
  normalize(input: TInput): ScopeNormalizeResult<D>;
  /**
   * `ok` only when both inputs normalise and every requested item is inside
   * the envelope. A malformed or unreadable request or envelope is never
   * widened, and never throws: it yields `malformed` violations.
   */
  isSubset(request: TInput, envelope: TInput): ScopeSubsetResult<D>;
  /**
   * Maximum `riskOf` over all requested items; `read` for an empty request.
   * Throws `ScopeError` for a malformed request (with the clone or `normalize`
   * error as `cause`, when there is one) or an invalid `riskOf` result.
   */
  classifyRisk(request: TInput): ScopeRisk;
  /**
   * `classifyRisk` for a frozen `scope` this grammar returned from `isSubset`
   * or `normalize`, without reading any caller input again. Throws
   * `ScopeError` for any other value or an invalid `riskOf` result.
   */
  classifyScope(scope: NormalizedScope<D>): ScopeRisk;
}

/**
 * Any scope grammar, whatever its dimensions and input type, with the widened
 * types: for code that accepts every provider. Structural, so every
 * `ScopeGrammar<D, TInput>` is assignable to it.
 */
export interface AnyScopeGrammar {
  readonly provider: string;
  readonly dimensions: PublishedScopeDimensions<ScopeDimensions>;
  normalize(input: unknown): ScopeNormalizeResult<ScopeDimensions>;
  isSubset(request: unknown, envelope: unknown): ScopeSubsetResult<ScopeDimensions>;
  classifyRisk(request: unknown): ScopeRisk;
  classifyScope(scope: WidenedScope): ScopeRisk;
}
