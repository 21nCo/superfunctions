/**
 * Built-in KV resource utilities
 */

import type { DatafnSchema, DatafnResourceSchema } from "./types.js";

/**
 * Canonical KV resource name
 */
export const KV_RESOURCE_NAME = "kv";

/**
 * Generate the canonical KV id from a key.
 * Mapping: kvId(key) = "kv:" + key
 */
export function kvId(key: string): string {
  if (typeof key !== "string") {
    throw new Error("Invalid KV key: must be string");
  }
  return `${KV_RESOURCE_NAME}:${key}`;
}

/**
 * Ensure the schema includes the built-in KV resource.
 * If schema already has resource "kv", validates it is compatible.
 * Otherwise appends a resource definition for KV.
 */
export function ensureBuiltinKv(schema: DatafnSchema): DatafnSchema {
  const existingKv = schema.resources.find((r) => r.name === KV_RESOURCE_NAME);

  if (existingKv) {
    // Validate compatibility
    if (existingKv.version !== 1) {
      throw new Error(
        `KV resource version mismatch: expected 1, got ${existingKv.version}`,
      );
    }
    // KV resource already exists and is compatible
    return schema;
  }

  // Append KV resource definition
  const kvResource: DatafnResourceSchema = {
    name: KV_RESOURCE_NAME,
    version: 1,
    idPrefix: KV_RESOURCE_NAME,
    fields: [
      {
        name: "id",
        type: "string",
        required: true,
      },
      {
        name: "value",
        type: "object",
        required: false,
      },
    ],
    indices: ["id"],
  };

  return {
    ...schema,
    resources: [...schema.resources, kvResource],
  };
}
