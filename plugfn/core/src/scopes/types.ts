/**
 * Scope-envelope engine types.
 *
 * A scope grammar describes the dimensions a provider credential request can
 * carry. Requests and envelopes are both expressed in that grammar, and the
 * engine answers whether a request stays inside an envelope and how risky it
 * is. Only the four dimension kinds below exist (a closed set).
 */

/** Risk levels, ordered from least to most risky. */
export const SCOPE_RISK_LEVELS = ['read', 'write', 'destructive'] as const;

export type ScopeRisk = (typeof SCOPE_RISK_LEVELS)[number];

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

type SetKeys<D extends ScopeDimensions> = {
  [K in keyof D]: D[K] extends SetDimension ? K : never;
}[keyof D];

type ScalarKeys<D extends ScopeDimensions> = Exclude<keyof D, SetKeys<D>>;

/**
 * Canonical scope input. Set dimensions may be omitted (an empty set); scalar
 * dimensions are required, because an absent limit would mean "unbounded".
 */
export type ScopeShape<D extends ScopeDimensions> = {
  readonly [K in SetKeys<D>]?: readonly string[];
} & {
  readonly [K in ScalarKeys<D>]: number;
};

/** A scope after validation: every dimension present, sets de-duplicated. */
export type NormalizedScope<D extends ScopeDimensions> = {
  readonly [K in keyof D]: D[K] extends SetDimension ? readonly string[] : number;
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

export interface ScopeSubsetResult {
  readonly ok: boolean;
  readonly violations: readonly ScopeViolation[];
}

export type ScopeNormalizeResult<D extends ScopeDimensions> =
  | { readonly ok: true; readonly scope: NormalizedScope<D> }
  | { readonly ok: false; readonly violations: readonly ScopeViolation[] };

export interface ScopeGrammarDefinition<D extends ScopeDimensions, TInput> {
  /** Provider identifier, for example `github`. */
  readonly provider: string;
  readonly dimensions: D;
  /**
   * Maps provider-shaped input to {@link ScopeShape}. Applied to requests and
   * envelopes alike. Its output is validated; a throw or an output that does
   * not fit the grammar is rejected. Defaults to the identity.
   */
  readonly normalize?: (input: TInput) => ScopeShape<D>;
  /** Risk of one requested item. Must return one of {@link SCOPE_RISK_LEVELS}. */
  readonly riskOf: (item: ScopeItem<D>) => ScopeRisk;
}

export interface ScopeGrammar<D extends ScopeDimensions = ScopeDimensions, TInput = ScopeShape<D>> {
  readonly provider: string;
  readonly dimensions: Readonly<D>;
  /** Normalises and validates input without comparing it to anything. */
  normalize(input: TInput): ScopeNormalizeResult<D>;
  /**
   * `ok` only when both inputs normalise and every requested item is inside
   * the envelope. A malformed request or envelope is never widened.
   */
  isSubset(request: TInput, envelope: TInput): ScopeSubsetResult;
  /** Maximum `riskOf` over all requested items; `read` for an empty request. */
  classifyRisk(request: TInput): ScopeRisk;
}
