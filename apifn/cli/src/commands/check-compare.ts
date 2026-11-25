/**
 * Validated comparison: `diffOpenAPI` and the version rule only ever see two documents that both
 * passed the existing validator and have every local `$ref` replaced by its target, so a change
 * behind a shared schema is diffed like the same change written inline.
 */

import { parseOpenAPI, validateOpenAPI } from "@apifn/core";
import type { OpenAPIDocument } from "@apifn/core";
import { openAPIReferenceContext, type OpenAPIReferenceMode as Mode } from "@apifn/core/internal/openapi-reference-context";
import { MAX_EXPANDED_SPEC_NODES, canonicalJson } from "./check-parse.js";
import type { JsonObject, JsonValue } from "./check-parse.js";

const { childMode, entryMode, isReferenceObject, arrayItemMode, isMap } = openAPIReferenceContext;

export class DereferenceError extends Error {}

export interface ValidationProblem {
  path: string;
  message: string;
}

/**
 * Runs the existing validator and keeps the errors. It reads a relocated copy (see `relocate`):
 * the structure it validates is the document's own, but a fragment inside a schema resource is
 * spelled from the document root, as the validator resolves it, and no `$ref` key is left in
 * literal data, so the validator follows only genuine references, all inside the document.
 */
export async function validationErrorsOf(doc: JsonObject): Promise<ValidationProblem[]> {
  let form: JsonObject;
  try {
    form = relocate(parseOpenAPI(structuredClone(doc)) as unknown as JsonObject);
  } catch (error) {
    return [{ path: "openapi", message: error instanceof Error ? error.message : String(error) }];
  }
  try {
    const errors = await validateOpenAPI(form as unknown as OpenAPIDocument);
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

/** One RFC 6901 token, spelled for a URI fragment. */
function encodeToken(token: string): string {
  return encodeURIComponent(token.replaceAll("~", "~0").replaceAll("/", "~1"));
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a copy of `doc` with every local `$ref` replaced by its target. Keys beside a schema `$ref`
 * apply together with the target, as OpenAPI 3.1 reads them, so they are conjoined with it (see
 * `conjoin`); beside a Reference Object elsewhere only `summary` and `description` apply. A reference back into a schema being expanded (a recursive schema) stays a `$ref`,
 * so the comparison still sees its name. Literal data (`example`, `default`, `const`, `enum`,
 * schema `examples`, an Example Object's value, `x-` extensions) is copied as it is: a `$ref` key
 * there is data, not a reference. Inside a schema resource with its own `$id` (its own `$ref`
 * included), a fragment resolves against that resource, not the document root. A reference that leaves the document, does not
 * resolve, expands past MAX_EXPANDED_SPEC_NODES or has siblings that cannot be conjoined exactly
 * throws DereferenceError. A recursive reference inside a schema resource is spelled from the
 * document root.
 */
export function dereference(doc: JsonObject): JsonObject {
  return new Dereferencer(true).copy(doc, "node", { node: doc, pointer: "" }, "") as JsonObject;
}

/**
 * The form the validator reads: the document as it is, except that a reference inside a schema
 * resource with its own `$id` is spelled from the document root (the validator resolves every
 * fragment from the root) and a `$ref` key in literal data is dropped (the validator would follow
 * it). A reference that leaves the document throws DereferenceError.
 */
function relocate(doc: JsonObject): JsonObject {
  return new Dereferencer(false).copy(doc, "node", { node: doc, pointer: "" }, "") as JsonObject;
}

/** A schema resource: the document or the nearest schema with its own `$id`, and its pointer. */
interface Resource {
  node: JsonValue;
  /** Its location from the document root, as a URI-fragment JSON pointer (`""` for the root). */
  pointer: string;
}

class Dereferencer {
  private nodes = 0;
  /** The targets being expanded, by identity. */
  private readonly expanding: JsonValue[] = [];

  /** `inline`: replace references by their targets (dereference) or only respell them (relocate). */
  constructor(private readonly inline: boolean) {}

  /**
   * `resource` is the schema resource a fragment resolves in: the document, or the nearest `$id`.
   * `at` is where `value` sits in the document, as a URI-fragment JSON pointer.
   */
  copy(value: JsonValue, mode: Mode, resource: Resource, at: string): JsonValue {
    this.nodes += 1;
    if (this.nodes > MAX_EXPANDED_SPEC_NODES) {
      throw new DereferenceError(`the $refs expand to more than ${MAX_EXPANDED_SPEC_NODES} nodes`);
    }
    if (Array.isArray(value)) {
      const itemMode = arrayItemMode(mode);
      return value.map((item, index) => this.copy(item, itemMode, resource, `${at}/${index}`));
    }
    if (!isRecord(value)) return value;
    // Literal data is copied as data; the validator's copy drops its `$ref` keys (see relocate).
    if (mode === "literal") return this.copyRecord(value, () => "literal", resource, at, this.inline ? undefined : "$ref");
    if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) throw outside(value.$ref);
    if (isMap(mode)) return this.copyRecord(value, (key, item) => entryMode(mode, key, item) as Mode, resource, at);
    // A schema's own `$id` is the resource its `$ref` (and every fragment inside it) resolves in.
    const own = isReferenceObject(mode) || typeof value.$id !== "string" ? resource : { node: value, pointer: at };
    if (typeof value.$ref === "string") return this.expand(value.$ref, value, mode, own, at);
    if (mode === "example") return this.copyRecord(value, () => "literal", resource, at);
    if (mode === "link") return this.copyRecord(value, (key, item) => entryMode(mode, key, item) as Mode, resource, at);
    return this.copyRecord(value, (key, item) => childMode(key, item), own, at);
  }

  private copyRecord(
    value: Record<string, JsonValue>,
    modeOf: (key: string, item: JsonValue) => Mode,
    resource: Resource,
    at: string,
    skip?: string
  ): JsonObject {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (key !== skip) setOwn(result, key, this.copy(item, modeOf(key, item), resource, `${at}/${encodeToken(key)}`));
    }
    return result;
  }

  private expand(ref: string, node: Record<string, JsonValue>, mode: Mode, resource: Resource, at: string): JsonValue {
    // A Reference Object outside a schema ignores every key beside it but `summary` and
    // `description`, so an ignored key is never read (an external `$ref` inside it included).
    const value = isReferenceObject(mode) ? referenceFields(node) : node;
    const siblingMode = (key: string, item: JsonValue): Mode => (mode === "example" ? "literal" : childMode(key, item));
    // The validator's copy resolves nothing itself: the validator reports a reference that does
    // not resolve from the document root.
    const found = !this.inline && resource.pointer === "" ? null : resolve(resource, ref);
    if (found === null || !this.inline || this.expanding.includes(found.target)) {
      // Kept as a reference (never inlined or conjoined in the validator's copy), spelled from the
      // document root when it resolves inside a resource.
      const kept = this.copyRecord(value, siblingMode, resource, at, "$ref");
      // The validator follows every `$ref` on the way to a target, so a target inside the node that
      // holds the reference (its own `$id` resource) is reached through `allOf`, which applies in
      // place like `$ref`, leaving no `$ref` on the way.
      if (!this.inline && found !== null && found.pointer.startsWith(`${at}/`)) {
        return { ...kept, allOf: [...(Array.isArray(kept.allOf) ? kept.allOf : []), { $ref: `#${found.pointer}` }] };
      }
      return { $ref: found === null || resource.pointer === "" ? ref : `#${found.pointer}`, ...kept };
    }
    this.expanding.push(found.target);
    const target = this.copy(found.target, mode, found.resource, found.pointer);
    this.expanding.pop();
    const siblings = this.copyRecord(value, siblingMode, resource, at, "$ref");
    if (Object.keys(siblings).length === 0) return target;
    if (isReferenceObject(mode)) return withReferenceSiblings(target, siblings);
    if (!isRecord(target)) {
      throw new DereferenceError(`$ref '${ref}' has sibling keys but its target is not an object`);
    }
    return conjoin(target, siblings, ref, true);
  }
}

/**
 * A Reference Object outside a schema (OpenAPI 3.1): its `summary` and `description` replace the
 * target's, and any other key beside it is ignored.
 */
function withReferenceSiblings(target: JsonValue, siblings: JsonObject): JsonValue {
  if (!isRecord(target)) return target;
  const result: JsonObject = { ...target };
  for (const key of ["summary", "description"]) {
    if (Object.hasOwn(siblings, key)) setOwn(result, key, siblings[key]);
  }
  return result;
}

/** The keys of a Reference Object outside a schema that are read: `$ref`, `summary`, `description`. */
function referenceFields(value: Record<string, JsonValue>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const key of ["$ref", "summary", "description"]) {
    if (Object.hasOwn(value, key)) setOwn(result, key, value[key]);
  }
  return result;
}

function outside(ref: string): DereferenceError {
  return new DereferenceError(`$ref '${ref}' points outside the document, which apifn check does not follow`);
}

/**
 * The target of a fragment `ref` in `resource`, where it sits in the document, and the schema
 * resource that holds it.
 */
function resolve(resource: Resource, ref: string): { target: JsonValue; pointer: string; resource: Resource } {
  let current = resource.node;
  let pointer = resource.pointer;
  let holder = resource;
  for (const token of pointerTokens(ref)) {
    if (current !== resource.node && isRecord(current) && typeof current.$id === "string") holder = { node: current, pointer };
    current = step(current, token, ref);
    pointer += `/${encodeToken(token)}`;
  }
  return { target: current, pointer, resource: holder };
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
 * prefix), which would move what the dependent keyword applies to, so that is refused. A list of
 * pairs, not an object literal: one keyword is `then`.
 */
const SCOPED: ReadonlyArray<readonly [keyword: string, partners: readonly string[]]> = [
  ["additionalProperties", ["properties", "patternProperties"]],
  ["unevaluatedProperties", ["properties", "patternProperties", "additionalProperties", "allOf", "anyOf", "oneOf", "if", "then", "else", "dependentSchemas"]],
  ["items", ["prefixItems"]],
  ["unevaluatedItems", ["prefixItems", "items", "contains", "allOf", "anyOf", "oneOf", "if", "then", "else"]],
  ["minContains", ["contains"]],
  ["maxContains", ["contains"]],
  ["then", ["if"]],
  ["else", ["if"]],
];
/**
 * `unevaluated*` directly beside a `$ref` already sees what the target evaluates (`$ref` applies
 * in place), so on the sibling side of that conjunction it keeps its scope. Two property schemas
 * merged under one name are evaluated independently: there it does not.
 */
const SEES_TARGET = new Set(["unevaluatedProperties", "unevaluatedItems"]);

/** Code-unit order, independent of locale. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** What a partner contributes to a dependent keyword's scope: its names, its length or itself. */
function scopeOf(key: string, value: JsonValue | undefined): string {
  if (value === undefined) return "";
  if ((key === "properties" || key === "patternProperties") && isRecord(value)) {
    return canonicalJson(Object.keys(value).sort(byCodeUnit));
  }
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
 * DereferenceError (exit 2). `direct` is true for the keys directly beside the `$ref`, false for
 * two property schemas merged under one name (see SEES_TARGET).
 */
function conjoin(target: JsonObject, siblings: JsonObject, ref: string, direct: boolean): JsonObject {
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
  assertScopeKept(target, closed[0] !== null, false, result, ref);
  assertScopeKept(siblings, closed[1] !== null, direct, result, ref);
  return result;
}

/** Throws when a dependent keyword of `side` would apply to a different scope in `result`. */
function assertScopeKept(side: JsonObject, closedHandled: boolean, beside: boolean, result: JsonObject, ref: string): void {
  for (const [key, partners] of SCOPED) {
    if (own(side, key) === undefined || (key === "additionalProperties" && closedHandled)) continue;
    if (beside && SEES_TARGET.has(key)) continue;
    const moved = partners.find((partner) => scopeOf(partner, own(side, partner)) !== scopeOf(partner, own(result, partner)));
    if (moved !== undefined) {
      throw new DereferenceError(
        `$ref '${ref}' and its siblings combine '${moved}' in a way that changes what '${key}' applies to, which apifn check cannot compare`
      );
    }
  }
}

/**
 * The JSON Schema types both lists allow; `integer` is the part of `number` they share, and is
 * dropped when `number` itself is allowed (it adds nothing).
 */
function bothTypes(a: JsonValue, b: JsonValue): JsonValue | undefined {
  const left = Array.isArray(a) ? a : [a];
  const right = Array.isArray(b) ? b : [b];
  const allows = (types: JsonValue[], type: JsonValue) => types.includes(type) || (type === "integer" && types.includes("number"));
  const both = new Set<JsonValue>();
  for (const type of left) if (allows(right, type)) both.add(type);
  for (const type of right) if (allows(left, type)) both.add(type);
  if (both.has("number")) both.delete("integer");
  const list = [...both];
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : list;
}

function combineBound(key: string, a: number, b: number): number | undefined {
  if (LOWER_BOUNDS.has(key)) return Math.max(a, b);
  if (UPPER_BOUNDS.has(key)) return Math.min(a, b);
  return undefined;
}

function combineRequired(a: JsonValue, b: JsonValue): JsonValue | undefined {
  if (!Array.isArray(a) || !Array.isArray(b)) return undefined;
  return [...a, ...b.filter((item) => !a.includes(item))];
}

function combineEnum(a: JsonValue, b: JsonValue): JsonValue | undefined {
  if (!Array.isArray(a) || !Array.isArray(b)) return undefined;
  const allowed = new Set(b.map((item) => canonicalJson(item)));
  return a.filter((item) => allowed.has(canonicalJson(item)));
}

function combineProperties(a: JsonValue, b: JsonValue, ref: string): JsonValue | undefined {
  if (!isRecord(a) || !isRecord(b)) return undefined;
  const merged: JsonObject = { ...a };
  for (const [name, schema] of Object.entries(b)) {
    const existing = own(merged, name);
    let value: JsonValue = schema;
    if (isRecord(existing) && isRecord(schema)) value = conjoin(existing, schema, ref, false);
    else if (existing !== undefined && canonicalJson(existing) !== canonicalJson(schema)) return undefined;
    setOwn(merged, name, value);
  }
  return merged;
}

const COMBINERS = new Map<string, (a: JsonValue, b: JsonValue, ref: string) => JsonValue | undefined>([
  ["required", combineRequired],
  ["enum", combineEnum],
  ["type", bothTypes],
  ["properties", combineProperties],
]);

function combineKeyword(key: string, a: JsonValue, b: JsonValue, ref: string): JsonValue | undefined {
  if (typeof a === "number" && typeof b === "number") return combineBound(key, a, b);
  return COMBINERS.get(key)?.(a, b, ref);
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
