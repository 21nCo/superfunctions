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

export class SchemaTypes {
  /** Maps a component schema name to its exported type name. */
  readonly #resolve: (component: string) => string | null;
  /** Prefix for references to model types, such as `Models.` outside models.ts. */
  readonly #prefix: string;

  constructor(resolve: (component: string) => string | null, prefix = "") {
    this.#resolve = resolve;
    this.#prefix = prefix;
  }

  type(schema: unknown, indent = "", depth = 0): string {
    if (depth > MAX_DEPTH || schema === true || schema === undefined || schema === null) return "unknown";
    if (schema === false) return "never";
    if (!isRecord(schema)) return "unknown";
    const next = depth + 1;
    const parts: string[] = [];
    for (const keyword of ["$ref", "$dynamicRef"]) {
      const ref = schema[keyword];
      if (typeof ref !== "string") continue;
      const component = componentName(ref);
      const name = component === null ? null : this.#resolve(component);
      parts.push(name === null ? "unknown" : `${this.#prefix}${name}`);
    }
    if ("const" in schema) parts.push(literal(schema.const) ?? "unknown");
    if (Array.isArray(schema.enum)) {
      const values = schema.enum.map(literal);
      parts.push(values.includes(null) ? "unknown" : union(values as string[]));
    }
    // Literal values already narrow a primitive type; `("a" | "b") & string` would only add noise.
    const literals = "const" in schema || Array.isArray(schema.enum);
    const typed = literals && primitiveOnly(schema.type) ? null : this.#byType(schema, indent, next);
    if (typed !== null) parts.push(typed);
    if (Array.isArray(schema.allOf)) parts.push(intersection(schema.allOf.map((member) => this.type(member, indent, next))));
    for (const keyword of ["anyOf", "oneOf"]) {
      const members = schema[keyword];
      if (Array.isArray(members)) parts.push(union(members.map((member) => this.type(member, indent, next))));
    }
    return intersection(parts);
  }

  #byType(schema: Record<string, unknown>, indent: string, depth: number): string | null {
    let types: unknown[];
    if (Array.isArray(schema.type)) types = schema.type;
    else if (typeof schema.type === "string") types = [schema.type];
    else if (isRecord(schema.properties) || "additionalProperties" in schema || "patternProperties" in schema) types = ["object"];
    else if ("items" in schema || "prefixItems" in schema) types = ["array"];
    else return null;
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
            return this.#array(schema, indent, depth);
          case "object":
            return this.#object(schema, indent, depth);
          default:
            return "unknown";
        }
      })
    );
  }

  #array(schema: Record<string, unknown>, indent: string, depth: number): string {
    const items = "items" in schema ? schema.items : true;
    if (Array.isArray(schema.prefixItems)) {
      // Positions at or past minItems may be missing, so they are optional elements.
      const minItems = typeof schema.minItems === "number" && Number.isInteger(schema.minItems) ? schema.minItems : 0;
      const head = schema.prefixItems.map((member, index) => {
        const type = this.type(member, indent, depth);
        return index < minItems ? type : `${group(type)}?`;
      });
      const tail = items === false ? [] : [`...${group(this.type(items, indent, depth))}[]`];
      return `[${[...head, ...tail].join(", ")}]`;
    }
    return `${group(this.type(items, indent, depth))}[]`;
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
