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

const SCHEMA_ARRAY_KEYWORDS = new Set(["anyOf", "oneOf"]);

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

interface RegionSummary {
  /** Names flagged in this region itself: the names its conversion removes. */
  names: ReadonlySet<string>;
  /** Names flagged in this region or any nested one. */
  flagged: Set<string>;
  /** Names some region (this or a nested one) uses in properties/required without flagging them. */
  unflagged: Set<string>;
  /** A name flagged inside not, if/then/else or a schema-valued dependency. */
  conditionalFlag?: string;
  /**
   * A `oneOf` (in this region or a nested one) whose members removal would
   * not change identically, so they could overlap after it (see `oneOfConflict`).
   */
  oneOfConflict?: AccessConflict;
}

/**
 * Why a flagged property cannot be removed soundly: `name` is the property
 * and `by` what else constrains it; `message`, when set, replaces the
 * sentence built from them (for a property that only contains flagged ones).
 */
interface AccessConflict {
  name: string;
  by: string;
  message?: string;
}

const ONE_OF_CONFLICT = "a oneOf whose members do not all mark it the same way";

/**
 * Keywords that constrain the whole instance, its property set or its
 * property count wherever they apply, so removing a property changes what
 * they accept.
 */
const INSTANCE_CONSTRAINTS = [
  "const",
  "enum",
  "minProperties",
  "propertyNames",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
] as const;

const EMPTY_REGION: RegionSummary = {
  names: new Set(),
  flagged: new Set(),
  unflagged: new Set(),
};

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
  private readonly flags = new Map<DirectionalKeyword, WeakMap<object, boolean>>();
  private readonly summaries = new Map<DirectionalKeyword, WeakMap<object, RegionSummary>>();

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

    const keyword = directionalKeyword(mode);
    const { names: own, conflict } = this.directionalAnalysis(schema, keyword);
    if (conflict !== undefined) {
      throw new OpenApiSkip(
        "unsupported-access-flag",
        conflict.message ??
          `property ${JSON.stringify(conflict.name)} is ${keyword} but is also constrained by ` +
            `${conflict.by}, so it cannot be removed soundly`,
      );
    }
    const removed = own.size === 0 ? strip : new Set([...strip, ...own]);
    const entries: Array<[string, unknown]> = [];
    let dependencies: JsonObject | undefined;
    for (const [keyword, value] of Object.entries(schema)) {
      if (DROPPED_KEYWORDS.has(keyword)) continue;
      if (SCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
        entries.push([keyword, this.convertMap(value, mode, refs)]);
      } else if (keyword === "allOf" && Array.isArray(value)) {
        // allOf members validate the same instance unconditionally, so the
        // removed names are removed from them too. anyOf/oneOf members are
        // converted on their own: directionalAnalysis has already rejected a
        // member that mentions a removed name.
        entries.push([keyword, value.map((item) => this.convert(item, mode, refs, removed))]);
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
        this.directionalAnalysis(schema, keyword).names,
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
   * `$ref` target, which constrain the same instance unconditionally. These
   * are the names conversion removes.
   *
   * `conflict` names a flagged property that removal would not handle
   * soundly, so the schema is skipped instead of rewritten:
   * - a name flagged in one region (the unconditional part above, or one
   *   `anyOf`/`oneOf` member with its own `allOf`/`$ref` closure) and
   *   mentioned in `properties` or `required` of another region that does
   *   not flag it too: for example `required: [id]` beside `oneOf` members
   *   that mark `id` readOnly, or a readOnly `id` that a `oneOf` member requires;
   * - a flagged name inside `not`, `if`, `then`, `else` or a schema-valued
   *   dependency, where removing it would invert or move the condition;
   * - a name removed anywhere inside a `oneOf` member that every member able
   *   to be an object does not remove in its own region through the same
   *   property schemas with the same required status (see `oneOfConflict`);
   * - any keyword other than `properties` and `required` that constrains a
   *   flagged name, the property set or the property count anywhere it
   *   applies to the instance (see `nameConstraint`);
   * - removal inside a child value (a property's object, array items, map
   *   values) that something other than the projected subschema also
   *   constrains, or that changes `oneOf` members differently (see
   *   `childConstraint` and `oneOfConflict`), even with no name flagged here.
   * An `anyOf`/`oneOf` member that flags and uses a name only itself is
   * converted on its own and removes the name there.
   */
  private directionalAnalysis(
    schema: unknown,
    keyword: DirectionalKeyword,
  ): { names: ReadonlySet<string>; conflict?: AccessConflict } {
    const summary = this.regionSummary(schema, keyword);
    const names = summary.names;
    // Checked first: removal inside a member's child instance (a property's
    // schema, items) can make members overlap with no name flagged here.
    if (summary.oneOfConflict !== undefined) return { names, conflict: summary.oneOfConflict };
    const child = this.childConstraint(schema, keyword);
    if (child !== undefined) return { names, conflict: child };
    if (summary.flagged.size === 0) return { names };
    const elsewhere = "anyOf/oneOf, not, if/then/else or a schema dependency";
    if (summary.conditionalFlag !== undefined) {
      return { names, conflict: { name: summary.conditionalFlag, by: elsewhere } };
    }
    // A name some region uses without flagging it conflicts with any region
    // that flags it (never the same region: there it would count as flagged).
    for (const name of summary.flagged) {
      if (summary.unflagged.has(name)) return { names, conflict: { name, by: elsewhere } };
    }
    const constraint = this.nameConstraint(schema, summary.flagged);
    return constraint === undefined ? { names } : { names, conflict: constraint };
  }

  /**
   * Removal inside a child instance (a property's value, an array item, a
   * map value) is sound only when the subschema it projects is the only
   * thing constraining that child: then a value the source schema accepted,
   * with the flagged properties left out, satisfies the projected subschema.
   * This walks every schema applied to the instance rooted at `schema` (as
   * `nameConstraint` does) and reports a child whose schema removes a name at
   * any depth (`reachesFlag`) when anything else constrains its value:
   * - `const` or `enum` (they constrain the whole value, children included);
   * - for a property: subschemas that are not all the same schema, a
   *   `patternProperties` key matching it, a schema-valued
   *   `additionalProperties` of a schema that does not list it, or any of
   *   these inside `not`, `if`/`then`/`else` or a dependency;
   * - for `patternProperties` or `additionalProperties` values: any other
   *   schema for the property names they could cover, or the holder inside
   *   `not`, `if`/`then`/`else` or a dependency;
   * - for array items (`items`, `additionalItems`, `contains`): more than one
   *   distinct item schema, `uniqueItems` (projected items can become equal),
   *   or the holder inside `not`, `if`/`then`/`else` or a dependency.
   * Members of a `oneOf` are compared by `oneOfConflict` as well.
   */
  private childConstraint(schema: unknown, keyword: DirectionalKeyword): AccessConflict | undefined {
    const entries = this.inPlaceEntries(schema);
    const reaches = (value: unknown) => this.reachesFlag(value, keyword);
    const affected = new Set<string>();
    const patterns: Array<{ entry: InPlaceEntry; pattern: string }> = [];
    const additional: InPlaceEntry[] = [];
    const items: InPlaceEntry[] = [];
    for (const entry of entries) {
      const current = entry.schema;
      if (isObject(current.properties)) {
        for (const [name, value] of Object.entries(current.properties)) if (reaches(value)) affected.add(name);
      }
      if (isObject(current.patternProperties)) {
        for (const [pattern, value] of Object.entries(current.patternProperties)) {
          if (reaches(value)) patterns.push({ entry, pattern });
        }
      }
      if (reaches(current.additionalProperties)) additional.push(entry);
      if (ITEM_KEYWORDS.some((item) => this.childSchemas(current, item).some(reaches))) items.push(entry);
    }
    if (affected.size === 0 && patterns.length === 0 && additional.length === 0 && items.length === 0) {
      return undefined;
    }
    const conflict = (subject: string, by: string): AccessConflict => ({
      name: subject,
      by,
      message: `${subject} contains ${keyword} properties but is also constrained by ${by}, so they cannot be removed soundly`,
    });
    const firstSubject = (): string => {
      const [name] = affected;
      if (name !== undefined) return `property ${JSON.stringify(name)}`;
      if (patterns.length > 0) return `patternProperties ${JSON.stringify(patterns[0]!.pattern)}`;
      return additional.length > 0 ? "additionalProperties" : "items";
    };
    // A const/enum of strings or numbers only constrains the kind of value,
    // which removal keeps; an object or array value constrains its children.
    for (const entry of entries) {
      if (Object.hasOwn(entry.schema, "const") && isComposite(entry.schema.const)) {
        return conflict(firstSubject(), "const");
      }
      if (Array.isArray(entry.schema.enum) && entry.schema.enum.some(isComposite)) {
        return conflict(firstSubject(), "enum");
      }
    }
    const conditional = "not, if/then/else or a schema dependency";
    for (const name of affected) {
      const subject = `property ${JSON.stringify(name)}`;
      const schemas: unknown[] = [];
      for (const entry of entries) {
        const current = entry.schema;
        const listed = isObject(current.properties) && Object.hasOwn(current.properties, name);
        const pattern = isObject(current.patternProperties)
          ? Object.keys(current.patternProperties).find((key) => patternMatches(key, name))
          : undefined;
        const valued = !listed && pattern === undefined && constrainsValues(current.additionalProperties);
        if (!listed && pattern === undefined && !valued) continue;
        if (entry.conditional) return conflict(subject, conditional);
        if (pattern !== undefined) return conflict(subject, `patternProperties ${JSON.stringify(pattern)}`);
        if (valued) return conflict(subject, "additionalProperties of a schema that does not list it");
        const value = (current.properties as JsonObject)[name];
        if (schemas.length > 0 && !schemas.some((known) => sameSchema(known, value))) {
          return conflict(subject, "another schema for the same property");
        }
        schemas.push(value);
      }
    }
    const holders = [
      ...patterns.map(({ entry, pattern }) => ({ entry, subject: `patternProperties ${JSON.stringify(pattern)}`, pattern })),
      ...additional.map((entry) => ({ entry, subject: "additionalProperties", pattern: undefined })),
    ];
    for (const { entry: holder, subject, pattern } of holders) {
      if (holder.conditional) return conflict(subject, conditional);
      for (const entry of entries) {
        const current = entry.schema;
        if (current === holder.schema) {
          // Additional properties exclude the listed ones; a pattern also covers them.
          const names = isObject(current.properties) ? Object.keys(current.properties) : [];
          const covered = pattern === undefined ? undefined : names.find((name) => patternMatches(pattern, name));
          if (covered !== undefined) return conflict(subject, `property ${JSON.stringify(covered)} it also covers`);
          const others = isObject(current.patternProperties) ? Object.keys(current.patternProperties) : [];
          if (pattern !== undefined && others.length > 1) {
            return conflict(subject, "another patternProperties key that may cover the same names");
          }
          continue;
        }
        if (isObject(current.properties) && Object.keys(current.properties).length > 0) {
          return conflict(subject, "properties of another schema for the same object");
        }
        if (isObject(current.patternProperties) && Object.keys(current.patternProperties).length > 0) {
          return conflict(subject, "patternProperties of another schema for the same object");
        }
        if (constrainsValues(current.additionalProperties)) {
          return conflict(subject, "additionalProperties of another schema for the same object");
        }
      }
    }
    if (items.length > 0) {
      if (items.some((entry) => entry.conditional)) return conflict("items", conditional);
      const schemas: unknown[] = [];
      for (const entry of entries) {
        if (entry.schema.uniqueItems === true) return conflict("items", "uniqueItems");
        for (const item of ITEM_KEYWORDS) {
          for (const value of this.childSchemas(entry.schema, item)) {
            if (value === true || (isObject(value) && Object.keys(value).length === 0)) continue;
            if (entry.conditional) return conflict("items", conditional);
            if (schemas.length > 0 && !schemas.some((known) => sameSchema(known, value))) {
              return conflict("items", "another schema for the same items");
            }
            schemas.push(value);
          }
        }
      }
    }
    return undefined;
  }

  /**
   * `schema` and every schema applied to the same instance: `$ref` targets
   * (OpenAPI 3.0 ignores the siblings), `allOf`/`anyOf`/`oneOf` members and,
   * marked `conditional`, `not`/`if`/`then`/`else` and schema-valued
   * dependencies and whatever they apply in turn.
   */
  private inPlaceEntries(schema: unknown): InPlaceEntry[] {
    const entries: InPlaceEntry[] = [];
    const visited = new Map<object, boolean>();
    const walk = (current: unknown, conditional: boolean): void => {
      if (!isObject(current)) return;
      const before = visited.get(current);
      if (before === true || (before === false && !conditional)) return;
      visited.set(current, conditional);
      if (Object.hasOwn(current, "$ref")) {
        walk(this.target(current.$ref), conditional);
        if (this.version === "3.0") return;
      }
      entries.push({ schema: current, conditional });
      for (const keyword of IN_PLACE_ARRAY_KEYWORDS) {
        const members = current[keyword];
        if (Array.isArray(members)) for (const member of members) walk(member, conditional);
      }
      for (const keyword of IN_PLACE_KEYWORDS) walk(current[keyword], true);
      for (const keyword of ["dependencies", "dependentSchemas"] as const) {
        for (const dependency of this.childSchemas(current, keyword)) walk(dependency, true);
      }
    };
    walk(schema, false);
    return entries;
  }

  /**
   * The single check of every keyword other than `properties[name]` and
   * `required` that constrains a flagged name, run over every schema applied
   * to the instance rooted at `schema`: `$ref` targets (OpenAPI 3.0 ignores
   * the siblings), `allOf`/`anyOf`/`oneOf` members, `not`/`if`/`then`/`else`
   * and schema-valued dependencies. Removing a flagged property is sound only
   * when none of these is present:
   * - `const`, `enum`, `minProperties`, `propertyNames`, `dependencies`,
   *   `dependentRequired` or `dependentSchemas`, anywhere;
   * - `maxProperties` inside `anyOf`/`oneOf`, `not`, `if`/`then`/`else` or a
   *   dependency (unconditional `maxProperties` only gains from removal);
   * - a `patternProperties` key matching the name (an invalid pattern counts
   *   as a match);
   * - `additionalProperties` other than absent, `true` or `{}` in a schema
   *   that neither lists the name in its own `properties` nor matches it by
   *   its own `patternProperties`.
   */
  private nameConstraint(
    schema: unknown,
    names: ReadonlySet<string>,
  ): { name: string; by: string } | undefined {
    const [first] = names;
    if (first === undefined) return undefined;
    // object -> whether it was already visited as a nested (conditional or alternative) schema
    const visited = new Map<object, boolean>();
    const walk = (current: unknown, nested: boolean): { name: string; by: string } | undefined => {
      if (!isObject(current)) return undefined;
      const before = visited.get(current);
      if (before === true || (before === false && !nested)) return undefined;
      visited.set(current, nested);
      if (Object.hasOwn(current, "$ref")) {
        const found = walk(this.target(current.$ref), nested);
        if (found !== undefined || this.version === "3.0") return found;
      }
      const keyword = INSTANCE_CONSTRAINTS.find((entry) => Object.hasOwn(current, entry));
      if (keyword !== undefined) return { name: first, by: keyword };
      if (nested && Object.hasOwn(current, "maxProperties")) {
        return { name: first, by: "maxProperties inside anyOf/oneOf, not, if/then/else or a dependency" };
      }
      const patterns = isObject(current.patternProperties) ? Object.keys(current.patternProperties) : [];
      for (const name of names) {
        const pattern = patterns.find((entry) => patternMatches(entry, name));
        if (pattern !== undefined) return { name, by: `patternProperties ${JSON.stringify(pattern)}` };
        if (
          !opensAdditional(current.additionalProperties) &&
          !(isObject(current.properties) && Object.hasOwn(current.properties, name))
        ) {
          return { name, by: "additionalProperties of a schema that does not list it" };
        }
      }
      for (const keyword of IN_PLACE_ARRAY_KEYWORDS) {
        const members = current[keyword];
        if (!Array.isArray(members)) continue;
        for (const member of members) {
          const found = walk(member, nested || keyword !== "allOf");
          if (found !== undefined) return found;
        }
      }
      for (const keyword of IN_PLACE_KEYWORDS) {
        const found = walk(current[keyword], true);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    return walk(schema, false);
  }

  /**
   * The flags and uses of property names in the region rooted at `schema`
   * (its `allOf`/`$ref` closure) and, aggregated, in every region nested in it
   * through `anyOf`/`oneOf`, `not`, `if`/`then`/`else` and dependencies.
   * Memoised per schema object; a cycle back to a schema being summarised adds
   * nothing (an in-place cycle is rejected by `definitions` anyway).
   */
  private regionSummary(schema: unknown, keyword: DirectionalKeyword): RegionSummary {
    if (!isObject(schema)) return EMPTY_REGION;
    let memo = this.summaries.get(keyword);
    if (!memo) {
      memo = new WeakMap();
      this.summaries.set(keyword, memo);
    }
    const known = memo.get(schema);
    if (known) return known;
    memo.set(schema, EMPTY_REGION);
    const flagged = new Set<string>();
    const mentioned = new Set<string>();
    const nested: RegionSummary[] = [];
    let conditionalFlag: string | undefined;
    let oneOfConflict: AccessConflict | undefined;
    const conditional = (member: unknown) => {
      const summary = this.regionSummary(member, keyword);
      conditionalFlag ??= summary.conditionalFlag ?? summary.flagged.values().next().value;
      nested.push(summary);
    };
    const seen = new Set<object>();
    const walk = (current: unknown): void => {
      if (!isObject(current) || seen.has(current)) return;
      seen.add(current);
      if (Object.hasOwn(current, "$ref")) {
        walk(this.target(current.$ref));
        if (this.version === "3.0") return;
      }
      if (isObject(current.properties)) {
        for (const [name, property] of Object.entries(current.properties)) {
          if (this.hasFlag(property, keyword)) flagged.add(name);
          else mentioned.add(name);
        }
      }
      if (Array.isArray(current.required)) {
        for (const name of current.required) if (typeof name === "string") mentioned.add(name);
      }
      for (const dependencyKeyword of ["dependencies", "dependentSchemas"] as const) {
        const map = current[dependencyKeyword];
        if (!isObject(map)) continue;
        for (const dependency of Object.values(map)) if (!Array.isArray(dependency)) conditional(dependency);
      }
      if (Array.isArray(current.allOf)) for (const member of current.allOf) walk(member);
      for (const alternatives of ["anyOf", "oneOf"] as const) {
        const members = current[alternatives];
        if (!Array.isArray(members)) continue;
        const summaries = members.map((member) => this.regionSummary(member, keyword));
        nested.push(...summaries);
        if (alternatives === "oneOf") oneOfConflict ??= this.oneOfConflict(members, summaries, keyword);
      }
      for (const condition of ["not", "if", "then", "else"] as const) {
        if (current[condition] !== undefined) conditional(current[condition]);
      }
    };
    walk(schema);
    const summary: RegionSummary = {
      names: flagged,
      flagged: new Set(flagged),
      unflagged: new Set([...mentioned].filter((name) => !flagged.has(name))),
      ...(conditionalFlag !== undefined ? { conditionalFlag } : {}),
      ...(oneOfConflict !== undefined ? { oneOfConflict } : {}),
    };
    for (const inner of nested) {
      for (const name of inner.flagged) summary.flagged.add(name);
      for (const name of inner.unflagged) summary.unflagged.add(name);
      if (inner.conditionalFlag !== undefined) summary.conditionalFlag ??= inner.conditionalFlag;
      if (inner.oneOfConflict !== undefined) summary.oneOfConflict ??= inner.oneOfConflict;
    }
    memo.set(schema, summary);
    return summary;
  }

  /**
   * Why removal could make the members of this `oneOf` overlap, so `oneOf`
   * would reject a value exactly one member accepted; undefined when every
   * member that removal changes changes the same way. Two rules:
   *
   * - A name removed anywhere inside a member (its own region or a nested
   *   `anyOf`/`oneOf`/`$ref` region) must be removed by every member that can
   *   be an object in its own region (not only inside a nested composition),
   *   through the same property schemas with the same required status, as
   *   polymorphic members sharing one base schema do (patterns,
   *   `propertyNames`, `maxProperties` and the rest are `nameConstraint`'s).
   *   Otherwise a member that differs on the name (another type, `const` or
   *   `enum`, required in one member only, absent or forbidden in one) could
   *   overlap with another once it is removed.
   * - Removal inside a child instance counts too. A property of a member
   *   whose schema removes a name at any depth (see `reachesFlag`) must be
   *   given the same property schemas with the same required status by every
   *   member that can be an object; a member changed through `items`,
   *   `additionalProperties`, `patternProperties`, `propertyNames` or a nested
   *   composition instead of a named property conflicts with any other member
   *   that admits a kind of value it admits.
   */
  private oneOfConflict(
    members: unknown[],
    summaries: RegionSummary[],
    keyword: DirectionalKeyword,
  ): AccessConflict | undefined {
    const removed = new Set<string>();
    for (const summary of summaries) for (const name of summary.flagged) removed.add(name);
    const projections = members.map((member) => this.memberProjection(member, keyword));
    if (removed.size === 0 && projections.every((entry) => entry.properties.size === 0 && !entry.other)) {
      return undefined;
    }
    // Removal only changes what objects a member accepts, so a member that
    // accepts no object (the `{ type: "null" }` of a nullable reference)
    // cannot start overlapping through a property.
    const objects = members.map((member) => this.mayBeObject(member));
    const differs = (name: string): boolean => {
      let first: PropertyFacts | undefined;
      for (const [index, member] of members.entries()) {
        if (!objects[index]) continue;
        const facts = this.propertyFacts(member, name);
        if (first === undefined) first = facts;
        else if (!sameFacts(first, facts)) return true;
      }
      return false;
    };
    for (const name of removed) {
      const unremoved = summaries.some((summary, index) => objects[index] && !summary.names.has(name));
      if (unremoved || differs(name)) return { name, by: ONE_OF_CONFLICT };
    }
    const kinds = members.map((member) => this.admittedValues(member));
    for (const [index, projection] of projections.entries()) {
      if (!projection.other) continue;
      const overlaps = kinds.some(
        (other, at) => at !== index && [...other].some((kind) => kinds[index]!.has(kind)),
      );
      if (overlaps) {
        return {
          name: projection.other,
          by: ONE_OF_CONFLICT,
          message:
            `a oneOf member removes ${keyword} properties through ${projection.other}, ` +
            "so its members could overlap once they are removed",
        };
      }
    }
    const affected = new Set<string>();
    for (const [index, projection] of projections.entries()) {
      if (objects[index]) for (const name of projection.properties) affected.add(name);
    }
    for (const name of affected) {
      if (removed.has(name) || !differs(name)) continue;
      return {
        name,
        by: ONE_OF_CONFLICT,
        message:
          `property ${JSON.stringify(name)} contains ${keyword} properties but the members of a oneOf ` +
          "do not all give it the same schema, so they could overlap once those are removed",
      };
    }
    return undefined;
  }

  /**
   * How removal changes the instances `member` describes below its own
   * level: the names of its properties (over its `allOf`/`$ref` closure)
   * whose schemas remove a name at any depth, and `other`, the first keyword
   * through which it removes one elsewhere.
   */
  private memberProjection(
    member: unknown,
    keyword: DirectionalKeyword,
  ): { properties: Set<string>; other?: string } {
    const properties = new Set<string>();
    let other: string | undefined;
    this.inPlaceMembers(member, (schema) => {
      if (isObject(schema.properties)) {
        for (const [name, property] of Object.entries(schema.properties)) {
          if (this.reachesFlag(property, keyword)) properties.add(name);
        }
      }
      if (other !== undefined) return;
      for (const entry of PROJECTION_KEYWORDS) {
        if (this.childSchemas(schema, entry).some((child) => this.reachesFlag(child, keyword))) {
          other = entry;
          return;
        }
      }
    }, false);
    return other === undefined ? { properties } : { properties, other };
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
    let memo = this.reaches.get(keyword);
    if (!memo) {
      memo = new WeakMap();
      this.reaches.set(keyword, memo);
    }
    let result = memo.get(schema);
    if (result === undefined) {
      const reaching = this.componentsReachingFlag(keyword);
      const { flagged, refs } = this.localFlags(schema, keyword);
      result = flagged || [...refs].some((name) => reaching.has(name));
      memo.set(schema, result);
    }
    return result;
  }

  private readonly reaches = new Map<DirectionalKeyword, WeakMap<object, boolean>>();

  private readonly reaching = new Map<DirectionalKeyword, ReadonlySet<string>>();

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
        let list = referrers.get(ref);
        if (!list) referrers.set(ref, (list = []));
        list.push(name);
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
      if (isObject(current.properties)) {
        for (const property of Object.values(current.properties)) {
          if (this.hasFlag(property, keyword)) flagged = true;
        }
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
    try {
      return this.admits(schema).values.has("object");
    } catch {
      return true;
    }
  }

  /** The schemas given to property `name` and whether it is required, over `schema`'s allOf/$ref closure. */
  private propertyFacts(schema: unknown, name: string): PropertyFacts {
    const schemas: unknown[] = [];
    let required = false;
    this.inPlaceMembers(schema, (member) => {
      if (isObject(member.properties) && Object.hasOwn(member.properties, name)) {
        schemas.push(member.properties[name]);
      }
      if (Array.isArray(member.required) && member.required.includes(name)) required = true;
    }, false);
    return { schemas, required };
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
   * references (an alias's own sibling included in 3.1; OpenAPI 3.0 ignores
   * every `$ref` sibling, so there only the target counts), on an `allOf` member, or on
   * every alternative of an `anyOf`/`oneOf` other than a null-only one (the
   * nullable reference idiom `anyOf: [{ $ref }, { type: "null" }]`).
   */
  private hasFlag(property: unknown, keyword: DirectionalKeyword): boolean {
    if (!isObject(property)) return false;
    let memo = this.flags.get(keyword);
    if (!memo) {
      memo = new WeakMap();
      this.flags.set(keyword, memo);
    }
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
    if (Array.isArray(property.allOf) && property.allOf.some((member) => this.hasFlag(member, keyword))) {
      return true;
    }
    for (const alternatives of ["anyOf", "oneOf"] as const) {
      const members = property[alternatives];
      if (!Array.isArray(members)) continue;
      const values = members.filter((member) => !this.isNullOnly(member));
      if (values.length > 0 && values.every((member) => this.hasFlag(member, keyword))) return true;
    }
    return false;
  }

  private isNullOnly(schema: unknown): boolean {
    try {
      const { values } = this.admits(schema);
      return values.size === 1 && values.has("null");
    } catch {
      return false;
    }
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

interface PropertyFacts {
  schemas: unknown[];
  required: boolean;
}

function sameFacts(left: PropertyFacts, right: PropertyFacts): boolean {
  return (
    left.required === right.required &&
    left.schemas.length === right.schemas.length &&
    left.schemas.every((schema, index) => sameSchema(schema, right.schemas[index]))
  );
}

/** The same object, or equal JSON (a schema JSON cannot represent counts as different). */
function sameSchema(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try {
    const encoded = JSON.stringify(left);
    return encoded !== undefined && encoded === JSON.stringify(right);
  } catch {
    return false;
  }
}

/** Whether an `additionalProperties` value accepts every additional property. */
function opensAdditional(value: unknown): boolean {
  return value === undefined || value === true || (isObject(value) && Object.keys(value).length === 0);
}

/** Whether a `patternProperties` key matches `name`; a pattern that does not compile counts as a match. */

function patternMatches(pattern: string, name: string): boolean {
  try {
    return new RegExp(pattern, "u").test(name);
  } catch {
    return true;
  }
}

/**
 * Keywords through which a `oneOf` member can change below its own level
 * other than a named property (see `memberProjection`).
 */
const PROJECTION_KEYWORDS = [
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

/** Keywords whose subschemas validate array items. */
const ITEM_KEYWORDS = ["items", "additionalItems", "contains"] as const;

/** A schema applied to an instance, and whether only under `not`, `if`/`then`/`else` or a dependency. */
interface InPlaceEntry {
  schema: JsonObject;
  conditional: boolean;
}

/** Whether a `const` or `enum` value is an object or array, which constrains child values. */
function isComposite(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/** Whether an `additionalProperties` value constrains the values (not only the presence) of properties. */
function constrainsValues(value: unknown): boolean {
  return isObject(value) && Object.keys(value).length > 0;
}

/** Every keyword holding subschemas, for `localFlags`. */
const SUBSCHEMA_KEYWORDS = ["properties", "definitions", "$defs", "allOf", ...PROJECTION_KEYWORDS] as const;

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
