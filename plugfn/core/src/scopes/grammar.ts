import {
  SCOPE_RISK_LEVELS,
  type NormalizedScope,
  type ScopeDimension,
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

  constructor(message: string, violations: readonly ScopeViolation[] = []) {
    super(message);
    this.name = 'ScopeError';
    this.violations = violations;
  }
}

type Side = ScopeViolation['side'];
type ScopeValue = readonly string[] | number;
type ParsedScope = Map<string, ScopeValue>;

interface CompiledDimension {
  readonly name: string;
  readonly def: ScopeDimension;
  readonly vocabulary?: ReadonlySet<string>;
}

const DIMENSION_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const RISK_RANK: ReadonlyMap<unknown, number> = new Map(SCOPE_RISK_LEVELS.map((level, rank) => [level, rank]));
const DESTRUCTIVE_RANK = SCOPE_RISK_LEVELS.length - 1;

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

function malformed(side: Side, message: string, dimension?: string, item?: string | number): ScopeViolation {
  return { code: 'malformed', side, message, ...(dimension === undefined ? {} : { dimension }), ...(item === undefined ? {} : { item }) };
}

function assertBound(provider: string, name: string, label: string, value: unknown, integer: boolean): void {
  if (value === undefined) return;
  const ok = integer ? Number.isSafeInteger(value) && (value as number) > 0 : typeof value === 'number' && Number.isFinite(value);
  if (!ok) {
    throw new TypeError(`Scope grammar "${provider}": dimension "${name}" ${label} must be ${integer ? 'a positive integer' : 'a finite number'}`);
  }
}

function compileDimension(provider: string, name: string, def: unknown): CompiledDimension {
  if (!DIMENSION_NAME.test(name)) {
    throw new TypeError(`Scope grammar "${provider}": invalid dimension name "${name}"`);
  }
  if (!isPlainObject(def)) {
    throw new TypeError(`Scope grammar "${provider}": dimension "${name}" must be an object`);
  }
  const dim = def as ScopeDimension;
  switch (dim.kind) {
    case 'exactSet': {
      if (dim.values === undefined) return { name, def: { kind: 'exactSet' } };
      if (!Array.isArray(dim.values)) {
        throw new TypeError(`Scope grammar "${provider}": dimension "${name}" values must be an array`);
      }
      for (const value of dim.values) {
        const reason = invalidMember(value, false);
        if (reason) throw new TypeError(`Scope grammar "${provider}": dimension "${name}" value ${reason}`);
      }
      const values = Object.freeze([...new Set(dim.values)]);
      return { name, def: Object.freeze({ kind: 'exactSet', values }), vocabulary: new Set(values) };
    }
    case 'prefixGlobSet':
      return { name, def: Object.freeze({ kind: 'prefixGlobSet' }) };
    case 'numericMax': {
      assertBound(provider, name, 'min', dim.min, false);
      assertBound(provider, name, 'max', dim.max, false);
      if (dim.integer !== undefined && typeof dim.integer !== 'boolean') {
        throw new TypeError(`Scope grammar "${provider}": dimension "${name}" integer must be a boolean`);
      }
      if (dim.min !== undefined && dim.max !== undefined && dim.min > dim.max) {
        throw new TypeError(`Scope grammar "${provider}": dimension "${name}" min exceeds max`);
      }
      return { name, def: Object.freeze({ kind: 'numericMax', min: dim.min, max: dim.max, integer: dim.integer === true }) };
    }
    case 'ttlMax': {
      assertBound(provider, name, 'minSeconds', dim.minSeconds, true);
      assertBound(provider, name, 'maxSeconds', dim.maxSeconds, true);
      if (dim.minSeconds !== undefined && dim.maxSeconds !== undefined && dim.minSeconds > dim.maxSeconds) {
        throw new TypeError(`Scope grammar "${provider}": dimension "${name}" minSeconds exceeds maxSeconds`);
      }
      return { name, def: Object.freeze({ kind: 'ttlMax', minSeconds: dim.minSeconds, maxSeconds: dim.maxSeconds }) };
    }
    default:
      throw new TypeError(
        `Scope grammar "${provider}": dimension "${name}" has unsupported kind ${JSON.stringify((dim as { kind?: unknown }).kind)}`,
      );
  }
}

function parseSet(dim: CompiledDimension, raw: unknown, side: Side, out: ScopeViolation[]): readonly string[] | undefined {
  if (!Array.isArray(raw)) {
    out.push(malformed(side, `dimension "${dim.name}" must be an array of strings`, dim.name));
    return undefined;
  }
  const glob = dim.def.kind === 'prefixGlobSet';
  const seen = new Set<string>();
  const before = out.length;
  for (let i = 0; i < raw.length; i++) {
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
  const def = dim.def;
  let reason: string | undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    reason = 'must be a finite number';
  } else if (def.kind === 'ttlMax') {
    if (!Number.isSafeInteger(raw) || raw <= 0) reason = 'must be a positive whole number of seconds';
    else if (def.minSeconds !== undefined && raw < def.minSeconds) reason = `must be at least ${def.minSeconds} seconds`;
    else if (def.maxSeconds !== undefined && raw > def.maxSeconds) reason = `must be at most ${def.maxSeconds} seconds`;
  } else if (def.kind === 'numericMax') {
    if (def.integer && !Number.isSafeInteger(raw)) reason = 'must be an integer';
    else if (def.min !== undefined && raw < def.min) reason = `must be at least ${def.min}`;
    else if (def.max !== undefined && raw > def.max) reason = `must be at most ${def.max}`;
  }
  if (reason) {
    out.push(malformed(side, `dimension "${dim.name}" ${reason}`, dim.name, typeof raw === 'number' ? raw : undefined));
    return undefined;
  }
  return raw as number;
}

function isSetKind(def: ScopeDimension): boolean {
  return def.kind === 'exactSet' || def.kind === 'prefixGlobSet';
}

/** Validates a normalised scope against the grammar. Never widens. */
function parseScope(dims: readonly CompiledDimension[], byName: ReadonlyMap<string, CompiledDimension>, raw: unknown, side: Side): ParsedScope | ScopeViolation[] {
  if (!isPlainObject(raw)) return [malformed(side, 'scope must be a plain object')];
  const out: ScopeViolation[] = [];
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !byName.has(key)) {
      out.push(malformed(side, `unknown dimension ${typeof key === 'string' ? JSON.stringify(key) : String(key)}`));
    }
  }
  const scope: ParsedScope = new Map();
  for (const dim of dims) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, dim.name);
    if (!descriptor) {
      if (isSetKind(dim.def)) scope.set(dim.name, Object.freeze([]));
      else out.push(malformed(side, `dimension "${dim.name}" is required`, dim.name));
      continue;
    }
    if (!('value' in descriptor)) {
      out.push(malformed(side, `dimension "${dim.name}" must be a data property`, dim.name));
      continue;
    }
    const value = isSetKind(dim.def) ? parseSet(dim, descriptor.value, side, out) : parseScalar(dim, descriptor.value, side, out);
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

const HASH_SEED = 0x811c9dc5;

function stepHash(hash: number, code: number): number {
  return Math.imul(hash ^ code, 0x01000193);
}

/** Envelope glob prefixes, indexed by a rolling hash of their characters. */
interface PrefixIndex {
  readonly byHash: Map<number, string[]>;
  /** `hasLength[n]` is 1 when some envelope prefix has length `n`. */
  readonly hasLength: Uint8Array;
}

function buildPrefixIndex(prefixes: readonly string[]): PrefixIndex {
  let maxLength = 0;
  for (const prefix of prefixes) if (prefix.length > maxLength) maxLength = prefix.length;
  const hasLength = new Uint8Array(maxLength + 1);
  const byHash = new Map<number, string[]>();
  for (const prefix of prefixes) {
    let hash = HASH_SEED;
    for (let i = 0; i < prefix.length; i++) hash = stepHash(hash, prefix.charCodeAt(i));
    hasLength[prefix.length] = 1;
    const bucket = byHash.get(hash);
    if (bucket) bucket.push(prefix);
    else byHash.set(hash, [prefix]);
  }
  return { byHash, hasLength };
}

/** Whether some indexed prefix is a prefix of `body`; one pass over `body`. */
function hasIndexedPrefix(index: PrefixIndex, body: string): boolean {
  const limit = Math.min(body.length, index.hasLength.length - 1);
  let hash = HASH_SEED;
  for (let i = 0; ; i++) {
    if (index.hasLength[i] === 1) {
      const bucket = index.byHash.get(hash);
      if (bucket) {
        for (const prefix of bucket) if (prefix.length === i && body.startsWith(prefix)) return true;
      }
    }
    if (i === limit) return false;
    hash = stepHash(hash, body.charCodeAt(i));
  }
}

/**
 * A literal `v` is covered by the literal `v` or by a glob `p*` with `p` a
 * prefix of `v`. A glob `q*` is covered only by a glob `p*` with `p` a prefix
 * of `q`. Each request item is scanned once and looked up only at lengths
 * that some envelope prefix has, so the cost is linear in the input size.
 */
function comparePrefixGlob(name: string, request: readonly string[], envelope: readonly string[], out: ScopeViolation[]): void {
  const literals = new Set<string>();
  const prefixes: string[] = [];
  for (const pattern of envelope) {
    if (pattern.endsWith('*')) prefixes.push(pattern.slice(0, -1));
    else literals.add(pattern);
  }
  const index = buildPrefixIndex(prefixes);
  for (const item of request) {
    const isGlob = item.endsWith('*');
    if (!isGlob && literals.has(item)) continue;
    const covered = prefixes.length > 0 && hasIndexedPrefix(index, isGlob ? item.slice(0, -1) : item);
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
 * definition, including any dimension kind outside the closed set.
 */
export function defineScopeGrammar<const D extends ScopeDimensions, TInput = ScopeShape<D>>(
  definition: ScopeGrammarDefinition<D, TInput>,
): ScopeGrammar<D, TInput> {
  if (!isPlainObject(definition)) throw new TypeError('Scope grammar definition must be an object');
  const { provider, dimensions, normalize, riskOf } = definition;
  if (typeof provider !== 'string' || provider.trim() === '' || hasControlChar(provider)) {
    throw new TypeError('Scope grammar provider must be a non-empty string');
  }
  if (!isPlainObject(dimensions)) throw new TypeError(`Scope grammar "${provider}": dimensions must be an object`);
  if (normalize !== undefined && typeof normalize !== 'function') {
    throw new TypeError(`Scope grammar "${provider}": normalize must be a function`);
  }
  if (typeof riskOf !== 'function') throw new TypeError(`Scope grammar "${provider}": riskOf must be a function`);

  const names = Object.keys(dimensions);
  if (names.length === 0 || Reflect.ownKeys(dimensions).length !== names.length) {
    throw new TypeError(`Scope grammar "${provider}": dimensions must have at least one enumerable string key and no symbols`);
  }
  const dims = names.map(name => compileDimension(provider, name, (dimensions as Record<string, unknown>)[name]));
  const byName = new Map(dims.map(dim => [dim.name, dim]));
  const frozenDimensions = Object.freeze(Object.fromEntries(dims.map(dim => [dim.name, dim.def]))) as Readonly<D>;

  const parse = (input: TInput, side: Side): ParsedScope | ScopeViolation[] => {
    let raw: unknown;
    try {
      raw = normalize ? normalize(input) : input;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return [malformed(side, `normalize failed: ${detail}`)];
    }
    return parseScope(dims, byName, raw, side);
  };

  const grammar: ScopeGrammar<D, TInput> = {
    provider,
    dimensions: frozenDimensions,

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
        if (dim.def.kind === 'exactSet') {
          compareExact(dim.name, requested as readonly string[], allowed as readonly string[], out);
        } else if (dim.def.kind === 'prefixGlobSet') {
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
          const risk: unknown = riskOf({ dimension: dim.name, kind: dim.def.kind, value: item } as ScopeItem<D>);
          const itemRank = RISK_RANK.get(risk);
          if (itemRank === undefined) {
            throw new ScopeError(`Scope grammar "${provider}": riskOf returned an unknown risk for dimension "${dim.name}"`);
          }
          if (itemRank > rank) rank = itemRank;
          if (rank === DESTRUCTIVE_RANK) return SCOPE_RISK_LEVELS[rank];
        }
      }
      return SCOPE_RISK_LEVELS[rank];
    },
  };
  return Object.freeze(grammar);
}
