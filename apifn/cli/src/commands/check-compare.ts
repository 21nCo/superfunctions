/**
 * Validated comparison: `diffOpenAPI` and the version rule only ever see two documents that both
 * passed the existing validator and have every local `$ref` replaced by its target, so a change
 * behind a shared schema is diffed like the same change written inline.
 */

import { parseOpenAPI, validateOpenAPI } from "@apifn/core";
import type { OpenAPIDocument } from "@apifn/core";
import { MAX_EXPANDED_SPEC_NODES } from "./check-parse.js";
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
 * Returns a copy of `doc` with every local `$ref` replaced by its target (sibling keys kept on top
 * of it, as OpenAPI 3.1 reads them). A reference back into a schema being expanded (a recursive
 * schema) stays a `$ref`, so the comparison still sees its name. A reference that leaves the
 * document, does not resolve, or expands past MAX_EXPANDED_SPEC_NODES throws DereferenceError.
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
    return { ...target, ...siblings };
  }

  private resolve(ref: string): JsonValue {
    let current: JsonValue = this.doc;
    for (const token of pointerTokens(ref)) {
      current = step(current, token, ref);
    }
    return current;
  }
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
