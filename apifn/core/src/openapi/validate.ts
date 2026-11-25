import SwaggerParser from "@apidevtools/swagger-parser";
import { parse as parseYaml } from "yaml";
import type { OpenAPIDocument, ValidationError } from "../types.js";
import { openAPIReferenceContext, type OpenAPIReferenceMode } from "./reference-context.js";

export interface OpenAPIValidationOptions {
  /**
   * Preloaded JSON or YAML for external documents, keyed by the resolved URI or
   * absolute file path, without a fragment. Validation never reads files or URLs.
   */
  externalReferences?: ReadonlyMap<string, string>;
}

const EXTERNAL_REF_ERROR = "External OpenAPI $ref requires an explicit allowlist entry";

function assertReferencePolicy(
  document: unknown,
  { allowExternal, stage }: { allowExternal: boolean; stage: "input" | "preloaded" | "resolved" }
): void {
  const { childMode, entryMode, arrayItemMode, isMap } = openAPIReferenceContext;
  const seen = new WeakMap<object, Set<OpenAPIReferenceMode>>();
  const pending: Array<{ value: unknown; mode: OpenAPIReferenceMode }> = [{ value: document, mode: "node" }];
  while (pending.length) {
    const { value, mode } = pending.pop()!;
    if (typeof value !== "object" || value === null) continue;
    const modes = seen.get(value) ?? new Set<OpenAPIReferenceMode>();
    if (modes.has(mode)) continue;
    modes.add(mode);
    seen.set(value, modes);

    if ("$ref" in value && typeof value.$ref === "string" && value.$ref) {
      const ref = value.$ref;
      if (!ref.startsWith("#")) {
        // The parser scans even literal data for external references.
        if (!allowExternal) throw new Error(EXTERNAL_REF_ERROR);
      } else if (mode !== "literal" && !isMap(mode) && ref !== "#" && !ref.startsWith("#/")) {
        if (stage !== "resolved" && /^#%2f/i.test(ref)) {
          const pointer = decodeURIComponent(ref.slice(1));
          value.$ref = "#" + pointer.split("/").map(encodeURIComponent).join("/");
        } else if (stage !== "preloaded") {
          throw new Error("OpenAPI $ref fragments must be JSON pointers");
        }
      }
    }
    if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child, mode: arrayItemMode(mode) });
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      const nextMode = mode === "literal" || mode === "example"
        ? "literal"
        : entryMode(mode, key, child) ?? childMode(key, child);
      pending.push({ value: child, mode: nextMode });
    }
  }
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
    const copy = structuredClone(document);
    const externalReferences = options?.externalReferences;
    const allowExternal = Boolean(externalReferences?.size);
    assertReferencePolicy(copy, { allowExternal, stage: "input" });
    const validated = await SwaggerParser.validate(copy as never, {
      resolve: {
        external: allowExternal,
        file: false,
        http: false,
        allowlist: {
          canRead: true,
          read({ url }: { url: string }): unknown {
            const contents = externalReferences?.get(url);
            if (contents === undefined) {
              deniedReference = true;
              throw new Error(EXTERNAL_REF_ERROR);
            }
            const parsed: unknown = parseYaml(contents);
            assertReferencePolicy(parsed, { allowExternal: true, stage: "preloaded" });
            return typeof parsed === "string" ? JSON.stringify(parsed) : parsed;
          },
        },
      },
    });
    // A preloaded document may be a map of schemas. Check the referenced
    // subtrees in the context where they appear after dereferencing.
    if (allowExternal) assertReferencePolicy(validated, { allowExternal: false, stage: "resolved" });
    return { document: validated as unknown as OpenAPIDocument, errors: [] };
  } catch (error) {
    return { document: null, errors: toValidationErrors(deniedReference ? new Error(EXTERNAL_REF_ERROR) : error) };
  }
}
