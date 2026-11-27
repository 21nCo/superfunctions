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

/** `true` for an optional key (`name?:`): the grammar may not have that dimension at runtime. */
type IsOptionalKey<D, K extends keyof D> = Record<never, never> extends Pick<D, K> ? true : false;

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * `true` only for an exact definition: not a union, and every key a single
 * required literal name. Exact definitions get precise types; every other
 * definition (one widened to {@link ScopeDimensions}, a mixed
 * declared-and-index one, a template-literal key, an optional key or a union)
 * gets the widened types as a whole, because the type cannot tell which names
 * the grammar really has.
 */
export type IsExactDimensions<D> = [true] extends [IsUnion<D>]
  ? false
  : [true] extends [{ [K in keyof D]-?: IsIndexKey<K> }[keyof D]]
    ? false
    : [true] extends [{ [K in keyof D]-?: IsOptionalKey<D, K> }[keyof D]]
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

/** One requested item, as passed to `riskOf`: a frozen record with a null prototype. */
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

/**
 * One violation. Like every record the engine returns, it is a frozen object
 * with a null prototype in which every field below is an own property, set to
 * `undefined` when it does not apply, so no field is ever read from a
 * (possibly polluted) `Object.prototype`.
 */
export interface ScopeViolation {
  readonly code: ScopeViolationCode;
  /** Which input the violation is about. */
  readonly side: 'request' | 'envelope';
  /** The dimension, when the violation is about one. */
  readonly dimension: string | undefined;
  /** The offending string or number, when it is one. */
  readonly item: string | number | undefined;
  /** The envelope limit for `exceeds_envelope`, otherwise `undefined`. */
  readonly limit: number | undefined;
  readonly message: string;
}

/**
 * The result of `isSubset` (and `normalize`): a frozen null-prototype record
 * with `ok`, `violations` (a fresh frozen array, empty when `ok`) and `scope`
 * always own. When `ok`, `scope` is the engine's frozen snapshot of the
 * request: exactly the values the verdict covers. Mint from it, never by
 * reading the raw request again. When not `ok`, `scope` is `undefined`.
 */
export type ScopeSubsetResult<D extends ScopeDimensions = ScopeDimensions> =
  | { readonly ok: true; readonly violations: readonly ScopeViolation[]; readonly scope: NormalizedScope<D> }
  | { readonly ok: false; readonly violations: readonly ScopeViolation[]; readonly scope: undefined };

/** The result of `normalize`; the same shape as {@link ScopeSubsetResult}. */
export type ScopeNormalizeResult<D extends ScopeDimensions> = ScopeSubsetResult<D>;

export interface ScopeGrammarDefinition<D extends ScopeDimensions, TInput> {
  /** Provider identifier, for example `github`. */
  readonly provider: string;
  /**
   * The dimension definitions. This object, every entry and every option
   * object must be plain data: a prototype of exactly `Object.prototype` or
   * `null` (`Array.prototype` for `values`) and only enumerable string-keyed
   * data properties. A class instance, an inherited option, a getter or
   * setter, or a non-enumerable or symbol-keyed property makes
   * `defineScopeGrammar` throw `TypeError`, because the engine would not
   * enforce it. A `values` array must also be dense, with no extra key. Each
   * object is read once, through its property descriptors, into the engine's
   * own copy, and only that copy is compiled and published: changing the
   * definition objects later, even from a Proxy trap during the read, cannot
   * change what the grammar enforces.
   */
  readonly dimensions: D;
  /**
   * Maps provider-shaped input to {@link ScopeShape}. Applied to requests and
   * envelopes alike. It receives the engine's structured clone of the input,
   * never the caller's object, and only when that clone is plain JSON-like
   * data: objects (prototype `Object.prototype`), dense arrays without extra
   * keys, strings, finite numbers, booleans and `null`, without cycles or
   * shared references.
   * Any other clone (a SharedArrayBuffer, an ArrayBuffer or view, a Map, Set,
   * Date, RegExp, Error, Blob, boxed value or `undefined`) is `malformed` and
   * `normalize` is not called. The engine detaches every record and array of
   * the clone it receives from the shared realm: every record has a null
   * prototype, and every array (still an array, `length` own) has a frozen
   * null-prototype prototype holding the `Array.prototype` methods captured
   * at load, without `constructor`. So a field inherited from a polluted
   * `Object.prototype` or `Array.prototype` never appears in the input.
   * Boundary: primitive values (read through the `String`, `Number` and
   * `Boolean` prototypes) and every object `normalize` builds itself belong
   * to the callback's realm, so a polluted realm can change what `normalize`
   * computes from them. Its result is cloned again, checked to be
   * plain JSON-like data in the same way, and validated: a throw, or a result
   * that is not plain data or does not fit the grammar, is `malformed`.
   * Defaults to the identity.
   *
   * Callback boundary (applies to `normalize` and `riskOf`): callbacks are
   * trusted grammar-author code and must be synchronous. An `async` function
   * (or async generator) is rejected with `TypeError` when the grammar is
   * defined. A plain function that returns a promise fails closed at once
   * (`normalize`: `malformed`; `riskOf`: `ScopeError`). The engine never awaits
   * it: it applies the intrinsic `Promise.prototype.then` (captured at load)
   * with a no-op rejection handler, which marks a native promise's rejection
   * handled so it cannot surface as an unhandled rejection. When the species
   * lookup inside `then` throws (a throwing `constructor` or
   * `Symbol.species`), it retries once with the promise's `constructor`
   * reading as `undefined`, decided by its own `constructor` descriptor (in
   * any realm): absent on an extensible promise, configurable, or
   * non-configurable writable data; then it restores the original.
   * Residual: a promise whose lookup throws and whose own `constructor` is a
   * non-configurable accessor or non-configurable non-writable data, or a
   * non-extensible promise with no own `constructor`, cannot be marked
   * handled; only deliberately hostile callback code can build one, and the
   * engine still fails closed. Any other returned
   * value is left alone; a returned object's own `then` is never read or
   * called.
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
 * request), `isSubset` captures the envelope before any request getter or
 * `normalize` call runs, and anything that cannot be cloned (a Proxy, a promise, a
 * function) is `malformed`. Every engine-owned clone, the input's and the
 * re-cloned `normalize` result alike, must be plain JSON-like data before
 * anything reads it (see {@link ScopeGrammarDefinition.normalize}): a clone
 * holding a Map, Set, Date, SharedArrayBuffer, boxed value, an array with an
 * extra key, a cycle or a shared reference is `malformed`. The verdict
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
