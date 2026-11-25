import SwaggerParser from "@apidevtools/swagger-parser";
import { parseDocument, visit } from "yaml";
import type { OpenAPIDocument, ValidationError } from "../types.js";
import { openAPIReferenceContext, type OpenAPIReferenceMode } from "./reference-context.js";

export interface OpenAPIValidationOptions {
  /**
   * Preloaded JSON or YAML for external documents, keyed by the resolved URI or
   * absolute file path, without a fragment. Within those documents, use
   * slash-delimited `#/` pointers. Validation never reads files or URLs.
   */
  externalReferences?: ReadonlyMap<string, string>;
}

const EXTERNAL_REF_ERROR = "External OpenAPI $ref requires an explicit allowlist entry";

function referenceChildMode(
  parent: object, mode: OpenAPIReferenceMode, key: string, child: unknown
): OpenAPIReferenceMode {
  const { childMode, entryMode, arrayItemMode } = openAPIReferenceContext;
  if (Array.isArray(parent)) return arrayItemMode(mode);
  if (mode === "literal" || mode === "example") return "literal";
  return entryMode(mode, key, child) ?? childMode(key, child);
}

function pointerTarget(
  document: unknown, tokens: string[]
): { value: unknown; mode: OpenAPIReferenceMode } | "reference" | undefined {
  let value = document;
  let mode: OpenAPIReferenceMode = "node";
  for (const key of tokens) {
    if (typeof value !== "object" || value === null) return undefined;
    // Swagger Parser follows an intermediate reference before looking up keys.
    if (mode !== "literal" && "$ref" in value && typeof value.$ref === "string" && value.$ref) {
      return "reference";
    }
    if (!Object.hasOwn(value, key)) return undefined;
    const child: unknown = Reflect.get(value, key);
    mode = referenceChildMode(value, mode, key, child);
    value = child;
  }
  return { value, mode };
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function unescapePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function localPointerTokens(document: unknown, fragment: string): string[] {
  if (fragment === "") return [];
  if (fragment.startsWith("/")) {
    const legacy = fragment.split("/").slice(1).map((token) => decodeFragment(unescapePointerToken(token)));
    if (!/%2f/i.test(fragment) || pointerTarget(document, legacy)) return legacy;
    const decoded = decodeFragment(fragment).split("/").slice(1).map(unescapePointerToken);
    return pointerTarget(document, decoded) ? decoded : legacy;
  }
  const decoded = decodeFragment(fragment);
  if (!decoded.startsWith("/")) {
    throw new Error("OpenAPI $ref fragments must be slash-delimited JSON pointers");
  }
  return decoded.split("/").slice(1).map(unescapePointerToken);
}

interface ReferenceCopies {
  field: string;
  targets: unknown[];
  originals: Map<string, string>;
}

function reserveReferenceField(ref: string, used: Set<string>): void {
  const normalized = ref.replaceAll("\\", "/").replace(/[\t\r\n]/g, "");
  const first = normalized.match(/#(?:\/|%2f)(.*?)(?:\/|%2f|$)/i)?.[1];
  if (first !== undefined) {
    try {
      used.add(decodeURIComponent(first));
    } catch {
      // A malformed token cannot name an ASCII extension field.
    }
  }
}

function reserveReferenceFields(document: unknown, used: Set<string>): void {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [document];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    if ("$ref" in value && typeof value.$ref === "string") {
      reserveReferenceField(value.$ref, used);
    }
    for (const child of Object.values(value)) pending.push(child);
  }
}

function reservePreloadedReferenceFields(contents: string, used: Set<string>): void {
  // Inspect scalar tokens without expanding YAML aliases or interpreting a
  // schema map. An aliased string is present as a scalar at its anchor.
  visit(parseDocument(contents), {
    Scalar(_key, scalar) {
      if (typeof scalar.value === "string") reserveReferenceField(scalar.value, used);
    },
  });
}

function restoreReferenceCopies(document: object, { field, targets, originals }: ReferenceCopies): void {
  if (!originals.size) return;
  const seen = new WeakSet<object>();
  const pending: unknown[] = [document];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    // A reference to the root with sibling fields can copy the temporary slot.
    if (Reflect.get(value, field) === targets) Reflect.deleteProperty(value, field);
    if ("$ref" in value && typeof value.$ref === "string") {
      const original = originals.get(value.$ref);
      if (original !== undefined) value.$ref = original;
    }
    for (const child of Object.values(value)) pending.push(child);
  }
}

function applyReferencePolicy<T>(
  document: T,
  {
    allowExternal,
    literalReferences,
    referenceCopies,
  }: { allowExternal: boolean; literalReferences?: Map<object, string>; referenceCopies?: ReferenceCopies }
): T {
  const prepare = literalReferences !== undefined;
  const { isMap } = openAPIReferenceContext;
  const seen = new WeakMap<object, Map<OpenAPIReferenceMode, object>>();
  const pending: Array<{ value: object; copy: object; mode: OpenAPIReferenceMode }> = [];
  const copiedPointers = new Map<string, string>();

  function enqueue(value: unknown, mode: OpenAPIReferenceMode): unknown {
    if (typeof value !== "object" || value === null) return value;
    const contexts = seen.get(value) ?? new Map<OpenAPIReferenceMode, object>();
    const existing = contexts.get(mode);
    if (existing) return existing;

    // YAML aliases can share a value between a schema and literal example data.
    const prototype = Object.getPrototypeOf(value);
    const copy = prepare && (Array.isArray(value) || prototype === Object.prototype || prototype === null)
      ? (Array.isArray(value) ? [...value] : { ...value })
      : value;
    contexts.set(mode, copy);
    seen.set(value, contexts);
    pending.push({ value, copy, mode });
    return copy;
  }

  const root = enqueue(document, "node");
  while (pending.length) {
    const { value, copy, mode } = pending.pop()!;

    if ("$ref" in value && typeof value.$ref === "string") {
      const ref = value.$ref;
      if (mode === "literal") {
        // The parser treats literal $ref strings as references. Restore these
        // values on their context-specific copies after validation.
        if (literalReferences) {
          literalReferences.set(copy, ref);
          Reflect.deleteProperty(copy, "$ref");
        }
      } else if (ref && !ref.startsWith("#")) {
        if (!allowExternal) throw new Error(EXTERNAL_REF_ERROR);
      } else if (ref && !isMap(mode)) {
        const fragment = ref.slice(1);
        if (!prepare && fragment !== "" && !fragment.startsWith("/")) {
          throw new Error("OpenAPI $ref fragments must be slash-delimited JSON pointers");
        }
        if (prepare) {
          const tokens = localPointerTokens(document, fragment);
          if (referenceCopies && tokens[0] === referenceCopies.field) {
            throw new Error("OpenAPI $ref target does not exist");
          }
          const canonical = "#" + tokens.map((token) =>
            "/" + encodeURIComponent(token.replaceAll("~", "~0").replaceAll("/", "~1"))
          ).join("");
          let resolved = canonical;
          const target = tokens.length ? pointerTarget(document, tokens) : undefined;
          if (target && target !== "reference" && target.mode === "literal" &&
              referenceCopies && typeof target.value === "object" && target.value !== null) {
            const key = mode + canonical;
            const existing = copiedPointers.get(key);
            if (existing) {
              resolved = existing;
            } else {
              // A schema can reference an extension or example as a schema.
              // Give the parser a copy for that use without changing the data.
              resolved = "#/" + referenceCopies.field + "/" + referenceCopies.targets.length;
              copiedPointers.set(key, resolved);
              referenceCopies.originals.set(resolved, canonical);
              referenceCopies.targets.push(enqueue(target.value, mode));
            }
          }
          Reflect.set(copy, "$ref", resolved);
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (prepare && key === "$ref" && typeof child === "string") continue;
      const childCopy = enqueue(child, referenceChildMode(value, mode, key, child));
      if (prepare) Reflect.set(copy, key, childCopy);
    }
  }
  return root as T;
}

function toValidationErrors(error: unknown): ValidationError[] {
  const details = (error as { details?: Array<{ path?: string | string[]; message?: string }> })
    ?.details;

  if (Array.isArray(details) && details.length > 0) {
    return details.map((detail) => ({
      path: Array.isArray(detail.path)
        ? detail.path.join(".")
        : detail.path || "openapi",
      message: detail.message || "Validation error",
      severity: "error",
    }));
  }

  const message = error instanceof Error ? error.message : "Validation error";
  return [
    {
      path: "openapi",
      message,
      severity: "error",
    },
  ];
}

export async function validateOpenAPI(
  document: OpenAPIDocument,
  options?: OpenAPIValidationOptions
): Promise<ValidationError[]> {
  return (await validateAndDereferenceOpenAPI(document, options)).errors;
}

/** Validates and returns a dereferenced copy for callers that compare or store it. */
export async function validateAndDereferenceOpenAPI(
  document: OpenAPIDocument,
  options?: OpenAPIValidationOptions
): Promise<{ document: OpenAPIDocument; errors: [] } | { document: null; errors: ValidationError[] }> {
  let deniedReference = false;
  try {
    const externalReferences = options?.externalReferences;
    const allowExternal = Boolean(externalReferences?.size);
    const literalReferences = new Map<object, string>();
    const input = structuredClone(document);
    const usedFields = new Set(Object.keys(input));
    reserveReferenceFields(input, usedFields);
    // Same-document URIs can reach the parser's cached root without a resolver
    // call. Reserve fragment names regardless of how a reference spells its URI.
    for (const contents of externalReferences?.values() ?? []) {
      try {
        reservePreloadedReferenceFields(contents, usedFields);
      } catch {
        // Invalid allowlist contents are reported if a reference selects them.
      }
    }
    let field = "x-apifn-reference-copies";
    while (usedFields.has(field)) field += "-";
    const referenceCopies: ReferenceCopies = { field, targets: [], originals: new Map() };
    const copy = applyReferencePolicy(input, { allowExternal, literalReferences, referenceCopies });
    if (referenceCopies.targets.length) Reflect.set(copy, field, referenceCopies.targets);
    const validated = await SwaggerParser.validate(copy as never, {
      resolve: {
        external: allowExternal,
        file: false,
        http: false,
        allowlist: {
          canRead: true,
          read({ url }: { url: string }): string {
            const contents = externalReferences?.get(url);
            if (contents !== undefined) {
              if (referenceCopies.targets.length) {
                const fields = new Set<string>();
                reservePreloadedReferenceFields(contents, fields);
                if (fields.has(field)) throw new Error("OpenAPI $ref target does not exist");
              }
              return contents;
            }
            deniedReference = true;
            throw new Error(EXTERNAL_REF_ERROR);
          },
        },
      },
    });
    // A preloaded document may be a map of schemas. Check the referenced
    // subtrees in the context where they appear after dereferencing.
    restoreReferenceCopies(validated, referenceCopies);
    if (allowExternal) applyReferencePolicy(validated, { allowExternal: false });
    for (const [literal, ref] of literalReferences) Reflect.set(literal, "$ref", ref);
    return { document: validated as unknown as OpenAPIDocument, errors: [] };
  } catch (error) {
    return { document: null, errors: toValidationErrors(deniedReference ? new Error(EXTERNAL_REF_ERROR) : error) };
  }
}
