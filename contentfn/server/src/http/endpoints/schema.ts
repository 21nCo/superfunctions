/**
 * HTTP handlers for schema upsert/get.
 */

import type { ContentfnSchema, ContentfnEnvelope } from "@contentfn/core";
import { schemaUpsert, schemaGet } from "../../storage/schemaStorage.js";
import type { SchemaStorageConfig } from "../../storage/schemaStorage.js";

export interface SchemaEndpointsConfig extends SchemaStorageConfig {}

export async function handleSchemaUpsert(
  config: SchemaEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<{ schemaHash: string }>> {
  if (body === null || typeof body !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Request body must be an object",
        details: {},
      },
    };
  }
  const b = body as { dataset?: unknown; schema?: unknown };
  if (b.dataset === undefined) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Request body must include dataset",
        details: { path: "dataset" },
      },
    };
  }
  if (b.schema === undefined) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Request body must include schema",
        details: { path: "schema" },
      },
    };
  }
  return schemaUpsert(config, {
    dataset: String(b.dataset),
    schema: b.schema as ContentfnSchema,
  });
}

export async function handleSchemaGet(
  config: SchemaEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<ContentfnSchema>> {
  if (body === null || typeof body !== "object" || !("dataset" in body)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Request body must be { dataset: string }",
        details: { path: "dataset" },
      },
    };
  }
  return schemaGet(config, { dataset: String((body as { dataset: unknown }).dataset) });
}
