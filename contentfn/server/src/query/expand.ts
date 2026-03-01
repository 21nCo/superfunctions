import type { Adapter } from "@superfunctions/db";
import type {
  ContentfnDocument,
  ContentfnEnvelope,
  CfqlProjection,
} from "@contentfn/core";
import { err, ok, DEFAULT_MAX_EXPAND_DEPTH } from "@contentfn/core";
import { CONTENTFN_TABLE_NAMES } from "../storage/schema.js";

export interface ExpandConfig {
  db: Adapter;
  dataset: string;
  maxExpandDepth?: number;
}

interface ReferenceObject {
  _type: "reference";
  _ref: string;
  _weak?: boolean;
}

function isReferenceObject(value: unknown): value is ReferenceObject {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return ref._type === "reference" && typeof ref._ref === "string";
}

async function fetchDocument(
  db: Adapter,
  dataset: string,
  docId: string
): Promise<ContentfnDocument | null> {
  const rows = await db.findMany({
    model: CONTENTFN_TABLE_NAMES.docsPublished,
    where: [
      { field: "dataset", operator: "eq" as const, value: dataset },
      { field: "id", operator: "eq" as const, value: docId },
    ],
  });

  if (rows.length === 0) {
    return null;
  }

  return (rows[0] as { docJson: ContentfnDocument }).docJson;
}

function applyProjectionToDoc(
  doc: ContentfnDocument,
  projection: CfqlProjection | undefined
): ContentfnDocument {
  if (!projection || !projection.fields) {
    return doc;
  }

  const projected: Record<string, unknown> = {};
  const systemFields = ["_id", "_type", "_rev", "_createdAt", "_updatedAt", "_publishedAt"];

  for (const field of projection.fields) {
    if (field in doc) {
      projected[field] = doc[field];
    }
  }

  for (const sysField of systemFields) {
    if (sysField in doc && !(sysField in projected)) {
      projected[sysField] = doc[sysField];
    }
  }

  return projected as ContentfnDocument;
}

async function expandField(
  config: ExpandConfig,
  value: unknown,
  projection: CfqlProjection | undefined,
  visited: Set<string>,
  currentDepth: number
): Promise<ContentfnEnvelope<unknown>> {
  const maxDepth = config.maxExpandDepth ?? DEFAULT_MAX_EXPAND_DEPTH;

  if (currentDepth >= maxDepth) {
    return err("QUERY_TOO_COMPLEX", `Expansion depth exceeds maximum of ${maxDepth}`, {});
  }

  if (Array.isArray(value)) {
    const expanded: unknown[] = [];
    for (const item of value) {
      if (isReferenceObject(item)) {
        const expandResult = await expandReference(
          config,
          item,
          projection,
          visited,
          currentDepth
        );
        if (!expandResult.ok) {
          return expandResult;
        }
        expanded.push(expandResult.result);
      } else {
        expanded.push(item);
      }
    }
    return ok(expanded);
  }

  if (isReferenceObject(value)) {
    return expandReference(config, value, projection, visited, currentDepth);
  }

  return ok(value);
}

async function expandReference(
  config: ExpandConfig,
  ref: ReferenceObject,
  projection: CfqlProjection | undefined,
  visited: Set<string>,
  currentDepth: number
): Promise<ContentfnEnvelope<unknown>> {
  if (visited.has(ref._ref)) {
    return ok(ref);
  }

  visited.add(ref._ref);

  const referencedDoc = await fetchDocument(config.db, config.dataset, ref._ref);
  
  if (!referencedDoc) {
    return ok(ref);
  }

  const projectedDoc = applyProjectionToDoc(referencedDoc, projection);

  if (projection?.expand) {
    for (const [expandKey, expandSpec] of Object.entries(projection.expand)) {
      const fieldValue = projectedDoc[expandSpec.field];
      if (fieldValue !== undefined) {
        const expandResult = await expandField(
          config,
          fieldValue,
          expandSpec.projection,
          new Set(visited),
          currentDepth + 1
        );
        if (!expandResult.ok) {
          return expandResult;
        }
        projectedDoc[expandKey] = expandResult.result;
      }
    }
  }

  return ok(projectedDoc);
}

export async function expandDocument(
  config: ExpandConfig,
  doc: ContentfnDocument,
  projection: CfqlProjection | undefined
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  if (!projection?.expand) {
    return ok(doc);
  }

  const expandedDoc = { ...doc };
  
  for (const [expandKey, expandSpec] of Object.entries(projection.expand)) {
    const fieldValue = doc[expandSpec.field];
    
    if (fieldValue !== undefined) {
      const visited = new Set<string>();
      const expandResult = await expandField(
        config,
        fieldValue,
        expandSpec.projection,
        visited,
        1
      );
      
      if (!expandResult.ok) {
        return expandResult as ContentfnEnvelope<ContentfnDocument>;
      }
      
      expandedDoc[expandKey] = expandResult.result;
    }
  }

  return ok(expandedDoc);
}
