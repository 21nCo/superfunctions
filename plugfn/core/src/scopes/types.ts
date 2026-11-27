/**
 * Scope-envelope engine types.
 *
 * A scope grammar describes the dimensions a provider credential request can
 * carry. Requests and envelopes are both expressed in that grammar, and the
 * engine answers whether a request stays inside an envelope. It supports only
 * the four dimension kinds below.
 */

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

export interface ScopeGrammarDefinition<D extends ScopeDimensions> {
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
}

/**
 * A defined scope grammar.
 *
 * The grammar definition is trusted; every request and envelope is untrusted.
 * The engine reads each input through one structured clone and validates only
 * that copy. Own enumerable string-keyed data counts, getters run once during
 * cloning, and values that cannot be cloned or are not plain data are malformed.
 * The envelope is captured before any request getter runs. A caller that mints
 * a credential must use the frozen scope covered by the subset decision.
 *
 * The engine never reads an input or its own arrays through the Array
 * iteration protocol or an `Array.prototype` method looked up at call time,
 * and fills every array it builds by own-property definition rather than
 * index assignment. So a data-valued pollution, a replaced Array iterator or
 * method, or an index property on `Array.prototype` or `Object.prototype`
 * (writable, non-writable or an accessor) cannot change a decision or make
 * `normalize` or `isSubset` throw. The same rule covers `defineScopeGrammar`:
 * the definition object is trusted data, read once through its own property
 * descriptors, and ambient `Array.prototype` or `Object.prototype` index
 * properties, or a replaced Array iterator or method, present while a
 * grammar is defined cannot change what it compiles, publishes or enforces.
 * The set arrays in a returned scope are
 * frozen ordinary arrays whose own indexes and `length` hold exactly the
 * approved members; reading them after the call through the realm's Array
 * iterator or methods belongs to the caller's realm. The realm's other built-in functions (`Set`, `Map`,
 * `String`, `Number`, `RegExp`, `JSON`, `Object` and `Math` methods) are
 * trusted; caller code that replaces them, including from an input getter,
 * has the caller's own authority and is outside this boundary. An input
 * getter is same-realm caller code: the engine guarantees only that it runs
 * once, during the clone, with the envelope captured first.
 */
export interface ScopeGrammar<D extends ScopeDimensions = ScopeDimensions> {
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
  normalize(input: ScopeShape<D>): ScopeNormalizeResult<D>;
  /**
   * `ok` only when both inputs normalise and every requested item is inside
   * the envelope. A malformed or unreadable request or envelope is never
   * widened, and never throws: it yields `malformed` violations.
   */
  isSubset(request: ScopeShape<D>, envelope: ScopeShape<D>): ScopeSubsetResult<D>;
}

/**
 * Any scope grammar, whatever its dimensions, with the widened
 * types: for code that accepts every provider. Structural, so every
 * `ScopeGrammar<D>` is assignable to it.
 */
export interface AnyScopeGrammar {
  readonly provider: string;
  readonly dimensions: PublishedScopeDimensions<ScopeDimensions>;
  normalize(input: unknown): ScopeNormalizeResult<ScopeDimensions>;
  isSubset(request: unknown, envelope: unknown): ScopeSubsetResult<ScopeDimensions>;
}
