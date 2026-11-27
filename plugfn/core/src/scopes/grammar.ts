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

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
/** A control character or `*`: one scan finds the first character a member needs a rule for. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const SPECIAL_CHAR = /[\u0000-\u001f\u007f*]/;

function hasControlChar(value: string): boolean {
  return CONTROL_CHAR.test(value);
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
 * Where an engine-owned clone stops being plain JSON-like data: `undefined`
 * when it is plain, the top-level key whose value is not, or `null` for the
 * root itself. Plain data is objects whose prototype is `Object.prototype`,
 * dense arrays without extra keys, strings, finite numbers, booleans and
 * `null`. Anything else a structured clone can hold (a SharedArrayBuffer,
 * which stays shared with the caller, an ArrayBuffer or view, a Map, Set,
 * Date, RegExp, Error, Blob or boxed value, `undefined` or a bigint) is not.
 * Iterative, so depth cannot overflow the call stack, and each object is
 * visited once: a second visit (a cycle or a shared reference) fails, so the
 * walk is linear in the clone's size.
 */
function notPlainAt(root: unknown): string | null | undefined {
  const seen = new Set<object>();
  // Objects still to visit, each with the top-level key it sits under.
  const pending: [object, string | null][] = [];
  /** Whether `value` is a plain leaf, or queues it; `false` when it can never be plain. */
  const accept = (value: unknown, at: string | null): boolean => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    pending.push([value, at]);
    return true;
  };
  if (!accept(root, null)) return null;
  while (pending.length > 0) {
    const [value, at] = pending.pop()!;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.keys(value).length !== value.length) return at;
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i) || !accept(value[i], at)) return at;
      }
    } else if (isCloneRecord(value)) {
      for (const key of Object.keys(value)) {
        const under = value === root ? key : at;
        if (!accept(value[key], under)) return under;
      }
    } else {
      return at;
    }
  }
  return undefined;
}

/**
 * The members of a cloned array, or why it is not a usable set. The length is
 * checked against {@link SCOPE_LIMITS} before any member is validated (the
 * clone has already copied them), and a hole is rejected rather than skipped.
 * Scope input reaches this only after {@link notPlainAt}; the definition's
 * `values` arrive here directly.
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
  const special = value.search(SPECIAL_CHAR);
  if (special === -1) return undefined;
  // The first special character is a control character or `*`; after a `*`
  // only a non-final one can be followed by a control character.
  const final = special === value.length - 1;
  if (value.charCodeAt(special) !== 0x2a || (!final && hasControlChar(value.slice(special + 1)))) return 'must not contain control characters';
  if (!glob) return 'must not contain "*"';
  if (!final) return 'may contain "*" only as the final character';
  return undefined;
}

/**
 * An own property of a record, or `undefined`: a value inherited from a
 * (possibly polluted) prototype is never read.
 */
function own(record: object, key: string): unknown {
  return Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined;
}

const PLAIN_DEFINITION = 'must be plain data: objects with a prototype of Object.prototype or null, arrays, and only enumerable string-keyed data properties (no getters or setters)';

/**
 * The own data properties of one trusted definition object, read once through
 * its descriptors into a null-prototype record. Throws unless the object is
 * plain: a prototype of exactly `Object.prototype` or `null` (or
 * `Array.prototype` for an array) and only enumerable string-keyed data
 * properties. Nothing is inherited and no getter runs, so the record is exactly
 * the data the author wrote. `structuredClone` would silently drop an
 * inherited, non-enumerable or symbol-keyed property or a prototype accessor,
 * and a dropped bound or dimension would weaken the grammar the types describe.
 */
function readDefinitionData(where: string, value: object): Record<string, unknown> {
  const isArray = Array.isArray(value);
  const proto: unknown = Object.getPrototypeOf(value);
  if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new TypeError(`${where} ${PLAIN_DEFINITION}`);
  // Bound the descriptor read: no definition array may exceed the set limit.
  if (isArray && (value as unknown[]).length > MAX_SET_ITEMS) throw new TypeError(`${where} arrays must have at most ${MAX_SET_ITEMS} items`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const data = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors] as PropertyDescriptor;
    const arrayLength = isArray && key === 'length';
    if (typeof key !== 'string' || !('value' in descriptor) || !(descriptor.enumerable === true || arrayLength)) {
      throw new TypeError(`${where} ${PLAIN_DEFINITION}`);
    }
    if (!arrayLength) data[key] = descriptor.value;
  }
  return data;
}

/**
 * Checks a trusted definition subtree (the `dimensions` object, its entries
 * and their options) with {@link readDefinitionData} before it is cloned:
 * with no accessor anywhere, the clone runs no author code and copies exactly
 * the data checked here. A Proxy or function still fails in the clone.
 */
function assertPlainDefinition(where: string, root: unknown): void {
  const seen = new Set<object>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    for (const member of Object.values(readDefinitionData(where, value))) pending.push(member);
  }
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
  // Only the request is deduplicated (it becomes the snapshot); the envelope
  // is engine-owned and read only by the comparisons.
  const seen = side === 'request' ? new Set<string>() : undefined;
  const before = out.length;
  for (let i = 0; i < members.length; i++) {
    const value = members[i];
    const reason = invalidMember(value, glob);
    if (reason) {
      out.push(malformed(side, `dimension "${dim.name}" item ${i} ${reason}`, dim.name, typeof value === 'string' ? value : undefined));
    } else if (dim.vocabulary && !dim.vocabulary.has(value as string)) {
      out.push(malformed(side, `dimension "${dim.name}" item ${i} is not in the grammar`, dim.name, value as string));
    } else {
      seen?.add(value as string);
    }
  }
  if (out.length !== before) return undefined;
  return seen ? Object.freeze([...seen]) : (members as readonly string[]);
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
 * A node of a compressed 16-ary radix trie over the envelope's glob prefixes,
 * keyed by nibble: each UTF-16 code unit is four 4-bit digits, most
 * significant first. A node at nibble depth `end` holds the prefix
 * `source[0, end)` in nibbles, where `source` is the envelope glob that
 * created it (a reference, not a copy). Every node but the root is a branch
 * point or ends a prefix, so the trie has at most two nodes per prefix and its
 * memory does not grow with prefix length.
 */
interface RadixNode {
  readonly source: string;
  /** Nibble depth of this node, so `source[0, end)` is its whole path. */
  readonly end: number;
  /** Some envelope prefix ends at this node; it covers everything below. */
  terminal: boolean;
  /**
   * Children indexed by the next nibble: 16 slots, allocated when the node
   * first branches. A child lookup is one array index, with no comparison or
   * hash function an input could make slow.
   */
  children: (RadixNode | undefined)[] | undefined;
}

function radixNode(source: string, end: number, terminal: boolean): RadixNode {
  return { source, end, terminal, children: undefined };
}

function emptySlots(): (RadixNode | undefined)[] {
  return new Array<RadixNode | undefined>(16).fill(undefined);
}

/** Nibble `n` of `value`: bits of code unit `n >> 2`, most significant nibble first. */
function nibbleAt(value: string, n: number): number {
  return (value.charCodeAt(n >> 2) >> ((3 - (n & 3)) << 2)) & 0xf;
}

/**
 * The first nibble in `[from, to)` where `a` and `b` differ, or `to`. Both
 * already agree before `from` (it is the depth of the node being left), so
 * whole code units are compared, one step per code unit, and the differing
 * nibble is read from the XOR of the first unequal pair.
 */
function agreeUntil(a: string, b: string, from: number, to: number): number {
  let unit = from >> 2;
  const whole = to >> 2;
  // A long shared run (a common path prefix) is compared natively in one go;
  // either way the cost stays linear in the run's length.
  if (whole - unit > 32 && a.slice(unit, whole) === b.slice(unit, whole)) unit = whole;
  for (; unit << 2 < to; unit++) {
    const diff = a.charCodeAt(unit) ^ b.charCodeAt(unit);
    // clz32 counts 16 leading zeros above a code unit, then 4 per equal nibble.
    if (diff !== 0) return Math.min((unit << 2) + ((Math.clz32(diff) - 16) >> 2), to);
  }
  return to;
}

/**
 * Adds the prefix `prefix[0, units)`, in any order relative to the others:
 * linear in its length.
 * A shorter prefix added after a longer one marks its node terminal and drops
 * the subtree; a prefix that reaches a terminal adds nothing.
 */
function insertPrefix(root: RadixNode, prefix: string, units: number): void {
  const length = units * 4;
  let node = root;
  for (;;) {
    if (node.terminal) return;
    const depth = node.end;
    if (depth === length) {
      node.terminal = true;
      node.children = undefined;
      return;
    }
    const children = (node.children ??= emptySlots());
    const slot = nibbleAt(prefix, depth);
    const child = children[slot];
    if (!child) {
      children[slot] = radixNode(prefix, length, true);
      return;
    }
    const split = agreeUntil(child.source, prefix, depth, Math.min(child.end, length));
    if (split < child.end) {
      // The new prefix leaves the edge (or ends inside it) at `split`.
      const middle = radixNode(child.source, split, false);
      middle.children = emptySlots();
      middle.children[nibbleAt(child.source, split)] = child;
      children[slot] = middle;
      node = middle;
    } else {
      node = child;
    }
  }
}

/** Whether some prefix in the trie is a prefix of `body[0, length)`: linear in `length`. */
function hasPrefixIn(root: RadixNode, body: string, length: number): boolean {
  const nibbles = length * 4;
  let node = root;
  for (;;) {
    if (node.terminal) return true;
    const depth = node.end;
    if (depth === nibbles || !node.children) return false;
    const child = node.children[nibbleAt(body, depth)];
    if (!child || child.end > nibbles || agreeUntil(child.source, body, depth, child.end) !== child.end) return false;
    node = child;
  }
}

/**
 * A literal `v` is covered by the literal `v` or by a glob `p*` with `p` a
 * prefix of `v`. A glob `q*` is covered only by a glob `p*` with `p` a prefix
 * of `q`. The envelope's glob prefixes go into a nibble radix trie in the
 * order given, with no sort: building it is linear in the envelope's code
 * units, and each request item is then checked with one walk over its own code
 * units, each child lookup one array index. Evaluation is linear in the input,
 * no hash function decides the cost, and memory is linear in the number of
 * envelope globs.
 */
function comparePrefixGlob(name: string, request: readonly string[], envelope: readonly string[], out: ScopeViolation[]): void {
  const literals = new Set<string>();
  let trie: RadixNode | undefined;
  for (const pattern of envelope) {
    if (pattern.endsWith('*')) insertPrefix((trie ??= radixNode('', 0, false)), pattern, pattern.length - 1);
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
 * does not have, an invalid bound, an async callback, a definition that is
 * not plain data (see `ScopeGrammarDefinition.dimensions`), or a runtime
 * without `structuredClone`.
 */
export function defineScopeGrammar<const D extends ScopeDimensions, TInput = ScopeShape<D>>(
  definition: ScopeGrammarDefinition<D, TInput>,
): ScopeGrammar<D, TInput> {
  const clone = hostClone;
  if (!clone) throw new TypeError('Scope grammars need structuredClone, which this runtime does not provide');
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) throw new TypeError('Scope grammar definition must be an object');
  // One read of the definition's own data: nothing inherited, hidden or computed by a getter.
  const fields = readDefinitionData('Scope grammar definition', definition);
  for (const key of Object.keys(fields)) {
    if (!DEFINITION_KEYS.has(key)) throw new TypeError(`Scope grammar definition has unsupported option ${JSON.stringify(key)}`);
  }
  const { provider, dimensions } = fields;
  if (typeof provider !== 'string' || provider.trim() === '' || hasControlChar(provider)) {
    throw new TypeError('Scope grammar provider must be a non-empty string');
  }
  const normalize = readCallback(provider, 'normalize', fields.normalize, true) as ((input: TInput) => unknown) | undefined;
  const riskOf = readCallback(provider, 'riskOf', fields.riskOf, false) as (item: ScopeItem<D>) => unknown;

  // The dimensions are checked as plain data, then cloned and compiled from
  // that one clone: the engine enforces exactly what the author wrote.
  assertPlainDefinition(`Scope grammar "${provider}": dimensions`, dimensions);
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
   * Reads one untrusted input: one structured clone, checked to be plain data;
   * then `normalize` on that clone and one clone of its result, checked the
   * same way; then validation of the engine-owned copy. Never throws; messages
   * are fixed and never format a thrown value.
   */
  const parse = (input: TInput, side: Side): ParseResult => {
    let value: unknown;
    try {
      value = clone(input);
    } catch (error) {
      return fail(side, 'scope must be plain data that structuredClone can copy', error);
    }
    // Every engine-owned clone is checked to be plain JSON-like data before
    // anything reads it: normalize never sees memory shared with the caller,
    // and validation never meets an extra array key or a shared reference.
    if (normalize) {
      // The input is provider-shaped, so its keys name no dimension.
      if (notPlainAt(value) !== undefined) return fail(side, NOT_PLAIN_DATA, undefined);
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
    const at = notPlainAt(value);
    if (at !== undefined) {
      if (at === null || !byName.has(at)) return fail(side, normalize ? `normalize result: ${NOT_PLAIN_DATA}` : NOT_PLAIN_DATA, undefined);
      return parseResult(undefined, [malformed(side, `dimension "${at}" must be plain data (arrays, strings, finite numbers) without shared references`, at)]);
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
