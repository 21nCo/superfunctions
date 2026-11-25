import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPIDocument, ValidationError } from "../types.js";

export interface OpenAPIValidationOptions {
  /**
   * Preloaded JSON or YAML for external documents, keyed by the resolved URI or
   * absolute file path, without a fragment. Validation never reads files or URLs.
   */
  externalReferences?: ReadonlyMap<string, string>;
}

const EXTERNAL_REF_ERROR = "External OpenAPI $ref requires an explicit allowlist entry";

function assertLocalReferences(document: OpenAPIDocument): void {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [document];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    if ("$ref" in value && typeof value.$ref === "string" && value.$ref) {
      if (value.$ref !== "#" && !value.$ref.startsWith("#/")) {
        throw new Error(EXTERNAL_REF_ERROR);
      }
    }
    for (const child of Object.values(value)) pending.push(child);
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
    if (!externalReferences?.size) assertLocalReferences(copy);
    const validated = await SwaggerParser.validate(copy as never, {
      resolve: {
        external: Boolean(externalReferences?.size),
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
      dereference: { circular: "ignore" },
    });
    return { document: validated as unknown as OpenAPIDocument, errors: [] };
  } catch (error) {
    return { document: null, errors: toValidationErrors(deniedReference ? new Error(EXTERNAL_REF_ERROR) : error) };
  }
}
