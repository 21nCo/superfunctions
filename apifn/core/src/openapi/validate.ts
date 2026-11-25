import SwaggerParser from "@apidevtools/swagger-parser";
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

function applyReferencePolicy<T>(
  document: T,
  { allowExternal, normalizePointers }: { allowExternal: boolean; normalizePointers: boolean }
): T {
  const { childMode, entryMode, arrayItemMode, isMap } = openAPIReferenceContext;
  const seen = new WeakMap<object, Map<OpenAPIReferenceMode, object>>();
  const pending: Array<{ value: object; copy: object; mode: OpenAPIReferenceMode }> = [];

  function enqueue(value: unknown, mode: OpenAPIReferenceMode): unknown {
    if (typeof value !== "object" || value === null) return value;
    const contexts = seen.get(value) ?? new Map<OpenAPIReferenceMode, object>();
    const existing = contexts.get(mode);
    if (existing) return existing;

    // YAML aliases can share a value between a schema and literal example data.
    const prototype = Object.getPrototypeOf(value);
    const copy = normalizePointers && (Array.isArray(value) || prototype === Object.prototype || prototype === null)
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

    if ("$ref" in value && typeof value.$ref === "string" && value.$ref) {
      const ref = value.$ref;
      if (!ref.startsWith("#")) {
        // The parser scans even literal data for external references.
        if (!allowExternal) throw new Error(EXTERNAL_REF_ERROR);
      } else if (mode !== "literal" && !isMap(mode) && ref !== "#" && !ref.startsWith("#/")) {
        if (normalizePointers && /^#%2f/i.test(ref)) {
          const pointer = decodeURIComponent(ref.slice(1));
          Reflect.set(copy, "$ref", "#" + pointer.split("/").map(encodeURIComponent).join("/"));
        } else {
          throw new Error("OpenAPI $ref fragments must be slash-delimited JSON pointers");
        }
      }
    }
    const items = Array.isArray(value);
    for (const [key, child] of Object.entries(value)) {
      const nextMode = items
        ? arrayItemMode(mode)
        : mode === "literal" || mode === "example"
        ? "literal"
        : entryMode(mode, key, child) ?? childMode(key, child);
      if (normalizePointers && key === "$ref" && typeof child === "string") continue;
      const childCopy = enqueue(child, nextMode);
      if (normalizePointers) Reflect.set(copy, key, childCopy);
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
    const copy = applyReferencePolicy(structuredClone(document), { allowExternal, normalizePointers: true });
    const validated = await SwaggerParser.validate(copy as never, {
      resolve: {
        external: allowExternal,
        file: false,
        http: false,
        allowlist: {
          canRead: true,
          read({ url }: { url: string }): string {
            const contents = externalReferences?.get(url);
            if (contents !== undefined) return contents;
            deniedReference = true;
            throw new Error(EXTERNAL_REF_ERROR);
          },
        },
      },
    });
    // A preloaded document may be a map of schemas. Check the referenced
    // subtrees in the context where they appear after dereferencing.
    if (allowExternal) applyReferencePolicy(validated, { allowExternal: false, normalizePointers: false });
    return { document: validated as unknown as OpenAPIDocument, errors: [] };
  } catch (error) {
    return { document: null, errors: toValidationErrors(deniedReference ? new Error(EXTERNAL_REF_ERROR) : error) };
  }
}
