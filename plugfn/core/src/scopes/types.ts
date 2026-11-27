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

/** Keys whose dimension may be a set kind; these may be omitted (an empty set). */
type SetKeys<D extends ScopeDimensions> = {
  [K in keyof D]: [Extract<D[K], SetDimension>] extends [never] ? never : K;
}[keyof D];

type ScalarKeys<D extends ScopeDimensions> = Exclude<keyof D, SetKeys<D>>;

/**
 * Canonical scope input. Set dimensions may be omitted (an empty set); scalar
 * dimensions are required, because an absent limit would mean "unbounded".
 */
export type ScopeShape<D extends ScopeDimensions> = {
  readonly [K in SetKeys<D>]?: ScopeDimensionValue<D[K]>;
} & {
  readonly [K in ScalarKeys<D>]: ScopeDimensionValue<D[K]>;
};

/** A scope after validation: every dimension present, sets de-duplicated. */
export type NormalizedScope<D extends ScopeDimensions> = {
  readonly [K in keyof D]: ScopeDimensionValue<D[K]>;
};

type ReadonlyArrays<T> = T extends readonly (infer U)[] ? readonly U[] : T;

/** A dimension definition as published on a grammar: frozen, arrays included. */
export type PublishedScopeDimension<T> = { readonly [P in keyof T]: ReadonlyArrays<T[P]> };

/** The frozen dimension definitions a grammar publishes. */
export type PublishedScopeDimensions<D extends ScopeDimensions> = {
  readonly [K in keyof D]: PublishedScopeDimension<D[K]>;
};

/** One requested item, as passed to `riskOf`. */
export interface ScopeItem<D extends ScopeDimensions = ScopeDimensions> {
  readonly dimension: keyof D & string;
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
  readonly dimensions: D;
  /**
   * Maps provider-shaped input to {@link ScopeShape}. Applied to requests and
   * envelopes alike. Its output is validated; a throw, a promise or an output
   * that does not fit the grammar is rejected. Must be synchronous. Defaults
   * to the identity. A returned native promise gets a rejection handler, but
   * one whose `constructor` or `Symbol.species` lookup throws cannot be
   * marked handled, so its rejection stays the grammar author's
   * responsibility.
   */
  readonly normalize?: (input: TInput) => ScopeShape<D>;
  /**
   * Risk of one requested item. Must synchronously return one of
   * {@link SCOPE_RISK_LEVELS}; any other result (a promise included), or a
   * throw, makes `classifyRisk` throw `ScopeError`. A returned promise is
   * handled as described for `normalize`.
   */
  readonly riskOf: (item: ScopeItem<D>) => ScopeRisk;
}

/**
 * A defined scope grammar.
 *
 * Trust boundary: every verdict covers only the snapshot the engine read.
 * Inputs are expected to be plain data. The engine reads each object only
 * through its own data properties, once each (a key listed without a data
 * property, a hole, an inherited or accessor element, or an inconsistent
 * array length is `malformed`), and never re-reads it. A caller that mints a
 * credential must mint from the frozen `scope` that `isSubset` or `normalize`
 * returns, and classify that same snapshot with `classifyScope`, never by
 * reading the raw input again: a getter or Proxy may answer differently on
 * the next read.
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
   * throws: unreadable input yields a `malformed` violation.
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
   * Throws `ScopeError` for a malformed request or an invalid `riskOf` result.
   */
  classifyRisk(request: TInput): ScopeRisk;
  /**
   * `classifyRisk` for a frozen `scope` this grammar returned from `isSubset`
   * or `normalize`, without reading any caller input again. Throws
   * `ScopeError` for any other value or an invalid `riskOf` result.
   */
  classifyScope(scope: NormalizedScope<D>): ScopeRisk;
}
