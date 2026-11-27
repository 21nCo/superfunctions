import {
  SCOPE_LIMITS,
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
  type PublishedScopeDimensions,
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
/**
 * Reserved: a promise recognised by {@link isPlainPromise} must have no own
 * `constructor`, so one that has it is always an unknown dimension.
 */
const RESERVED_DIMENSION_NAMES: ReadonlySet<string> = new Set(['constructor']);
const { maxSetItems: MAX_SET_ITEMS, maxMemberLength: MAX_MEMBER_LENGTH } = SCOPE_LIMITS;
/** Longest thrown-error message copied into a violation. */
const MAX_ERROR_MESSAGE_LENGTH = 200;
const UNREADABLE_ERROR = 'an unreadable value was thrown';
/** Private copy of the risk order, independent of the exported array. */
const RISK_ORDER: readonly ScopeRisk[] = Object.freeze(['read', 'write', 'destructive'] as const);
const RISK_RANK: ReadonlyMap<unknown, number> = new Map(RISK_ORDER.map((level, rank) => [level, rank]));

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
  if (value.length > MAX_MEMBER_LENGTH) return `must be at most ${MAX_MEMBER_LENGTH} characters`;
  if (hasControlChar(value)) return 'must not contain control characters';
  const star = value.indexOf('*');
  if (star === -1) return undefined;
  if (!glob) return 'must not contain "*"';
  if (star !== value.length - 1) return 'may contain "*" only as the final character';
  return undefined;
}

/**
 * A short description of a thrown value. Total: it reads `message` once, uses
 * it only when that one read is a primitive string, and otherwise returns a
 * fixed fallback, so formatting a hostile error can never throw.
 */
function describeError(error: unknown): string {
  let message: unknown;
  try {
    message = typeof error === 'string' ? error : error instanceof Error ? error.message : undefined;
  } catch {
    // An unreadable error (for example a Proxy trap or a throwing `message` getter).
    return UNREADABLE_ERROR;
  }
  if (typeof message !== 'string') return UNREADABLE_ERROR;
  return message.length > MAX_ERROR_MESSAGE_LENGTH ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...` : message;
}

/** Marks a key that has no own data property. */
const NO_DATA = Symbol('no own data property');

/**
 * Reads one own data property, once, through its descriptor. Returns
 * {@link NO_DATA} for a missing key, a hole, an inherited value or an
 * accessor, so no getter or Proxy `get` trap ever runs.
 */
function ownData(target: object, key: string | number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : NO_DATA;
}

/**
 * Snapshots an array's members: its own data `length` (a safe integer within
 * {@link SCOPE_LIMITS}) and an own data property at every index below it, each
 * read once. Returns the copy, or why the array is unusable.
 */
function readOwnArray(array: object): unknown[] | string {
  const length = ownData(array, 'length');
  if (!Number.isSafeInteger(length) || (length as number) < 0) return 'has an invalid length';
  if ((length as number) > MAX_SET_ITEMS) return `must have at most ${MAX_SET_ITEMS} items`;
  const items: unknown[] = [];
  for (let i = 0; i < (length as number); i++) {
    const item = ownData(array, i);
    if (item === NO_DATA) return `item ${i} must be an own data property`;
    items.push(item);
  }
  return items;
}

/** Ignores a rejection; see {@link isNativePromise}. */
function ignoreRejection(): void {
  // Intentionally empty: the engine has already rejected the promise as a result.
}

/**
 * Whether a callback result is a native promise, attaching a rejection
 * handler when it can. Never throws.
 *
 * Boundary: `Promise.prototype.then` brand-checks its receiver and then looks
 * up its species constructor (`constructor`, then `Symbol.species`) before it
 * attaches the handler. For a native promise, including a null-prototype one
 * or a well-behaved subclass, the handler is attached, so a rejecting async
 * `normalize` or `riskOf` does not become an unhandled rejection. A promise
 * whose `constructor` or species lookup throws cannot be marked handled
 * without running that code: `then` throws before attaching, the error is
 * swallowed and the value is still rejected as a result, but its own
 * rejection stays the grammar author's responsibility. Pure JavaScript has
 * no trap-free promise brand check that avoids this.
 */
function isNativePromise(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  try {
    Promise.prototype.then.call(value, undefined, ignoreRejection);
    return true;
  } catch {
    // Not a native promise, or a promise whose constructor or species lookup
    // throws (no handler is attached then; see the boundary above). Either
    // way the value is not a valid result and is rejected.
    return false;
  }
}

/**
 * Whether a plain-data scope (prototype `Object.prototype` or `null`) is a
 * native promise, attaching a rejection handler when it is. Runs no caller
 * code: the brand check's species lookup reads `constructor`, which is
 * inherited from `Object.prototype` (or absent) whenever the value has no own
 * `constructor`, and that is checked first. A promise with an own
 * `constructor` is not inspected, because recognising it would read that
 * value; like any other input it is judged by its own data properties, and
 * `constructor` is a reserved name that no grammar can declare, so it is an
 * unknown dimension (`malformed`). Proxy traps may throw; callers catch.
 */
function isPlainPromise(value: object): boolean {
  if (Object.getOwnPropertyDescriptor(value, 'constructor') !== undefined) return false;
  return isNativePromise(value);
}

function malformed(side: Side, message: string, dimension?: string, item?: string | number): ScopeViolation {
  return { code: 'malformed', side, message, ...(dimension === undefined ? {} : { dimension }), ...(item === undefined ? {} : { item }) };
}

/**
 * Reads a definition object's own data properties once, rejecting any key
 * outside `allowed` (when given), symbol keys, accessors and keys listed
 * without a property (a Proxy can list one), so a mistyped
 * option (for example a `max` on a ttlMax dimension) fails at definition time
 * instead of being silently dropped. Keys whose value is `undefined` are kept:
 * callers treat an undefined option as absent, but a dimension entry must be
 * an object, so an undefined dimension fails instead of disappearing.
 */
function readDefinitionFields(where: string, value: object, allowed?: ReadonlySet<string>): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${where} has unsupported option a symbol key`);
    const field = ownData(value, key);
    if (field === NO_DATA) throw new TypeError(`${where} option ${JSON.stringify(key)} must be an own data property`);
    fields.set(key, field);
  }
  if (allowed !== undefined) {
    for (const key of fields.keys()) {
      if (!allowed.has(key)) throw new TypeError(`${where} has unsupported option ${JSON.stringify(key)}`);
    }
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
  if (!DIMENSION_NAME.test(name) || RESERVED_DIMENSION_NAMES.has(name)) {
    throw new TypeError(`Scope grammar "${provider}": invalid dimension name "${name}"`);
  }
  if (!isPlainObject(def)) throw new TypeError(`${where} must be an object`);
  // One read of the definition: `kind` and the options come from the same snapshot.
  const fields = readDefinitionFields(where, def);
  const kind = fields.get('kind');
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(DIMENSION_KEYS, kind)) {
    throw new TypeError(`${where} has unsupported kind ${typeof kind === 'string' ? JSON.stringify(kind) : String(typeof kind)}`);
  }
  for (const key of fields.keys()) {
    if (!DIMENSION_KEYS[kind as ScopeDimensionKind].has(key)) throw new TypeError(`${where} has unsupported option ${JSON.stringify(key)}`);
  }
  const published: Record<string, unknown> = { kind };

  switch (kind as ScopeDimensionKind) {
    case 'exactSet': {
      const values = fields.get('values');
      if (values === undefined) return { compiled: Object.freeze({ name, kind: 'exactSet', integer: false }), published: publish(published) };
      if (!Array.isArray(values)) throw new TypeError(`${where} values must be an array`);
      const members = readOwnArray(values);
      if (typeof members === 'string') throw new TypeError(`${where} values ${members}`);
      const copy: string[] = [];
      for (const value of members) {
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
  const members = readOwnArray(raw);
  if (typeof members === 'string') {
    out.push(malformed(side, `dimension "${dim.name}" ${members}`, dim.name));
    return undefined;
  }
  const glob = dim.kind === 'prefixGlobSet';
  const seen = new Set<string>();
  const before = out.length;
  for (let i = 0; i < members.length; i++) {
    const value = members[i];
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

/**
 * Validates a normalised scope against the grammar. Never widens. Reads each
 * listed key once, through its own data descriptor, and decides only from that
 * snapshot. May throw on hostile input (a throwing Proxy trap); see `parse`.
 */
function parseScope(dims: readonly CompiledDimension[], byName: ReadonlyMap<string, CompiledDimension>, raw: unknown, side: Side): ParsedScope | ScopeViolation[] {
  if (!isPlainObject(raw)) return [malformed(side, 'scope must be a plain object')];
  const out: ScopeViolation[] = [];
  const listed = new Set<string>();
  const fields = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !byName.has(key)) {
      out.push(malformed(side, `unknown dimension ${typeof key === 'string' ? JSON.stringify(key) : 'with a symbol key'}`));
      continue;
    }
    listed.add(key);
    const value = ownData(raw, key);
    if (value === NO_DATA) out.push(malformed(side, `dimension "${key}" must be an own data property`, key));
    else fields.set(key, value);
  }
  const scope: ParsedScope = new Map();
  for (const dim of dims) {
    if (!fields.has(dim.name)) {
      if (listed.has(dim.name)) continue;
      if (isSetKind(dim)) scope.set(dim.name, Object.freeze([]));
      else out.push(malformed(side, `dimension "${dim.name}" is required`, dim.name));
      continue;
    }
    const field = fields.get(dim.name);
    const value = isSetKind(dim) ? parseSet(dim, field, side, out) : parseScalar(dim, field, side, out);
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

/**
 * A node of a compressed (radix) trie over the envelope's glob prefixes. The
 * edge into a node is `source[start, end)`: a range of an envelope string, not
 * a copy. Every node but the root ends at least one edge with two or more
 * children or at a prefix, so the trie has at most two nodes per prefix and
 * its memory does not grow with prefix length.
 */
interface RadixNode {
  source: string;
  start: number;
  end: number;
  /** Some envelope prefix ends at this node; it covers everything below. */
  terminal: boolean;
  children: Map<number, RadixNode> | undefined;
}

function radixNode(source: string, start: number, end: number, terminal: boolean): RadixNode {
  return { source, start, end, terminal, children: undefined };
}

/** Adds the prefix `prefix[0, length)`. Linear in `length`. */
function insertPrefix(root: RadixNode, prefix: string, length: number): void {
  let node = root;
  let i = 0;
  for (;;) {
    if (node.terminal) return;
    if (i === length) {
      // A shorter prefix covers everything below it; drop the subtree.
      node.terminal = true;
      node.children = undefined;
      return;
    }
    const code = prefix.charCodeAt(i);
    const children: Map<number, RadixNode> = (node.children ??= new Map());
    const child = children.get(code);
    if (!child) {
      children.set(code, radixNode(prefix, i, length, true));
      return;
    }
    let j = child.start;
    while (j < child.end && i < length && child.source.charCodeAt(j) === prefix.charCodeAt(i)) {
      j++;
      i++;
    }
    if (j < child.end) {
      // Split the edge where the new prefix leaves it (or ends inside it).
      const middle = radixNode(child.source, child.start, j, false);
      middle.children = new Map([[child.source.charCodeAt(j), child]]);
      child.start = j;
      children.set(code, middle);
      node = middle;
    } else {
      node = child;
    }
  }
}

/** Whether some prefix in the trie is a prefix of `body[0, length)`: at most `length` steps. */
function hasPrefixIn(root: RadixNode, body: string, length: number): boolean {
  let node = root;
  let i = 0;
  for (;;) {
    if (node.terminal) return true;
    if (i === length || !node.children) return false;
    const child = node.children.get(body.charCodeAt(i));
    if (!child) return false;
    for (let j = child.start; j < child.end; j++, i++) {
      if (i === length || child.source.charCodeAt(j) !== body.charCodeAt(i)) return false;
    }
    node = child;
  }
}

/**
 * A literal `v` is covered by the literal `v` or by a glob `p*` with `p` a
 * prefix of `v`. A glob `q*` is covered only by a glob `p*` with `p` a prefix
 * of `q`. The envelope prefixes form a radix trie, so every request item is
 * checked with one walk over its own characters: time is linear in the input
 * size whatever the strings look like, and memory is linear in the number of
 * envelope globs.
 */
function comparePrefixGlob(name: string, request: readonly string[], envelope: readonly string[], out: ScopeViolation[]): void {
  const literals = new Set<string>();
  let trie: RadixNode | undefined;
  for (const pattern of envelope) {
    if (pattern.endsWith('*')) insertPrefix((trie ??= radixNode('', 0, 0, false)), pattern, pattern.length - 1);
    else literals.add(pattern);
  }
  for (const item of request) {
    const isGlob = item.endsWith('*');
    if (!isGlob && literals.has(item)) continue;
    const covered = trie !== undefined && hasPrefixIn(trie, item, isGlob ? item.length - 1 : item.length);
    if (!covered) {
      out.push({ code: 'not_in_envelope', side: 'request', dimension: name, item, message: `"${item}" is not covered by the envelope for "${name}"` });
    }
  }
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
  // Null prototype: a name the grammar does not declare (`toString` included) is absent.
  const publishedDimensions = Object.freeze(
    Object.assign(Object.create(null) as object, Object.fromEntries(results.map(result => [result.compiled.name, result.published]))),
  ) as PublishedScopeDimensions<D>;

  /** The frozen snapshots this grammar returned, with their parsed form, for `classifyScope`. */
  const snapshots = new WeakMap<object, ParsedScope>();
  const snapshot = (scope: ParsedScope): NormalizedScope<D> => {
    // Null prototype: a name the grammar does not declare (`toString` included) is absent.
    const result = Object.create(null) as Record<string, ScopeValue>;
    for (const [name, value] of scope) result[name] = value;
    const frozen = Object.freeze(result);
    snapshots.set(frozen, scope);
    return frozen as NormalizedScope<D>;
  };

  /**
   * Normalises and validates one input. Every failure, including a throwing
   * or asynchronous normalizer, getter or Proxy trap, becomes a `malformed`
   * violation.
   */
  const parse = (input: TInput, side: Side): ParsedScope | ScopeViolation[] => {
    let raw: unknown;
    try {
      raw = normalize ? normalize(input) : input;
    } catch (error) {
      return [malformed(side, `normalize failed: ${describeError(error)}`)];
    }
    if (normalize && isNativePromise(raw)) {
      return [malformed(side, 'normalize returned a promise; it must return a scope synchronously')];
    }
    try {
      // With or without normalize: a promise reparented to a plain prototype
      // is still a promise, never a scope, whatever own data it carries.
      if (isPlainObject(raw) && isPlainPromise(raw)) {
        return [malformed(side, 'scope must be plain data, not a promise')];
      }
      return parseScope(dims, byName, raw, side);
    } catch (error) {
      return [malformed(side, `scope could not be read: ${describeError(error)}`)];
    }
  };

  /**
   * Every item is passed to riskOf and validated, even after the highest level
   * is reached, so an invalid result fails whatever the item order.
   */
  const classify = (parsed: ParsedScope): ScopeRisk => {
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
        if (isNativePromise(risk)) {
          throw new ScopeError(`Scope grammar "${provider}": riskOf returned a promise for dimension "${dim.name}"; it must return a risk synchronously`);
        }
        const itemRank = RISK_RANK.get(risk);
        if (itemRank === undefined) {
          throw new ScopeError(`Scope grammar "${provider}": riskOf returned an unknown risk for dimension "${dim.name}"`);
        }
        if (itemRank > rank) rank = itemRank;
      }
    }
    return RISK_ORDER[rank] as ScopeRisk;
  };

  const grammar: ScopeGrammar<D, TInput> = {
    provider,
    dimensions: publishedDimensions,

    normalize(input: TInput): ScopeNormalizeResult<D> {
      const parsed = parse(input, 'request');
      return Array.isArray(parsed) ? { ok: false, violations: parsed } : { ok: true, scope: snapshot(parsed) };
    },

    isSubset(request: TInput, envelope: TInput): ScopeSubsetResult<D> {
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
      return out.length === 0 ? { ok: true, violations: out, scope: snapshot(req) } : { ok: false, violations: out };
    },

    classifyRisk(request: TInput): ScopeRisk {
      const parsed = parse(request, 'request');
      if (Array.isArray(parsed)) throw new ScopeError(`Scope request for "${provider}" does not fit the grammar`, parsed);
      return classify(parsed);
    },

    classifyScope(scope: NormalizedScope<D>): ScopeRisk {
      const parsed = typeof scope === 'object' && scope !== null ? snapshots.get(scope) : undefined;
      if (!parsed) throw new ScopeError(`Scope grammar "${provider}": classifyScope accepts only a scope this grammar returned`);
      return classify(parsed);
    },
  };
  return Object.freeze(grammar);
}
