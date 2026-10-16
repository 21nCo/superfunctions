/**
 * Deterministic schema hash: canonical JSON stringify of normalized schema.
 * Hash changes only when schema content changes (SPEC / SCHEMA-001).
 */

import type { ContentfnSchema, ContentfnDocumentType, ContentfnField } from "@contentfn/core";
import { createHash } from "crypto";

/**
 * Normalize schema for deterministic serialization: sort document types and fields by name.
 */
function normalizeSchema(schema: ContentfnSchema): ContentfnSchema {
  const documentTypes = [...schema.documentTypes].sort((a, b) =>
    a.name.localeCompare(b.name, "en")
  );
  return {
    version: schema.version,
    documentTypes: documentTypes.map((dt) => normalizeDocumentType(dt)),
  };
}

function normalizeDocumentType(dt: ContentfnDocumentType): ContentfnDocumentType {
  const fields = [...dt.fields].sort((a, b) => a.name.localeCompare(b.name, "en"));
  return {
    name: dt.name,
    fields: fields.map(normalizeField),
    meta: dt.meta,
  };
}

function normalizeField(f: ContentfnField): ContentfnField {
  return {
    name: f.name,
    type: f.type,
    required: f.required,
    validation: f.validation,
  };
}

/**
 * Compute deterministic schema hash (SHA-256 hex of canonical JSON).
 */
export function schemaHash(schema: ContentfnSchema): string {
  const normalized = normalizeSchema(schema);
  const canonical = JSON.stringify(normalized);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
