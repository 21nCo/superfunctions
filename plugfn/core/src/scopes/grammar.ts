import {
  type NormalizedScope,
  type ScopeDimension,
  type ScopeDimensionKind,
  type ScopeDimensions,
  type ScopeGrammar,
  type ScopeGrammarDefinition,
  type ScopeItem,
  type ScopeNormalizeResult,
  type ScopeRisk,
  type ScopeShape,
  type ScopeSubsetResult,
  type ScopeViolation,
} from './types.js';

/** Thrown by `classifyRisk` for input it cannot classify. */
export class ScopeError extends Error {
  readonly violations: readonly ScopeViolation[];

  constructor(message: string, violations: readonly ScopeViolation[] = [], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ScopeError';
    this.violations = violations;
  }
}

type Side = ScopeViolation['side'];
type ScopeValue = readonly string[] | number;
type ParsedScope = Map<string, ScopeValue>;

/**
 * The engine's private, frozen view of one dimension. It is never exposed, so
 * nothing a caller does to `grammar.dimensions` can change an evaluation.
 */
interface CompiledDimension {
  readonly name: string;
  readonly kind: ScopeDimensionKind;
  /** exactSet: the closed vocabulary, when declared. */
  readonly vocabulary?: ReadonlySet<string>;
  /** numericMax `min`/`max`, or ttlMax `minSeconds`/`maxSeconds`. */
  readonly min?: number;
  readonly max?: number;
  /** numericMax: require a safe integer. ttlMax: always true. */
  readonly integer: boolean;
}

const DIMENSION_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
/** Private copy of the risk order, independent of the exported array. */
const RISK_ORDER: readonly ScopeRisk[] = Object.freeze(['read', 'write', 'destructive'] as const);
const RISK_RANK: ReadonlyMap<unknown, number> = new Map(RISK_ORDER.map((level, rank) => [level, rank]));
const DESTRUCTIVE_RANK = RISK_ORDER.length - 1;

/** The keys each dimension kind accepts; anything else is a definition error. */
const DIMENSION_KEYS: Readonly<Record<ScopeDimensionKind, ReadonlySet<string>>> = Object.freeze({
  exactSet: new Set(['kind', 'values']),
  prefixGlobSet: new Set(['kind']),
  numericMax: new Set(['kind', 'min', 'max', 'integer']),
  ttlMax: new Set(['kind', 'minSeconds', 'maxSeconds']),
});
const DEFINITION_KEYS: ReadonlySet<string> = new Set(['provider', 'dimensions', 'normalize', 'riskOf']);

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Why a string cannot be a member of the given set kind, or `undefined`. */
function invalidMember(value: unknown, glob: boolean): string | undefined {
  if (typeof value !== 'string') return 'must be a string';
  if (value.length === 0) return 'must not be empty';
  if (hasControlChar(value)) return 'must not contain control characters';
  const star = value.indexOf('*');
  if (star === -1) return undefined;
  if (!glob) return 'must not contain "*"';
  if (star !== value.length - 1) return 'may contain "*" only as the final character';
  return undefined;
}

/** A short description of a thrown value that cannot itself throw. */
function describeError(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message;
    if (typeof error === 'string') return error;
  } catch {
    // An unreadable error (for example a Proxy or a throwing `message` getter).
  }
  return 'an unreadable value was thrown';
}

function malformed(side: Side, message: string, dimension?: string, item?: string | number): ScopeViolation {
  return { code: 'malformed', side, message, ...(dimension === undefined ? {} : { dimension }), ...(item === undefined ? {} : { item }) };
}

/**
 * Reads a definition object's own data properties, rejecting any key outside
 * `allowed` (when given), symbol keys and accessors, so a mistyped option (for example a
 * `max` on a ttlMax dimension) fails at definition time instead of being
 * silently dropped.
 */
function readDefinitionFields(where: string, value: object, allowed?: ReadonlySet<string>): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (allowed !== undefined && !allowed.has(key))) {
      throw new TypeError(`${where} has unsupported option ${typeof key === 'string' ? JSON.stringify(key) : 'a symbol key'}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) throw new TypeError(`${where} option "${key}" must be a data property`);
    if (descriptor.value !== undefined) fields.set(key, descriptor.value);
  }
  return fields;
}

function readBound(where: string, label: string, value: unknown, positiveInteger: boolean): number | undefined {
  if (value === undefined) return undefined;
  const ok = positiveInteger
    ? Number.isSafeInteger(value) && (value as number) > 0
    : typeof value === 'number' && Number.isFinite(value);
  if (!ok) throw new TypeError(`${where} ${label} must be ${positiveInteger ? 'a positive integer' : 'a finite number'}`);
  return value as number;
}

interface CompileResult {
  readonly compiled: CompiledDimension;
  /** Frozen copy of the definition as given, for `grammar.dimensions`. */
  readonly published: ScopeDimension;
}

function publish(fields: Record<string, unknown>): ScopeDimension {
  return Object.freeze(fields) as unknown as ScopeDimension;
}

function compileDimension(provider: string, name: string, def: unknown): CompileResult {
  const where = `Scope grammar "${provider}": dimension "${name}"`;
  if (!DIMENSION_NAME.test(name)) {
    throw new TypeError(`Scope grammar "${provider}": invalid dimension name "${name}"`);
  }
  if (!isPlainObject(def)) throw new TypeError(`${where} must be an object`);
  const kindDescriptor = Object.getOwnPropertyDescriptor(def, 'kind');
  const kind: unknown = kindDescriptor && 'value' in kindDescriptor ? kindDescriptor.value : undefined;
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(DIMENSION_KEYS, kind)) {
    throw new TypeError(`${where} has unsupported kind ${typeof kind === 'string' ? JSON.stringify(kind) : String(typeof kind)}`);
  }
  const fields = readDefinitionFields(where, def, DIMENSION_KEYS[kind as ScopeDimensionKind]);
  const published: Record<string, unknown> = { kind };

  switch (kind as ScopeDimensionKind) {
    case 'exactSet': {
      const values = fields.get('values');
      if (values === undefined) return { compiled: Object.freeze({ name, kind: 'exactSet', integer: false }), published: publish(published) };
      if (!Array.isArray(values)) throw new TypeError(`${where} values must be an array`);
      const copy: string[] = [];
      for (let i = 0; i < values.length; i++) {
        const value: unknown = values[i];
        const reason = invalidMember(value, false);
        if (reason) throw new TypeError(`${where} value ${reason}`);
        copy.push(value as string);
      }
      published.values = Object.freeze(copy);
      return {
        compiled: Object.freeze({ name, kind: 'exactSet', integer: false, vocabulary: new Set(copy) }),
        published: publish(published),
      };
    }
    case 'prefixGlobSet':
      return { compiled: Object.freeze({ name, kind: 'prefixGlobSet', integer: false }), published: publish(published) };
    case 'numericMax': {
      const min = readBound(where, 'min', fields.get('min'), false);
      const max = readBound(where, 'max', fields.get('max'), false);
      const integer = fields.get('integer');
      if (integer !== undefined && typeof integer !== 'boolean') throw new TypeError(`${where} integer must be a boolean`);
      if (min !== undefined && max !== undefined && min > max) throw new TypeError(`${where} min exceeds max`);
      if (min !== undefined) published.min = min;
      if (max !== undefined) published.max = max;
      if (integer !== undefined) published.integer = integer;
      return {
        compiled: Object.freeze({ name, kind: 'numericMax', min, max, integer: integer === true }),
        published: publish(published),
      };
    }
    case 'ttlMax': {
      const min = readBound(where, 'minSeconds', fields.get('minSeconds'), true);
      const max = readBound(where, 'maxSeconds', fields.get('maxSeconds'), true);
      if (min !== undefined && max !== undefined && min > max) throw new TypeError(`${where} minSeconds exceeds maxSeconds`);
      if (min !== undefined) published.minSeconds = min;
      if (max !== undefined) published.maxSeconds = max;
      return {
        compiled: Object.freeze({ name, kind: 'ttlMax', min, max, integer: true }),
        published: publish(published),
      };
    }
  }
}

function isSetKind(dim: CompiledDimension): boolean {
  return dim.kind === 'exactSet' || dim.kind === 'prefixGlobSet';
}

function parseSet(dim: CompiledDimension, raw: unknown, side: Side, out: ScopeViolation[]): readonly string[] | undefined {
  if (!Array.isArray(raw)) {
    out.push(malformed(side, `dimension "${dim.name}" must be an array of strings`, dim.name));
    return undefined;
  }
  const glob = dim.kind === 'prefixGlobSet';
  const seen = new Set<string>();
  const before = out.length;
  const length = raw.length;
  for (let i = 0; i < length; i++) {
    const value: unknown = raw[i];
    const reason = invalidMember(value, glob);
    if (reason) {
      out.push(malformed(side, `dimension "${dim.name}" item ${i} ${reason}`, dim.name, typeof value === 'string' ? value : undefined));
    } else if (dim.vocabulary && !dim.vocabulary.has(value as string)) {
      out.push(malformed(side, `dimension "${dim.name}" item ${i} is not in the grammar`, dim.name, value as string));
    } else {
      seen.add(value as string);
    }
  }
  return out.length === before ? Object.freeze([...seen]) : undefined;
}

function parseScalar(dim: CompiledDimension, raw: unknown, side: Side, out: ScopeViolation[]): number | undefined {
  const ttl = dim.kind === 'ttlMax';
  const unit = ttl ? ' seconds' : '';
  let reason: string | undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) reason = 'must be a finite number';
  else if (ttl && (!Number.isSafeInteger(raw) || raw <= 0)) reason = 'must be a positive whole number of seconds';
  else if (dim.integer && !Number.isSafeInteger(raw)) reason = 'must be an integer';
  else if (dim.min !== undefined && raw < dim.min) reason = `must be at least ${dim.min}${unit}`;
  else if (dim.max !== undefined && raw > dim.max) reason = `must be at most ${dim.max}${unit}`;
  if (reason) {
    out.push(malformed(side, `dimension "${dim.name}" ${reason}`, dim.name, typeof raw === 'number' ? raw : undefined));
    return undefined;
  }
  return raw as number;
}

/** Validates a normalised scope against the grammar. Never widens. May throw on hostile input; see `parse`. */
function parseScope(dims: readonly CompiledDimension[], byName: ReadonlyMap<string, CompiledDimension>, raw: unknown, side: Side): ParsedScope | ScopeViolation[] {
  if (!isPlainObject(raw)) return [malformed(side, 'scope must be a plain object')];
  const out: ScopeViolation[] = [];
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !byName.has(key)) {
      out.push(malformed(side, `unknown dimension ${typeof key === 'string' ? JSON.stringify(key) : 'with a symbol key'}`));
    }
  }
  const scope: ParsedScope = new Map();
  for (const dim of dims) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, dim.name);
    if (!descriptor) {
      if (isSetKind(dim)) scope.set(dim.name, Object.freeze([]));
      else out.push(malformed(side, `dimension "${dim.name}" is required`, dim.name));
      continue;
    }
    if (!('value' in descriptor)) {
      out.push(malformed(side, `dimension "${dim.name}" must be a data property`, dim.name));
      continue;
    }
    const value = isSetKind(dim) ? parseSet(dim, descriptor.value, side, out) : parseScalar(dim, descriptor.value, side, out);
    if (value !== undefined) scope.set(dim.name, value);
  }
  return out.length > 0 ? out : scope;
}

function compareExact(name: string, request: readonly string[], envelope: readonly string[], out: ScopeViolation[]): void {
  const allowed = new Set(envelope);
  for (const item of request) {
    if (!allowed.has(item)) {
      out.push({ code: 'not_in_envelope', side: 'request', dimension: name, item, message: `"${item}" is not in the envelope for "${name}"` });
    }
  }
}

/** A character trie over the envelope's glob prefixes. */
interface PrefixNode {
  /** Some envelope prefix ends at this node. */
  end: boolean;
  next: Map<number, PrefixNode> | undefined;
}

function buildPrefixTrie(prefixes: readonly string[]): PrefixNode {
  const root: PrefixNode = { end: false, next: undefined };
  for (const prefix of prefixes) {
    let node = root;
    for (let i = 0; i < prefix.length && !node.end; i++) {
      const code = prefix.charCodeAt(i);
      const next = (node.next ??= new Map());
      let child = next.get(code);
      if (!child) {
        child = { end: false, next: undefined };
        next.set(code, child);
      }
      node = child;
    }
    // A shorter prefix already covers everything below it; drop the subtree.
    node.end = true;
    node.next = undefined;
  }
  return root;
}

/** Whether some envelope prefix is a prefix of `body`: one walk, at most `body.length` steps. */
function hasPrefixIn(root: PrefixNode, body: string): boolean {
  let node: PrefixNode | undefined = root;
  for (let i = 0; ; i++) {
    if (node.end) return true;
    if (i === body.length || !node.next) return false;
    node = node.next.get(body.charCodeAt(i));
    if (!node) return false;
  }
}

/**
 * A literal `v` is covered by the literal `v` or by a glob `p*` with `p` a
 * prefix of `v`. A glob `q*` is covered only by a glob `p*` with `p` a prefix
 * of `q`. The envelope prefixes form a character trie, so every request item
 * is checked with one walk over its own characters, and the whole comparison
 * is linear in the input size whatever the strings look like.
 */
function comparePrefixGlob(name: string, request: readonly string[], envelope: readonly string[], out: ScopeViolation[]): void {
  const literals = new Set<string>();
  const prefixes: string[] = [];
  for (const pattern of envelope) {
    if (pattern.endsWith('*')) prefixes.push(pattern.slice(0, -1));
    else literals.add(pattern);
  }
  const trie = prefixes.length > 0 ? buildPrefixTrie(prefixes) : undefined;
  for (const item of request) {
    const isGlob = item.endsWith('*');
    if (!isGlob && literals.has(item)) continue;
    const covered = trie !== undefined && hasPrefixIn(trie, isGlob ? item.slice(0, -1) : item);
    if (!covered) {
      out.push({ code: 'not_in_envelope', side: 'request', dimension: name, item, message: `"${item}" is not covered by the envelope for "${name}"` });
    }
  }
}

function toNormalized<D extends ScopeDimensions>(scope: ParsedScope): NormalizedScope<D> {
  const result: Record<string, ScopeValue> = {};
  for (const [name, value] of scope) result[name] = value;
  return Object.freeze(result) as NormalizedScope<D>;
}

/**
 * Defines a provider scope grammar. Throws `TypeError` for an invalid
 * definition: any dimension kind outside the closed set, an option the kind
 * does not have, or an invalid bound.
 */
export function defineScopeGrammar<const D extends ScopeDimensions, TInput = ScopeShape<D>>(
  definition: ScopeGrammarDefinition<D, TInput>,
): ScopeGrammar<D, TInput> {
  if (!isPlainObject(definition)) throw new TypeError('Scope grammar definition must be an object');
  const fields = readDefinitionFields('Scope grammar definition', definition, DEFINITION_KEYS);
  const provider = fields.get('provider');
  const dimensions = fields.get('dimensions');
  const normalize = fields.get('normalize') as ((input: TInput) => unknown) | undefined;
  const riskOf = fields.get('riskOf') as ((item: ScopeItem<D>) => unknown) | undefined;
  if (typeof provider !== 'string' || provider.trim() === '' || hasControlChar(provider)) {
    throw new TypeError('Scope grammar provider must be a non-empty string');
  }
  if (!isPlainObject(dimensions)) throw new TypeError(`Scope grammar "${provider}": dimensions must be an object`);
  if (normalize !== undefined && typeof normalize !== 'function') {
    throw new TypeError(`Scope grammar "${provider}": normalize must be a function`);
  }
  if (typeof riskOf !== 'function') throw new TypeError(`Scope grammar "${provider}": riskOf must be a function`);

  const dimensionDefs = readDefinitionFields(`Scope grammar "${provider}": dimensions`, dimensions);
  if (dimensionDefs.size === 0) throw new TypeError(`Scope grammar "${provider}": dimensions must not be empty`);
  const results = [...dimensionDefs].map(([name, def]) => compileDimension(provider, name, def));
  const dims: readonly CompiledDimension[] = Object.freeze(results.map(result => result.compiled));
  const byName: ReadonlyMap<string, CompiledDimension> = new Map(dims.map(dim => [dim.name, dim]));
  const publishedDimensions = Object.freeze(Object.fromEntries(results.map(result => [result.compiled.name, result.published]))) as Readonly<D>;

  /**
   * Normalises and validates one input. Every failure, including a throwing
   * normalizer, getter or Proxy trap, becomes a `malformed` violation.
   */
  const parse = (input: TInput, side: Side): ParsedScope | ScopeViolation[] => {
    let raw: unknown;
    try {
      raw = normalize ? normalize(input) : input;
    } catch (error) {
      return [malformed(side, `normalize failed: ${describeError(error)}`)];
    }
    try {
      return parseScope(dims, byName, raw, side);
    } catch (error) {
      return [malformed(side, `scope could not be read: ${describeError(error)}`)];
    }
  };

  const grammar: ScopeGrammar<D, TInput> = {
    provider,
    dimensions: publishedDimensions,

    normalize(input: TInput): ScopeNormalizeResult<D> {
      const parsed = parse(input, 'request');
      return Array.isArray(parsed) ? { ok: false, violations: parsed } : { ok: true, scope: toNormalized<D>(parsed) };
    },

    isSubset(request: TInput, envelope: TInput): ScopeSubsetResult {
      const req = parse(request, 'request');
      const env = parse(envelope, 'envelope');
      if (Array.isArray(req) || Array.isArray(env)) {
        return { ok: false, violations: [...(Array.isArray(req) ? req : []), ...(Array.isArray(env) ? env : [])] };
      }
      const out: ScopeViolation[] = [];
      for (const dim of dims) {
        const requested = req.get(dim.name)!;
        const allowed = env.get(dim.name)!;
        if (dim.kind === 'exactSet') {
          compareExact(dim.name, requested as readonly string[], allowed as readonly string[], out);
        } else if (dim.kind === 'prefixGlobSet') {
          comparePrefixGlob(dim.name, requested as readonly string[], allowed as readonly string[], out);
        } else if ((requested as number) > (allowed as number)) {
          out.push({
            code: 'exceeds_envelope',
            side: 'request',
            dimension: dim.name,
            item: requested as number,
            limit: allowed as number,
            message: `"${dim.name}" ${String(requested)} exceeds the envelope limit ${String(allowed)}`,
          });
        }
      }
      return { ok: out.length === 0, violations: out };
    },

    classifyRisk(request: TInput): ScopeRisk {
      const parsed = parse(request, 'request');
      if (Array.isArray(parsed)) throw new ScopeError(`Scope request for "${provider}" does not fit the grammar`, parsed);
      let rank = 0;
      for (const dim of dims) {
        const value = parsed.get(dim.name)!;
        const items = typeof value === 'number' ? [value] : value;
        for (const item of items) {
          let risk: unknown;
          try {
            risk = riskOf(Object.freeze({ dimension: dim.name, kind: dim.kind, value: item }) as ScopeItem<D>);
          } catch (error) {
            throw new ScopeError(`Scope grammar "${provider}": riskOf failed for dimension "${dim.name}"`, [], { cause: error });
          }
          const itemRank = RISK_RANK.get(risk);
          if (itemRank === undefined) {
            throw new ScopeError(`Scope grammar "${provider}": riskOf returned an unknown risk for dimension "${dim.name}"`);
          }
          if (itemRank > rank) rank = itemRank;
          if (rank === DESTRUCTIVE_RANK) return RISK_ORDER[rank] as ScopeRisk;
        }
      }
      return RISK_ORDER[rank] as ScopeRisk;
    },
  };
  return Object.freeze(grammar);
}
