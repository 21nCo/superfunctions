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

// 2020-12 keywords outside the closed set (D12), plus identifiers that change
// the base URI so `#/definitions/<name>` would no longer resolve.
const UNSUPPORTED_KEYWORDS = [
  "prefixItems",
  "$dynamicRef",
  "$recursiveRef",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentSchemas",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$recursiveAnchor",
] as const;

// OpenAPI-only annotations dropped from the produced draft-07 schema. `nullable`
// is folded into the type first; `$schema` names the 2020-12 dialect.
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

function decodePointerToken(token: string): string {
  let decoded = token;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    // Keep the raw token; it then fails the component-name check below.
  }
  return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
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
  const match = /^#\/components\/([^/]+)\/([^/]+)$/.exec(ref);
  if (!match || match[1] !== kind) {
    throw new OpenApiSkip(
      "unsupported-ref",
      `reference ${JSON.stringify(ref)} is not a #/components/${kind}/<name> reference`,
    );
  }
  const name = decodePointerToken(match[2]!);
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
  error?: OpenApiSkip;
}

/**
 * Converts OpenAPI 3.0/3.1 Schema Objects to draft-07 for mcpFn's validators.
 * Component schemas are converted once per mode and shared between tools.
 */
export class SchemaConverter {
  private readonly cache = new Map<string, ConvertedComponent>();
  private readonly ancestors = new Set<object>();

  constructor(
    private readonly version: OpenApiVersion,
    private readonly schemas: JsonObject,
  ) {}

  /** Follow `$ref` chains to the component schema object, for shape checks. */
  resolve(schema: unknown): unknown {
    let current = schema;
    const seen = new Set<string>();
    while (isObject(current) && "$ref" in current) {
      const name = parseComponentRef(current.$ref, "schemas");
      if (seen.has(name)) throw aliasCycle(name);
      seen.add(name);
      current = this.component(name);
    }
    return current;
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

  private readonly admitted = new Map<string, AdmittedKinds>();

  /**
   * The kinds of value `schema` accepts, following local `$ref`s and
   * `allOf`/`anyOf`/`oneOf`. A schema without `type`, `enum` or `const`
   * accepts every kind; a reference cycle is treated as accepting every kind.
   */
  admits(schema: unknown, stack: Set<unknown> = new Set()): AdmittedKinds {
    if (schema === false) return NOTHING;
    if (!isObject(schema) || stack.has(schema)) return EVERYTHING;
    stack.add(schema);
    try {
      return this.admitsObject(schema, stack);
    } finally {
      stack.delete(schema);
    }
  }

  private admitsObject(schema: JsonObject, stack: Set<unknown>): AdmittedKinds {
    let result = EVERYTHING;
    if (Object.hasOwn(schema, "$ref")) {
      const name = parseComponentRef(schema.$ref, "schemas");
      let target = this.admitted.get(name);
      if (!target) {
        // A cycle cut below this point widens the result, which stays safe to reuse.
        target = this.admits(this.component(name), stack);
        this.admitted.set(name, target);
      }
      // OpenAPI 3.0 ignores $ref siblings; 3.1 applies them too.
      if (this.version === "3.0") return target;
      result = target;
    }
    if (schema.type !== undefined) {
      const kinds = (Array.isArray(schema.type) ? schema.type : [schema.type]).flatMap(kindsOfType);
      if (this.version === "3.0" && schema.nullable === true) kinds.push("null");
      result = { ...result, values: intersect(result.values, kinds) };
    }
    if (Array.isArray(schema.enum)) {
      result = { ...result, values: intersect(result.values, schema.enum.map(kindOfValue)) };
    }
    if (Object.hasOwn(schema, "const")) {
      result = { ...result, values: intersect(result.values, [kindOfValue(schema.const)]) };
    }
    if (Object.hasOwn(schema, "items") && !Array.isArray(schema.items)) {
      result = { ...result, items: intersect(result.items, this.admits(schema.items, stack).values) };
    }
    if (Array.isArray(schema.allOf)) {
      for (const member of schema.allOf) result = both(result, this.admits(member, stack));
    }
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const members = schema[keyword];
      if (Array.isArray(members)) {
        result = both(result, either(members.map((member) => this.admits(member, stack))));
      }
    }
    return result;
  }

  /**
   * Convert a schema rooted in a tool's input or output schema. Referenced
   * component names are added to `refs`; call `definitions` for their closure.
   */
  convert(schema: unknown, mode: SchemaMode, refs: Set<string>): McpFnJsonSchema | boolean {
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

  private convertObject(schema: JsonObject, mode: SchemaMode, refs: Set<string>): McpFnJsonSchema {
    for (const keyword of UNSUPPORTED_KEYWORDS) {
      if (Object.hasOwn(schema, keyword)) {
        throw new OpenApiSkip(
          "unsupported-schema-keyword",
          `schema keyword ${keyword} is not supported`,
        );
      }
    }
    if (Object.hasOwn(schema, "$ref")) {
      const name = parseComponentRef(schema.$ref, "schemas");
      this.component(name);
      refs.add(name);
      const reference = { $ref: `#/definitions/${name}` };
      // OpenAPI 3.0 ignores $ref siblings; 3.1 (2020-12) applies them too.
      if (this.version === "3.0") return reference;
      const { $ref: _ref, ...rest } = schema;
      if (Object.keys(rest).length === 0) return reference;
      const siblings = this.convertObject(rest, mode, refs);
      const allOf = Array.isArray(siblings.allOf) ? siblings.allOf : [];
      return { ...siblings, allOf: [...allOf, reference] };
    }

    const entries: Array<[string, unknown]> = [];
    let dependencies: JsonObject | undefined;
    for (const [keyword, value] of Object.entries(schema)) {
      if (DROPPED_KEYWORDS.has(keyword)) continue;
      if (SCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
        entries.push([keyword, this.convertMap(value, mode, refs)]);
      } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) {
        entries.push([keyword, value.map((item) => this.convert(item, mode, refs))]);
      } else if (keyword === "items") {
        entries.push([
          keyword,
          Array.isArray(value)
            ? value.map((item) => this.convert(item, mode, refs))
            : this.convert(value, mode, refs),
        ]);
      } else if (SCHEMA_KEYWORDS.has(keyword)) {
        entries.push([keyword, this.convert(value, mode, refs)]);
      } else if (keyword === "dependencies" && isObject(value)) {
        dependencies = { ...dependencies, ...this.convertDependencies(value, mode, refs) };
      } else if (keyword === "dependentRequired" && isObject(value)) {
        dependencies = { ...value, ...dependencies };
      } else if (
        (keyword === "exclusiveMinimum" || keyword === "exclusiveMaximum") &&
        typeof value === "boolean"
      ) {
        // OpenAPI 3.0 (draft-04 style) boolean form; draft-07 takes the bound.
        const bound = schema[keyword === "exclusiveMinimum" ? "minimum" : "maximum"];
        if (value && typeof bound === "number") entries.push([keyword, bound]);
      } else {
        entries.push([keyword, value]);
      }
    }
    if (dependencies) entries.push(["dependencies", dependencies]);
    const converted = Object.fromEntries(entries) as McpFnJsonSchema;
    this.foldExclusiveBounds(converted);
    this.removeDirectionalProperties(schema, converted, mode);
    return this.version === "3.0" && schema.nullable === true
      ? nullableSchema(converted)
      : converted;
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

  private foldExclusiveBounds(converted: McpFnJsonSchema): void {
    // `{ minimum: 1, exclusiveMinimum: true }` became `exclusiveMinimum: 1`;
    // the inclusive bound it replaced is redundant.
    if (typeof converted.exclusiveMinimum === "number" && converted.minimum === converted.exclusiveMinimum) {
      delete converted.minimum;
    }
    if (typeof converted.exclusiveMaximum === "number" && converted.maximum === converted.exclusiveMaximum) {
      delete converted.maximum;
    }
  }

  private removeDirectionalProperties(
    source: JsonObject,
    converted: McpFnJsonSchema,
    mode: SchemaMode,
  ): void {
    const properties = source.properties;
    if (!isObject(properties) || !isObject(converted.properties)) return;
    const keyword = mode === "input" ? "readOnly" : "writeOnly";
    const removed = new Set<string>();
    for (const [name, property] of Object.entries(properties)) {
      if (this.hasFlag(property, keyword)) removed.add(name);
    }
    if (removed.size === 0) return;
    converted.properties = Object.fromEntries(
      Object.entries(converted.properties).filter(([name]) => !removed.has(name)),
    );
    if (Array.isArray(converted.required)) {
      converted.required = converted.required.filter(
        (name) => typeof name !== "string" || !removed.has(name),
      );
      if ((converted.required as unknown[]).length === 0) delete converted.required;
    }
    // An input must not carry a readOnly field even when the object accepts
    // other additional properties. A closed object already rejects it.
    if (mode === "input" && !(converted.additionalProperties === false && converted.patternProperties === undefined)) {
      const forbidden = { not: { enum: [...removed] } };
      converted.propertyNames =
        converted.propertyNames === undefined ? forbidden : { allOf: [converted.propertyNames, forbidden] };
    }
  }

  private hasFlag(property: unknown, keyword: "readOnly" | "writeOnly"): boolean {
    if (!isObject(property)) return false;
    if (property[keyword] === true) return true;
    if (!("$ref" in property)) return false;
    try {
      const target = this.resolve(property);
      return isObject(target) && target[keyword] === true;
    } catch {
      return false; // the reference itself fails when the property is converted
    }
  }

  private convertedComponent(name: string, mode: SchemaMode): ConvertedComponent {
    const key = `${mode}:${name}`;
    let entry = this.cache.get(key);
    if (!entry) {
      try {
        const refs = new Set<string>();
        entry = { schema: this.convert(this.component(name), mode, refs), refs };
      } catch (error) {
        if (!(error instanceof OpenApiSkip)) throw error;
        entry = {
          error: new OpenApiSkip(error.code, `${error.message} (in #/components/schemas/${name})`),
        };
      }
      this.cache.set(key, entry);
    }
    return entry;
  }

  /** The transitive closure of referenced component schemas, as `definitions`. */
  definitions(refs: Iterable<string>, mode: SchemaMode): Record<string, McpFnJsonSchema | boolean> {
    const result: Array<[string, McpFnJsonSchema | boolean]> = [];
    const seen = new Set<string>();
    const queue = [...refs];
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const entry = this.convertedComponent(name, mode);
      if (entry.error) throw entry.error;
      result.push([name, entry.schema!]);
      for (const next of entry.refs!) if (!seen.has(next)) queue.push(next);
    }
    const definitions = Object.fromEntries(result);
    for (const name of seen) assertNoAliasCycle(definitions, name);
    return definitions;
  }
}

function aliasCycle(name: string): OpenApiSkip {
  return new OpenApiSkip(
    "unresolved-ref",
    `#/components/schemas/${name} is a $ref cycle with no schema of its own`,
  );
}

const DEFINITION_REF = "#/definitions/";

/** `A: { $ref: B }, B: { $ref: A }` never reaches a schema; validators may loop on it. */
function assertNoAliasCycle(definitions: Record<string, McpFnJsonSchema | boolean>, start: string): void {
  const seen = new Set<string>();
  let name = start;
  for (;;) {
    const schema = definitions[name];
    if (!isObject(schema) || typeof schema.$ref !== "string" || Object.keys(schema).length !== 1) return;
    if (seen.has(name)) throw aliasCycle(start);
    seen.add(name);
    name = schema.$ref.slice(DEFINITION_REF.length);
  }
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
 * can accept. It over-approximates: keywords that only narrow (`not`, `if`,
 * bounds) are ignored, so a kind outside the set is never accepted.
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

function intersect(left: ReadonlySet<ValueKind>, right: Iterable<ValueKind>): Set<ValueKind> {
  const allowed = new Set(right);
  return new Set([...left].filter((kind) => allowed.has(kind)));
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
