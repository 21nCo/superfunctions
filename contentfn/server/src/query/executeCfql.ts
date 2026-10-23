import type { ContentfnDatabase as Adapter } from "../storage/database.js";
import type {
  CfqlQuery,
  CfqlResultPage,
  ContentfnEnvelope,
  ContentfnDocument,
  CfqlFilter,
  CfqlOrderBy,
  CfqlProjection,
} from "@contentfn/core";
import { validateCfql, err, ok, DEFAULT_MAX_QUERY_LIMIT } from "@contentfn/core";
import { datasetExists } from "../storage/datasets.js";
import { CONTENTFN_TABLE_NAMES } from "../storage/schema.js";
import { normalizeOrderBy } from "./order.js";
import { encodeCursor, decodeCursor } from "./cursor.js";
import { expandDocument } from "./expand.js";

export interface ExecuteCfqlConfig {
  db: Adapter;
  maxQueryLimit?: number;
  maxExpandDepth?: number;
  maxFilterDepth?: number;
  /** Enable deterministic case-insensitive Unicode token matching. */
  search?: { enabled: boolean };
}

function matchesFilter(doc: ContentfnDocument, filter: CfqlFilter | undefined): boolean {
  if (!filter) return true;

  if ("op" in filter && (filter.op === "and" || filter.op === "or")) {
    if (filter.op === "and") {
      return filter.filters.every((f) => matchesFilter(doc, f));
    }
    return filter.filters.some((f) => matchesFilter(doc, f));
  }

  const { field, op, value } = filter;
  const docValue = getFieldValue(doc, field);

  switch (op) {
    case "eq":
      return docValue === value;
    case "ne":
      return docValue !== value;
    case "gt":
      return typeof docValue === "number" && typeof value === "number" && docValue > value;
    case "gte":
      return typeof docValue === "number" && typeof value === "number" && docValue >= value;
    case "lt":
      return typeof docValue === "number" && typeof value === "number" && docValue < value;
    case "lte":
      return typeof docValue === "number" && typeof value === "number" && docValue <= value;
    case "in":
      return Array.isArray(value) && value.includes(docValue);
    case "not_in":
      return Array.isArray(value) && !value.includes(docValue);
    case "contains":
      return typeof docValue === "string" && typeof value === "string" && docValue.includes(value);
    case "starts_with":
      return typeof docValue === "string" && typeof value === "string" && docValue.startsWith(value);
    case "ends_with":
      return typeof docValue === "string" && typeof value === "string" && docValue.endsWith(value);
    case "is_null":
      return docValue === null || docValue === undefined;
    case "is_not_null":
      return docValue !== null && docValue !== undefined;
    case "match":
      return typeof docValue === "string" && typeof value === "string" &&
        value.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean).every(
          (token) => docValue.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}_]+/u).includes(token)
        );
    default:
      return false;
  }
}

function getFieldValue(doc: Record<string, unknown>, field: string): unknown {
  const parts = field.split(".");
  let current: unknown = doc;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compareValues(a: unknown, b: unknown, direction: "asc" | "desc"): number {
  const mult = direction === "asc" ? 1 : -1;

  if (a === b) return 0;
  if (a === null || a === undefined) return mult;
  if (b === null || b === undefined) return -mult;

  if (typeof a === "string" && typeof b === "string") {
    return mult * (a < b ? -1 : 1);
  }
  if (typeof a === "number" && typeof b === "number") {
    return mult * (a - b);
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return mult * (a === b ? 0 : a ? 1 : -1);
  }

  const aStr = String(a);
  const bStr = String(b);
  return mult * (aStr < bStr ? -1 : aStr > bStr ? 1 : 0);
}

function sortDocuments(docs: ContentfnDocument[], orderBy: CfqlOrderBy[]): ContentfnDocument[] {
  return docs.slice().sort((a, b) => {
    for (const order of orderBy) {
      const aVal = getFieldValue(a, order.field);
      const bVal = getFieldValue(b, order.field);
      const cmp = compareValues(aVal, bVal, order.direction);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

function extractOrderingValues(doc: ContentfnDocument, orderBy: CfqlOrderBy[]): unknown[] {
  return orderBy.map((o) => getFieldValue(doc, o.field));
}

function shouldSkipBasedOnCursor(
  doc: ContentfnDocument,
  orderBy: CfqlOrderBy[],
  cursorValues: unknown[]
): boolean {
  const docValues = extractOrderingValues(doc, orderBy);

  for (let i = 0; i < orderBy.length; i++) {
    const cmp = compareValues(docValues[i], cursorValues[i], orderBy[i].direction);
    if (cmp < 0) return true;
    if (cmp > 0) return false;
  }

  return true;
}

export async function executeCfql(
  config: ExecuteCfqlConfig,
  query: CfqlQuery
): Promise<ContentfnEnvelope<CfqlResultPage>> {
  const validation = validateCfql(query, { maxFilterDepth: config.maxFilterDepth, maxExpandDepth: config.maxExpandDepth });
  if (!validation.ok) {
    return validation as ContentfnEnvelope<CfqlResultPage>;
  }

  function checkMatch(filter: CfqlFilter | undefined): ContentfnEnvelope<void> | null {
    if (!filter) return null;
    if (filter.op === "and" || filter.op === "or") {
      for (const child of filter.filters) { const failure = checkMatch(child); if (failure) return failure; }
    } else if (filter.op === "match") {
      if (!config.search?.enabled) return err("QUERY_INVALID", "Text search is disabled; configure search.enabled", { path: "filter.op" });
      if (typeof filter.value !== "string" || !/[\p{L}\p{N}_]/u.test(filter.value)) return err("QUERY_INVALID", "match requires a non-empty text query", { path: "filter.value" });
    }
    return null;
  }
  const matchFailure = checkMatch(query.filter);
  if (matchFailure) return matchFailure as ContentfnEnvelope<CfqlResultPage>;
  if (query.limit !== undefined && query.limit > (config.maxQueryLimit ?? DEFAULT_MAX_QUERY_LIMIT)) {
    return err("QUERY_TOO_COMPLEX", "Query limit exceeds configured maximum", { path: "limit" });
  }
  const exists = await datasetExists({ db: config.db }, query.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: query.dataset });
  }

  const limit = Math.min(query.limit ?? DEFAULT_MAX_QUERY_LIMIT, config.maxQueryLimit ?? DEFAULT_MAX_QUERY_LIMIT);

  const rows = await config.db.findMany({
    model: CONTENTFN_TABLE_NAMES.docsPublished,
    where: [{ field: "dataset", operator: "eq" as const, value: query.dataset }],
  });

  let docs = rows.map((r: { docJson: ContentfnDocument }) => r.docJson);

  if (query.types && query.types.length > 0) {
    docs = docs.filter((doc) => query.types!.includes(doc._type));
  }

  docs = docs.filter((doc) => matchesFilter(doc, query.filter));

  const normalizedOrderBy = normalizeOrderBy(query.orderBy);
  docs = sortDocuments(docs, normalizedOrderBy);

  let cursorValues: unknown[] | null = null;
  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    if (!decoded || decoded.values.length !== normalizedOrderBy.length) {
      return err("QUERY_INVALID", "Invalid cursor", { path: "cursor" });
    }
    cursorValues = decoded.values;
    docs = docs.filter((doc) => !shouldSkipBasedOnCursor(doc, normalizedOrderBy, cursorValues!));
  }

  const hasMore = docs.length > limit;
  const resultDocs = docs.slice(0, limit);

  const expandedDocs: ContentfnDocument[] = [];
  for (const doc of resultDocs) {
    const expandResult = await expandDocument(
      {
        db: config.db,
        dataset: query.dataset,
        maxExpandDepth: config.maxExpandDepth,
      },
      doc,
      query.projection
    );

    if (!expandResult.ok) {
      return expandResult as ContentfnEnvelope<CfqlResultPage>;
    }

    expandedDocs.push(expandResult.result);
  }

  const nextCursor = hasMore
    ? encodeCursor({ values: extractOrderingValues(resultDocs[resultDocs.length - 1], normalizedOrderBy) })
    : null;

  return ok({
    data: expandedDocs,
    nextCursor,
  });
}
