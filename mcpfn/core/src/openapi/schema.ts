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
  /** Definitions this one validates the same instance against (allOf/anyOf/oneOf/not/if/then/else/dependencies). */
  inPlace?: Set<string>;
  error?: OpenApiSkip;
}

/** A component converted with extra property names removed (see `reference`). */
interface DefinitionVariant {
  name: string;
  strip: ReadonlySet<string>;
}

type DirectionalKeyword = "readOnly" | "writeOnly";

const NO_NAMES: ReadonlySet<string> = new Set();

function directionalKeyword(mode: SchemaMode): DirectionalKeyword {
  return mode === "input" ? "readOnly" : "writeOnly";
}

/**
 * Converts OpenAPI 3.0/3.1 Schema Objects to draft-07 for mcpFn's validators.
 * Component schemas are converted once per mode and shared between tools.
 */
export class SchemaConverter {
  private readonly cache = new Map<string, ConvertedComponent>();
  private readonly ancestors = new Set<object>();
  private readonly variants = new Map<string, DefinitionVariant>();
  private readonly variantKeys = new Map<string, string>();
  private readonly flaggedNames = new Map<string, ReadonlySet<string>>();
  private readonly mentionedNames = new Map<string, ReadonlySet<string>>();

  constructor(
    private readonly version: OpenApiVersion,
    private readonly schemas: JsonObject,
  ) {}

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
  convert(
    schema: unknown,
    mode: SchemaMode,
    refs: Set<string>,
    strip: ReadonlySet<string> = NO_NAMES,
  ): McpFnJsonSchema | boolean {
    if (typeof schema === "boolean") return schema;
    if (!isObject(schema)) {
      throw new OpenApiSkip("invalid-schema", "a schema is not an object");
    }
    if (this.ancestors.has(schema)) {
      throw new OpenApiSkip("circular-object", "a schema contains itself as an object (not through $ref)");
    }
    this.ancestors.add(schema);
    try {
      return this.convertObject(schema, mode, refs, strip);
    } finally {
      this.ancestors.delete(schema);
    }
  }

  /**
   * `strip` holds property names an enclosing schema marks readOnly (input) or
   * writeOnly (output) for the same instance; they are removed from this
   * schema's `properties` and `required` and from its in-place members.
   */
  private convertObject(
    schema: JsonObject,
    mode: SchemaMode,
    refs: Set<string>,
    strip: ReadonlySet<string> = NO_NAMES,
  ): McpFnJsonSchema {
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
      // OpenAPI 3.0 ignores $ref siblings; 3.1 (2020-12) applies them too,
      // which is an allOf of the siblings and the reference.
      const { $ref, ...rest } = schema;
      if (this.version === "3.0" || Object.keys(rest).length === 0) {
        return this.reference(name, mode, refs, strip);
      }
      if (rest.allOf !== undefined && !Array.isArray(rest.allOf)) {
        throw new OpenApiSkip("invalid-schema", "allOf is not an array");
      }
      const allOf = (rest.allOf as unknown[] | undefined) ?? [];
      return this.convertObject({ ...rest, allOf: [...allOf, { $ref }] }, mode, refs, strip);
    }

    const own = this.directionalNames(schema, directionalKeyword(mode));
    const removed = own.size === 0 ? strip : new Set([...strip, ...own]);
    const entries: Array<[string, unknown]> = [];
    let dependencies: JsonObject | undefined;
    for (const [keyword, value] of Object.entries(schema)) {
      if (DROPPED_KEYWORDS.has(keyword)) continue;
      if (SCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
        entries.push([keyword, this.convertMap(value, mode, refs)]);
      } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) {
        entries.push([keyword, value.map((item) => this.convert(item, mode, refs, removed))]);
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
    this.removeDirectionalProperties(converted, removed, own, mode);
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

  /**
   * Remove `removed` from `properties` and `required`. In input mode the names
   * this schema itself marks readOnly (`own`) are also refused through
   * `propertyNames` unless the object is closed, so a caller cannot send one
   * as an additional property.
   */
  private removeDirectionalProperties(
    converted: McpFnJsonSchema,
    removed: ReadonlySet<string>,
    own: ReadonlySet<string>,
    mode: SchemaMode,
  ): void {
    if (removed.size === 0) return;
    if (isObject(converted.properties)) {
      converted.properties = Object.fromEntries(
        Object.entries(converted.properties).filter(([name]) => !removed.has(name)),
      );
    }
    if (Array.isArray(converted.required)) {
      converted.required = converted.required.filter(
        (name) => typeof name !== "string" || !removed.has(name),
      );
      if ((converted.required as unknown[]).length === 0) delete converted.required;
    }
    if (
      mode === "input" &&
      own.size > 0 &&
      !(converted.additionalProperties === false && converted.patternProperties === undefined)
    ) {
      const forbidden = { not: { enum: [...own] } };
      converted.propertyNames =
        converted.propertyNames === undefined ? forbidden : { allOf: [converted.propertyNames, forbidden] };
    }
  }

  /**
   * A reference to component `name` for an instance whose enclosing schemas
   * remove `strip`. When the component mentions a name it does not already
   * remove itself, the reference targets a variant definition converted
   * without those names; otherwise it targets the shared definition.
   */
  private reference(
    name: string,
    mode: SchemaMode,
    refs: Set<string>,
    strip: ReadonlySet<string>,
  ): McpFnJsonSchema {
    let key = name;
    if (strip.size > 0) {
      const own = this.componentNames(name, directionalKeyword(mode), this.flaggedNames, (schema, keyword) =>
        this.directionalNames(schema, keyword),
      );
      const mentioned = this.componentNames(name, directionalKeyword(mode), this.mentionedNames, (schema) =>
        this.mentions(schema),
      );
      const pending = [...strip].filter((entry) => !own.has(entry) && mentioned.has(entry)).sort();
      if (pending.length > 0) key = this.variantKey(name, mode, pending);
    }
    refs.add(key);
    return { $ref: `${DEFINITION_REF}${key}` };
  }

  private variantKey(name: string, mode: SchemaMode, strip: string[]): string {
    const identity = JSON.stringify([mode, name, strip]);
    let key = this.variantKeys.get(identity);
    if (!key) {
      // ":" is outside component names, so a variant never collides with one.
      key = `${name}:${directionalKeyword(mode)}-${this.variantKeys.size + 1}`;
      this.variantKeys.set(identity, key);
      this.variants.set(key, { name, strip: new Set(strip) });
    }
    return key;
  }

  private componentNames(
    name: string,
    keyword: DirectionalKeyword,
    cache: Map<string, ReadonlySet<string>>,
    compute: (schema: unknown, keyword: DirectionalKeyword) => ReadonlySet<string>,
  ): ReadonlySet<string> {
    const key = `${keyword}:${name}`;
    let names = cache.get(key);
    if (!names) {
      cache.set(key, NO_NAMES); // a cycle back to this component adds nothing new
      names = Object.hasOwn(this.schemas, name) ? compute(this.schemas[name], keyword) : NO_NAMES;
      cache.set(key, names);
    }
    return names;
  }

  /**
   * Names of properties the instance described by `schema` carries with
   * `keyword` set: its own `properties`, and those of its `allOf` members and
   * `$ref` target, which constrain the same instance.
   */
  private directionalNames(schema: unknown, keyword: DirectionalKeyword): ReadonlySet<string> {
    const names = new Set<string>();
    this.inPlaceMembers(schema, (member) => {
      if (isObject(member.properties)) {
        for (const [name, property] of Object.entries(member.properties)) {
          if (this.hasFlag(property, keyword, new Set())) names.add(name);
        }
      }
    }, false);
    return names;
  }

  /** Property names in `properties` or `required` of `schema` or any schema validating the same instance. */
  private mentions(schema: unknown): ReadonlySet<string> {
    const names = new Set<string>();
    this.inPlaceMembers(schema, (member) => {
      if (isObject(member.properties)) for (const name of Object.keys(member.properties)) names.add(name);
      if (Array.isArray(member.required)) {
        for (const name of member.required) if (typeof name === "string") names.add(name);
      }
    }, true);
    return names;
  }

  /**
   * Visit `schema` and the schemas applied to the same instance: `$ref`
   * targets, `allOf` members and, when `alternatives` is set, `anyOf`/`oneOf`
   * members. Unresolvable references are left for conversion to report.
   */
  private inPlaceMembers(schema: unknown, visit: (member: JsonObject) => void, alternatives: boolean): void {
    const seen = new Set<object>();
    const walk = (current: unknown): void => {
      if (!isObject(current) || seen.has(current)) return;
      seen.add(current);
      if (Object.hasOwn(current, "$ref")) {
        walk(this.target(current.$ref));
        if (this.version === "3.0") return;
      }
      visit(current);
      const keywords = alternatives ? ["allOf", "anyOf", "oneOf"] : ["allOf"];
      for (const keyword of keywords) {
        const members = current[keyword];
        if (Array.isArray(members)) for (const member of members) walk(member);
      }
    };
    walk(schema);
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
   * references (an alias's own sibling included) or on an `allOf` member.
   */
  private hasFlag(property: unknown, keyword: DirectionalKeyword, seen: Set<object>): boolean {
    if (!isObject(property) || seen.has(property)) return false;
    seen.add(property);
    if (property[keyword] === true) return true;
    if (Object.hasOwn(property, "$ref") && this.hasFlag(this.target(property.$ref), keyword, seen)) return true;
    return Array.isArray(property.allOf) && property.allOf.some((member) => this.hasFlag(member, keyword, seen));
  }

  private convertedComponent(key: string, mode: SchemaMode): ConvertedComponent {
    const cacheKey = `${mode}:${key}`;
    let entry = this.cache.get(cacheKey);
    if (!entry) {
      const variant = this.variants.get(key);
      const name = variant?.name ?? key;
      try {
        const refs = new Set<string>();
        const schema = this.convert(this.component(name), mode, refs, variant?.strip);
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
    assertProductiveRecursion(entries, (key) => this.variants.get(key)?.name ?? key);
    return Object.fromEntries(result);
  }
}

const DEFINITION_REF = "#/definitions/";

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
      const members = current[keyword];
      if (Array.isArray(members)) for (const member of members) walk(member);
    }
    for (const keyword of IN_PLACE_KEYWORDS) walk(current[keyword]);
    if (isObject(current.dependencies)) {
      for (const dependency of Object.values(current.dependencies)) walk(dependency);
    }
  };
  walk(schema);
  return found;
}

/**
 * `A: { $ref: B }, B: { $ref: A }` or a 3.1 `X: { $ref: X, type: object }`
 * never descends into a child value; validators recurse on it without end.
 */
function assertProductiveRecursion(
  entries: ReadonlyMap<string, ConvertedComponent>,
  componentOf: (key: string) => string,
): void {
  const done = new Set<string>();
  const active = new Set<string>();
  const visit = (key: string): void => {
    if (done.has(key)) return;
    if (active.has(key)) {
      const name = componentOf(key);
      throw new OpenApiSkip(
        "unresolved-ref",
        `#/components/schemas/${name} refers back to itself without descending into a property or array item`,
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
