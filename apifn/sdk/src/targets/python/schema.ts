// JSON Schema 2020-12 (as published in operation-catalog.v1) → Python type expressions.
// Objects with declared properties become TypedDicts (allOf of such objects merges them); constructs
// Python cannot express, such as other intersections, widen to Any. Type expressions are written as
// strings wherever they are evaluated, so definitions may refer to each other in any order.

import { componentName } from "../typescript/schema.js";
import { pyString } from "./naming.js";

const MAX_DEPTH = 64;
export const ANY = "_t.Any";
export const NEVER = "_te.Never";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function primitiveOnly(type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.every((entry) => entry === "string" || entry === "number" || entry === "integer" || entry === "boolean" || entry === "null");
}

/** The JSON types a schema's `type` keyword, or failing that its keywords, give it; null if neither does. */
function typeList(schema: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(schema.type)) return schema.type;
  if (typeof schema.type === "string") return [schema.type];
  if (isRecord(schema.properties) || "additionalProperties" in schema || "patternProperties" in schema) return ["object"];
  if ("items" in schema || "prefixItems" in schema) return ["array"];
  return null;
}

/** A literal type for a JSON value, `float` for a number Literal cannot hold, or null for an object or array. */
function literal(value: unknown): string | null {
  if (value === null) return "None";
  if (typeof value === "boolean") return `_t.Literal[${value ? "True" : "False"}]`;
  if (typeof value === "string") return `_t.Literal[${pyString(value)}]`;
  if (typeof value === "number" && Number.isFinite(value)) return Number.isSafeInteger(value) ? `_t.Literal[${value === 0 ? 0 : value}]` : "float";
  return null;
}

function union(types: string[]): string {
  const unique = [...new Set(types.filter((type) => type !== NEVER))];
  if (unique.length === 0) return NEVER;
  if (unique.includes(ANY)) return ANY;
  return unique.join(" | ");
}

/** Python has no intersection types: one constraint keeps its type, several widen to Any. */
function intersection(types: string[]): string {
  const unique = [...new Set(types.filter((type) => type !== ANY))];
  if (unique.includes(NEVER)) return NEVER;
  return unique.length === 1 ? unique[0]! : ANY;
}

/** A TypedDict field: the type expression is unquoted here and quoted where it is written. */
export interface PyField {
  key: string;
  type: string;
  required: boolean;
  description: string | null;
  deprecated: boolean;
}

/** A TypedDict synthesized for an object type that is not a component schema. */
export interface InlineTypedDict {
  name: string;
  fields: PyField[];
}

/** What `objectFields` merges: the object parts, and the property names any of them requires. */
interface FieldPlan {
  parts: Array<Record<string, unknown>>;
  required: ReadonlySet<string>;
}

/**
 * Where a schema sits in the component schema being typed: `direct` outside any object or array, `array`
 * inside plain array items, `tuple` inside `prefixItems`. A component reference that `cut` names is typed
 * Any in a `direct` or `tuple` position, as the TypeScript target types it unknown (see `aliasCuts`): there
 * it would make a type alias refer to itself.
 */
type Position = "direct" | "array" | "tuple";

const NO_CUTS: ReadonlySet<string> = new Set();

export class PythonTypes {
  constructor(
    private readonly schemas: Readonly<Record<string, unknown>>,
    /** Exported type name of a component schema, or null when it has none. */
    private readonly resolve: (component: string) => string | null,
    /** Alias cuts per referencing component (see `allAliasCuts`). */
    private readonly cuts: ReadonlyMap<string, ReadonlySet<string>>,
    /** Prefix for model names: `_m.` outside models.py. */
    private readonly prefix: string,
    /** Names already used in models.py; inline names are chosen around them. */
    private readonly taken: Set<string>,
    /** Inline TypedDicts in the order they were first needed, from every module; written to models.py. */
    readonly inline: InlineTypedDict[] = [],
    /** The types of models.py, where inline TypedDicts and their fields are written. */
    models?: PythonTypes
  ) {
    this.#models = models ?? this;
  }

  readonly #models: PythonTypes;

  /** Types for another module, which refers to models.py names through `prefix`; inline types still go to models.py. */
  withPrefix(prefix: string): PythonTypes {
    return new PythonTypes(this.schemas, this.resolve, this.cuts, prefix, this.taken, this.inline, this.#models);
  }

  /**
   * The object schemas a TypedDict for `schema` merges, when every part of it is an object: the schema itself,
   * each `allOf` member and the component it refers to, recursively, each once (a part reached again adds
   * nothing, so shared references cost one visit). Includes parts that declare no property, whose `required`
   * still applies. Null when some part is not an object type. Reads only; creates no types.
   */
  #objectParts(schema: unknown, cut: ReadonlySet<string>, depth: number): Array<Record<string, unknown>> | null {
    const parts: Array<Record<string, unknown>> = [];
    return this.#collectParts(schema, cut, depth, new Map(), parts) ? parts : null;
  }

  /** Adds the parts of `schema` to `parts`; false when some part is not an object type, or on a reference cycle. */
  #collectParts(
    schema: unknown,
    cut: ReadonlySet<string>,
    depth: number,
    visits: Map<object, "open" | "done">,
    parts: Array<Record<string, unknown>>
  ): boolean {
    if (depth > MAX_DEPTH || !isRecord(schema)) return false;
    const visit = visits.get(schema);
    // A part still being collected is a cycle, which yields no TypedDict, as when the depth limit stopped it.
    if (visit !== undefined) return visit === "done";
    if ("const" in schema || "enum" in schema || "anyOf" in schema || "oneOf" in schema || "$dynamicRef" in schema || "not" in schema) return false;
    const types = typeList(schema);
    if (types !== null && (types.length !== 1 || types[0] !== "object")) return false;
    visits.set(schema, "open");
    if ("$ref" in schema) {
      const component = typeof schema.$ref === "string" ? componentName(schema.$ref) : null;
      if (component === null || cut.has(component) || !Object.prototype.hasOwnProperty.call(this.schemas, component) || this.resolve(component) === null) return false;
      if (!this.#collectParts(this.schemas[component], this.cuts.get(component) ?? NO_CUTS, depth + 1, visits, parts)) return false;
    }
    if ("allOf" in schema) {
      if (!Array.isArray(schema.allOf)) return false;
      for (const member of schema.allOf) {
        if (!this.#collectParts(member, cut, depth + 1, visits, parts)) return false;
      }
    }
    visits.set(schema, "done");
    parts.push(schema);
    return true;
  }

  /**
   * The TypedDict fields of a schema that declares properties itself or merges several object parts (see
   * `#objectParts`), or null. A reference, or `allOf` with one member, is typed as what it refers to unless the
   * schema requires a property that the referent declares but leaves optional. A field two parts declare with
   * different types is Any; a field any part requires is required; `required` naming no declared property only
   * constrains, as in the TypeScript target.
   */
  objectFields(schema: unknown, owner: string, cut: ReadonlySet<string> = NO_CUTS, depth = 0): PyField[] | null {
    const plan = this.#fieldPlan(schema, cut, depth);
    return plan === null ? null : this.#typeFields(plan, owner, depth);
  }

  /** The parts and required names `objectFields` merges, decided before any field is typed; null for no TypedDict. */
  #fieldPlan(schema: unknown, cut: ReadonlySet<string>, depth: number): FieldPlan | null {
    if (!isRecord(schema)) return null;
    const own = isRecord(schema.properties) && Object.keys(schema.properties).length > 0 ? 1 : 0;
    const references = ("$ref" in schema ? 1 : 0) + (Array.isArray(schema.allOf) ? schema.allOf.length : 0);
    if (own === 0 && references === 0) return null;
    const parts = this.#objectParts(schema, cut, depth);
    if (parts === null) return null;
    const declared = new Set(parts.flatMap((part) => (isRecord(part.properties) ? Object.keys(part.properties) : [])));
    if (declared.size === 0) return null;
    // Any part may require a property any part declares, including a part that declares none itself.
    const required = new Set<string>();
    let added = false;
    for (const [index, part] of parts.entries()) {
      for (const name of Array.isArray(part.required) ? part.required : []) {
        if (typeof name !== "string" || !declared.has(name) || required.has(name)) continue;
        required.add(name);
        // With one referent, the schema itself is the last part and every other part is the referent's.
        added ||= index === parts.length - 1;
      }
    }
    if (own === 0 && references === 1 && !added) return null;
    return { parts, required };
  }

  #typeFields({ parts, required }: FieldPlan, owner: string, depth: number): PyField[] {
    const merged = new Map<string, PyField>();
    for (const part of parts) {
      if (!isRecord(part.properties)) continue;
      const properties = part.properties;
      for (const key of Object.keys(properties)) {
        const property = properties[key];
        const field: PyField = {
          key,
          type: this.type(property, owner, depth + 1),
          required: required.has(key),
          description: isRecord(property) && typeof property.description === "string" ? property.description : null,
          deprecated: isRecord(property) && property.deprecated === true,
        };
        const previous = merged.get(key);
        merged.set(key, previous ? { ...previous, type: previous.type === field.type ? field.type : ANY } : field);
      }
    }
    return [...merged.values()];
  }

  /** Synthesized TypedDict names per schema object and cut set (null: the schema has none), shared by every module. */
  readonly #inlineNames = new WeakMap<object, Map<ReadonlySet<string>, string | null>>();
  /** The properties-only view `#object` types an object schema through, one per schema, so it is memoized too. */
  readonly #propertyViews = new WeakMap<object, Record<string, unknown>>();

  /**
   * A reference to a synthesized private TypedDict (its name starts with `_` and the owner's name) for an object
   * schema's fields. It is written to models.py, so its fields are typed there, without this module's prefix. Each
   * schema object gets one, named before its fields are typed, so a reference back to it (through a component it
   * wraps) reuses the name: TypedDict fields are forward references, and the work stays linear in the schemas.
   */
  #inlineTypedDict(schema: Record<string, unknown>, owner: string, cut: ReadonlySet<string>, depth: number): string | null {
    const models = this.#models;
    let byCut = models.#inlineNames.get(schema);
    if (byCut === undefined) models.#inlineNames.set(schema, (byCut = new Map()));
    let name = byCut.get(cut);
    if (name === undefined) {
      const plan = models.#fieldPlan(schema, cut, depth);
      if (plan === null) byCut.set(cut, (name = null));
      else {
        let index = 1;
        while (this.taken.has(`_${owner}_${index}`)) index++;
        name = `_${owner}_${index}`;
        this.taken.add(name);
        const entry: InlineTypedDict = { name, fields: [] };
        this.inline.push(entry);
        byCut.set(cut, name);
        entry.fields = models.#typeFields(plan, owner, depth);
      }
    }
    return name === null ? null : `${this.prefix}${name}`;
  }

  /**
   * The Python type of a schema. `owner` names inline TypedDicts; `cut` names components whose references in a
   * `direct` or `tuple` position are typed Any; `input` types arrays and maps as the read-only `Sequence` and
   * `Mapping` a parameter accepts.
   */
  type(schema: unknown, owner: string, depth = 0, cut: ReadonlySet<string> = NO_CUTS, position: Position = "direct", input = false): string {
    if (depth > MAX_DEPTH || schema === true || schema === undefined || schema === null) return ANY;
    if (schema === false) return NEVER;
    if (!isRecord(schema)) return ANY;
    const inline = this.#inlineTypedDict(schema, owner, position === "array" ? NO_CUTS : cut, depth);
    if (inline !== null) return inline;
    const next = depth + 1;
    const parts: string[] = [];
    for (const keyword of ["$ref", "$dynamicRef"]) {
      const ref = schema[keyword];
      if (typeof ref !== "string") continue;
      const component = componentName(ref);
      const name = component === null || (position !== "array" && cut.has(component)) ? null : this.resolve(component);
      parts.push(name === null ? ANY : `${this.prefix}${name}`);
    }
    if ("const" in schema) parts.push(literal(schema.const) ?? ANY);
    if (Array.isArray(schema.enum)) {
      const values = schema.enum.map(literal);
      parts.push(values.includes(null) ? ANY : union(values as string[]));
    }
    // Literal values already narrow a primitive type.
    const literals = "const" in schema || Array.isArray(schema.enum);
    const typed = literals && primitiveOnly(schema.type) ? null : this.#byType(schema, owner, next, cut, position, input);
    if (typed !== null) parts.push(typed);
    if (Array.isArray(schema.allOf)) parts.push(intersection(schema.allOf.map((member) => this.type(member, owner, next, cut, position, input))));
    for (const keyword of ["anyOf", "oneOf"]) {
      const members = schema[keyword];
      if (Array.isArray(members)) parts.push(union(members.map((member) => this.type(member, owner, next, cut, position, input))));
    }
    return intersection(parts);
  }

  #byType(schema: Record<string, unknown>, owner: string, depth: number, cut: ReadonlySet<string>, position: Position, input: boolean): string | null {
    const types = typeList(schema);
    if (types === null) return null;
    return union(
      types.map((type) => {
        switch (type) {
          case "string":
            return "str";
          case "integer":
            return "int";
          case "number":
            return "float";
          case "boolean":
            return "bool";
          case "null":
            return "None";
          case "array":
            return this.#array(schema, owner, depth, cut, position, input);
          case "object":
            return this.#object(schema, owner, depth, input);
          default:
            return ANY;
        }
      })
    );
  }

  /** JSON arrays decode to lists, so a tuple schema is a list of the union of its positions. */
  #array(schema: Record<string, unknown>, owner: string, depth: number, cut: ReadonlySet<string>, position: Position, input: boolean): string {
    const items = "items" in schema ? schema.items : true;
    const members: string[] = [];
    if (Array.isArray(schema.prefixItems)) {
      for (const member of schema.prefixItems) members.push(this.type(member, owner, depth, cut, "tuple", input));
      if (items !== false) members.push(this.type(items, owner, depth, cut, "tuple", input));
    } else {
      members.push(this.type(items, owner, depth, cut, position === "tuple" ? "tuple" : "array", input));
    }
    return `${input ? "_t.Sequence" : "list"}[${union(members)}]`;
  }

  #object(schema: Record<string, unknown>, owner: string, depth: number, input: boolean): string {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const map = input ? "_t.Mapping" : "dict";
    if (Object.keys(properties).length > 0) {
      let view = this.#models.#propertyViews.get(schema);
      if (view === undefined) this.#models.#propertyViews.set(schema, (view = { properties, required: schema.required }));
      const inline = this.#inlineTypedDict(view, owner, NO_CUTS, depth);
      if (inline !== null) return inline;
    }
    const additional = schema.additionalProperties;
    if (additional === false && !isRecord(schema.patternProperties)) return `${map}[str, ${NEVER}]`;
    return `${map}[str, ${additional === undefined || additional === true ? ANY : this.type(additional, owner, depth, NO_CUTS, "direct", input)}]`;
  }
}
