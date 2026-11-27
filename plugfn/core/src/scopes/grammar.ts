import { SCOPE_LIMITS } from './types.js';
import type { NormalizedScope, PublishedScopeDimensions, ScopeDimension, ScopeDimensionKind, ScopeDimensions, ScopeGrammar } from './types.js';
import type { ScopeGrammarDefinition, ScopeItem, ScopeNormalizeResult, ScopeRisk, ScopeShape, ScopeSubsetResult, ScopeViolation } from './types.js';

/** Thrown by `classifyRisk` and `classifyScope` for input they cannot classify. */
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
type Clone = (value: unknown) => unknown;

/**
 * The host's `structuredClone`, resolved once at load and bound, so replacing
 * the global later changes nothing. Untrusted input crosses into the engine
 * only through it; see the trust boundary on `ScopeGrammar`.
 */
const hostClone: Clone | undefined = (() => {
  const candidate: unknown = (globalThis as { structuredClone?: unknown }).structuredClone;
  return typeof candidate === 'function' ? (candidate.bind(globalThis) as Clone) : undefined;
})();

/**
 * The engine's private, frozen view of one dimension. It is never exposed, so
 * nothing a caller does to `grammar.dimensions` can change an evaluation. It
 * has a null prototype and every field is own, so a polluted
 * `Object.prototype` can never supply or change a field.
 */
interface CompiledDimension {
  readonly name: string;
  readonly kind: ScopeDimensionKind;
  /** exactSet: the closed vocabulary, when declared. */
  readonly vocabulary?: ReadonlySet<string>;
  /** numericMax `min`/`max`, or ttlMax `minSeconds`/`maxSeconds`; `integer` is always true for ttlMax. */
  readonly min?: number;
  readonly max?: number;
  readonly integer: boolean;
}

const NOT_PLAIN_DATA = 'scope must be plain data (objects, arrays, strings, finite numbers, booleans, null) without cycles or shared references';
const DIMENSION_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const { maxSetItems: MAX_SET_ITEMS, maxMemberLength: MAX_MEMBER_LENGTH } = SCOPE_LIMITS;
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
const ASYNC_FUNCTION_TAGS: ReadonlySet<string> = new Set(['[object AsyncFunction]', '[object AsyncGeneratorFunction]']);

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A plain object as produced by `structuredClone`: its prototype is exactly
 * `Object.prototype`. A clone of a Map, Set, Date, Error, array or boxed
 * primitive keeps its own prototype and fails this check.
 */
function isCloneRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Whether an engine-owned clone is plain JSON-like data: objects whose
 * prototype is `Object.prototype`, dense arrays without extra keys, strings,
 * finite numbers, booleans and `null`. Anything else a structured clone can
 * hold (a SharedArrayBuffer, which stays shared with the caller, an
 * ArrayBuffer or view, a Map, Set, Date, RegExp, Error, Blob or boxed value,
 * `undefined` or a bigint) fails. Iterative, so depth cannot overflow the call
 * stack, and each object is visited once: a second visit (a cycle or a shared
 * reference) fails, so the walk is linear in the clone's size.
 */
function isPlainData(root: unknown): boolean {
  const seen = new Set<object>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) continue;
      return false;
    }
    if (typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.keys(value).length !== value.length) return false;
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i)) return false;
        pending.push(value[i]);
      }
    } else if (isCloneRecord(value)) {
      for (const key of Object.keys(value)) pending.push(value[key]);
    } else {
      return false;
    }
  }
  return true;
}

/**
 * The members of a cloned array, or why it is not a usable set. The length is
 * checked against {@link SCOPE_LIMITS} before any member is validated (the
 * clone has already copied them), and a hole is rejected rather than skipped.
 */
function readArray(value: unknown): readonly unknown[] | string {
  if (!Array.isArray(value)) return 'must be an array of strings';
  if (value.length > MAX_SET_ITEMS) return `must have at most ${MAX_SET_ITEMS} items`;
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) return `item ${i} is missing`;
  }
  return value;
}

/** Why a value cannot be a member of the given set kind, or `undefined`. */
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
 * An own property of a record, or `undefined`: a value inherited from a
 * (possibly polluted) prototype is never read.
 */
function own(record: object, key: string): unknown {
  return Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined;
}

/** A frozen null-prototype record holding exactly the given own fields. */
function ownRecord<T extends object>(fields: T): T {
  return Object.freeze(Object.assign(Object.create(null) as T, fields));
}

function malformed(side: Side, message: string, dimension?: string, item?: string | number): ScopeViolation {
  return { code: 'malformed', side, message, ...(dimension === undefined ? {} : { dimension }), ...(item === undefined ? {} : { item }) };
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

function compiledDimension(name: string, kind: ScopeDimensionKind, integer: boolean, min?: number, max?: number, vocabulary?: ReadonlySet<string>): CompiledDimension {
  return ownRecord<CompiledDimension>({ name, kind, vocabulary, min, max, integer });
}

/**
 * Compiles one dimension of the cloned definition; options left `undefined`
 * are absent. Only own properties are read, so a polluted prototype can never
 * supply a kind or an option.
 */
function compileDimension(provider: string, name: string, def: unknown): CompileResult {
  const where = `Scope grammar "${provider}": dimension "${name}"`;
  if (!DIMENSION_NAME.test(name)) throw new TypeError(`Scope grammar "${provider}": invalid dimension name "${name}"`);
  if (!isCloneRecord(def)) throw new TypeError(`${where} must be an object`);
  const kind = own(def, 'kind');
  if (typeof kind !== 'string' || !Object.hasOwn(DIMENSION_KEYS, kind)) {
    throw new TypeError(`${where} has unsupported kind ${typeof kind === 'string' ? JSON.stringify(kind) : typeof kind}`);
  }
  const allowed = DIMENSION_KEYS[kind as ScopeDimensionKind];
  for (const key of Object.keys(def)) {
    if (!allowed.has(key)) throw new TypeError(`${where} has unsupported option ${JSON.stringify(key)}`);
  }
  let compiled: CompiledDimension;
  switch (kind as ScopeDimensionKind) {
    case 'exactSet': {
      const values = own(def, 'values');
      if (values === undefined) {
        compiled = compiledDimension(name, 'exactSet', false);
        break;
      }
      const members = readArray(values);
      if (typeof members === 'string') throw new TypeError(`${where} values ${members}`);
      for (const value of members) {
        const reason = invalidMember(value, false);
        if (reason) throw new TypeError(`${where} value ${reason}`);
      }
      compiled = compiledDimension(name, 'exactSet', false, undefined, undefined, new Set(members as string[]));
      break;
    }
    case 'prefixGlobSet':
      compiled = compiledDimension(name, 'prefixGlobSet', false);
      break;
    case 'numericMax': {
      const min = readBound(where, 'min', own(def, 'min'), false);
      const max = readBound(where, 'max', own(def, 'max'), false);
      const integer = own(def, 'integer');
      if (integer !== undefined && typeof integer !== 'boolean') throw new TypeError(`${where} integer must be a boolean`);
      if (min !== undefined && max !== undefined && min > max) throw new TypeError(`${where} min exceeds max`);
      compiled = compiledDimension(name, 'numericMax', integer === true, min, max);
      break;
    }
    case 'ttlMax': {
      const min = readBound(where, 'minSeconds', own(def, 'minSeconds'), true);
      const max = readBound(where, 'maxSeconds', own(def, 'maxSeconds'), true);
      if (min !== undefined && max !== undefined && min > max) throw new TypeError(`${where} minSeconds exceeds maxSeconds`);
      compiled = compiledDimension(name, 'ttlMax', true, min, max);
      break;
    }
  }
  // The validated clone, minus options left undefined; arrays are copied and frozen.
  const published = Object.entries(def).flatMap(([key, value]) => (value === undefined ? [] : [[key, Array.isArray(value) ? Object.freeze([...value]) : value]]));
  return { compiled, published: Object.freeze(Object.fromEntries(published)) as ScopeDimension };
}

function isSetKind(dim: CompiledDimension): boolean {
  return dim.kind === 'exactSet' || dim.kind === 'prefixGlobSet';
}

function parseSet(dim: CompiledDimension, raw: unknown, side: Side, out: ScopeViolation[]): readonly string[] | undefined {
  const members = readArray(raw);
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

/** Validates an engine-owned clone against the grammar. Never widens. */
function parseScope(dims: readonly CompiledDimension[], byName: ReadonlyMap<string, CompiledDimension>, value: unknown, side: Side): ParsedScope | ScopeViolation[] {
  if (!isCloneRecord(value)) return [malformed(side, 'scope must be a plain object')];
  const out: ScopeViolation[] = [];
  for (const key of Object.keys(value)) {
    if (!byName.has(key)) out.push(malformed(side, `unknown dimension ${JSON.stringify(key)}`));
  }
  const scope: ParsedScope = new Map();
  for (const dim of dims) {
    if (!Object.hasOwn(value, dim.name)) {
      if (isSetKind(dim)) scope.set(dim.name, Object.freeze([]));
      else out.push(malformed(side, `dimension "${dim.name}" is required`, dim.name));
      continue;
    }
    const raw = value[dim.name];
    const parsed = isSetKind(dim) ? parseSet(dim, raw, side, out) : parseScalar(dim, raw, side, out);
    if (parsed !== undefined) scope.set(dim.name, parsed);
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
  /**
   * Children in ascending order of their first code unit, searched by
   * bisection: a lookup costs at most 17 comparisons whatever the code units,
   * with no hash function an input could make collide.
   */
  children: RadixNode[] | undefined;
}

function radixNode(source: string, start: number, end: number, terminal: boolean): RadixNode {
  return { source, start, end, terminal, children: undefined };
}

function firstCode(node: RadixNode): number {
  return node.source.charCodeAt(node.start);
}

/**
 * Adds the prefix `prefix[0, length)`. Prefixes must arrive in ascending
 * code-unit order: then a new branch always sorts after its siblings, so the
 * only child it can share an edge with is the last one, and insertion is an
 * append, linear in `length`.
 */
function insertSortedPrefix(root: RadixNode, prefix: string, length: number): void {
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
    const children: RadixNode[] = (node.children ??= []);
    const last = children.length - 1;
    const child = children[last];
    if (!child || firstCode(child) !== code) {
      children.push(radixNode(prefix, i, length, true));
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
      middle.children = [child];
      child.start = j;
      children[last] = middle;
      node = middle;
    } else {
      node = child;
    }
  }
}

/** The child whose edge starts with `code`, by bisection over the sorted children. */
function childFor(children: readonly RadixNode[], code: number): RadixNode | undefined {
  let low = 0;
  let high = children.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const child = children[middle]!;
    const childCode = firstCode(child);
    if (childCode === code) return child;
    if (childCode < code) low = middle + 1;
    else high = middle - 1;
  }
  return undefined;
}

/** Whether some prefix in the trie is a prefix of `body[0, length)`: one bounded step per character. */
function hasPrefixIn(root: RadixNode, body: string, length: number): boolean {
  let node = root;
  let i = 0;
  for (;;) {
    if (node.terminal) return true;
    if (i === length || !node.children) return false;
    const child = childFor(node.children, body.charCodeAt(i));
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
 * of `q`. The envelope prefixes are sorted by code unit and form a radix trie,
 * so every request item is checked with one walk over its own characters, each
 * step a bisection over at most 65,536 siblings: the cost of a lookup does not
 * depend on any hash function, and memory is linear in the number of envelope
 * globs.
 */
function comparePrefixGlob(name: string, request: readonly string[], envelope: readonly string[], out: ScopeViolation[]): void {
  const literals = new Set<string>();
  const prefixes: string[] = [];
  for (const pattern of envelope) {
    if (pattern.endsWith('*')) prefixes.push(pattern.slice(0, -1));
    else literals.add(pattern);
  }
  // Default sort order is ascending UTF-16 code units, the order insertion needs.
  prefixes.sort();
  let trie: RadixNode | undefined;
  for (const prefix of prefixes) insertSortedPrefix((trie ??= radixNode('', 0, 0, false)), prefix, prefix.length);
  for (const item of request) {
    const isGlob = item.endsWith('*');
    if (!isGlob && literals.has(item)) continue;
    const covered = trie !== undefined && hasPrefixIn(trie, item, isGlob ? item.length - 1 : item.length);
    if (!covered) {
      out.push({ code: 'not_in_envelope', side: 'request', dimension: name, item, message: `"${item}" is not covered by the envelope for "${name}"` });
    }
  }
}

function readCallback(provider: string, label: string, value: unknown, optional: boolean): ((arg: never) => unknown) | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'function') throw new TypeError(`Scope grammar "${provider}": ${label} must be a function`);
  if (ASYNC_FUNCTION_TAGS.has(Object.prototype.toString.call(value))) {
    throw new TypeError(`Scope grammar "${provider}": ${label} must be synchronous, not an async function`);
  }
  return value as (arg: never) => unknown;
}

/**
 * A validated scope, or why reading failed; `cause` (a clone or normalize
 * error) is kept for `ScopeError` and never formatted. Built only by
 * {@link parseResult}, so every field is own and none is inherited.
 */
type ParseResult = { readonly scope: ParsedScope | undefined; readonly violations: ScopeViolation[]; readonly cause: unknown };

function parseResult(scope: ParsedScope | undefined, violations: ScopeViolation[], cause?: unknown): ParseResult {
  return ownRecord<ParseResult>({ scope, violations, cause });
}

/**
 * Defines a provider scope grammar. Throws `TypeError` for an invalid
 * definition: any dimension kind outside the closed set, an option the kind
 * does not have, an invalid bound, an async callback, or a runtime without
 * `structuredClone`.
 */
export function defineScopeGrammar<const D extends ScopeDimensions, TInput = ScopeShape<D>>(
  definition: ScopeGrammarDefinition<D, TInput>,
): ScopeGrammar<D, TInput> {
  const clone = hostClone;
  if (!clone) throw new TypeError('Scope grammars need structuredClone, which this runtime does not provide');
  if (typeof definition !== 'object' || definition === null) throw new TypeError('Scope grammar definition must be an object');
  for (const key of Object.keys(definition)) {
    if (!DEFINITION_KEYS.has(key)) throw new TypeError(`Scope grammar definition has unsupported option ${JSON.stringify(key)}`);
  }
  // Own properties only: a polluted prototype never supplies a field or callback.
  const provider = own(definition, 'provider');
  const dimensions = own(definition, 'dimensions');
  if (typeof provider !== 'string' || provider.trim() === '' || hasControlChar(provider)) {
    throw new TypeError('Scope grammar provider must be a non-empty string');
  }
  const normalize = readCallback(provider, 'normalize', own(definition, 'normalize'), true) as ((input: TInput) => unknown) | undefined;
  const riskOf = readCallback(provider, 'riskOf', own(definition, 'riskOf'), false) as (item: ScopeItem<D>) => unknown;

  let dimensionDefs: unknown;
  try {
    dimensionDefs = clone(dimensions);
  } catch (error) {
    throw new TypeError(`Scope grammar "${provider}": dimensions must be plain data`, { cause: error });
  }
  if (!isCloneRecord(dimensionDefs)) throw new TypeError(`Scope grammar "${provider}": dimensions must be an object`);
  const results = Object.keys(dimensionDefs).map(name => compileDimension(provider, name, own(dimensionDefs, name)));
  if (results.length === 0) throw new TypeError(`Scope grammar "${provider}": dimensions must not be empty`);
  const dims: readonly CompiledDimension[] = Object.freeze(results.map(result => result.compiled));
  const byName: ReadonlyMap<string, CompiledDimension> = new Map(dims.map(dim => [dim.name, dim]));
  // Null prototype: a name the grammar does not declare (`toString` included) is absent.
  const publishedDimensions = Object.freeze(
    Object.assign(Object.create(null) as object, Object.fromEntries(results.map(result => [result.compiled.name, result.published]))),
  ) as PublishedScopeDimensions<D>;

  /** The frozen snapshots this grammar returned, with their parsed form, for `classifyScope`. */
  const snapshots = new WeakMap<object, ParsedScope>();
  const snapshot = (scope: ParsedScope): NormalizedScope<D> => {
    const result = Object.create(null) as Record<string, ScopeValue>;
    for (const [name, value] of scope) result[name] = value;
    const frozen = Object.freeze(result);
    snapshots.set(frozen, scope);
    return frozen as NormalizedScope<D>;
  };

  const fail = (side: Side, message: string, cause: unknown): ParseResult => parseResult(undefined, [malformed(side, message)], cause);

  /**
   * Reads one untrusted input: one structured clone, `normalize` on that
   * clone once it is checked to be plain data, one clone of its result, and plain validation of the engine-owned
   * copy. Never throws; messages are fixed and never format a thrown value.
   */
  const parse = (input: TInput, side: Side): ParseResult => {
    let value: unknown;
    try {
      value = clone(input);
    } catch (error) {
      return fail(side, 'scope must be plain data that structuredClone can copy', error);
    }
    if (normalize) {
      // normalize sees only plain JSON-like data: never memory shared with the caller.
      if (!isPlainData(value)) return fail(side, NOT_PLAIN_DATA, undefined);
      let mapped: unknown;
      try {
        mapped = normalize(value as TInput);
      } catch (error) {
        return fail(side, 'normalize threw', error);
      }
      try {
        value = clone(mapped);
      } catch (error) {
        return fail(side, 'normalize must return plain data that structuredClone can copy', error);
      }
    }
    const parsed = parseScope(dims, byName, value, side);
    return Array.isArray(parsed) ? parseResult(undefined, parsed) : parseResult(parsed, []);
  };

  /**
   * Every item is passed to riskOf and validated, even after the highest level
   * is reached, so an invalid result fails whatever the item order.
   */
  const classify = (parsed: ParsedScope): ScopeRisk => {
    let rank = 0;
    for (const dim of dims) {
      const value = parsed.get(dim.name)!;
      for (const item of typeof value === 'number' ? [value] : value) {
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
      }
    }
    return RISK_ORDER[rank] as ScopeRisk;
  };

  const grammar: ScopeGrammar<D, TInput> = {
    provider,
    dimensions: publishedDimensions,

    normalize(input: TInput): ScopeNormalizeResult<D> {
      const { scope, violations } = parse(input, 'request');
      return scope ? { ok: true, scope: snapshot(scope) } : { ok: false, violations };
    },

    isSubset(request: TInput, envelope: TInput): ScopeSubsetResult<D> {
      const req = parse(request, 'request');
      const env = parse(envelope, 'envelope');
      if (!req.scope || !env.scope) return { ok: false, violations: [...req.violations, ...env.violations] };
      const out: ScopeViolation[] = [];
      for (const dim of dims) {
        const requested = req.scope.get(dim.name)!;
        const allowed = env.scope.get(dim.name)!;
        if (dim.kind === 'exactSet') {
          compareExact(dim.name, requested as readonly string[], allowed as readonly string[], out);
        } else if (dim.kind === 'prefixGlobSet') {
          comparePrefixGlob(dim.name, requested as readonly string[], allowed as readonly string[], out);
        } else if ((requested as number) > (allowed as number)) {
          const message = `"${dim.name}" ${String(requested)} exceeds the envelope limit ${String(allowed)}`;
          out.push({ code: 'exceeds_envelope', side: 'request', dimension: dim.name, item: requested as number, limit: allowed as number, message });
        }
      }
      return out.length === 0 ? { ok: true, violations: out, scope: snapshot(req.scope) } : { ok: false, violations: out };
    },

    classifyRisk(request: TInput): ScopeRisk {
      const { scope, violations, cause } = parse(request, 'request');
      if (!scope) throw new ScopeError(`Scope request for "${provider}" does not fit the grammar`, violations, { cause });
      return classify(scope);
    },

    classifyScope(scope: NormalizedScope<D>): ScopeRisk {
      const parsed = typeof scope === 'object' && scope !== null ? snapshots.get(scope) : undefined;
      if (!parsed) throw new ScopeError(`Scope grammar "${provider}": classifyScope accepts only a scope this grammar returned`);
      return classify(parsed);
    },
  };
  return Object.freeze(grammar);
}
