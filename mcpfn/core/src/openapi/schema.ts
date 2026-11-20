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

/** `input` removes `readOnly` properties; `output` removes `writeOnly` properties. */
export type SchemaMode = "input" | "output";

type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 2019-09/2020-12 keywords outside the closed set (D12), plus identifiers
// that change the base URI so `#/definitions/<name>` would no longer resolve.
// Every 2019-09/2020-12 keyword draft-07 does not define is either listed
// here or handled in convertObject: `dependentRequired` is translated to
// `dependencies`, `$defs` is converted like `definitions` (refs only ever
// target components), and the annotations `$comment`, `deprecated`,
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
] as const;

// OpenAPI-only annotations dropped from the produced draft-07 schema. `nullable`
// is folded into the type first. A default `$schema` is dropped too (see checkKeywords).
const DROPPED_KEYWORDS = new Set([
  "example",
  "discriminator",
  "xml",
  "externalDocs",
  "nullable",
  "$schema",
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
 * Whether a 3.1 `jsonSchemaDialect` or `$schema` names the dialect the
 * converter implements: the OAS 3.1 base dialect or JSON Schema 2020-12.
 */
export function isDefaultDialect(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  const base = uri.endsWith("#") ? uri.slice(0, -1) : uri;
  return (
    base === "https://json-schema.org/draft/2020-12/schema" ||
    base.startsWith("https://spec.openapis.org/oas/3.1/dialect/")
  );
}

/**
 * Schema nodes one operation's input, one operation's output or one
 * component may produce, counted while converting and while copying. A
 * parsed document can share one object between many schema positions, so
 * the produced tree can be exponentially larger than the document.
 */
export const MAX_SCHEMA_NODES = 100_000;

export class NodeBudget {
  private remaining = MAX_SCHEMA_NODES;

  charge(): void {
    this.remaining -= 1;
    if (this.remaining < 0) {
      throw new OpenApiSkip("schema-too-large", `a schema expands to more than ${MAX_SCHEMA_NODES} nodes`);
    }
  }
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

function directionalKeyword(mode: SchemaMode): DirectionalKeyword {
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
const UNPROJECTED_POSITIONS = ["patternProperties", "contains", "additionalItems", "propertyNames"] as const;

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
  private readonly flags = new Map<DirectionalKeyword, WeakMap<object, boolean>>();
  private readonly reaches = new Map<DirectionalKeyword, WeakMap<object, boolean>>();
  private readonly reaching = new Map<DirectionalKeyword, ReadonlySet<string>>();
  private readonly projections = new Map<DirectionalKeyword, WeakMap<object, AccessConflict | null>>();
  private budget = new NodeBudget();

  constructor(
    private readonly version: OpenApiVersion,
    private readonly schemas: JsonObject,
    /** Set when the document's `jsonSchemaDialect` is not the default; every schema is then refused. */
    private readonly unsupportedDialect?: string,
  ) {}

  /** Run `task` with a fresh node budget (one per operation input, operation output or component). */
  budgeted<T>(task: () => T): T {
    const outer = this.budget;
    this.budget = new NodeBudget();
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
    if (!isObject(schema) || stack.has(schema)) return EVERYTHING;
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
    for (const member of arrayOf(schema.allOf)) result = both(result, this.admits(member, stack));
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const members = schema[keyword];
      if (Array.isArray(members)) {
        result = both(result, either(members.map((member) => this.admits(member, stack))));
      }
    }
    const excluded = typeOnlyKinds(schema.not);
    return excluded.length === 0 ? result : { ...result, values: without(result.values, excluded) };
  }

  /** `type` (with 3.0 `nullable`), `enum` and `const`. */
  private narrowByValues(result: AdmittedKinds, schema: JsonObject): AdmittedKinds {
    let narrowed = result;
    if (schema.type !== undefined) {
      const kinds = listOf(schema.type).flatMap(kindsOfType);
      if (this.version === "3.0" && schema.nullable === true) kinds.push("null");
      narrowed = { ...narrowed, values: intersect(narrowed.values, kinds) };
    }
    if (Array.isArray(schema.enum)) narrowed = narrowByLiterals(narrowed, schema.enum);
    if (Object.hasOwn(schema, "const")) narrowed = narrowByLiterals(narrowed, [schema.const]);
    return narrowed;
  }

  /**
   * Convert a schema rooted in a tool's input or output schema. Referenced
   * component names are added to `refs`; call `definitions` for their closure.
   */
  convert(schema: unknown, mode: SchemaMode, refs: Set<string>): McpFnJsonSchema | boolean {
    if (this.unsupportedDialect !== undefined) {
      throw new OpenApiSkip("unsupported-dialect", `the document's jsonSchemaDialect ${this.unsupportedDialect} is not supported`);
    }
    this.budget.charge();
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
    if (rest.allOf !== undefined && !Array.isArray(rest.allOf)) {
      throw new OpenApiSkip("invalid-schema", "allOf is not an array");
    }
    return this.convertObject({ ...rest, allOf: [...arrayOf(rest.allOf), { $ref }] }, mode, refs);
  }

  private convertKeywords(schema: JsonObject, mode: SchemaMode, refs: Set<string>): McpFnJsonSchema {
    const entries: Array<[string, unknown]> = [];
    let dependencies: JsonObject | undefined;
    for (const [keyword, value] of Object.entries(schema)) {
      if (DROPPED_KEYWORDS.has(keyword)) continue;
      if (keyword === "dependencies" && isObject(value)) {
        dependencies = { ...dependencies, ...this.convertDependencies(value, mode, refs) };
      } else if (keyword === "dependentRequired" && isObject(value)) {
        dependencies = { ...value, ...dependencies };
      } else {
        const entry = this.convertEntry(schema, keyword, value, mode, refs);
        if (entry) entries.push(entry);
      }
    }
    if (dependencies) entries.push(["dependencies", dependencies]);
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
    if (SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) {
      return [keyword, value.map((item) => this.convert(item, mode, refs))];
    }
    if (keyword === "items") {
      return [
        keyword,
        Array.isArray(value) ? value.map((item) => this.convert(item, mode, refs)) : this.convert(value, mode, refs),
      ];
    }
    if (SCHEMA_KEYWORDS.has(keyword)) return [keyword, this.convert(value, mode, refs)];
    if ((keyword === "exclusiveMinimum" || keyword === "exclusiveMaximum") && typeof value === "boolean") {
      // OpenAPI 3.0 (draft-04 style) boolean form; draft-07 takes the bound.
      const bound = schema[keyword === "exclusiveMinimum" ? "minimum" : "maximum"];
      return value && typeof bound === "number" ? [keyword, bound] : undefined;
    }
    return [keyword, value];
  }

  private convertMap(value: JsonObject, mode: SchemaMode, refs: Set<string>): JsonObject {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, this.convert(item, mode, refs)]),
    );
  }

  private convertDependencies(value: JsonObject, mode: SchemaMode, refs: Set<string>): JsonObject {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        Array.isArray(item) ? item : this.convert(item, mode, refs),
      ]),
    );
  }

  /**
   * Leave out the properties `source` itself flags for `mode`: `false` refuses
   * the name whatever `patternProperties` or `additionalProperties` say, and a
   * closed object refuses it once it is no longer listed.
   */
  private project(converted: McpFnJsonSchema, source: JsonObject, mode: SchemaMode): void {
    const keyword = directionalKeyword(mode);
    const flagged = objectEntries(source.properties)
      .filter(([, property]) => this.hasFlag(property, keyword))
      .map(([name]) => name);
    if (flagged.length === 0 || !isObject(converted.properties)) return;
    const closed = converted.additionalProperties === false && converted.patternProperties === undefined;
    const properties: JsonObject = { ...converted.properties };
    for (const name of flagged) {
      if (closed) delete properties[name];
      else properties[name] = false;
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
  checkProjection(schema: unknown, mode: SchemaMode): void {
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

  /** Memoised per schema object; a cycle back to a schema being checked adds nothing new. */
  private projectionConflict(schema: unknown, keyword: DirectionalKeyword): AccessConflict | undefined {
    if (!isObject(schema) || !this.reachesFlag(schema, keyword)) return undefined;
    const memo = memoFor(this.projections, keyword);
    const known = memo.get(schema);
    if (known !== undefined) return known ?? undefined;
    memo.set(schema, null);
    const entries = this.closure(schema);
    const conflict = this.flagConflict(entries, keyword) ?? this.childConflict(entries, keyword);
    memo.set(schema, conflict ?? null);
    return conflict;
  }

  /**
   * `root` and every schema applied to the same instance: `$ref` targets
   * (OpenAPI 3.0 ignores the siblings), `allOf` members and `anyOf`/`oneOf`
   * members, plus, marked `conditional`, `not`/`if`/`then`/`else`, schema
   * dependencies and alternatives that can accept the same kind of value.
   */
  private closure(root: JsonObject): ClosureEntry[] {
    const entries: ClosureEntry[] = [];
    const visited = new Map<object, boolean>();
    const walk = (current: unknown, conditional: boolean): void => {
      if (!isObject(current)) return;
      const before = visited.get(current);
      if (before === false || (before === true && conditional)) return;
      visited.set(current, conditional);
      if (Object.hasOwn(current, "$ref")) {
        walk(this.target(current.$ref), conditional);
        if (this.version === "3.0") return;
      }
      entries.push({ schema: current, conditional });
      for (const member of arrayOf(current.allOf)) walk(member, conditional);
      for (const keyword of ["anyOf", "oneOf"] as const) {
        const members = arrayOf(current[keyword]);
        const exclusive = this.exclusive(members);
        for (const member of members) walk(member, conditional || !exclusive);
      }
      for (const keyword of ["not", "if", "then", "else"] as const) walk(current[keyword], true);
      for (const keyword of ["dependencies", "dependentSchemas"] as const) {
        for (const [, dependency] of objectEntries(current[keyword])) walk(dependency, true);
      }
    };
    walk(root, false);
    return entries;
  }

  /** Whether no two alternatives accept the same kind of value, so each value meets at most one. */
  private exclusive(members: unknown[]): boolean {
    if (members.length <= 1) return true;
    const seen = new Set<ValueKind>();
    for (const member of members) {
      for (const kind of this.admittedValues(member)) {
        if (seen.has(kind)) return false;
        seen.add(kind);
      }
    }
    return true;
  }

  /**
   * Flags on this instance's own properties: each must be declared in an
   * unconditional schema, no schema that can accept an object may need the
   * name (a `required` list of another schema, `const`, `enum`,
   * `minProperties` or a dependency), and no conditional one may tell the
   * object with the name from the object without it (listing it, counting
   * or matching property names, or closing the object).
   */
  private flagConflict(entries: ClosureEntry[], keyword: DirectionalKeyword): AccessConflict | undefined {
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
    if (declarers.size === 0) return undefined;
    for (const entry of entries) {
      const conflict = this.mayBeObject(entry.schema) ? needsFlagged(entry, declarers) : undefined;
      if (conflict !== undefined) return conflict;
    }
    return undefined;
  }

  /**
   * Flags below this instance: a child value (a property, the additional
   * properties, the items) is projected only when exactly one schema
   * constrains it, unconditionally, and nothing compares whole values.
   */
  private childConflict(entries: ClosureEntry[], keyword: DirectionalKeyword): AccessConflict | undefined {
    const reaches = (value: unknown) => this.reachesFlag(value, keyword);
    for (const { schema } of entries) {
      for (const position of UNPROJECTED_POSITIONS) {
        if (this.childSchemas(schema, position).some(reaches)) return childConflict(keyword, position, "its position");
      }
      if (Array.isArray(schema.items) && schema.items.some(reaches)) {
        return childConflict(keyword, "items", "its position in a tuple");
      }
    }
    return (
      this.propertyConflict(entries, keyword) ??
      this.additionalConflict(entries, keyword) ??
      this.itemsConflict(entries, keyword)
    );
  }

  private propertyConflict(entries: ClosureEntry[], keyword: DirectionalKeyword): AccessConflict | undefined {
    const names = new Set<string>();
    for (const { schema } of entries) {
      for (const [name, property] of objectEntries(schema.properties)) {
        // A flagged property is refused outright, so its value is never checked.
        if (!this.hasFlag(property, keyword)) names.add(name);
      }
    }
    const patterned = entries.some(({ schema }) =>
      objectEntries(schema.patternProperties).some(([, value]) => constrainsValues(value)),
    );
    for (const name of names) {
      const { sources, conditional } = propertySources(entries, name);
      if (!sources.some((source) => this.reachesFlag(source, keyword))) continue;
      const subject = `property ${JSON.stringify(name)}`;
      const conflict = this.singleSource(entries, keyword, subject, sources, conditional, patterned);
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
          this.mayBeObject(schema) &&
          (objectEntries(schema.properties).length > 0 ||
            objectEntries(schema.patternProperties).length > 0 ||
            constrainsValues(schema.additionalProperties)),
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
      if (schema.items === undefined || Array.isArray(schema.items) || opens(schema.items)) continue;
      sources.push(schema.items);
      conditional ||= entry.conditional;
    }
    if (!sources.some((source) => this.reachesFlag(source, keyword))) return undefined;
    for (const { schema } of entries) {
      if (schema.uniqueItems === true) return childConflict(keyword, "items", "uniqueItems");
      if (!opens(schema.contains) || !opens(schema.additionalItems)) {
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
    const distinct = sources.filter((source, index) => sources.findIndex((other) => sameReference(other, source)) === index);
    if (distinct.length > 1) return childConflict(keyword, subject, "another schema for the same value");
    const literal = entries.find(
      ({ schema }) => isComposite(schema.const) || arrayOf(schema.enum).some(isComposite),
    );
    if (literal !== undefined) return childConflict(keyword, subject, "const or enum");
    return this.projectionConflict(distinct[0], keyword);
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
      const { flagged, refs } = this.localFlags(schema, keyword);
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
    const result = this.computeFlag(property, keyword);
    memo.set(property, result);
    return result;
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
        const schema = this.budgeted(() => this.convert(this.component(name), mode, refs));
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
function needsFlagged(entry: ClosureEntry, declarers: ReadonlyMap<string, ReadonlySet<object>>): AccessConflict | undefined {
  const { schema, conditional } = entry;
  const [first] = declarers.keys();
  const constraint = (conditional ? NAME_SENSITIVE : INSTANCE_CONSTRAINTS).find((keyword) => Object.hasOwn(schema, keyword));
  if (constraint !== undefined) return { name: first!, by: constraint };
  if (conditional && !opens(schema.additionalProperties)) {
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

/** The schemas `entries` give property `name` (listed, or through a constraining `additionalProperties`). */
function propertySources(entries: ClosureEntry[], name: string): { sources: unknown[]; conditional: boolean } {
  const sources: unknown[] = [];
  let conditional = false;
  for (const entry of entries) {
    const { schema } = entry;
    const listed = isObject(schema.properties) && Object.hasOwn(schema.properties, name);
    const value = listed ? (schema.properties as JsonObject)[name] : schema.additionalProperties;
    if (!listed && !constrainsValues(value)) continue;
    sources.push(value);
    conditional ||= entry.conditional;
  }
  return { sources, conditional };
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

/** Whether a subschema accepts every value (absent, `true` or `{}`). */
function opens(value: unknown): boolean {
  return value === undefined || value === true || (isObject(value) && Object.keys(value).length === 0);
}

/** Whether a `const` or `enum` value is an object or array, which constrains child values. */
function isComposite(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/** Whether an `additionalProperties` value constrains the values (not only the presence) of properties. */
function constrainsValues(value: unknown): boolean {
  return isObject(value) && Object.keys(value).length > 0;
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
function narrowByLiterals(result: AdmittedKinds, literals: unknown[]): AdmittedKinds {
  const items = new Set<ValueKind>();
  for (const literal of literals) {
    for (const item of arrayOf(literal)) items.add(kindOfValue(item));
  }
  return { values: intersect(result.values, literals.map(kindOfValue)), items: intersect(result.items, items) };
}

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
