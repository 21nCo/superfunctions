// JSON Schema 2020-12 (as published in operation-catalog.v1) → TypeScript types.
// Constructs without a TypeScript equivalent widen to `unknown`; they never fail generation.

import { docComment, propertyKey } from "./naming.js";

const REF_PREFIX = "#/components/schemas/";
const MAX_DEPTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a catalog schema reference as RFC 6901 section 6 reads a URI fragment; null if it is not a component reference. */
export function componentName(ref: string): string | null {
  if (!ref.startsWith(REF_PREFIX)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(ref.slice(1));
  } catch {
    return null;
  }
  const segments = decoded.split("/");
  if (segments.length !== 4 || /~[^01]|~$/.test(segments[3])) return null;
  return segments[3].replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Wraps unions, intersections and function-like types so they can sit inside another type. */
function group(type: string): string {
  return /^(?:[\w$.]+|"(?:[^"\\]|\\.)*"|-?[\d.]+(?:e[+-]?\d+)?)(?:\[\])*$/i.test(type) ? type : `(${type})`;
}

function union(types: string[]): string {
  const unique = [...new Set(types.filter((type) => type !== "never"))];
  if (unique.length === 0) return "never";
  if (unique.includes("unknown")) return "unknown";
  return unique.length === 1 ? unique[0] : unique.map(group).join(" | ");
}

function intersection(types: string[]): string {
  const unique = [...new Set(types.filter((type) => type !== "unknown"))];
  if (unique.includes("never")) return "never";
  if (unique.length === 0) return "unknown";
  return unique.length === 1 ? unique[0] : unique.map(group).join(" & ");
}

function primitiveOnly(type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.every((entry) => entry === "string" || entry === "number" || entry === "integer" || entry === "boolean" || entry === "null");
}

function literal(value: unknown): string | null {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  return null;
}

/** The JSON types a schema's `type` keyword, or failing that its keywords, give it; null if neither does. */
function typeList(schema: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(schema.type)) return schema.type;
  if (typeof schema.type === "string") return [schema.type];
  if (isRecord(schema.properties) || "additionalProperties" in schema || "patternProperties" in schema) return ["object"];
  if ("items" in schema || "prefixItems" in schema) return ["array"];
  return null;
}

/**
 * Where a schema sits in the type of the component schema that contains it, for cycle detection:
 * `direct` outside any object or array type, `array` inside array types only, and `tuple` once inside a
 * tuple type. TypeScript defers references inside object types and plain array types, but resolves
 * some inside tuple types eagerly, such as `[A[]?, ...number[]] | B` and `[string?, ...A[][]][] & B`.
 */
type Position = "direct" | "array" | "tuple";

/**
 * Component names a schema's type refers to in a `direct` or `tuple` position (see `Position`):
 * through `$ref`, `$dynamicRef`, `allOf`/`anyOf`/`oneOf` members and array items, but never through an
 * object type. A cycle of these references may be a circular type alias.
 */
function directReferences(schema: unknown, found: Set<string>, position: Position = "direct", depth = 0): Set<string> {
  if (depth > MAX_DEPTH || !isRecord(schema)) return found;
  if (position !== "array") {
    for (const keyword of ["$ref", "$dynamicRef"]) {
      const ref = schema[keyword];
      const component = typeof ref === "string" ? componentName(ref) : null;
      if (component !== null) found.add(component);
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const members = schema[keyword];
    if (Array.isArray(members)) for (const member of members) directReferences(member, found, position, depth + 1);
  }
  if (typeList(schema)?.includes("array")) {
    const tuple = Array.isArray(schema.prefixItems);
    const inner: Position = tuple || position === "tuple" ? "tuple" : "array";
    if (tuple) for (const member of schema.prefixItems as unknown[]) directReferences(member, found, inner, depth + 1);
    if ("items" in schema) directReferences(schema.items, found, inner, depth + 1);
  }
  return found;
}

/**
 * Finds the references (see `directReferences`) that close a cycle between component schemas,
 * by a depth-first search over names and references in sorted order, so the result is deterministic.
 * Typing each returned reference as `unknown` leaves the direct references acyclic. Keys are the
 * referencing schemas; values are the referenced ones, sorted.
 */
export function aliasCycleCuts(schemas: Readonly<Record<string, unknown>>): Map<string, string[]> {
  const names = Object.keys(schemas).sort();
  const edges = new Map(names.map((name) => [name, [...directReferences(schemas[name], new Set())].filter((target) => Object.prototype.hasOwnProperty.call(schemas, target)).sort()]));
  const state = new Map<string, "open" | "done">();
  const cuts = new Map<string, string[]>();
  const visit = (name: string) => {
    state.set(name, "open");
    for (const target of edges.get(name) ?? []) {
      const seen = state.get(target);
      if (seen === "open") cuts.set(name, [...(cuts.get(name) ?? []), target]);
      else if (seen === undefined) visit(target);
    }
    state.set(name, "done");
  };
  for (const name of names) if (!state.has(name)) visit(name);
  return cuts;
}

/** Kinds of value a schema's type admits at its top level, as bit flags. */
export const SCALAR = 1;
export const NULL = 2;
export const ARRAY = 4;
export const OBJECT = 8;
const ANY = SCALAR | NULL | ARRAY | OBJECT;

function literalKind(value: unknown): number {
  if (value === null) return NULL;
  return literal(value) === null ? ANY : SCALAR;
}

/**
 * The kinds of value (`SCALAR` strings, numbers and booleans, `NULL`, `ARRAY`, `OBJECT`) the type
 * `SchemaTypes.type` gives a schema admits at its top level, following component references in
 * `schemas`. Anything typed `unknown` admits every kind.
 */
export function valueKinds(schema: unknown, schemas: Readonly<Record<string, unknown>>, seen: ReadonlySet<string> = new Set(), depth = 0): number {
  if (depth > MAX_DEPTH || schema === true || schema === undefined || schema === null || !isRecord(schema)) return schema === false ? 0 : ANY;
  const next = depth + 1;
  let kinds = ANY;
  for (const keyword of ["$ref", "$dynamicRef"]) {
    const ref = schema[keyword];
    if (typeof ref !== "string") continue;
    const component = componentName(ref);
    if (component !== null && !seen.has(component) && Object.prototype.hasOwnProperty.call(schemas, component)) {
      kinds &= valueKinds(schemas[component], schemas, new Set([...seen, component]), next);
    }
  }
  if ("const" in schema) kinds &= literalKind(schema.const);
  if (Array.isArray(schema.enum)) kinds &= schema.enum.reduce((all: number, value) => all | literalKind(value), 0);
  const types = "const" in schema || Array.isArray(schema.enum) ? (primitiveOnly(schema.type) ? null : typeList(schema)) : typeList(schema);
  if (types !== null) {
    kinds &= types.reduce((all: number, type) => {
      switch (type) {
        case "string":
        case "number":
        case "integer":
        case "boolean":
          return all | SCALAR;
        case "null":
          return all | NULL;
        case "array":
          return all | ARRAY;
        case "object":
          return all | OBJECT;
        default:
          return ANY;
      }
    }, 0);
  }
  if (Array.isArray(schema.allOf)) for (const member of schema.allOf) kinds &= valueKinds(member, schemas, seen, next);
  for (const keyword of ["anyOf", "oneOf"]) {
    const members = schema[keyword];
    if (Array.isArray(members)) kinds &= members.reduce((all: number, member) => all | valueKinds(member, schemas, seen, next), 0);
  }
  return kinds;
}

/** What a schema's type admits inside its array and object types: see `containerMembers`. */
export interface ContainerMembers {
  /** Kinds admitted by the items of each array type. */
  items: number[];
  /** Kinds admitted by each declared property and index signature of each object type. */
  members: Array<{ name: string | null; kinds: number }>;
  /** Whether some part of the type is `unknown`, so its arrays and objects are not described. */
  opaque: boolean;
}

/**
 * The array item and object member kinds (see `valueKinds`) of every array and object type a schema's
 * top level may be: through component references and `allOf`/`anyOf`/`oneOf`, as `SchemaTypes.type`
 * types them. Object types list declared properties by name and an index signature as null.
 */
export function containerMembers(
  schema: unknown,
  schemas: Readonly<Record<string, unknown>>,
  found: ContainerMembers = { items: [], members: [], opaque: false },
  seen: ReadonlySet<string> = new Set(),
  depth = 0
): ContainerMembers {
  if (depth > MAX_DEPTH || schema === true || schema === undefined || schema === null || !isRecord(schema)) {
    if (schema !== false) found.opaque = true;
    return found;
  }
  const next = depth + 1;
  let described = false;
  for (const keyword of ["$ref", "$dynamicRef"]) {
    const ref = schema[keyword];
    if (typeof ref !== "string") continue;
    described = true;
    const component = componentName(ref);
    if (component === null || seen.has(component) || !Object.prototype.hasOwnProperty.call(schemas, component)) found.opaque = true;
    else containerMembers(schemas[component], schemas, found, new Set([...seen, component]), next);
  }
  if ("const" in schema || Array.isArray(schema.enum)) {
    described = true;
    // A non-primitive literal makes the type unknown.
    const values = [...("const" in schema ? [schema.const] : []), ...(Array.isArray(schema.enum) ? schema.enum : [])];
    if (values.some((value) => value !== null && literal(value) === null)) found.opaque = true;
  }
  const types = typeList(schema);
  if (types !== null) {
    described = true;
    if (types.some((type) => typeof type !== "string" || !["string", "number", "integer", "boolean", "null", "array", "object"].includes(type))) found.opaque = true;
    if (types.includes("array")) {
      const items = "items" in schema ? schema.items : true;
      let kinds = Array.isArray(schema.prefixItems) ? schema.prefixItems.reduce((all: number, member) => all | valueKinds(member, schemas), 0) : 0;
      if (items !== false) kinds |= valueKinds(items, schemas);
      found.items.push(kinds);
    }
    if (types.includes("object")) {
      // Mirrors SchemaTypes#object: declared properties, then the index signature it would emit.
      const properties = isRecord(schema.properties) ? schema.properties : {};
      for (const name of Object.keys(properties)) found.members.push({ name, kinds: valueKinds(properties[name], schemas) });
      const additional = schema.additionalProperties;
      const hasProperties = Object.keys(properties).length > 0;
      if (additional !== false && (additional !== undefined || isRecord(schema.patternProperties) || !hasProperties)) {
        found.members.push({ name: null, kinds: hasProperties || additional === undefined ? ANY : valueKinds(additional, schemas) });
      }
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const members = schema[keyword];
    if (!Array.isArray(members)) continue;
    described = true;
    for (const member of members) containerMembers(member, schemas, found, seen, next);
  }
  if (!described) found.opaque = true;
  return found;
}

const NO_CUTS: ReadonlySet<string> = new Set();

export class SchemaTypes {
  /** Maps a component schema name to its exported type name. */
  readonly #resolve: (component: string) => string | null;
  /** Prefix for references to model types, such as `Models.` outside models.ts. */
  readonly #prefix: string;

  constructor(resolve: (component: string) => string | null, prefix = "") {
    this.#resolve = resolve;
    this.#prefix = prefix;
  }

  /**
   * `cut` names components whose references in a `direct` or `tuple` position (see `aliasCycleCuts`)
   * are typed `unknown`; `position` is where `schema` sits in the component schema being typed.
   */
  type(schema: unknown, indent = "", depth = 0, cut: ReadonlySet<string> = NO_CUTS, position: Position = "direct"): string {
    if (depth > MAX_DEPTH || schema === true || schema === undefined || schema === null) return "unknown";
    if (schema === false) return "never";
    if (!isRecord(schema)) return "unknown";
    const next = depth + 1;
    const parts: string[] = [];
    for (const keyword of ["$ref", "$dynamicRef"]) {
      const ref = schema[keyword];
      if (typeof ref !== "string") continue;
      const component = componentName(ref);
      const name = component === null || (position !== "array" && cut.has(component)) ? null : this.#resolve(component);
      parts.push(name === null ? "unknown" : `${this.#prefix}${name}`);
    }
    if ("const" in schema) parts.push(literal(schema.const) ?? "unknown");
    if (Array.isArray(schema.enum)) {
      const values = schema.enum.map(literal);
      parts.push(values.includes(null) ? "unknown" : union(values as string[]));
    }
    // Literal values already narrow a primitive type; `("a" | "b") & string` would only add noise.
    const literals = "const" in schema || Array.isArray(schema.enum);
    const typed = literals && primitiveOnly(schema.type) ? null : this.#byType(schema, indent, next, cut, position);
    if (typed !== null) parts.push(typed);
    if (Array.isArray(schema.allOf)) parts.push(intersection(schema.allOf.map((member) => this.type(member, indent, next, cut, position))));
    for (const keyword of ["anyOf", "oneOf"]) {
      const members = schema[keyword];
      if (Array.isArray(members)) parts.push(union(members.map((member) => this.type(member, indent, next, cut, position))));
    }
    return intersection(parts);
  }

  #byType(schema: Record<string, unknown>, indent: string, depth: number, cut: ReadonlySet<string>, position: Position): string | null {
    const types = typeList(schema);
    if (types === null) return null;
    return union(
      types.map((type) => {
        switch (type) {
          case "string":
            return "string";
          case "number":
          case "integer":
            return "number";
          case "boolean":
            return "boolean";
          case "null":
            return "null";
          case "array":
            return this.#array(schema, indent, depth, cut, position);
          case "object":
            return this.#object(schema, indent, depth);
          default:
            return "unknown";
        }
      })
    );
  }

  #array(schema: Record<string, unknown>, indent: string, depth: number, cut: ReadonlySet<string>, position: Position): string {
    const items = "items" in schema ? schema.items : true;
    if (Array.isArray(schema.prefixItems)) {
      // Positions at or past minItems may be missing, so they are optional elements.
      const minItems = typeof schema.minItems === "number" && Number.isInteger(schema.minItems) ? schema.minItems : 0;
      const head = schema.prefixItems.map((member, index) => {
        const type = this.type(member, indent, depth, cut, "tuple");
        return index < minItems ? type : `${group(type)}?`;
      });
      const tail = items === false ? [] : [`...${group(this.type(items, indent, depth, cut, "tuple"))}[]`];
      return `[${[...head, ...tail].join(", ")}]`;
    }
    return `${group(this.type(items, indent, depth, cut, position === "tuple" ? "tuple" : "array"))}[]`;
  }

  #object(schema: Record<string, unknown>, indent: string, depth: number): string {
    const inner = `${indent}  `;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []);
    const lines: string[] = [];
    for (const name of Object.keys(properties)) {
      const property = properties[name];
      const doc = isRecord(property) ? docComment([typeof property.description === "string" ? property.description : null, property.deprecated === true ? "@deprecated" : null], inner) : "";
      lines.push(`${doc}${inner}${propertyKey(name)}${required.has(name) ? "" : "?"}: ${this.type(property, inner, depth)};\n`);
    }
    const additional = schema.additionalProperties;
    const hasProperties = lines.length > 0;
    if (additional !== false && (additional !== undefined || isRecord(schema.patternProperties) || !hasProperties)) {
      // Declared properties must fit the index signature, so it widens to unknown beside them.
      const value = hasProperties || additional === undefined ? "unknown" : this.type(additional, inner, depth);
      lines.push(`${inner}[key: string]: ${value};\n`);
    }
    // An object that allows no properties at all.
    return lines.length === 0 ? "{ [key: string]: never }" : `{\n${lines.join("")}${indent}}`;
  }
}
