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

function nullableSchema(schema: McpFnJsonSchema): McpFnJsonSchema {
  const result: McpFnJsonSchema = { ...schema };
  let handled = false;
  if (typeof result.type === "string") {
    result.type = result.type === "null" ? "null" : [result.type, "null"];
    handled = true;
  } else if (Array.isArray(result.type)) {
    if (!result.type.includes("null")) result.type = [...result.type, "null"];
    handled = true;
  }
  if (Array.isArray(result.enum)) {
    if (!result.enum.includes(null)) result.enum = [...result.enum, null];
    handled = true;
  }
  if (handled) return result;
  // No type of its own (for example `allOf: [{ $ref }]`): accept null beside it.
  return { anyOf: [schema, { type: "null" }] };
}
