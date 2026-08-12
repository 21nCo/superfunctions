/**
 * Deterministic schema validation: unique type names, unique field names,
 * reference targets exist, validation rule shapes well-formed.
 */

import type { ContentfnSchema, ContentfnDocumentType, ContentfnField, ContentfnFieldType } from "./types.js";
import type { ContentfnEnvelope } from "../errors.js";
import { err } from "../errors.js";

const VALID_PRIMITIVES = new Set([
  "string",
  "text",
  "number",
  "boolean",
  "date",
  "datetime",
  "json",
]);

const VALID_VALIDATION_RULES = new Set(["min", "max", "regex", "enum", "unique"]);

function validateSchemaInternal(schema: unknown, path: string): ContentfnEnvelope<ContentfnSchema> {
  if (schema === null || typeof schema !== "object") {
    return err("SCHEMA_INVALID", "Schema must be an object", { path });
  }
  const s = schema as Record<string, unknown>;
  if (typeof s.version !== "number" || s.version < 1) {
    return err("SCHEMA_INVALID", "Schema version must be a positive number", {
      path: path ? `${path}.version` : "version",
    });
  }
  if (!Array.isArray(s.documentTypes)) {
    return err("SCHEMA_INVALID", "documentTypes must be an array", {
      path: path ? `${path}.documentTypes` : "documentTypes",
    });
  }

  const typeNames = new Set<string>();
  for (let i = 0; i < s.documentTypes.length; i++) {
    const dt = s.documentTypes[i];
    const typePath = `documentTypes[${i}]`;
    if (dt === null || typeof dt !== "object") {
      return err("SCHEMA_INVALID", "Document type must be an object", {
        path: typePath,
      });
    }
    const docType = dt as ContentfnDocumentType;
    if (typeof docType.name !== "string" || !docType.name) {
      return err("SCHEMA_INVALID", "Document type name must be a non-empty string", {
        path: `${typePath}.name`,
      });
    }
    if (typeNames.has(docType.name)) {
      return err("SCHEMA_INVALID", "Duplicate document type name", {
        path: `${typePath}.name`,
        type: docType.name,
      });
    }
    typeNames.add(docType.name);

    if (!Array.isArray(docType.fields)) {
      return err("SCHEMA_INVALID", "fields must be an array", {
        path: `${typePath}.fields`,
      });
    }
    const fieldRes = validateFields(docType.fields, typeNames, `${typePath}.fields`);
    if (!fieldRes.ok) return fieldRes;
  }

  return { ok: true, result: schema as ContentfnSchema };
}

function validateFields(
  fields: ContentfnField[],
  typeNames: Set<string>,
  path: string
): ContentfnEnvelope<void> {
  const seen = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const fieldPath = `${path}[${i}]`;
    if (f === null || typeof f !== "object") {
      return err("SCHEMA_INVALID", "Field must be an object", { path: fieldPath });
    }
    if (typeof f.name !== "string" || !f.name) {
      return err("SCHEMA_INVALID", "Field name must be a non-empty string", {
        path: `${fieldPath}.name`,
      });
    }
    if (seen.has(f.name)) {
      return err("SCHEMA_INVALID", "Duplicate field name in type/object", {
        path: `${fieldPath}.name`,
      });
    }
    seen.add(f.name);

    const typeRes = validateFieldType(f.type, typeNames, `${fieldPath}.type`);
    if (!typeRes.ok) return typeRes;

    if (f.validation !== undefined) {
      if (!Array.isArray(f.validation)) {
        return err("SCHEMA_INVALID", "validation must be an array", {
          path: `${fieldPath}.validation`,
        });
      }
      for (let v = 0; v < f.validation.length; v++) {
        const rule = f.validation[v];
        if (rule === null || typeof rule !== "object") {
          return err("SCHEMA_INVALID", "Validation rule must be an object", {
            path: `${fieldPath}.validation[${v}]`,
          });
        }
        const r = rule as { rule?: string; value?: unknown };
        if (typeof r.rule !== "string" || !VALID_VALIDATION_RULES.has(r.rule)) {
          return err("SCHEMA_INVALID", "Invalid validation rule", {
            path: `${fieldPath}.validation[${v}].rule`,
          });
        }
        if (r.rule === "min" || r.rule === "max") {
          if (typeof r.value !== "number") {
            return err("SCHEMA_INVALID", `${r.rule} rule requires numeric value`, {
              path: `${fieldPath}.validation[${v}].value`,
            });
          }
        }
        if (r.rule === "regex" && typeof r.value !== "string") {
          return err("SCHEMA_INVALID", "regex rule requires string value", {
            path: `${fieldPath}.validation[${v}].value`,
          });
        }
        if (r.rule === "enum") {
          if (!Array.isArray(r.value) || r.value.some((x: unknown) => typeof x !== "string")) {
            return err("SCHEMA_INVALID", "enum rule requires array of strings", {
              path: `${fieldPath}.validation[${v}].value`,
            });
          }
        }
      }
    }
  }
  return { ok: true, result: undefined };
}

function validateFieldType(
  ft: ContentfnFieldType,
  typeNames: Set<string>,
  path: string
): ContentfnEnvelope<void> {
  if (ft === null || typeof ft !== "object" || !("kind" in ft)) {
    return err("SCHEMA_INVALID", "Field type must have kind", { path });
  }
  switch (ft.kind) {
    case "primitive":
      if (typeof ft.type !== "string" || !VALID_PRIMITIVES.has(ft.type)) {
        return err("SCHEMA_INVALID", "Invalid primitive type", { path: `${path}.type` });
      }
      return { ok: true, result: undefined };
    case "object":
      if (!Array.isArray(ft.fields)) {
        return err("SCHEMA_INVALID", "object fields must be an array", { path: `${path}.fields` });
      }
      return validateFields(ft.fields, typeNames, `${path}.fields`);
    case "array":
      if (!Array.isArray(ft.of) || ft.of.length === 0) {
        return err("SCHEMA_INVALID", "array of must be non-empty array", { path: `${path}.of` });
      }
      for (let i = 0; i < ft.of.length; i++) {
        const item = ft.of[i];
        const itemPath = `${path}.of[${i}]`;
        if (item && typeof item === "object" && "kind" in item) {
          if ((item as { kind: string }).kind === "reference") {
            const ref = item as { to?: string[] };
            if (!Array.isArray(ref.to) || ref.to.length === 0) {
              return err("SCHEMA_INVALID", "reference to must be non-empty string array", {
                path: `${itemPath}.to`,
              });
            }
            for (const t of ref.to) {
              if (!typeNames.has(t)) {
                return err("SCHEMA_INVALID", "Reference target type does not exist", {
                  path: itemPath,
                  type: t,
                });
              }
            }
          } else {
            const res = validateFieldType(item as ContentfnFieldType, typeNames, itemPath);
            if (!res.ok) return res;
          }
        }
      }
      if (ft.maxLength !== undefined && (typeof ft.maxLength !== "number" || ft.maxLength < 1)) {
        return err("SCHEMA_INVALID", "maxLength must be positive number", {
          path: `${path}.maxLength`,
        });
      }
      return { ok: true, result: undefined };
    case "reference":
      if (!Array.isArray(ft.to) || ft.to.length === 0) {
        return err("SCHEMA_INVALID", "reference to must be non-empty string array", {
          path: `${path}.to`,
        });
      }
      for (const t of ft.to) {
        if (!typeNames.has(t)) {
          return err("SCHEMA_INVALID", "Reference target type does not exist", {
            path,
            type: t,
          });
        }
      }
      return { ok: true, result: undefined };
    case "richtext":
      return { ok: true, result: undefined };
    case "markdown":
      if (ft.dialect !== undefined && ft.dialect !== "commonmark" && ft.dialect !== "gfm") {
        return err("SCHEMA_INVALID", "markdown dialect must be commonmark or gfm", { path: `${path}.dialect` });
      }
      if (ft.allowRawHtml !== undefined && typeof ft.allowRawHtml !== "boolean") {
        return err("SCHEMA_INVALID", "markdown allowRawHtml must be boolean", { path: `${path}.allowRawHtml` });
      }
      return { ok: true, result: undefined };
    case "asset":
      if (ft.assetType !== "file" && ft.assetType !== "image") {
        return err("SCHEMA_INVALID", "assetType must be file or image", {
          path: `${path}.assetType`,
        });
      }
      return { ok: true, result: undefined };
    default:
      return err("SCHEMA_INVALID", "Unknown field kind", { path });
  }
}

/**
 * Validates a ContentfnSchema. Returns SCHEMA_INVALID with details.path when invalid.
 */
export function validateSchema(schema: unknown): ContentfnEnvelope<ContentfnSchema> {
  return validateSchemaInternal(schema, "");
}
