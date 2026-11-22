/**
 * Validated comparison: `diffOpenAPI` and the version rule only ever see two documents that both
 * passed the existing validator and have every local `$ref` replaced by its target, so a change
 * behind a shared schema is diffed like the same change written inline.
 */

import { parseOpenAPI, validateOpenAPI } from "@apifn/core";
import type { OpenAPIDocument } from "@apifn/core";
import { MAX_EXPANDED_SPEC_NODES, canonicalJson } from "./check-parse.js";
import type { JsonObject, JsonValue } from "./check-parse.js";

export class DereferenceError extends Error {}

export interface ValidationProblem {
  path: string;
  message: string;
}

/** Runs the existing validator on a copy (it dereferences in place) and keeps the errors. */
export async function validationErrorsOf(doc: JsonObject): Promise<ValidationProblem[]> {
  try {
    const errors = await validateOpenAPI(parseOpenAPI(structuredClone(doc)));
    return errors.filter((e) => e.severity === "error").map((e) => ({ path: e.path, message: e.message }));
  } catch (error) {
    return [{ path: "openapi", message: error instanceof Error ? error.message : String(error) }];
  }
}

/** RFC 6901 pointer inside a URI fragment (`#/components/schemas/A~1B`). */
function pointerTokens(ref: string): string[] {
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    throw new DereferenceError(`$ref '${ref}' is not a valid URI fragment`);
  }
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new DereferenceError(`$ref '${ref}' is not a JSON pointer`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a copy of `doc` with every local `$ref` replaced by its target. Keys beside a `$ref` apply
 * together with the target, as OpenAPI 3.1 reads them, so they are conjoined with it (see
 * `conjoin`). A reference back into a schema being expanded (a recursive schema) stays a `$ref`,
 * so the comparison still sees its name. A reference that leaves the document, does not resolve,
 * expands past MAX_EXPANDED_SPEC_NODES or has siblings that cannot be conjoined exactly throws
 * DereferenceError.
 */
export function dereference(doc: JsonObject): JsonObject {
  return new Dereferencer(doc).copy(doc) as JsonObject;
}

class Dereferencer {
  private nodes = 0;
  private readonly expanding: string[] = [];

  constructor(private readonly doc: JsonObject) {}

  copy(value: JsonValue): JsonValue {
    this.nodes += 1;
    if (this.nodes > MAX_EXPANDED_SPEC_NODES) {
      throw new DereferenceError(`the $refs expand to more than ${MAX_EXPANDED_SPEC_NODES} nodes`);
    }
    if (Array.isArray(value)) return value.map((item) => this.copy(item));
    if (!isRecord(value)) return value;
    return typeof value.$ref === "string" ? this.expand(value.$ref, value) : this.copyRecord(value, null);
  }

  private copyRecord(value: Record<string, JsonValue>, skip: string | null): JsonObject {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === skip) continue;
      Object.defineProperty(result, key, { value: this.copy(item), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }

  private expand(ref: string, value: Record<string, JsonValue>): JsonValue {
    if (!ref.startsWith("#")) {
      throw new DereferenceError(`$ref '${ref}' points outside the document, which apifn check does not follow`);
    }
    if (this.expanding.includes(ref)) {
      return this.copyRecord(value, null);
    }
    this.expanding.push(ref);
    const target = this.copy(this.resolve(ref));
    this.expanding.pop();
    const siblings = this.copyRecord(value, "$ref");
    if (Object.keys(siblings).length === 0) return target;
    if (!isRecord(target)) {
      throw new DereferenceError(`$ref '${ref}' has sibling keys but its target is not an object`);
    }
    return conjoin(target, siblings, ref);
  }

  private resolve(ref: string): JsonValue {
    let current: JsonValue = this.doc;
    for (const token of pointerTokens(ref)) {
      current = step(current, token, ref);
    }
    return current;
  }
}

/** Annotations: they constrain nothing, so the keys beside the `$ref` replace the target's. */
const ANNOTATIONS = new Set(["title", "description", "summary", "example", "examples", "default", "$comment", "externalDocs"]);
/** Lower bounds (the larger one wins) and upper bounds (the smaller one wins). */
const LOWER_BOUNDS = new Set(["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties", "minContains"]);
const UPPER_BOUNDS = new Set(["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties", "maxContains"]);

/**
 * Keywords whose meaning depends on keywords beside them (their partners): `additionalProperties`
 * applies to the names `properties` and `patternProperties` leave, `items` to the entries after
 * `prefixItems`, and so on. Conjoining may change a partner (more property names, a longer
 * prefix), which would move what the dependent keyword applies to, so that is refused.
 */
const SCOPED: Record<string, readonly string[]> = {
  additionalProperties: ["properties", "patternProperties"],
  unevaluatedProperties: ["properties", "patternProperties", "additionalProperties", "allOf", "anyOf", "oneOf", "if", "then", "else", "dependentSchemas"],
  items: ["prefixItems"],
  unevaluatedItems: ["prefixItems", "items", "contains", "allOf", "anyOf", "oneOf", "if", "then", "else"],
  minContains: ["contains"],
  maxContains: ["contains"],
  then: ["if"],
  else: ["if"],
};

/** What a partner contributes to a dependent keyword's scope: its names, its length or itself. */
function scopeOf(key: string, value: JsonValue | undefined): string {
  if (value === undefined) return "";
  if ((key === "properties" || key === "patternProperties") && isRecord(value)) return canonicalJson(Object.keys(value).sort());
  if (key === "prefixItems" && Array.isArray(value)) return String(value.length);
  return canonicalJson(value);
}

function own(record: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function setOwn(record: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * A side closed by `additionalProperties: false` (and no `patternProperties` on either side)
 * allows only its own property names, so the conjunction keeps exactly those: a name only the
 * other side declares is forbidden and leaves `properties`, as it would written inline.
 */
function closedNames(side: JsonObject, other: JsonObject): Set<string> | null {
  if (own(side, "additionalProperties") !== false) return null;
  if (own(side, "patternProperties") !== undefined || own(other, "patternProperties") !== undefined) return null;
  const otherAdditional = own(other, "additionalProperties");
  if (otherAdditional !== undefined && otherAdditional !== false) return null;
  const properties = own(side, "properties");
  return new Set(isRecord(properties) ? Object.keys(properties) : []);
}

/**
 * The schema both `target` and `siblings` describe, written with the keywords the differ reads:
 * `required` and `enum` combine exactly, `properties` combine per property, bounds keep the
 * tighter one and `type` keeps the types both allow (`integer` is a `number`). Keyword scope is
 * kept on both sides (see SCOPED and closedNames). Any other keyword present on both sides with
 * different values, or a change of scope, has no exact single-schema form, so it throws
 * DereferenceError (exit 2).
 */
function conjoin(target: JsonObject, siblings: JsonObject, ref: string): JsonObject {
  const result: JsonObject = { ...target };
  for (const [key, value] of Object.entries(siblings)) {
    const current = own(result, key);
    let combined: JsonValue | undefined;
    if (current === undefined || canonicalJson(current) === canonicalJson(value)) combined = value;
    else if (ANNOTATIONS.has(key) || key.startsWith("x-")) combined = value;
    else combined = combineKeyword(key, current, value, ref);
    if (combined === undefined) {
      throw new DereferenceError(`$ref '${ref}' has a sibling '${key}' that apifn check cannot combine with its target`);
    }
    setOwn(result, key, combined);
  }
  const closed = [closedNames(target, siblings), closedNames(siblings, target)];
  for (const names of closed) {
    const properties = own(result, "properties");
    if (names === null || !isRecord(properties)) continue;
    const kept: JsonObject = {};
    for (const [name, schema] of Object.entries(properties)) if (names.has(name)) setOwn(kept, name, schema);
    setOwn(result, "properties", kept);
  }
  assertScopeKept(target, closed[0] !== null, result, ref);
  assertScopeKept(siblings, closed[1] !== null, result, ref);
  return result;
}

/** Throws when a dependent keyword of `side` would apply to a different scope in `result`. */
function assertScopeKept(side: JsonObject, closedHandled: boolean, result: JsonObject, ref: string): void {
  for (const [key, partners] of Object.entries(SCOPED)) {
    if (own(side, key) === undefined || (key === "additionalProperties" && closedHandled)) continue;
    const moved = partners.find((partner) => scopeOf(partner, own(side, partner)) !== scopeOf(partner, own(result, partner)));
    if (moved !== undefined) {
      throw new DereferenceError(
        `$ref '${ref}' and its siblings combine '${moved}' in a way that changes what '${key}' applies to, which apifn check cannot compare`
      );
    }
  }
}

/** The JSON Schema types both lists allow; `integer` is the part of `number` they share. */
function bothTypes(a: JsonValue, b: JsonValue): JsonValue | undefined {
  const left = Array.isArray(a) ? a : [a];
  const right = Array.isArray(b) ? b : [b];
  const allows = (types: JsonValue[], type: JsonValue) => types.includes(type) || (type === "integer" && types.includes("number"));
  const both = [...left.filter((type) => allows(right, type)), ...right.filter((type) => type === "integer" && !left.includes(type) && allows(left, type))];
  if (both.length === 0) return undefined;
  return both.length === 1 ? both[0] : both;
}

function combineKeyword(key: string, a: JsonValue, b: JsonValue, ref: string): JsonValue | undefined {
  if (typeof a === "number" && typeof b === "number") {
    if (LOWER_BOUNDS.has(key)) return Math.max(a, b);
    if (UPPER_BOUNDS.has(key)) return Math.min(a, b);
    return undefined;
  }
  if (key === "required" && Array.isArray(a) && Array.isArray(b)) {
    return [...a, ...b.filter((item) => !a.includes(item))];
  }
  if (key === "enum" && Array.isArray(a) && Array.isArray(b)) {
    const allowed = new Set(b.map((item) => canonicalJson(item)));
    return a.filter((item) => allowed.has(canonicalJson(item)));
  }
  if (key === "type") return bothTypes(a, b);
  if (key === "properties" && isRecord(a) && isRecord(b)) {
    const merged: JsonObject = { ...a };
    for (const [name, schema] of Object.entries(b)) {
      const existing = own(merged, name);
      let value: JsonValue = schema;
      if (isRecord(existing) && isRecord(schema)) value = conjoin(existing, schema, ref);
      else if (existing !== undefined && canonicalJson(existing) !== canonicalJson(schema)) return undefined;
      setOwn(merged, name, value);
    }
    return merged;
  }
  return undefined;
}

function step(current: JsonValue, token: string, ref: string): JsonValue {
  if (Array.isArray(current) && /^(0|[1-9]\d*)$/.test(token) && Number(token) < current.length) {
    return current[Number(token)];
  }
  if (isRecord(current) && Object.hasOwn(current, token)) {
    return current[token];
  }
  throw new DereferenceError(`$ref '${ref}' does not resolve inside the document`);
}

/** The comparable form of a document: normalized by parseOpenAPI, then dereferenced. */
export function comparable(doc: JsonObject): OpenAPIDocument {
  const normalized = parseOpenAPI(structuredClone(doc)) as unknown as JsonObject;
  return dereference(normalized) as unknown as OpenAPIDocument;
}
