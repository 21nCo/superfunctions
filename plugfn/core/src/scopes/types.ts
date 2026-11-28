/**
 * Scope-envelope engine types.
 *
 * A scope grammar describes the dimensions a provider credential request can
 * carry. Requests and envelopes are both expressed in that grammar, and the
 * engine answers whether a request stays inside an envelope and, for a
 * callback grammar, how risky the request is. It supports only the four
 * dimension kinds below.
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

/** One requested item, as passed to `riskOf`: a frozen record with a null prototype. */
export interface ScopeItem<D extends ScopeDimensions = ScopeDimensions> {
  readonly dimension: IsExactDimensions<D> extends true ? keyof D & string : string;
  readonly kind: ScopeDimensionKind;
  /** A set member (string) or a scalar value (number). */
  readonly value: string | number;
}

/** The fields every grammar definition has. */
interface ScopeGrammarDefinitionBase<D extends ScopeDimensions> {
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
 * A data-only grammar definition: no callbacks. `defineScopeGrammar` returns a
 * {@link ScopeGrammar} for it. `normalize` and `riskOf` may only be absent or
 * `undefined`; a definition with a callback is a
 * {@link ScopeCallbackGrammarDefinition}.
 */
export interface ScopeGrammarDefinition<D extends ScopeDimensions> extends ScopeGrammarDefinitionBase<D> {
  readonly normalize?: undefined;
  readonly riskOf?: undefined;
}

/**
 * A callback grammar definition: a required per-item `riskOf` and an optional
 * provider-shaped `normalize`. `defineScopeGrammar` returns a
 * {@link ScopeCallbackGrammar} for it. A `normalize` without `riskOf` makes
 * `defineScopeGrammar` throw `TypeError`.
 *
 * Callback boundary (applies to `normalize` and `riskOf`): callbacks are
 * trusted grammar-author code and must be synchronous. An `async` function
 * (or async generator) is rejected with `TypeError` when the grammar is
 * defined; that check reads the function's `Object.prototype.toString` tag,
 * so it catches mistakes and trusted code could defeat it with
 * `Symbol.toStringTag`, but the result is still checked at call time. A
 * function that returns a promise fails closed at once (`normalize`:
 * `malformed`; `riskOf`: `ScopeError`). The engine never awaits it and never
 * calls a returned object's own `then`: promise containment applies the
 * intrinsic `Promise.prototype.then` (captured at load) once, with no-op
 * fulfillment and rejection handlers and with the intrinsic `Promise` as the
 * species (see below), which marks a native promise's rejection handled so it
 * cannot surface as an unhandled rejection, and the promise `then` derives
 * then always fulfills. Containment never reads an own
 * `then` either; a `normalize` result is then copied with `structuredClone`,
 * which, like any other own enumerable property, reads an own `then` getter
 * on a non-promise object (a native promise cannot be cloned and fails
 * before that).
 *
 * `then` looks up the species constructor (`constructor`, then
 * `Symbol.species`) before it attaches the handler. That lookup can run code
 * that changes state and then throws, and a custom species builds the derived
 * promise itself, so it can reject that promise even when `then` succeeds.
 * So, before `then` runs, the engine decides whether `then` can only use the
 * default species, from state it can read without running caller code: the
 * value's own `constructor` descriptor and prototype, and the ambient
 * `Object` species state, read only from the identity-pinned `Object`,
 * `Function.prototype` and `Object.prototype` captured at load. That holds
 * only for no own `constructor` and a prototype of `null`, or of
 * `Object.prototype` while `Object.prototype.constructor` is the intrinsic
 * `Object` as data, `Object`'s prototype chain is exactly
 * `Function.prototype` then `Object.prototype`, and none of the three defines
 * `Symbol.species`. So a plain record keeps the fast path and never sees a
 * `defineProperty`. Anything else, or state that cannot be read, has its own
 * `constructor` descriptor read and made to read as `undefined` (so `then`
 * uses the intrinsic `Promise` without a species lookup) before `then` runs
 * once, and that descriptor is restored afterwards, even when redefining it
 * throws after applying the change: an absent one is defined on an
 * extensible value and deleted afterwards, a configurable one (data or
 * accessor) is redefined and restored, and non-configurable writable data has
 * its value set to `undefined` and back.
 * Residual: a promise whose own `constructor` is a non-configurable accessor
 * or non-configurable non-writable data, or a non-extensible promise with no
 * own `constructor`, gets `then` as is: a species lookup that throws leaves
 * its rejection unhandled, and a custom species can reject the promise `then`
 * derives. Only deliberately hostile callback code can build one, and the
 * engine still fails closed. Host code that runs inside `then` (a V8 promise
 * hook, say) has the host's authority and is outside this boundary: one that
 * freezes the value keeps its `constructor` from being restored.
 */
export type ScopeCallbackGrammarDefinition<D extends ScopeDimensions, TInput = ScopeShape<D>> =
  // `normalize` is optional only when `TInput` is canonical input: assignable
  // to `ScopeShape<D>` (a narrowed value, such as a literal TTL, included),
  // no union member has a key outside it (an optional one included), every
  // member has its required keys, and a member has some key unless the shape
  // has none. So an extra field needs `normalize`, and so does a broad type
  // such as `{}` or `object`, which admits non-scope values when every
  // dimension is optional; omitting an optional set dimension does not.
  // Each check is written directly on `TInput`, and the per-member key check
  // is reached only when some shape key is not common to every member, so for
  // a generic `D` with `TInput` = `ScopeShape<D>` the compiler relates a
  // definition to the optional branch alone.
  [TInput] extends [ScopeShape<D>]
    ? [InputKeys<TInput>] extends [keyof ScopeShape<D>]
      ? [RequiredKeys<ScopeShape<D>>] extends [keyof TInput]
        ? [keyof ScopeShape<D>] extends [keyof TInput]
          ? ScopeCallbackGrammarFields<D, TInput>
          : [KeylessMember<TInput>] extends [never]
            ? ScopeCallbackGrammarFields<D, TInput>
            : ScopeNormalizingFields<D, TInput>
        : ScopeNormalizingFields<D, TInput>
      : ScopeNormalizingFields<D, TInput>
    : ScopeNormalizingFields<D, TInput>;

/** Every key of every member of `TInput` (`keyof` on a union sees only the common ones). */
type InputKeys<TInput> = TInput extends unknown ? keyof TInput : never;

/** The members of `TInput` with no key at all, such as `{}` or `object`. */
type KeylessMember<TInput> = TInput extends unknown ? ([keyof TInput] extends [never] ? TInput : never) : never;

/** The keys `T` requires. */
type RequiredKeys<T> = { [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K }[keyof T];

/** {@link ScopeCallbackGrammarFields} with a required `normalize`. */
type ScopeNormalizingFields<D extends ScopeDimensions, TInput> = ScopeCallbackGrammarFields<D, TInput> & {
  readonly normalize: (input: TInput) => ScopeShape<D>;
};

/**
 * The fields of a {@link ScopeCallbackGrammarDefinition}, where `normalize`
 * is optional whatever the input type. Declare a definition with
 * `ScopeCallbackGrammarDefinition`, which requires `normalize` for any
 * input type that is not canonical: one that is not assignable to
 * `ScopeShape`, or with a union member that has a key outside it (an
 * optional one included), lacks a required key, or is a broad type such as
 * `{}`. An interface cannot extend that conditional type: a generic
 * definition type for the canonical input extends this interface with the
 * default input, and one for any input is an intersection with
 * `ScopeCallbackGrammarDefinition`, which keeps the requirement.
 * `defineScopeGrammar` checks its argument against
 * `ScopeCallbackGrammarDefinition`, so a value typed only with these fields,
 * for an input that is not canonical and without `normalize`, is rejected.
 */
export interface ScopeCallbackGrammarFields<D extends ScopeDimensions, TInput = ScopeShape<D>> extends ScopeGrammarDefinitionBase<D> {
  /**
   * Maps provider-shaped input to {@link ScopeShape}. Applied to requests and
   * envelopes alike. It receives the engine's structured clone of the input,
   * never the caller's object, and only when that clone is plain JSON-like
   * data: objects (prototype `Object.prototype`), dense arrays without extra
   * keys, strings, finite numbers, booleans and `null`, without cycles or
   * shared references. Any other clone (a SharedArrayBuffer, an ArrayBuffer
   * or view, a Map, Set, Date, RegExp, Error, Blob, boxed value or
   * `undefined`) is `malformed` and `normalize` is not called. The engine
   * detaches every record and array of the clone it receives from the shared
   * realm: every record has a null prototype, and every array (still an
   * array, `length` own) has a frozen null-prototype prototype holding the
   * standard `Array.prototype` methods captured at load (a fixed list of
   * method names plus `Symbol.iterator`, each copied only when it is an own
   * data property whose value is a function), without `constructor`. So a
   * field inherited from a polluted `Object.prototype` or `Array.prototype`
   * never appears in the input.
   * Boundary: primitive values (read through the `String`, `Number` and
   * `Boolean` prototypes) and every object `normalize` builds itself belong
   * to the callback's realm, so a polluted realm can change what `normalize`
   * computes from them. Its result is cloned again, checked to be plain
   * JSON-like data in the same way, and validated: a throw, a promise, or a
   * result that is not plain data or does not fit the grammar, is
   * `malformed`. Defaults to the identity, so it is required whenever the
   * input type is not {@link ScopeShape} (an explicit `TInput` type argument,
   * or one inferred from the expected grammar type); an unannotated
   * `normalize` takes `ScopeShape`. See the callback boundary on
   * {@link ScopeCallbackGrammarDefinition}.
   */
  readonly normalize?: (input: TInput) => ScopeShape<D>;
  /**
   * Risk of one requested item. Must return one of {@link SCOPE_RISK_LEVELS};
   * any other result (a promise included), or a throw, makes `classifyRisk`
   * and `classifyScope` throw `ScopeError`. See the callback boundary above.
   */
  readonly riskOf: (item: ScopeItem<D>) => ScopeRisk;
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
 *
 * A callback grammar adds trusted, synchronous callbacks (see
 * {@link ScopeCallbackGrammarDefinition}): `isSubset` clones, checks and
 * normalizes the envelope before it clones the request, and a caller that
 * classifies risk must classify the frozen snapshot with `classifyScope`.
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
}

/** A grammar defined with callbacks: a {@link ScopeGrammar} that also classifies risk. */
export interface ScopeCallbackGrammar<D extends ScopeDimensions = ScopeDimensions, TInput = ScopeShape<D>> extends ScopeGrammar<D, TInput> {
  /**
   * Maximum `riskOf` over all requested items; `read` for an empty request.
   * Throws `ScopeError` for a malformed request (with the clone or `normalize`
   * error as `cause`, when there is one) or an invalid `riskOf` result.
   */
  classifyRisk(request: TInput): ScopeRisk;
  /**
   * `classifyRisk` for a frozen `scope` this same grammar returned from
   * `isSubset` or `normalize`, without reading any caller input again. Throws
   * `ScopeError` for any other value (a copy, or a snapshot of another
   * grammar) or an invalid `riskOf` result.
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
}

/** Any callback grammar, with the widened types. Every `ScopeCallbackGrammar<D, TInput>` is assignable to it. */
export interface AnyScopeCallbackGrammar extends AnyScopeGrammar {
  classifyRisk(request: unknown): ScopeRisk;
  classifyScope(scope: WidenedScope): ScopeRisk;
}
