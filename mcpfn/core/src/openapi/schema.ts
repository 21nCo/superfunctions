import type { McpFnJsonSchema } from "@mcpfn/core";
import type { OpenApiSkipCode } from "./types.js";

/** Thrown while converting one operation; the operation is skipped with this code. */
export class OpenApiSkip extends Error {
  constructor(
    readonly code: OpenApiSkipCode,
    message: string,
  ) {
    super(message);
    this.name = "OpenApiSkip";
  }
}

export type OpenApiVersion = "3.0" | "3.1";

/**
 * `input` removes `readOnly` properties; `output` removes `writeOnly`
 * properties; `plain` removes none (to check a schema as the document wrote it).
 */
export type SchemaMode = "input" | "output" | "plain";

type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 2019-09/2020-12 keywords outside the closed set (D12), plus identifiers
// that change the base URI so `#/definitions/<name>` would no longer resolve.
// Every 2019-09/2020-12 keyword draft-07 does not define is either listed
// here or handled in convertObject: `dependentRequired` is translated to
// `dependencies`, `$defs` becomes `definitions` (refs only ever target
// components; see addDefinitions), and the annotations `$comment`, `deprecated`,
// `contentSchema` and `examples` change no result in either engine. A listed
// keyword would be validated by @cfworker/json-schema but ignored by Ajv's
// draft-07 dialect (or change reference resolution), so the engines would
// accept different payloads.
const UNSUPPORTED_KEYWORDS = [
  "prefixItems",
  "$dynamicRef",
  "$recursiveRef",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentSchemas",
  "minContains",
  "maxContains",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$recursiveAnchor",
  "$vocabulary",
  // Draft-04's schema id: mcpFn's validators refuse it at registration.
  "id",
] as const;

// OpenAPI-only annotations dropped from the produced draft-07 schema. `nullable`
// is folded into the type first. A default `$schema` is dropped too (see checkKeywords),
// and so is Ajv's `$async`, which would make its validator return a promise
// that mcpFn's synchronous checks read as a pass; no JSON Schema dialect defines it.
const DROPPED_KEYWORDS = new Set([
  "example",
  "discriminator",
  "xml",
  "externalDocs",
  "nullable",
  "$schema",
  "$async",
]);

const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
]);

const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf"]);

const SCHEMA_KEYWORDS = new Set([
  "additionalProperties",
  "additionalItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
]);

const COMPONENT_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Whether a 3.1 `jsonSchemaDialect` or `$schema` names a dialect the
 * converter implements: JSON Schema 2020-12 or a published OAS 3.1 base
 * dialect id (`base`, `2024-10-25` or `2024-11-10`). Any other id,
 * including an unpublished dated one, is not known to mean the same.
 */
export function isDefaultDialect(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  return SUPPORTED_DIALECTS.has(uri.endsWith("#") ? uri.slice(0, -1) : uri);
}

const SUPPORTED_DIALECTS = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "https://spec.openapis.org/oas/3.1/dialect/base",
  "https://spec.openapis.org/oas/3.1/dialect/2024-10-25",
  "https://spec.openapis.org/oas/3.1/dialect/2024-11-10",
]);

/**
 * Schema nodes one operation's input, one operation's output or one
 * component may produce, counted while converting and while copying. A
 * parsed document can share one object between many schema positions, so
 * the produced tree can be exponentially larger than the document.
 */
export const MAX_SCHEMA_NODES = 100_000;

/**
 * Schema nodes all of one `fromOpenAPI` call's conversions may produce: a
 * floor plus a multiple of the document's own size, so a document that shares
 * one schema object between many operations cannot multiply the work.
 * Copies made to check a schema are charged to it too; each tool's own copy
 * of its schemas is not (see `copyBudget`).
 */
const DOCUMENT_NODE_FLOOR = 1_000_000;
const DOCUMENT_NODE_FACTOR = 64;

/**
 * Within one conversion or copy, the produced nodes may exceed the values of
 * the distinct source objects it reads by this factor (plus an allowance)
 * only when objects are shared; a plain JSON tree produces exactly as many.
 */
const SHARING_FACTOR = 4;
const SHARING_ALLOWANCE = 1024;

const REGION = "a schema expands";

/**
 * Skip reasons a schema object's conversion gives whatever region, budget or
 * position it is read in, so one call remembers them per object. A
 * `circular-object` skip raised while converting an object is one of them: the
 * object met again is on the stack below or above it, so either way the cycle
 * is reachable from the object itself. Budget and sharing skips depend on
 * where the object is read and are never remembered (their work is charged).
 */
export const CONTEXT_FREE_FAILURES: ReadonlySet<OpenApiSkipCode> = new Set<OpenApiSkipCode>([
  "circular-object",
  "invalid-schema",
  "unsupported-schema-keyword",
  "unsupported-dialect",
  "unresolved-ref",
  "external-ref",
  "unsupported-ref",
  "unsupported-component-name",
]);

export class NodeBudget {
  private produced = 0;
  private sourceValues = 0;
  /** Objects whose own values are already counted, each once by identity. */
  private readonly credited = new WeakSet<object>();
  /**
   * What a whole call learns about the objects it reads, shared by its
   * budgets: each object's own keys, listed once (so every unit of
   * enumeration work is done once per call or charged to the call's total,
   * however many regions read the same object), and the objects a copy found
   * to contain themselves.
   */
  private readonly call: { keys: WeakMap<object, readonly string[]>; circular: WeakSet<object> };

  constructor(
    private readonly limit = MAX_SCHEMA_NODES,
    private readonly total?: NodeBudget,
    private readonly subject = REGION,
    call?: NodeBudget["call"],
  ) {
    this.call = call ?? total?.call ?? { keys: new WeakMap(), circular: new WeakSet() };
  }

  /** A budget with only its own limits that shares what this call learnt. */
  uncharged(): NodeBudget {
    return new NodeBudget(MAX_SCHEMA_NODES, undefined, REGION, this.call);
  }

  /** The own enumerable keys of `value` (an array's indices without its holes), listed once per call. */
  ownKeys(value: object): readonly string[] {
    let keys = this.call.keys.get(value);
    if (keys === undefined) {
      keys = Object.keys(value);
      this.call.keys.set(value, keys);
    }
    return keys;
  }

  /** Whether a copy in this call found that `value` contains itself (a cycle reachable from it). */
  isCircular(value: object): boolean {
    return this.call.circular.has(value);
  }

  markCircular(value: object): void {
    this.call.circular.add(value);
  }

  /** The conversion budget of a whole call for `document`, counted as its values (shared ones once). */
  static forDocument(document: unknown): NodeBudget {
    const limit = DOCUMENT_NODE_FLOOR + DOCUMENT_NODE_FACTOR * countValues(document);
    return new NodeBudget(limit, undefined, "the document's schemas expand in total");
  }

  /** A budget for one input, output or component conversion, also charged to this one. */
  child(): NodeBudget {
    return new NodeBudget(MAX_SCHEMA_NODES, this);
  }

  /** Charge one produced node read from `value`. */
  charge(value?: unknown): void {
    this.total?.charge();
    this.produced += 1;
    if (typeof value === "object" && value !== null) this.source(value);
    if (this.produced > this.limit) {
      throw new OpenApiSkip("schema-too-large", `${this.subject} to more than ${this.limit} nodes`);
    }
    // The call's total counts nodes only; each region checks its own sharing.
    if (this.subject === REGION && this.produced > SHARING_FACTOR * this.sourceValues + SHARING_ALLOWANCE) {
      throw new OpenApiSkip(
        "schema-too-large",
        `a schema repeats shared objects into ${this.produced} nodes from ${this.sourceValues} source values`,
      );
    }
  }

  /**
   * Count `value` and its own values as source, once per object whoever refers
   * to it. A conversion that reads the members of an array or map it does not
   * charge (allOf, properties, $defs, ...) calls this for the container.
   */
  source(value: object): void {
    if (this.credited.has(value)) return;
    this.credited.add(value);
    // Own keys, not length: the holes of a sparse array are not source values.
    this.sourceValues += 1 + this.ownKeys(value).length;
  }

  /** Mark `value`, built by the conversion from source already counted, as counted. */
  generated(value: object): void {
    this.credited.add(value);
  }
}

/** The values in a JSON-like tree, each shared object counted once. */
function countValues(root: unknown): number {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  let count = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    count += 1;
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    for (const item of Object.values(value)) stack.push(item);
  }
  return count;
}

function unescapePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Parse a local component reference, rejecting external and URL references. */
export function parseComponentRef(
  ref: unknown,
  kind: "schemas" | "parameters" | "requestBodies" | "responses",
): string {
  if (typeof ref !== "string") {
    throw new OpenApiSkip("unsupported-ref", "a $ref value is not a string");
  }
  if (!ref.startsWith("#")) {
    throw new OpenApiSkip("external-ref", `external reference ${JSON.stringify(ref)}`);
  }
  const unsupported = () =>
    new OpenApiSkip(
      "unsupported-ref",
      `reference ${JSON.stringify(ref)} is not a #/components/${kind}/<name> reference`,
    );
  // The fragment is percent-decoded first, then read as a JSON Pointer (RFC 6901 §6).
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    throw unsupported();
  }
  const tokens = pointer.split("/").map(unescapePointerToken);
  if (tokens.length !== 4 || tokens[0] !== "" || tokens[1] !== "components" || tokens[2] !== kind) {
    throw unsupported();
  }
  const name = tokens[3]!;
  if (!COMPONENT_NAME.test(name)) {
    throw new OpenApiSkip(
      "unsupported-component-name",
      `component name ${JSON.stringify(name)} is outside [A-Za-z0-9._-]`,
    );
  }
  return name;
}

interface ConvertedComponent {
  schema?: McpFnJsonSchema | boolean;
  refs?: Set<string>;
  /** Definitions this one validates the same instance against (allOf/anyOf/oneOf/not/if/then/else/dependencies). */
  inPlace?: Set<string>;
  error?: OpenApiSkip;
}

type DirectionalKeyword = "readOnly" | "writeOnly";

function directionalKeyword(mode: "input" | "output"): DirectionalKeyword {
  return mode === "input" ? "readOnly" : "writeOnly";
}

/** Why removing flagged properties from a schema would not be sound. */
interface AccessConflict {
  name: string;
  by: string;
  /** Replaces the sentence built from `name` and `by`. */
  message?: string;
}

/** A schema applied to an instance, and whether only under a condition or an overlapping alternative. */
interface ClosureEntry {
  schema: JsonObject;
  conditional: boolean;
  /** The kinds of value for which the schema applies only under a condition or an overlapping alternative. */
  conditionalKinds?: ReadonlySet<ValueKind>;
  /** The kinds of value for which the schema matters: those every schema on its path from the root admits. */
  kinds: ReadonlySet<ValueKind>;
}

const CONDITIONAL = "anyOf/oneOf members that can overlap, not, if/then/else or a dependency";

/**
 * Keywords that constrain the whole object or its property count, so a
 * flagged property cannot be left out of a value they accepted.
 */
const INSTANCE_CONSTRAINTS = [
  "const",
  "enum",
  "minProperties",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
] as const;

/**
 * Keywords whose result can change when a property is left out, wherever the
 * schema holding them applies only under a condition (where a changed result
 * can turn a pass into a failure).
 */
const NAME_SENSITIVE = [
  ...INSTANCE_CONSTRAINTS,
  "maxProperties",
  "patternProperties",
  "propertyNames",
] as const;

/** Positions whose subschemas are never projected: a flag below them skips the projection. */
// Child positions a flag may not be under, by the kind of value they apply to.
const UNPROJECTED_OBJECT_POSITIONS = ["patternProperties", "propertyNames"] as const;
const UNPROJECTED_ARRAY_POSITIONS = ["contains", "additionalItems"] as const;

function memoFor<K, V>(memos: Map<K, WeakMap<object, V>>, key: K): WeakMap<object, V> {
  let memo = memos.get(key);
  if (!memo) {
    memo = new WeakMap();
    memos.set(key, memo);
  }
  return memo;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A keyword that takes one value or an array of them (such as `type`). */
function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function objectEntries(value: unknown): Array<[string, unknown]> {
  return isObject(value) ? Object.entries(value) : [];
}

/**
 * Converts OpenAPI 3.0/3.1 Schema Objects to draft-07 for mcpFn's validators.
 * Component schemas are converted once per mode and shared between tools.
 *
 * Properties flagged `readOnly` (input) or `writeOnly` (output) are projected
 * out where they are declared: `properties[name]` becomes `false` (or is
 * deleted from a closed object) and leaves that object's `required`. Because
 * the converted schema is shared, `checkProjection` first proves that every
 * flag reachable from a root sits on a plain applicator chain (`properties`,
 * one `items` schema, a schema `additionalProperties`, `allOf`, `$ref`, or an
 * `anyOf`/`oneOf` member no other member overlaps by kind of value) and that
 * nothing else needs the property; otherwise the root is not projected.
 */
export class SchemaConverter {
  private readonly cache = new Map<string, ConvertedComponent>();
  private readonly ancestors = new Set<object>();
  private readonly admitted = new WeakMap<object, AdmittedKinds>();
  /** The kinds of an allOf (`both`) or anyOf/oneOf (`either`) member array, or why it failed, once per array. */
  private readonly memberKinds = new Map<"both" | "either", WeakMap<object, AdmittedKinds | OpenApiSkip>>();
  /** Reference cycles cut so far: a result that needed a cut depends on the schemas being checked. */
  private cuts = 0;
  /** The kinds of the values an `enum` array or a `const` object lists, once per object. */
  private readonly literalKinds = new Map<"enum" | "const", WeakMap<object, AdmittedKinds>>();
  private readonly flags = new Map<DirectionalKeyword, WeakMap<object, boolean>>();
  private readonly reaches = new Map<DirectionalKeyword, WeakMap<object, boolean>>();
  private readonly reaching = new Map<DirectionalKeyword, ReadonlySet<string>>();
  private readonly projections = new Map<DirectionalKeyword, WeakMap<object, AccessConflict | null>>();
  /** Schema objects whose conversion failed for a reason of their own, by mode, for the whole call. */
  private readonly failures = new Map<SchemaMode, WeakMap<object, OpenApiSkip>>();
  private budget: NodeBudget;

  constructor(
    private readonly version: OpenApiVersion,
    private readonly schemas: JsonObject,
    /** The budget of the whole call; every conversion and copy is charged to it. */
    private readonly total: NodeBudget,
    /**
     * Set when the document's `jsonSchemaDialect` is not the default: a root
     * schema without its own supported `$schema` is then refused.
     */
    private readonly unsupportedDialect?: string,
  ) {
    this.budget = total.child();
  }

  /**
   * A budget for one copy of a produced schema. A tool's own copy of its
   * schemas is output the registry compiles anyway, so it has only its own
   * limits; a copy made only to check a schema is charged to the call's total.
   */
  copyBudget(charged = false): NodeBudget {
    return charged ? this.total.child() : this.total.uncharged();
  }

  /** Run `task` with a fresh node budget (one per operation input, operation output or component). */
  budgeted<T>(task: () => T): T {
    const outer = this.budget;
    this.budget = this.total.child();
    try {
      return task();
    } finally {
      this.budget = outer;
    }
  }

  private component(name: string): unknown {
    if (!Object.hasOwn(this.schemas, name)) {
      throw new OpenApiSkip(
        "unresolved-ref",
        `reference #/components/schemas/${name} has no target`,
      );
    }
    return this.schemas[name];
  }

  /**
   * The kinds of value `schema` accepts, following local `$ref`s and
   * `allOf`/`anyOf`/`oneOf`. A schema without `type`, `enum` or `const`
   * accepts every kind; a reference cycle is treated as accepting every kind.
   * Results are memoised per schema object (a cycle cut only widens them).
   */
  admits(schema: unknown, stack: Set<unknown> = new Set()): AdmittedKinds {
    if (schema === false) return NOTHING;
    if (!isObject(schema)) return EVERYTHING;
    if (stack.has(schema)) {
      this.cuts += 1;
      return EVERYTHING;
    }
    const known = this.admitted.get(schema);
    if (known) return known;
    stack.add(schema);
    try {
      const result = this.admitsObject(schema, stack);
      this.admitted.set(schema, result);
      return result;
    } finally {
      stack.delete(schema);
    }
  }

  private admitsObject(schema: JsonObject, stack: Set<unknown>): AdmittedKinds {
    let result = EVERYTHING;
    if (Object.hasOwn(schema, "$ref")) {
      const target = this.admits(this.component(parseComponentRef(schema.$ref, "schemas")), stack);
      // OpenAPI 3.0 ignores $ref siblings; 3.1 applies them too.
      if (this.version === "3.0") return target;
      result = target;
    }
    result = this.narrowByValues(result, schema);
    if (Object.hasOwn(schema, "items") && !Array.isArray(schema.items)) {
      result = { ...result, items: intersect(result.items, this.admits(schema.items, stack).values) };
    }
    if (Array.isArray(schema.allOf)) result = both(result, this.admitsMembers(schema.allOf, "both", stack));
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const members = schema[keyword];
      if (Array.isArray(members)) result = both(result, this.admitsMembers(members, "either", stack));
    }
    const excluded = typeOnlyKinds(schema.not);
    return excluded.length === 0 ? result : { ...result, values: without(result.values, excluded) };
  }

  /**
   * The kinds all (`both`) or some (`either`) of `members` admit. Kept per
   * array, failure included, so roots that share one are not walked again;
   * a result that needed a cycle cut is not kept, since it is provisional.
   */
  private admitsMembers(members: unknown[], combine: "both" | "either", stack: Set<unknown>): AdmittedKinds {
    const memo = memoFor(this.memberKinds, combine);
    const known = memo.get(members);
    if (known instanceof OpenApiSkip) throw known;
    if (known) return known;
    const cuts = this.cuts;
    try {
      const kinds = members.map((member) => this.admits(member, stack));
      const result = combine === "both" ? kinds.reduce(both, EVERYTHING) : either(kinds);
      if (this.cuts === cuts) memo.set(members, result);
      return result;
    } catch (error) {
      if (error instanceof OpenApiSkip) memo.set(members, error);
      throw error;
    }
  }

  /** The kinds of the literals an `enum` array (or a `const` value) lists, kept per object. */
  private literals(keyword: "enum" | "const", value: unknown): AdmittedKinds {
    const listed = keyword === "enum" ? (value as unknown[]) : [value];
    if (typeof value !== "object" || value === null) return kindsOfLiterals(listed);
    const memo = memoFor(this.literalKinds, keyword);
    let kinds = memo.get(value);
    if (kinds === undefined) {
      kinds = kindsOfLiterals(listed);
      memo.set(value, kinds);
    }
    return kinds;
  }

  /** `type` (with 3.0 `nullable`), `enum` and `const`. */
  private narrowByValues(result: AdmittedKinds, schema: JsonObject): AdmittedKinds {
    let narrowed = result;
    if (schema.type !== undefined) {
      const kinds = listOf(schema.type).flatMap(kindsOfType);
      if (this.version === "3.0" && schema.nullable === true) kinds.push("null");
      narrowed = { ...narrowed, values: intersect(narrowed.values, kinds) };
    }
    if (Array.isArray(schema.enum)) narrowed = both(narrowed, this.literals("enum", schema.enum));
    if (Object.hasOwn(schema, "const")) narrowed = both(narrowed, this.literals("const", schema.const));
    return narrowed;
  }

  /**
   * Convert a schema rooted in a tool's input or output schema. Referenced
   * component names are added to `refs`; call `definitions` for their closure.
   */
  convertRoot(schema: unknown, mode: SchemaMode, refs: Set<string>): McpFnJsonSchema | boolean {
    this.checkRootDialect(schema);
    return this.convert(schema, mode, refs);
  }

  /**
   * A schema resource root (a media type, parameter or component schema) is
   * read in its own `$schema` (checked with the other keywords), else in the
   * document's `jsonSchemaDialect`. A root holding only `$ref` is read in the
   * dialect of its target component, which is checked as a root itself; a
   * boolean root is refused like any other.
   */
  private checkRootDialect(schema: unknown): void {
    if (this.unsupportedDialect === undefined) return;
    if (isObject(schema) && Object.hasOwn(schema, "$schema")) return;
    if (isObject(schema) && this.budget.ownKeys(schema).length === 1 && Object.hasOwn(schema, "$ref")) return;
    if (!isObject(schema) && typeof schema !== "boolean") return;
    throw new OpenApiSkip("unsupported-dialect", `the document's jsonSchemaDialect ${this.unsupportedDialect} is not supported`);
  }

  private convert(schema: unknown, mode: SchemaMode, refs: Set<string>): McpFnJsonSchema | boolean {
    // A schema object that already failed for a reason of its own fails again without any work.
    const failed = isObject(schema) ? this.failures.get(mode)?.get(schema) : undefined;
    if (failed) throw failed;
    this.budget.charge(schema);
    if (typeof schema === "boolean") return schema;
    if (!isObject(schema)) {
      throw new OpenApiSkip("invalid-schema", "a schema is not an object");
    }
    if (this.ancestors.has(schema)) {
      throw new OpenApiSkip("circular-object", "a schema contains itself as an object (not through $ref)");
    }
    this.ancestors.add(schema);
    try {
      return this.convertObject(schema, mode, refs);
    } catch (error) {
      if (error instanceof OpenApiSkip && CONTEXT_FREE_FAILURES.has(error.code)) memoFor(this.failures, mode).set(schema, error);
      throw error;
    } finally {
      this.ancestors.delete(schema);
    }
  }

  private checkKeywords(schema: JsonObject): void {
    for (const keyword of UNSUPPORTED_KEYWORDS) {
      if (Object.hasOwn(schema, keyword)) {
        throw new OpenApiSkip(
          "unsupported-schema-keyword",
          `schema keyword ${keyword} is not supported`,
        );
      }
    }
    if (Object.hasOwn(schema, "$schema") && (this.version === "3.0" || !isDefaultDialect(schema.$schema))) {
      throw new OpenApiSkip("unsupported-dialect", `schema dialect ${JSON.stringify(schema.$schema)} is not supported`);
    }
  }

  private convertObject(schema: JsonObject, mode: SchemaMode, refs: Set<string>): McpFnJsonSchema {
    if (Object.hasOwn(schema, "$ref")) return this.convertReference(schema, mode, refs);
    this.checkKeywords(schema);
    const converted = this.convertKeywords(schema, mode, refs);
    foldExclusiveBounds(converted);
    this.project(converted, schema, mode);
    return this.version === "3.0" && schema.nullable === true
      ? nullableSchema(converted)
      : converted;
  }

  private convertReference(schema: JsonObject, mode: SchemaMode, refs: Set<string>): McpFnJsonSchema {
    const name = parseComponentRef(schema.$ref, "schemas");
    this.component(name);
    // OpenAPI 3.0 ignores every $ref sibling, so they are neither checked nor kept.
    if (this.version === "3.0") return this.reference(name, refs);
    // 3.1 (2020-12) applies the siblings too: an allOf of them and the reference.
    const { $ref, ...rest } = schema;
    this.checkKeywords(rest);
    if (Object.keys(rest).length === 0) return this.reference(name, refs);
    if (rest.allOf !== undefined && !(Array.isArray(rest.allOf) && rest.allOf.length > 0)) {
      throw new OpenApiSkip("invalid-schema", "allOf is not a non-empty array");
    }
    // The siblings are converted where they are (a shared allOf is read, not
    // copied) and the reference joins their allOf as its last member. The
    // allOf is credited first, whatever the order of the siblings.
    if (Array.isArray(rest.allOf)) this.budget.source(rest.allOf);
    this.budget.generated(rest);
    const converted = this.convertObject(rest, mode, refs);
    this.budget.charge();
    const reference = this.reference(name, refs);
    if (Array.isArray(converted.allOf)) converted.allOf.push(reference);
    else converted.allOf = [reference];
    return converted;
  }

  private convertKeywords(schema: JsonObject, mode: SchemaMode, refs: Set<string>): McpFnJsonSchema {
    const entries: Array<[string, unknown]> = [];
    let dependencies: JsonObject | undefined;
    let defs: JsonObject | undefined;
    // Keyword by keyword, so a failing one ends the work before the rest are read.
    for (const keyword of this.budget.ownKeys(schema)) {
      const value = schema[keyword];
      if (DROPPED_KEYWORDS.has(keyword)) continue;
      // 2020-12 (OpenAPI 3.1) defines no `dependencies`: it annotates only.
      if (keyword === this.ignoredKeyword()) continue;
      if (keyword === "dependencies" && isObject(value)) {
        dependencies = { ...dependencies, ...this.convertDependencies(value, mode, refs) };
      } else if (keyword === "dependentRequired" && isObject(value)) {
        dependencies = { ...value, ...dependencies };
      } else if (keyword === "$defs") {
        // Draft-07 has no $defs, so Ajv would not refuse a malformed one.
        if (!isObject(value)) throw new OpenApiSkip("invalid-schema", "$defs is not an object");
        defs = this.convertMap(value, mode, refs);
      } else {
        const entry = this.convertEntry(schema, keyword, value, mode, refs);
        if (entry) entries.push(entry);
      }
    }
    if (dependencies) entries.push(["dependencies", dependencies]);
    if (defs) addDefinitions(entries, defs);
    return Object.fromEntries(entries) as McpFnJsonSchema;
  }

  private convertEntry(
    schema: JsonObject,
    keyword: string,
    value: unknown,
    mode: SchemaMode,
    refs: Set<string>,
  ): [string, unknown] | undefined {
    if (SCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
      return [keyword, this.convertMap(value, mode, refs)];
    }
    if ((SCHEMA_ARRAY_KEYWORDS.has(keyword) || keyword === "items") && Array.isArray(value)) {
      this.budget.source(value);
      return [keyword, value.map((item) => this.convert(item, mode, refs))];
    }
    if (keyword === "items") return [keyword, this.convert(value, mode, refs)];
    if (SCHEMA_KEYWORDS.has(keyword)) return [keyword, this.convert(value, mode, refs)];
    if ((keyword === "exclusiveMinimum" || keyword === "exclusiveMaximum") && typeof value === "boolean") {
      // OpenAPI 3.0 (draft-04 style) boolean form; draft-07 takes the bound.
      const bound = schema[keyword === "exclusiveMinimum" ? "minimum" : "maximum"];
      return value && typeof bound === "number" ? [keyword, bound] : undefined;
    }
    return [keyword, value];
  }

  private convertMap(value: JsonObject, mode: SchemaMode, refs: Set<string>): JsonObject {
    return this.convertMembers(value, (item) => this.convert(item, mode, refs));
  }

  private convertDependencies(value: JsonObject, mode: SchemaMode, refs: Set<string>): JsonObject {
    return this.convertMembers(value, (item) => (Array.isArray(item) ? item : this.convert(item, mode, refs)));
  }

  /** A map's members converted one by one, so a failing member ends the work before the rest are read. */
  private convertMembers(value: JsonObject, convert: (item: unknown) => unknown): JsonObject {
    this.budget.source(value);
    const entries: Array<[string, unknown]> = [];
    for (const key of this.budget.ownKeys(value)) entries.push([key, convert(value[key])]);
    return Object.fromEntries(entries);
  }

  /**
   * Leave out the properties `source` itself flags for `mode`: `false` refuses
   * the name whatever `patternProperties` or `additionalProperties` say, and a
   * closed object refuses it once it is no longer listed.
   */
  private project(converted: McpFnJsonSchema, source: JsonObject, mode: SchemaMode): void {
    if (mode === "plain") return;
    const keyword = directionalKeyword(mode);
    const flagged = objectEntries(source.properties)
      .filter(([, property]) => this.hasFlag(property, keyword))
      .map(([name]) => name);
    if (flagged.length === 0 || !isObject(converted.properties)) return;
    const closed = converted.additionalProperties === false && converted.patternProperties === undefined;
    const properties: JsonObject = { ...converted.properties };
    for (const name of flagged) {
      if (closed) delete properties[name];
      else Object.defineProperty(properties, name, { value: false, enumerable: true, writable: true, configurable: true });
    }
    converted.properties = properties as McpFnJsonSchema["properties"];
    if (Array.isArray(converted.required)) {
      converted.required = converted.required.filter((name) => !flagged.includes(name as string));
      if ((converted.required as unknown[]).length === 0) delete converted.required;
    }
  }

  private reference(name: string, refs: Set<string>): McpFnJsonSchema {
    refs.add(name);
    return { $ref: `${DEFINITION_REF}${name}` };
  }

  /**
   * Throw `unsupported-access-flag` unless leaving out the properties flagged
   * for `mode` everywhere `schema` applies is sound: the result refuses every
   * flagged name and still accepts what the source accepted without them.
   */
  checkProjection(schema: unknown, mode: "input" | "output"): void {
    const keyword = directionalKeyword(mode);
    const conflict = this.projectionConflict(schema, keyword);
    if (conflict === undefined) return;
    throw new OpenApiSkip(
      "unsupported-access-flag",
      conflict.message ??
        `property ${JSON.stringify(conflict.name)} is ${keyword} but is also constrained by ` +
          `${conflict.by}, so it cannot be removed soundly`,
    );
  }

  /** Whether `schema` (through any subschema or reference) flags a property for `mode`. */
  flagsFor(schema: unknown, mode: "input" | "output"): boolean {
    return this.reachesFlag(schema, directionalKeyword(mode));
  }

  /**
   * Memoised per schema object. A check that reaches a schema still being
   * checked (a reference cycle), or one whose clean result is still
   * provisional, does not know that schema's result yet; as in Tarjan's
   * algorithm, checks are numbered in the order they start, and a clean
   * result that depends on an earlier one stays provisional until the check
   * it depends on ends clean as the first of its cycle. A conflict is always
   * final and ends every check up to the outermost one.
   */
  private projectionConflict(schema: unknown, keyword: DirectionalKeyword): AccessConflict | undefined {
    if (!isObject(schema) || !this.reachesFlag(schema, keyword)) return undefined;
    const memo = memoFor(this.projections, keyword);
    const known = memo.get(schema);
    if (known !== undefined) return known ?? undefined;
    const unknown = this.checking.get(schema) ?? this.provisional.get(schema);
    if (unknown !== undefined) {
      this.lowest = Math.min(this.lowest, unknown);
      return undefined;
    }
    const index = this.started++;
    const mark = this.pending.length;
    const outer = this.lowest;
    this.checking.set(schema, index);
    this.lowest = Number.POSITIVE_INFINITY;
    try {
      const entries = this.closure(schema);
      // Object children only matter in schemas that can accept an object,
      // array items only in schemas that can accept an array, each with
      // whether it applies to that kind of value only under a condition.
      const objects = entriesFor(entries, "object");
      const arrays = entriesFor(entries, "array");
      const conflict = this.flagConflict(objects, keyword) ?? this.childConflict(objects, arrays, keyword);
      if (conflict !== undefined) memo.set(schema, conflict);
      else if (this.lowest >= index) this.settle(schema, mark, memo);
      else {
        this.provisional.set(schema, index);
        this.pending.push(schema);
      }
      return conflict;
    } finally {
      this.checking.delete(schema);
      this.lowest = Math.min(outer, this.lowest >= index ? Number.POSITIVE_INFINITY : this.lowest);
      if (this.checking.size === 0) {
        this.provisional.clear();
        this.pending.length = 0;
      }
    }
  }

  /** `schema` ends clean, first of its cycle: so do the provisional results that started inside its check. */
  private settle(schema: object, mark: number, memo: WeakMap<object, AccessConflict | null>): void {
    memo.set(schema, null);
    for (const settled of this.pending.splice(mark)) {
      memo.set(settled, null);
      this.provisional.delete(settled);
    }
  }

  /** Checks in progress and provisional clean results, by the order their checks started. */
  private readonly checking = new Map<object, number>();
  private readonly provisional = new Map<object, number>();
  private readonly pending: object[] = [];
  private started = 0;
  private lowest = Number.POSITIVE_INFINITY;

  /**
   * `root` and every schema applied to the same instance: `$ref` targets
   * (OpenAPI 3.0 ignores the siblings), `allOf` members and `anyOf`/`oneOf`
   * members, plus, marked `conditional`, `not`/`if`/`then`/`else`, schema
   * dependencies and, for each kind of value two alternatives can both
   * accept, those alternatives. A schema reached both ways is also recorded
   * as conditional, whatever the order of the visits, because its converted
   * form is shared by both.
   * Each entry also keeps the kinds of value every schema on a path to it
   * admits: for any other value a schema on that path fails whatever the
   * entry says, so the entry decides nothing for it. A schema reached for
   * more kinds, or under a condition for more kinds, is visited again (at
   * most twice per kind).
   */
  private closure(root: JsonObject): ClosureEntry[] {
    const entries: ClosureEntry[] = [];
    const visited = new Map<object, { conditionalKinds: ReadonlySet<ValueKind>; kinds: ReadonlySet<ValueKind> }>();
    const walk = (current: unknown, under: ReadonlySet<ValueKind>, reaching: ReadonlySet<ValueKind>): void => {
      if (!isObject(current)) return;
      const before = visited.get(current);
      let kinds = intersect(reaching, this.admittedValues(current));
      let conditionalKinds = under.size === 0 ? NO_KINDS : intersect(under, kinds);
      if (before !== undefined) {
        const covered = [...kinds].every((kind) => before.kinds.has(kind));
        if (covered && [...conditionalKinds].every((kind) => before.conditionalKinds.has(kind))) return;
        kinds = new Set([...before.kinds, ...kinds]);
        conditionalKinds = new Set([...before.conditionalKinds, ...conditionalKinds]);
      }
      visited.set(current, { conditionalKinds, kinds });
      if (Object.hasOwn(current, "$ref")) {
        walk(this.target(current.$ref), conditionalKinds, kinds);
        if (this.version === "3.0") return;
      }
      entries.push({ schema: current, conditional: conditionalKinds.size > 0, conditionalKinds, kinds });
      for (const member of arrayOf(current.allOf)) walk(member, conditionalKinds, kinds);
      for (const keyword of ["anyOf", "oneOf"] as const) {
        const members = arrayOf(current[keyword]);
        const shared = this.sharedKinds(members);
        for (const member of members) {
          const overlapping = shared.size === 0 ? NO_KINDS : intersect(shared, this.admittedValues(member));
          walk(member, overlapping.size === 0 ? conditionalKinds : new Set([...conditionalKinds, ...overlapping]), kinds);
        }
      }
      for (const keyword of ["not", "if", "then", "else"] as const) walk(current[keyword], kinds, kinds);
      for (const keyword of this.dependencyKeywords()) {
        for (const [, dependency] of objectEntries(current[keyword])) walk(dependency, kinds, kinds);
      }
    };
    walk(root, NO_KINDS, EVERYTHING.values);
    return entries;
  }

  /** The keyword conversion drops: 2020-12 (OpenAPI 3.1) defines no `dependencies`, so it annotates only. */
  private ignoredKeyword(): string | undefined {
    return this.version === "3.1" ? "dependencies" : undefined;
  }

  private dependencyKeywords(): string[] {
    return this.version === "3.1" ? ["dependentSchemas"] : ["dependencies", "dependentSchemas"];
  }

  /** The kinds of value two or more alternatives accept; a value of any other kind meets at most one. */
  private sharedKinds(members: unknown[]): Set<ValueKind> {
    const shared = new Set<ValueKind>();
    const seen = new Set<ValueKind>();
    for (const member of members) {
      for (const kind of this.admittedValues(member)) {
        if (seen.has(kind)) shared.add(kind);
        seen.add(kind);
      }
    }
    return shared;
  }

  /**
   * Flags on this instance's own properties, among the schemas that can
   * accept an object: each must be declared in an unconditional schema, no
   * such schema may need the name (a `required` list of another schema, `const`, `enum`,
   * `minProperties` or a dependency), and no conditional one may tell the
   * object with the name from the object without it (listing it, counting
   * or matching property names, or closing the object).
   */
  private flagConflict(entries: ClosureEntry[], keyword: DirectionalKeyword): AccessConflict | undefined {
    const declarers = this.declarers(entries, keyword);
    if (!(declarers instanceof Map)) return declarers;
    if (declarers.size === 0) return undefined;
    // Validators do not read a "__proto__" key of properties as a property schema.
    if (declarers.has("__proto__")) return { name: "__proto__", by: "the validators, which ignore it in properties" };
    for (const entry of entries) {
      const conflict = needsFlagged(entry, declarers, this.ignoredKeyword());
      if (conflict !== undefined) return conflict;
    }
    return undefined;
  }

  /** The schemas flagging each property name, or the conflict of a flag under a condition. */
  private declarers(
    entries: ClosureEntry[],
    keyword: DirectionalKeyword,
  ): Map<string, Set<object>> | AccessConflict {
    const declarers = new Map<string, Set<object>>();
    for (const { schema, conditional } of entries) {
      for (const [name, property] of objectEntries(schema.properties)) {
        if (!this.hasFlag(property, keyword)) continue;
        if (conditional) return { name, by: CONDITIONAL };
        const known = declarers.get(name) ?? new Set<object>();
        known.add(schema);
        declarers.set(name, known);
      }
    }
    return declarers;
  }

  /**
   * Flags below this instance: a child value (a property, the additional
   * properties, the items) is projected only when exactly one schema
   * constrains it, unconditionally, and nothing compares whole values.
   * Property children are compared among the schemas that can accept an
   * object (`objects`), items among those that can accept an array
   * (`arrays`): a schema of another kind never applies them.
   */
  private childConflict(
    objects: ClosureEntry[],
    arrays: ClosureEntry[],
    keyword: DirectionalKeyword,
  ): AccessConflict | undefined {
    const reaches = (value: unknown) => this.reachesFlag(value, keyword);
    for (const [members, positions] of [
      [objects, UNPROJECTED_OBJECT_POSITIONS],
      [arrays, UNPROJECTED_ARRAY_POSITIONS],
    ] as const) {
      for (const { schema } of members) {
        for (const position of positions) {
          if (this.childSchemas(schema, position).some(reaches)) return childConflict(keyword, position, "its position");
        }
      }
    }
    for (const { schema } of arrays) {
      if (Array.isArray(schema.items) && schema.items.some(reaches)) {
        return childConflict(keyword, "items", "its position in a tuple");
      }
    }
    return (
      this.propertyConflict(objects, keyword) ??
      this.additionalConflict(objects, keyword) ??
      this.itemsConflict(arrays, keyword)
    );
  }

  private propertyConflict(entries: ClosureEntry[], keyword: DirectionalKeyword): AccessConflict | undefined {
    // One pass: the listed schemas of every unflagged name (a flagged
    // property is refused outright, so its value is never checked).
    const listed = new Map<string, { values: unknown[]; conditional: boolean }>();
    for (const { schema, conditional } of entries) {
      for (const [name, property] of objectEntries(schema.properties)) {
        if (this.hasFlag(property, keyword)) continue;
        const known = listed.get(name) ?? { values: [], conditional: false };
        known.values.push(property);
        known.conditional ||= conditional;
        listed.set(name, known);
      }
    }
    // How many schemas with a constraining additionalProperties list each
    // name: one that does not list it validates its value as well.
    const ignored = this.ignoredKeyword();
    const additional = entries.filter(({ schema }) => constrainsValues(schema.additionalProperties, ignored));
    const listedByAdditional = new Map<string, number>();
    for (const { schema } of additional) {
      for (const [name] of objectEntries(schema.properties)) {
        listedByAdditional.set(name, (listedByAdditional.get(name) ?? 0) + 1);
      }
    }
    const patterned = patternMatcher(entries, ignored);
    for (const [name, { values, conditional }] of listed) {
      if (!values.some((value) => this.reachesFlag(value, keyword))) continue;
      const subject = `property ${JSON.stringify(name)}`;
      if ((listedByAdditional.get(name) ?? 0) < additional.length) {
        return childConflict(keyword, subject, "additionalProperties of another schema for the same object");
      }
      const conflict = this.singleSource(entries, keyword, subject, values, conditional, patterned(name));
      if (conflict !== undefined) return conflict;
    }
    return undefined;
  }

  private additionalConflict(entries: ClosureEntry[], keyword: DirectionalKeyword): AccessConflict | undefined {
    for (const entry of entries) {
      const value = entry.schema.additionalProperties;
      if (!this.reachesFlag(value, keyword)) continue;
      // Names another schema lists or patterns are validated by both schemas.
      const shared = entries.some(
        ({ schema }) =>
          schema !== entry.schema &&
          (objectEntries(schema.properties).length > 0 ||
            objectEntries(schema.patternProperties).length > 0 ||
            constrainsValues(schema.additionalProperties, this.ignoredKeyword())),
      );
      const subject = "additionalProperties";
      const conflict = shared
        ? childConflict(keyword, subject, "properties of another schema for the same object")
        : this.singleSource(entries, keyword, subject, [value], entry.conditional, false);
      if (conflict !== undefined) return conflict;
    }
    return undefined;
  }

  private itemsConflict(entries: ClosureEntry[], keyword: DirectionalKeyword): AccessConflict | undefined {
    const sources: unknown[] = [];
    let conditional = false;
    for (const entry of entries) {
      const { schema } = entry;
      if (schema.items === undefined || Array.isArray(schema.items) || opens(schema.items, this.ignoredKeyword())) continue;
      sources.push(schema.items);
      conditional ||= entry.conditional;
    }
    if (!sources.some((source) => this.reachesFlag(source, keyword))) return undefined;
    for (const { schema } of entries) {
      if (Array.isArray(schema.items)) return childConflict(keyword, "items", "a tuple items list for the same array");
      if (schema.uniqueItems === true) return childConflict(keyword, "items", "uniqueItems");
      if (!opens(schema.contains, this.ignoredKeyword()) || !opens(schema.additionalItems, this.ignoredKeyword())) {
        return childConflict(keyword, "items", "contains or additionalItems");
      }
    }
    return this.singleSource(entries, keyword, "items", sources, conditional, false);
  }

  /** A child value projected through exactly one unconditional schema, which is then checked in turn. */
  private singleSource(
    entries: ClosureEntry[],
    keyword: DirectionalKeyword,
    subject: string,
    sources: unknown[],
    conditional: boolean,
    patterned: boolean,
  ): AccessConflict | undefined {
    if (conditional) return childConflict(keyword, subject, CONDITIONAL);
    if (patterned) return childConflict(keyword, subject, "patternProperties of a schema for the same object");
    // sameReference is an equivalence, so comparing with the first suffices.
    const [first] = sources;
    if (sources.some((source) => !sameReference(first, source))) {
      return childConflict(keyword, subject, "another schema for the same value");
    }
    if (comparesWholeValues(entries)) return childConflict(keyword, subject, "const or enum");
    return this.projectionConflict(first, keyword);
  }

  /** The subschemas `schema` holds under `keyword` (a schema, an array of them or a map of them). */
  private childSchemas(schema: JsonObject, keyword: string): unknown[] {
    const value = schema[keyword];
    if (value === undefined) return [];
    if (Array.isArray(value)) return value;
    if (SCHEMA_MAP_KEYWORDS.has(keyword) || keyword === "dependencies" || keyword === "dependentSchemas") {
      return isObject(value) ? Object.values(value).filter((entry) => !Array.isArray(entry)) : [];
    }
    return [value];
  }

  /**
   * Whether removal changes anything in the instance tree `schema` describes:
   * whether some schema reachable from it (through every subschema keyword
   * and `$ref`, with OpenAPI 3.0 ignoring `$ref` siblings) has a property
   * flagged with `keyword`. Components are resolved once per keyword
   * (`componentsReachingFlag`), so the check stays linear in the document.
   */
  private reachesFlag(schema: unknown, keyword: DirectionalKeyword): boolean {
    if (!isObject(schema)) return false;
    const memo = memoFor(this.reaches, keyword);
    let result = memo.get(schema);
    if (result === undefined) {
      const reaching = this.componentsReachingFlag(keyword);
      const { flagged, refs } = this.localFlags(schema, keyword);
      result = flagged || [...refs].some((name) => reaching.has(name));
      memo.set(schema, result);
    }
    return result;
  }

  private componentsReachingFlag(keyword: DirectionalKeyword): ReadonlySet<string> {
    const known = this.reaching.get(keyword);
    if (known) return known;
    const result = new Set<string>();
    const referrers = new Map<string, string[]>();
    const queue: string[] = [];
    for (const [name, schema] of Object.entries(this.schemas)) {
      const { flagged, refs } = this.componentFlags(schema, keyword);
      if (flagged) {
        result.add(name);
        queue.push(name);
      }
      for (const ref of refs) {
        const list = referrers.get(ref) ?? [];
        list.push(name);
        referrers.set(ref, list);
      }
    }
    while (queue.length > 0) {
      for (const referrer of referrers.get(queue.pop()!) ?? []) {
        if (result.has(referrer)) continue;
        result.add(referrer);
        queue.push(referrer);
      }
    }
    this.reaching.set(keyword, result);
    return result;
  }

  /**
   * `localFlags` of a component. One too deeply nested to scan (a stack
   * overflow) counts as flagged, so any operation reaching it is checked in
   * full, and fails there with its own skip; others are unaffected.
   */
  private componentFlags(schema: unknown, keyword: DirectionalKeyword): { flagged: boolean; refs: Set<string> } {
    try {
      return this.localFlags(schema, keyword);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return { flagged: true, refs: new Set() };
    }
  }

  /**
   * Whether the schemas reachable from `schema` without following `$ref`
   * have a property flagged with `keyword`, and the components they reference.
   */
  private localFlags(schema: unknown, keyword: DirectionalKeyword): { flagged: boolean; refs: Set<string> } {
    const refs = new Set<string>();
    let flagged = false;
    const seen = new Set<object>();
    const walk = (current: unknown): void => {
      if (!isObject(current) || seen.has(current)) return;
      seen.add(current);
      if (Object.hasOwn(current, "$ref")) {
        try {
          refs.add(parseComponentRef(current.$ref, "schemas"));
        } catch {
          // left for conversion to report
        }
        if (this.version === "3.0") return;
      }
      for (const [, property] of objectEntries(current.properties)) {
        if (this.hasFlag(property, keyword)) flagged = true;
      }
      for (const entry of SUBSCHEMA_KEYWORDS) {
        if (entry === this.ignoredKeyword()) continue;
        for (const child of this.childSchemas(current, entry)) walk(child);
      }
    };
    walk(schema);
    return { flagged, refs };
  }

  private admittedValues(schema: unknown): ReadonlySet<ValueKind> {
    try {
      return this.admits(schema).values;
    } catch {
      return EVERYTHING.values;
    }
  }

  private mayBeObject(schema: unknown): boolean {
    return this.admittedValues(schema).has("object");
  }

  private target(ref: unknown): unknown {
    try {
      return this.component(parseComponentRef(ref, "schemas"));
    } catch {
      return undefined;
    }
  }

  /**
   * Whether a property schema carries `keyword`: on itself, on a schema it
   * references (an alias's own sibling included in 3.1; OpenAPI 3.0 ignores
   * every `$ref` sibling, so there only the target counts), on an `allOf` member, or on
   * every alternative of an `anyOf`/`oneOf` other than a null-only one (the
   * nullable reference idiom `anyOf: [{ $ref }, { type: "null" }]`).
   */
  private hasFlag(property: unknown, keyword: DirectionalKeyword): boolean {
    if (!isObject(property)) return false;
    const memo = memoFor(this.flags, keyword);
    const known = memo.get(property);
    if (known !== undefined) return known;
    // A cycle back to this schema adds no flag; a cycle that never descends
    // into a child is rejected by `definitions` anyway.
    memo.set(property, false);
    try {
      const result = this.computeFlag(property, keyword);
      memo.set(property, result);
      return result;
    } catch (error) {
      // A partial result (such as after a stack overflow) is never kept.
      memo.delete(property);
      throw error;
    }
  }

  private computeFlag(property: JsonObject, keyword: DirectionalKeyword): boolean {
    if (Object.hasOwn(property, "$ref")) {
      const referenced = this.hasFlag(this.target(property.$ref), keyword);
      if (this.version === "3.0" || referenced) return referenced;
    }
    if (property[keyword] === true) return true;
    if (arrayOf(property.allOf).some((member) => this.hasFlag(member, keyword))) return true;
    for (const alternatives of ["anyOf", "oneOf"] as const) {
      const values = arrayOf(property[alternatives]).filter((member) => !this.isNullOnly(member));
      if (values.length > 0 && values.every((member) => this.hasFlag(member, keyword))) return true;
    }
    return false;
  }

  private isNullOnly(schema: unknown): boolean {
    const values = this.admittedValues(schema);
    return values.size === 1 && values.has("null");
  }

  private convertedComponent(name: string, mode: SchemaMode): ConvertedComponent {
    const cacheKey = `${mode}:${name}`;
    let entry = this.cache.get(cacheKey);
    if (!entry) {
      try {
        const refs = new Set<string>();
        const schema = this.budgeted(() => this.convertRoot(this.component(name), mode, refs));
        entry = { schema, refs, inPlace: inPlaceReferences(schema) };
      } catch (error) {
        if (!(error instanceof OpenApiSkip)) throw error;
        entry = {
          error: new OpenApiSkip(error.code, `${error.message} (in #/components/schemas/${name})`),
        };
      }
      this.cache.set(cacheKey, entry);
    }
    return entry;
  }

  /**
   * The transitive closure of referenced component schemas, as `definitions`.
   * A closure in which a definition reaches itself without descending into a
   * property, item or other child instance is rejected: validators would
   * recurse on the same value without end.
   */
  definitions(refs: Iterable<string>, mode: SchemaMode): Record<string, McpFnJsonSchema | boolean> {
    // Kept per call by mode and names: many operations reach the same closure.
    const names = [...refs];
    const key = `${mode}\0${names.join("\0")}`;
    let known = this.closures.get(key);
    if (!known) {
      try {
        known = { value: this.closureOf(names, mode) };
      } catch (error) {
        if (!(error instanceof OpenApiSkip)) throw error;
        known = { error };
      }
      this.closures.set(key, known);
    }
    if (known.error) throw known.error;
    return known.value!;
  }

  private readonly closures = new Map<string, { value?: Record<string, McpFnJsonSchema | boolean>; error?: OpenApiSkip }>();

  private closureOf(refs: string[], mode: SchemaMode): Record<string, McpFnJsonSchema | boolean> {
    const result: Array<[string, McpFnJsonSchema | boolean]> = [];
    const entries = new Map<string, ConvertedComponent>();
    const queue = [...refs];
    while (queue.length > 0) {
      const key = queue.shift()!;
      if (entries.has(key)) continue;
      const entry = this.convertedComponent(key, mode);
      if (entry.error) throw entry.error;
      entries.set(key, entry);
      result.push([key, entry.schema!]);
      for (const next of entry.refs!) if (!entries.has(next)) queue.push(next);
    }
    assertProductiveRecursion(entries);
    return Object.fromEntries(result);
  }
}

const DEFINITION_REF = "#/definitions/";

/**
 * Why `entry`, a schema for an object whose flagged properties `declarers`
 * maps to the schemas flagging them, needs a flagged name: a `required` list
 * of a schema that does not flag it, an object-wide constraint, or (under a
 * condition) a keyword that tells the object with the name from the one without.
 */
function needsFlagged(
  entry: ClosureEntry,
  declarers: ReadonlyMap<string, ReadonlySet<object>>,
  ignored: string | undefined,
): AccessConflict | undefined {
  const { schema, conditional } = entry;
  const [first] = declarers.keys();
  const constraint = (conditional ? NAME_SENSITIVE : INSTANCE_CONSTRAINTS).find(
    (keyword) => keyword !== ignored && Object.hasOwn(schema, keyword),
  );
  if (constraint !== undefined) return { name: first!, by: constraint };
  if (conditional && !opens(schema.additionalProperties, ignored)) {
    return { name: first!, by: "additionalProperties under a condition" };
  }
  const listed = conditional ? objectEntries(schema.properties).find(([name]) => declarers.has(name)) : undefined;
  if (listed !== undefined) return { name: listed[0], by: CONDITIONAL };
  const foreign = arrayOf(schema.required).find(
    (name) => typeof name === "string" && declarers.get(name)?.has(schema) === false,
  );
  return foreign === undefined
    ? undefined
    : { name: foreign as string, by: "a required list of another schema for the same object" };
}

const wholeValueChecks = new WeakMap<ClosureEntry[], boolean>();

/** Whether some schema for the instance has an object or array `const`/`enum` (computed once per closure). */
function comparesWholeValues(entries: ClosureEntry[]): boolean {
  let known = wholeValueChecks.get(entries);
  if (known === undefined) {
    known = entries.some(({ schema }) => isComposite(schema.const) || arrayOf(schema.enum).some(isComposite));
    wholeValueChecks.set(entries, known);
  }
  return known;
}

/**
 * Whether a constraining `patternProperties` key of `entries` may match a
 * name. Only an anchored literal prefix (`^x-`) or literal (`^id$`) is
 * decided, by looking strings up; any other pattern may match. No document
 * pattern is ever run.
 */
function patternMatcher(entries: ClosureEntry[], ignored: string | undefined): (name: string) => boolean {
  const exact = new Set<string>();
  // Literal prefixes by length: a name is compared once per distinct length,
  // with no structure larger than the prefixes themselves.
  const prefixes = new Map<number, Set<string>>();
  let any = false;
  for (const { schema } of entries) {
    for (const [pattern, value] of objectEntries(schema.patternProperties)) {
      if (!constrainsValues(value, ignored)) continue;
      const literal = /^\^([A-Za-z0-9_-]*)(\$?)$/.exec(pattern);
      if (!literal) any = true;
      else if (literal[2]) exact.add(literal[1]!);
      else {
        const prefix = literal[1]!;
        const known = prefixes.get(prefix.length) ?? new Set<string>();
        known.add(prefix);
        prefixes.set(prefix.length, known);
      }
    }
  }
  return (name) => {
    if (any || exact.has(name)) return true;
    for (const [length, known] of prefixes) {
      if (length <= name.length && known.has(name.slice(0, length))) return true;
    }
    return false;
  };
}

/**
 * Draft-07 has no `$defs`, so Ajv would not check the declarations under it
 * while @cfworker/json-schema does: they become `definitions` (never
 * referenced, since refs only target components), or an `allOf` member's
 * when the schema declares `definitions` too, which accepts every value.
 */
function addDefinitions(entries: Array<[string, unknown]>, defs: JsonObject): void {
  if (!entries.some(([keyword]) => keyword === "definitions")) {
    entries.push(["definitions", defs]);
    return;
  }
  const allOf = entries.find(([keyword]) => keyword === "allOf");
  if (allOf === undefined) entries.push(["allOf", [{ definitions: defs }]]);
  else if (Array.isArray(allOf[1]) && allOf[1].length > 0) allOf[1] = [...allOf[1], { definitions: defs }];
  // A malformed allOf is kept as written, so the schema is still refused.
  else entries.push(["$defs", defs]);
}

function childConflict(keyword: DirectionalKeyword, subject: string, by: string): AccessConflict {
  return {
    name: subject,
    by,
    message: `${subject} contains ${keyword} properties but is also constrained by ${by}, so they cannot be removed soundly`,
  };
}

/** The same object, or two references to the same component. */
function sameReference(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  return (
    isObject(left) &&
    isObject(right) &&
    Object.keys(left).length === 1 &&
    Object.keys(right).length === 1 &&
    typeof left.$ref === "string" &&
    left.$ref === right.$ref
  );
}

/** Whether a subschema accepts every value (absent, `true` or `{}`, ignoring a keyword the dialect does not define). */
function opens(value: unknown, ignored: string | undefined): boolean {
  return value === undefined || value === true || (isObject(value) && Object.keys(value).every((key) => key === ignored));
}

/** Whether a `const` or `enum` value is an object or array, which constrains child values. */
function isComposite(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/** Whether an `additionalProperties` value constrains the values (not only the presence) of properties. */
function constrainsValues(value: unknown, ignored: string | undefined): boolean {
  return isObject(value) && Object.keys(value).some((key) => key !== ignored);
}

function foldExclusiveBounds(converted: McpFnJsonSchema): void {
  // `{ minimum: 1, exclusiveMinimum: true }` became `exclusiveMinimum: 1`;
  // the inclusive bound it replaced is redundant.
  if (typeof converted.exclusiveMinimum === "number" && converted.minimum === converted.exclusiveMinimum) {
    delete converted.minimum;
  }
  if (typeof converted.exclusiveMaximum === "number" && converted.maximum === converted.exclusiveMaximum) {
    delete converted.maximum;
  }
}

/** Every keyword holding subschemas, for `localFlags`. */
const SUBSCHEMA_KEYWORDS = [
  "properties",
  "definitions",
  "$defs",
  "allOf",
  "items",
  "additionalItems",
  "contains",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependencies",
  "dependentSchemas",
] as const;

const IN_PLACE_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;
const IN_PLACE_KEYWORDS = ["not", "if", "then", "else"] as const;

/** Definitions a converted schema applies to the same instance it validates. */
function inPlaceReferences(schema: McpFnJsonSchema | boolean): Set<string> {
  const found = new Set<string>();
  const walk = (current: unknown): void => {
    if (!isObject(current)) return;
    if (typeof current.$ref === "string" && current.$ref.startsWith(DEFINITION_REF)) {
      found.add(current.$ref.slice(DEFINITION_REF.length));
    }
    for (const keyword of IN_PLACE_ARRAY_KEYWORDS) {
      for (const member of arrayOf(current[keyword])) walk(member);
    }
    for (const keyword of IN_PLACE_KEYWORDS) walk(current[keyword]);
    for (const [, dependency] of objectEntries(current.dependencies)) walk(dependency);
  };
  walk(schema);
  return found;
}

/**
 * `A: { $ref: B }, B: { $ref: A }` or a 3.1 `X: { $ref: X, type: object }`
 * never descends into a child value; validators recurse on it without end.
 */
function assertProductiveRecursion(entries: ReadonlyMap<string, ConvertedComponent>): void {
  const done = new Set<string>();
  const active = new Set<string>();
  const visit = (key: string): void => {
    if (done.has(key)) return;
    if (active.has(key)) {
      throw new OpenApiSkip(
        "unresolved-ref",
        `#/components/schemas/${key} refers back to itself without descending into a property or array item`,
      );
    }
    active.add(key);
    for (const next of entries.get(key)?.inPlace ?? []) visit(next);
    active.delete(key);
    done.add(key);
  };
  for (const key of entries.keys()) visit(key);
}

// OpenAPI 3.0.3: `nullable: true` adds "null" only to an explicitly defined
// `type`; other constraints such as `enum` keep their meaning, and a schema
// without `type` is unaffected.
function nullableSchema(schema: McpFnJsonSchema): McpFnJsonSchema {
  if (typeof schema.type === "string") {
    return schema.type === "null" ? schema : { ...schema, type: [schema.type, "null"] };
  }
  if (Array.isArray(schema.type) && !schema.type.includes("null")) {
    return { ...schema, type: [...schema.type, "null"] };
  }
  return schema;
}

/** A kind of JSON value. `integer` and `number` are disjoint: 1 is an integer, 1.5 a number. */
export type ValueKind = "string" | "number" | "integer" | "boolean" | "null" | "array" | "object";

const ALL_KINDS: readonly ValueKind[] = ["string", "number", "integer", "boolean", "null", "array", "object"];

/**
 * The kinds of value a schema can accept, and for arrays the kinds its items
 * can accept. It over-approximates: keywords that only narrow (`if`, bounds,
 * a `not` other than one of bare types) are ignored, so a kind outside the
 * set is never accepted.
 */
export interface AdmittedKinds {
  values: ReadonlySet<ValueKind>;
  items: ReadonlySet<ValueKind>;
}

const EVERYTHING: AdmittedKinds = { values: new Set(ALL_KINDS), items: new Set(ALL_KINDS) };
const NOTHING: AdmittedKinds = { values: new Set(), items: new Set() };

function kindsOfType(type: unknown): ValueKind[] {
  switch (type) {
    case "number":
      return ["number", "integer"];
    case "string":
    case "integer":
    case "boolean":
    case "null":
    case "array":
    case "object":
      return [type];
    default:
      return [];
  }
}

function kindOfValue(value: unknown): ValueKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  return "object";
}

const ANNOTATION_KEYWORDS = new Set(["type", "title", "description", "$comment"]);

/** The kinds a `not` refuses when it holds nothing but `type` (and annotations). */
function typeOnlyKinds(not: unknown): ValueKind[] {
  if (!isObject(not) || not.type === undefined) return [];
  if (!Object.keys(not).every((key) => ANNOTATION_KEYWORDS.has(key))) return [];
  return listOf(not.type).flatMap(kindsOfType);
}

/** `enum`/`const`: the value is one of `literals`, and an array value's items are among theirs. */
/** The kinds of `literals` and of the items of those that are arrays, to narrow by with `both`. */
function kindsOfLiterals(literals: unknown[]): AdmittedKinds {
  const items = new Set<ValueKind>();
  for (const literal of literals) {
    for (const item of arrayOf(literal)) items.add(kindOfValue(item));
  }
  return { values: new Set(literals.map(kindOfValue)), items };
}

/** The entries that can apply to a value of `kind`, each conditional when it applies to that kind only under a condition. */
function entriesFor(entries: ClosureEntry[], kind: ValueKind): ClosureEntry[] {
  const result: ClosureEntry[] = [];
  for (const entry of entries) {
    if (!entry.kinds.has(kind)) continue;
    const conditional = entry.conditionalKinds?.has(kind) ?? entry.conditional;
    result.push(conditional === entry.conditional ? entry : { ...entry, conditional });
  }
  return result;
}

const NO_KINDS: ReadonlySet<ValueKind> = new Set();

function intersect(left: ReadonlySet<ValueKind>, right: Iterable<ValueKind>): Set<ValueKind> {
  const allowed = new Set(right);
  return new Set([...left].filter((kind) => allowed.has(kind)));
}

function without(left: ReadonlySet<ValueKind>, removed: readonly ValueKind[]): Set<ValueKind> {
  return new Set([...left].filter((kind) => !removed.includes(kind)));
}

function both(left: AdmittedKinds, right: AdmittedKinds): AdmittedKinds {
  return { values: intersect(left.values, right.values), items: intersect(left.items, right.items) };
}

/** `anyOf`/`oneOf`: a value matches some member; item kinds come from members that accept arrays. */
function either(members: AdmittedKinds[]): AdmittedKinds {
  const values = new Set<ValueKind>();
  const items = new Set<ValueKind>();
  for (const member of members) {
    for (const kind of member.values) values.add(kind);
    if (member.values.has("array")) for (const kind of member.items) items.add(kind);
  }
  return { values, items };
}
