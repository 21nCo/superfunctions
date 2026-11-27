import { SCOPE_LIMITS } from './types.js';
import type { NormalizedScope, PublishedScopeDimensions, ScopeDimension, ScopeDimensionKind, ScopeDimensions, ScopeGrammar } from './types.js';
import type { ScopeGrammarDefinition, ScopeNormalizeResult, ScopeShape, ScopeSubsetResult, ScopeViolation } from './types.js';

/**
 * A fresh frozen array holding the entries of `first` and then `second`,
 * copied by index: no `concat`, spread or iterator, so a polluted
 * `Symbol.isConcatSpreadable` or `Symbol.iterator` cannot nest or drop entries.
 */
function frozenList<T>(first: readonly T[], second: readonly T[]): readonly T[] {
  const out: T[] = [];
  for (let i = 0; i < first.length; i++) out[out.length] = first[i]!;
  for (let i = 0; i < second.length; i++) out[out.length] = second[i]!;
  return Object.freeze(out);
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
const DIMENSION_KEYS: Readonly<Record<ScopeDimensionKind, ReadonlySet<string>>> = Object.freeze({
  exactSet: new Set(['kind', 'values']),
  prefixGlobSet: new Set(['kind']),
  numericMax: new Set(['kind', 'min', 'max', 'integer']),
  ttlMax: new Set(['kind', 'minSeconds', 'maxSeconds']),
});
const DEFINITION_KEYS: ReadonlySet<string> = new Set(['provider', 'dimensions']);

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
 * The key a validated set member is stored under in every engine `Set`. V8
 * hashes a string that reads as an array index from its numeric value,
 * without the per-process hash seed, so untrusted members such as
 * `String(i * 4096)` could all land in one bucket chain. Only a string that
 * starts with a digit can be an index; it is keyed with a leading control
 * character, which no member may contain, so keys stay distinct, none is an
 * index and every one is hashed with the seed. Members are at most
 * `maxMemberLength` code units, so a key is always hashed in full.
 */
function memberKey(value: string): string {
  const first = value.charCodeAt(0);
  return first >= 0x30 && first <= 0x39 ? `\u0001${value}` : value;
}

/**
 * An own property of a record, or `undefined`: a value inherited from a
 * (possibly polluted) prototype is never read.
 */
function own(record: object, key: string): unknown {
  return Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined;
}

const PLAIN_DEFINITION = 'must be plain data: objects with a prototype of Object.prototype or null, arrays, and only enumerable string-keyed data properties (no getters or setters)';
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

/**
 * Whether a property descriptor describes a data property: it has its own
 * `value` and no own `get` or `set`. Every field is read only when own, so a
 * polluted `Object.prototype.value` or `.enumerable` cannot make an accessor
 * look like data.
 */
function isDataDescriptor(descriptor: PropertyDescriptor): boolean {
  return Object.hasOwn(descriptor, 'value') && !Object.hasOwn(descriptor, 'get') && !Object.hasOwn(descriptor, 'set');
}

function isEnumerable(descriptor: PropertyDescriptor): boolean {
  return Object.hasOwn(descriptor, 'enumerable') && descriptor.enumerable === true;
}

/**
 * Every own property descriptor of one trusted definition object, read once
 * (a Proxy's traps run at most once here). Throws unless every key is a
 * string and every property is data, never an accessor, so no getter runs.
 */
function readDescriptors(where: string, value: object): [string, PropertyDescriptor][] {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: [string, PropertyDescriptor][] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors] as PropertyDescriptor;
    if (typeof key !== 'string' || !isDataDescriptor(descriptor)) throw new TypeError(`${where} ${PLAIN_DEFINITION}`);
    entries.push([key, descriptor]);
  }
  return entries;
}

/**
 * A fresh null-prototype record holding the own data of one trusted
 * definition object, read once through its descriptors. Throws unless the
 * object is plain: a prototype of exactly `Object.prototype` or `null` and
 * only enumerable string-keyed data properties. Nothing is inherited and no
 * getter runs. The engine compiles and publishes only from such copies and
 * never reads the author's object again, so the grammar enforces exactly the
 * data checked here.
 */
function readDefinitionData(where: string, value: object): Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value) || (proto !== Object.prototype && proto !== null)) throw new TypeError(`${where} ${PLAIN_DEFINITION}`);
  const data = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of readDescriptors(where, value)) {
    if (!isEnumerable(descriptor)) throw new TypeError(`${where} ${PLAIN_DEFINITION}`);
    data[key] = descriptor.value;
  }
  return data;
}

/**
 * A fresh dense copy of one trusted definition array, read once through its
 * descriptors: its prototype is `Array.prototype` and it holds only its
 * enumerable index data properties (no hole, no extra key) and at most
 * `maxSetItems` of them.
 */
function readDefinitionArray(where: string, value: readonly unknown[]): unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${where} ${PLAIN_DEFINITION}`);
  // Bound the descriptor read before it allocates one descriptor per member.
  if (value.length > MAX_SET_ITEMS) throw new TypeError(`${where} must have at most ${MAX_SET_ITEMS} items`);
  const members: unknown[] = [];
  let length = 0;
  let count = 0;
  for (const [key, descriptor] of readDescriptors(where, value)) {
    if (key === 'length') {
      length = descriptor.value as number;
    } else if (ARRAY_INDEX.test(key) && isEnumerable(descriptor)) {
      members[Number(key)] = descriptor.value;
      count++;
    } else {
      throw new TypeError(`${where} ${PLAIN_DEFINITION}`);
    }
  }
  if (length > MAX_SET_ITEMS) throw new TypeError(`${where} must have at most ${MAX_SET_ITEMS} items`);
  if (count !== length || members.length !== length) throw new TypeError(`${where} must not have missing items`);
  return members;
}

/**
 * The engine's own copy of the trusted `dimensions` definition, made in one
 * read of each author object: a null-prototype record of null-prototype
 * entries, with each array option copied into a fresh array. The schema is
 * three levels deep, so the walk is bounded and a cycle cannot recur. Any
 * other value is copied as it is, and {@link compileDimension} rejects every
 * one that is not a valid option.
 */
function readDimensionsDefinition(provider: string, dimensions: unknown): Record<string, Record<string, unknown>> {
  const where = `Scope grammar "${provider}": dimensions`;
  if (typeof dimensions !== 'object' || dimensions === null) throw new TypeError(`${where} must be an object`);
  const entries = readDefinitionData(where, dimensions);
  const copy = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const name of Object.keys(entries)) {
    const entryWhere = `Scope grammar "${provider}": dimension "${name}"`;
    const entry = entries[name];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new TypeError(`${entryWhere} must be an object`);
    const options = readDefinitionData(entryWhere, entry);
    for (const key of Object.keys(options)) {
      const option = options[key];
      if (Array.isArray(option)) options[key] = readDefinitionArray(`${entryWhere} ${key}`, option);
    }
    copy[name] = options;
  }
  return copy;
}

/**
 * A frozen null-prototype record holding exactly the given own fields. Every
 * record the engine creates goes through it, and each constructor below lists
 * every declared field of its type (`undefined` when absent), so no field of
 * an engine record is ever missing or read from a prototype.
 */
function ownRecord<T extends object>(fields: T): T {
  return Object.freeze(Object.assign(Object.create(null) as T, fields));
}

/** The one constructor of a {@link ScopeViolation}. */
function violation(
  code: ScopeViolation['code'],
  side: Side,
  message: string,
  dimension: string | undefined,
  item: string | number | undefined,
  limit: number | undefined,
): ScopeViolation {
  return ownRecord<ScopeViolation>({ code, side, dimension, item, limit, message });
}

function malformed(side: Side, message: string, dimension?: string, item?: string | number): ScopeViolation {
  return violation('malformed', side, message, dimension, item, undefined);
}

/**
 * The one constructor of a `normalize` or `isSubset` result: `ok` exactly when
 * there is a scope, a fresh frozen violations array, and `scope` own on both
 * branches (`undefined` on failure).
 */
function scopeResult<D extends ScopeDimensions>(scope: NormalizedScope<D> | undefined, violations: readonly ScopeViolation[]): ScopeSubsetResult<D> {
  return ownRecord({ ok: scope !== undefined, violations: frozenList(violations, []), scope }) as ScopeSubsetResult<D>;
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
 * Compiles one dimension of the engine's copy of the definition (see
 * {@link readDimensionsDefinition}); options left `undefined` are absent. Only
 * own properties are read, so a polluted prototype can never supply a kind or
 * an option.
 */
function compileDimension(provider: string, name: string, def: Record<string, unknown>): CompileResult {
  const where = `Scope grammar "${provider}": dimension "${name}"`;
  if (!DIMENSION_NAME.test(name)) throw new TypeError(`Scope grammar "${provider}": invalid dimension name "${name}"`);
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
      compiled = compiledDimension(name, 'exactSet', false, undefined, undefined, new Set((members as string[]).map(memberKey)));
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
  // The validated copy, minus options left undefined; arrays are copied and frozen.
  const published = Object.keys(def).flatMap(key => {
    const value = def[key];
    return value === undefined ? [] : [[key, Array.isArray(value) ? Object.freeze([...value]) : value]];
  });
  return ownRecord<CompileResult>({ compiled, published: ownRecord(Object.fromEntries(published)) as ScopeDimension });
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
  const unique: string[] = [];
  const before = out.length;
  for (let i = 0; i < members.length; i++) {
    const value = members[i];
    const reason = invalidMember(value, glob);
    if (reason) {
      out.push(malformed(side, `dimension "${dim.name}" item ${i} ${reason}`, dim.name, typeof value === 'string' ? value : undefined));
      continue;
    }
    const key = memberKey(value as string);
    if (dim.vocabulary && !dim.vocabulary.has(key)) {
      out.push(malformed(side, `dimension "${dim.name}" item ${i} is not in the grammar`, dim.name, value as string));
    } else if (seen && !seen.has(key)) {
      seen.add(key);
      unique.push(value as string);
    }
  }
  if (out.length !== before) return undefined;
  return seen ? Object.freeze(unique) : (members as readonly string[]);
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
  const allowed = new Set(envelope.map(memberKey));
  for (const item of request) {
    if (!allowed.has(memberKey(item))) {
      out.push(violation('not_in_envelope', 'request', `"${item}" is not in the envelope for "${name}"`, name, item, undefined));
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
class RadixNode {
  /**
   * Children indexed by the next nibble: 16 slots, allocated when the node
   * first branches. A child lookup is one array index, with no comparison or
   * hash function an input could make slow.
   */
  children: (RadixNode | undefined)[] | undefined = undefined;

  constructor(
    readonly source: string,
    /** Nibble depth of this node, so `source[0, end)` is its whole path. */
    readonly end: number,
    /** Some envelope prefix ends at this node; it covers everything below. */
    public terminal: boolean,
  ) {}
}

function radixNode(source: string, end: number, terminal: boolean): RadixNode {
  return new RadixNode(source, end, terminal);
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
 * units, each child lookup one array index. Literals are looked up by
 * {@link memberKey}, so no input chooses its hash. Evaluation is linear in the
 * input, and memory is linear in the number of envelope globs.
 */
function comparePrefixGlob(name: string, request: readonly string[], envelope: readonly string[], out: ScopeViolation[]): void {
  const literals = new Set<string>();
  let trie: RadixNode | undefined;
  for (const pattern of envelope) {
    if (pattern.endsWith('*')) insertPrefix((trie ??= radixNode('', 0, false)), pattern, pattern.length - 1);
    else literals.add(memberKey(pattern));
  }
  for (const item of request) {
    const isGlob = item.endsWith('*');
    if (!isGlob && literals.has(memberKey(item))) continue;
    const covered = trie !== undefined && hasPrefixIn(trie, item, isGlob ? item.length - 1 : item.length);
    if (!covered) {
      out.push(violation('not_in_envelope', 'request', `"${item}" is not covered by the envelope for "${name}"`, name, item, undefined));
    }
  }
}

/**
 * Defines a provider scope grammar. Throws `TypeError` for an invalid
 * definition: any dimension kind outside the closed set, an option the kind
 * does not have, an invalid bound, a definition that is
 * not plain data (see `ScopeGrammarDefinition.dimensions`), or a runtime
 * without `structuredClone`.
 */
export function defineScopeGrammar<const D extends ScopeDimensions>(
  definition: ScopeGrammarDefinition<D>,
): ScopeGrammar<D> {
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
  // One read of each dimensions object builds the engine's own copy, and only
  // that copy is compiled and published: the engine enforces exactly the data
  // it checked and never reads the author's objects again.
  const dimensionDefs = readDimensionsDefinition(provider, dimensions);
  const results = Object.keys(dimensionDefs).map(name => compileDimension(provider, name, dimensionDefs[name]!));
  if (results.length === 0) throw new TypeError(`Scope grammar "${provider}": dimensions must not be empty`);
  const dims: readonly CompiledDimension[] = Object.freeze(results.map(result => result.compiled));
  const byName: ReadonlyMap<string, CompiledDimension> = new Map(dims.map(dim => [dim.name, dim]));
  // Null prototype: a name the grammar does not declare (`toString` included) is absent.
  const publishedDimensions = Object.freeze(
    Object.assign(Object.create(null) as object, Object.fromEntries(results.map(result => [result.compiled.name, result.published]))),
  ) as PublishedScopeDimensions<D>;

  const snapshot = (scope: ParsedScope): NormalizedScope<D> => {
    const result = Object.create(null) as Record<string, ScopeValue>;
    for (const [name, value] of scope) result[name] = value;
    return Object.freeze(result) as NormalizedScope<D>;
  };

  /** Validates a single structured clone. Never reads or formats a thrown value. */
  const parse = (input: ScopeShape<D>, side: Side): ParsedScope | ScopeViolation[] => {
    let value: unknown;
    try {
      value = clone(input);
    } catch {
      return [malformed(side, 'scope must be plain data that structuredClone can copy')];
    }
    const at = notPlainAt(value);
    if (at === undefined) return parseScope(dims, byName, value, side);
    if (at === null || !byName.has(at)) return [malformed(side, NOT_PLAIN_DATA)];
    return [malformed(side, `dimension "${at}" must be plain data (arrays, strings, finite numbers) without shared references`, at)];
  };

  const grammar: ScopeGrammar<D> = {
    provider,
    dimensions: publishedDimensions,

    normalize(input: ScopeShape<D>): ScopeNormalizeResult<D> {
      const parsed = parse(input, 'request');
      return Array.isArray(parsed) ? scopeResult<D>(undefined, parsed) : scopeResult(snapshot(parsed), []);
    },

    isSubset(request: ScopeShape<D>, envelope: ScopeShape<D>): ScopeSubsetResult<D> {
      // Capture the envelope before any request getter can change it.
      const env = parse(envelope, 'envelope');
      const req = parse(request, 'request');
      if (Array.isArray(req) || Array.isArray(env)) {
        return scopeResult<D>(undefined, frozenList(Array.isArray(req) ? req : [], Array.isArray(env) ? env : []));
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
          const message = `"${dim.name}" ${String(requested)} exceeds the envelope limit ${String(allowed)}`;
          out.push(violation('exceeds_envelope', 'request', message, dim.name, requested as number, allowed as number));
        }
      }
      return out.length === 0 ? scopeResult(snapshot(req), out) : scopeResult<D>(undefined, out);
    },
  };
  return Object.freeze(grammar);
}
