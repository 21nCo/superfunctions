import { DEFAULT_MAX_RICHTEXT_BLOCKS } from "../limits/limits.js";
import { documentStorageId } from "./documentIdentity.js";
import type { ContentfnEnvelope, ContentfnSchema, ContentfnField, ContentfnFieldType } from "@contentfn/core";
import { ok, err } from "@contentfn/core";
import { parseMarkdown } from "@mdfn/markdown";
import { calloutExtension, commonmarkExtension, diagramExtension, gfmExtension } from "@mdfn/extensions";
import { isMarkdownContent, markdownContent, type MarkdownContent, type MarkdownContentProfile } from "@mdfn/contentfn";

const markdownExtensionByName = {
  callout: calloutExtension,
  "directive/callout": calloutExtension,
  diagram: diagramExtension,
  "directive/diagram": diagramExtension,
} as const;

function markdownProfile(fieldType: Extract<ContentfnFieldType, { kind: "markdown" }>): MarkdownContentProfile {
  const dialect = fieldType.dialect ?? "gfm";
  return {
    id: `mdfn:${dialect}`,
    dialect,
    allowRawHtml: fieldType.allowRawHtml ?? false,
    extensions: [...(fieldType.extensions ?? [])],
    schemaVersion: fieldType.schemaVersion ?? 1,
  };
}

function markdownProfilesEqual(left: MarkdownContentProfile, right: MarkdownContentProfile): boolean {
  return left.id === right.id
    && left.dialect === right.dialect
    && left.allowRawHtml === right.allowRawHtml
    && left.schemaVersion === right.schemaVersion
    && left.extensions.length === right.extensions.length
    && left.extensions.every((extension, index) => extension === right.extensions[index]);
}

type Failure = { ok: false; field: string; error: string };
type Check = { ok: true } | Failure;
const fail = (field: string, error: string): Failure => ({ ok: false, field, error });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export function jsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? Array.from(value).every(item => jsonValue(item, seen))
    : Object.values(value).every(item => item === undefined || jsonValue(item, seen));
  seen.delete(value);
  return valid;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function validateFields(fields: ContentfnField[], value: Record<string, unknown>, path: string, maxRichtextBlocks = Infinity): Check {
  for (const field of fields) {
    const fieldPath = path ? `${path}.${field.name}` : field.name;
    if (!own(value, field.name) || value[field.name] == null) {
      if (field.required) return fail(fieldPath, "required field must have a non-null value");
      continue;
    }
    const current = value[field.name];
    const checked = validateFieldType(field.type, current, fieldPath, maxRichtextBlocks);
    if (!checked.ok) return checked;
    for (const rule of field.validation ?? []) {
      if (rule.rule === "min" || rule.rule === "max") {
        const size = typeof current === "number" ? current : typeof current === "string" || Array.isArray(current) ? current.length : NaN;
        if (!Number.isFinite(size) || (rule.rule === "min" ? size < rule.value : size > rule.value)) return fail(fieldPath, `${rule.rule} constraint failed`);
      } else if (rule.rule === "regex") {
        try {
          if (typeof current !== "string" || !new RegExp(rule.value).test(current)) return fail(fieldPath, "regex constraint failed");
        } catch { return fail(fieldPath, "invalid regex constraint"); }
      } else if (rule.rule === "enum") {
        if (typeof current !== "string" || !rule.value.includes(current)) return fail(fieldPath, "enum constraint failed");
      } else if (rule.rule === "unique") {
        if (!Array.isArray(current) || new Set(current.map(stable)).size !== current.length) return fail(fieldPath, "array items must be unique");
      }
    }
  }
  return { ok: true };
}

function validateFieldType(type: ContentfnFieldType, value: unknown, path: string, maxRichtextBlocks = Infinity): Check {
  switch (type.kind) {
    case "primitive": {
      if (type.type === "json") return jsonValue(value) ? { ok: true } : fail(path, "expected JSON value");
      if (type.type === "number") return typeof value === "number" && Number.isFinite(value) ? { ok: true } : fail(path, "expected finite number");
      if (type.type === "boolean") return typeof value === "boolean" ? { ok: true } : fail(path, "expected boolean");
      if (typeof value !== "string") return fail(path, "expected string");
      if (type.type === "date" && !validDate(value)) return fail(path, "expected calendar date YYYY-MM-DD");
      if (type.type === "datetime" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !validDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value)))) return fail(path, "expected ISO datetime with timezone");
      return { ok: true };
    }
    case "object": return record(value) ? validateFields(type.fields, value, path, maxRichtextBlocks) : fail(path, "expected object");
    case "array": {
      if (!Array.isArray(value)) return fail(path, "expected array");
      if (type.maxLength !== undefined && value.length > type.maxLength) return fail(path, "array exceeds maxLength");
      for (let index = 0; index < value.length; index++) {
        const results = type.of.map(candidate => validateFieldType(candidate, value[index], `${path}[${index}]`, maxRichtextBlocks));
        if (!results.some(result => result.ok)) return results.find(result => !result.ok)!;
      }
      return { ok: true };
    }
    case "reference": {
      if (!record(value) || value._type !== "reference" || typeof value._ref !== "string" || !value._ref.trim()) return fail(path, "expected canonical reference");
      if (value._weak !== undefined && typeof value._weak !== "boolean") return fail(path, "reference _weak must be boolean");
      if (value._weak === true && type.weak !== true) return fail(path, "weak reference is not allowed by schema");
      return { ok: true };
    }
    case "asset": return record(value) && value._type === "asset" && typeof value._ref === "string" && !!value._ref.trim() && value.assetType === type.assetType ? { ok: true } : fail(path, "expected matching canonical asset reference");
    case "richtext": {
      if (!Array.isArray(value)) return fail(path, "expected richtext block array");
      if (value.length > maxRichtextBlocks) return fail(path, "richtext exceeds maxRichtextBlocks");
      const keys = new Set<string>();
      for (let index = 0; index < value.length; index++) {
        const block = value[index], itemPath = `${path}[${index}]`;
        if (!record(block) || typeof block._key !== "string" || !block._key || keys.has(block._key)) return fail(itemPath, "richtext blocks require unique non-empty _key");
        keys.add(block._key);
        if (block._type !== "block") {
          if (typeof block._type !== "string" || !type.allowObjects?.includes(block._type)) return fail(itemPath, "richtext object type is not allowed");
          continue;
        }
        if (!Array.isArray(block.children)) return fail(itemPath, "block children must be spans");
        const definitions = new Map<string, string>();
        if (block.markDefs !== undefined) {
          if (!Array.isArray(block.markDefs)) return fail(itemPath, "markDefs must be an array");
          for (const definition of block.markDefs) {
            if (!record(definition) || typeof definition._key !== "string" || !definition._key || definitions.has(definition._key) || typeof definition._type !== "string" || !definition._type) return fail(itemPath, "invalid mark definition");
            definitions.set(definition._key, definition._type);
          }
        }
        const spans = new Set<string>();
        for (const child of block.children) {
          if (!record(child) || child._type !== "span" || typeof child._key !== "string" || !child._key || spans.has(child._key) || typeof child.text !== "string") return fail(itemPath, "invalid richtext span");
          spans.add(child._key);
          if (child.marks !== undefined && (!Array.isArray(child.marks) || child.marks.some(mark => typeof mark !== "string" || (type.allowMarks !== undefined && !type.allowMarks.includes(mark) && !type.allowMarks.includes(definitions.get(mark) ?? ""))))) return fail(itemPath, "invalid or disallowed richtext marks");
        }
      }
      return { ok: true };
    }
    case "markdown": {
      if (!isMarkdownContent(value)) return fail(path, "expected versioned Markdown value");
      try {
        const content = value as MarkdownContent;
        if (!markdownProfilesEqual(content.profile, markdownProfile(type))) return fail(path, "markdown profile does not match schema");
        const configured = content.profile.extensions.map(name => markdownExtensionByName[name as keyof typeof markdownExtensionByName]);
        if (configured.some(extension => !extension)) return fail(path, "unknown markdown extension");
        parseMarkdown(content.markdown, { ...content.profile, extensions: [commonmarkExtension, ...(content.profile.dialect === "gfm" ? [gfmExtension] : []), ...configured] });
        return { ok: true };
      } catch { return fail(path, "invalid markdown"); }
    }
  }
}

export function validateDocumentAgainstSchema(schema: ContentfnSchema, docType: string, doc: Record<string, unknown>, maxRichtextBlocks = DEFAULT_MAX_RICHTEXT_BLOCKS): ContentfnEnvelope<void> {
  const type = schema.documentTypes.find(candidate => candidate.name === docType);
  if (!type) return err("VALIDATION_FAILED", "Document type not found in schema", { type: docType });
  if (!record(doc) || !jsonValue(doc)) return err("VALIDATION_FAILED", "Document must contain only JSON values", { path: "" });
  const result = validateFields(type.fields, doc, "", maxRichtextBlocks);
  return result.ok ? ok(undefined) : err("VALIDATION_FAILED", result.error, { path: result.field });
}

function sameShape(type: ContentfnFieldType, value: unknown): boolean {
  if (type.kind === "primitive") return type.type === "json" || typeof value === (["number", "boolean"].includes(type.type) ? type.type : "string");
  if (type.kind === "markdown") return typeof value === "string" || isMarkdownContent(value);
  if (type.kind === "array" || type.kind === "richtext") return Array.isArray(value);
  if (type.kind === "reference" || type.kind === "asset") return record(value) && value._type === type.kind;
  return record(value);
}

function normalize(type: ContentfnFieldType, value: unknown, path: string): { ok: true; value: unknown } | Failure {
  if (value == null) return { ok: true, value };
  if (type.kind === "markdown") {
    const profile = markdownProfile(type);
    if (typeof value === "string") return { ok: true, value: markdownContent(value, { profile }) };
    if (!isMarkdownContent(value) || !markdownProfilesEqual(value.profile, profile)) return fail(path, "markdown profile does not match schema");
  } else if (type.kind === "object" && record(value)) {
    return normalizeFields(type.fields, value, path);
  } else if (type.kind === "array" && Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const itemPath = `${path}[${index}]`;
      const candidates = type.of.filter(candidate => sameShape(candidate, value[index]))
        .map(candidate => ({ candidate, result: normalize(candidate, value[index], itemPath) }));
      const matching = candidates.find(({candidate, result}) => result.ok && validateFieldType(candidate, result.value, itemPath).ok)
        ?? candidates.find(({result}) => result.ok);
      // Normalization also runs on reads: schema evolution must not revalidate old snapshots.
      if (!matching) {
        const failure = candidates.find(({result}) => !result.ok)?.result;
        if (failure && !failure.ok) return failure;
        result.push(value[index]);
      } else result.push((matching.result as { ok: true; value: unknown }).value);
    }
    return { ok: true, value: result };
  }
  return { ok: true, value };
}
function normalizeFields(fields: ContentfnField[], doc: Record<string, unknown>, path: string): { ok: true; value: Record<string, unknown> } | Failure {
  const value = { ...doc };
  for (const field of fields) {
    if (!own(doc, field.name)) continue;
    const result = normalize(field.type, doc[field.name], path ? `${path}.${field.name}` : field.name);
    if (!result.ok) return result;
    Object.defineProperty(value, field.name, { value: result.value, enumerable: true, writable: true, configurable: true });
  }
  return { ok: true, value };
}
export function normalizeMarkdownFields(schema: ContentfnSchema, docType: string, doc: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | Failure {
  const type = schema.documentTypes.find(candidate => candidate.name === docType);
  if (!type) return fail("_type", "document type not found");
  if (!record(doc) || !jsonValue(doc)) return fail("", "document must contain only JSON values");
  return normalizeFields(type.fields, doc, "");
}

/** Run within the caller's transaction so reference reads and the mutation share its boundary. */
export async function validateReferences(
  db: import("./database.js").ContentfnDatabase,
  schema: ContentfnSchema,
  dataset: string,
  perspective: "draft" | "published",
  docType: string,
  doc: Record<string, unknown>,
  documentId?: string,
): Promise<ContentfnEnvelope<void>> {
  const { CONTENTFN_TABLE_NAMES } = await import("./schema.js");
  async function visit(type: ContentfnFieldType, value: unknown, path: string): Promise<Check> {
    if (value == null) return { ok: true };
    if (type.kind === "reference" && record(value)) {
      const id = value._ref as string;
      let targetType: string | undefined;
      if (documentId === id || (perspective === "draft" && documentId === `drafts.${id}`)) targetType = docType;
      else {
        const tables = perspective === "draft"
          ? [CONTENTFN_TABLE_NAMES.docsDrafts, CONTENTFN_TABLE_NAMES.docsPublished]
          : [CONTENTFN_TABLE_NAMES.docsPublished];
        for (const model of tables) {
          const target = await db.findOne({ model, where: [
            { field: "dataset", operator: "eq", value: dataset },
            { field: "id", operator: "eq", value: documentStorageId(dataset, model === CONTENTFN_TABLE_NAMES.docsDrafts && !id.startsWith("drafts.") ? `drafts.${id}` : id) },
          ] });
          if (target) { targetType = target.type as string; break; }
        }
      }
      if (!targetType) return value._weak === true && type.weak === true ? { ok: true } : fail(path, "reference target does not exist");
      return type.to.includes(targetType) ? { ok: true } : fail(path, "reference target type is not allowed");
    }
    if (type.kind === "object" && record(value)) {
      for (const field of type.fields) {
        const result = await visit(field.type, value[field.name], `${path}.${field.name}`);
        if (!result.ok) return result;
      }
    }
    if (type.kind === "array" && Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const candidates = type.of.filter(candidate => validateFieldType(candidate, value[index], `${path}[${index}]`).ok);
        let failure: Failure | undefined;
        for (const candidate of candidates) {
          const result = await visit(candidate, value[index], `${path}[${index}]`);
          if (result.ok) { failure = undefined; break; }
          failure = result;
        }
        if (failure) return failure;
      }
    }
    return { ok: true };
  }
  const type = schema.documentTypes.find(candidate => candidate.name === docType);
  if (!type) return err("VALIDATION_FAILED", "Document type not found", { path: "_type" });
  for (const field of type.fields) {
    const result = await visit(field.type, doc[field.name], field.name);
    if (!result.ok) return err("VALIDATION_FAILED", result.error, { path: result.field });
  }
  return ok(undefined);
}

/** Archive snapshots lack their historical schemas. Apply only declared richtext limits,
 * without retroactively requiring current fields or coercing unknown JSON. */
export function validateImportedRichtextLimits(schema: ContentfnSchema, doc: Record<string, unknown>, maxBlocks = DEFAULT_MAX_RICHTEXT_BLOCKS): ContentfnEnvelope<void> {
  const visit = (type: ContentfnFieldType, value: unknown, path: string): Check => {
    if (value == null) return { ok: true };
    if (type.kind === 'richtext' && Array.isArray(value)) return value.length > maxBlocks ? fail(path, 'richtext exceeds maxRichtextBlocks') : { ok: true };
    if (type.kind === 'object' && record(value)) {
      for (const field of type.fields) { const checked = visit(field.type, value[field.name], `${path}.${field.name}`); if (!checked.ok) return checked; }
    }
    if (type.kind === 'array' && Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const checks = type.of.filter(candidate => sameShape(candidate, value[index])).map(candidate => visit(candidate, value[index], `${path}[${index}]`));
        if (checks.length && checks.every(check => !check.ok)) return checks[0];
      }
    }
    return { ok: true };
  };
  const type = schema.documentTypes.find(type => type.name === doc._type);
  for (const field of type?.fields ?? []) {
    const result = visit(field.type, doc[field.name], field.name);
    if (!result.ok) return err('VALIDATION_FAILED', result.error, { path: result.field });
  }
  return ok(undefined);
}
