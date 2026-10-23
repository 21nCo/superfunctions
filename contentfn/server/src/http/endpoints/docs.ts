/**
 * HTTP handlers for document create/get/delete.
 */

import type { ContentfnEnvelope, ContentfnDocument } from "@contentfn/core";
import { err, validatePatch } from "@contentfn/core";
import { docCreate, docGet, docDelete, docPatch } from "../../storage/docs.js";
import type { DocsStorageConfig } from "../../storage/docs.js";

export interface DocsEndpointsConfig extends DocsStorageConfig {}

export async function handleDocsCreate(
  config: DocsEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.dataset !== "string" || typeof b.type !== "string") {
    return err("VALIDATION_FAILED", "Request body must include dataset and type as strings", { path: "dataset" });
  }
  if (typeof b.doc !== "object" || b.doc === null) {
    return err("VALIDATION_FAILED", "Request body must include doc as an object", { path: "doc" });
  }

  return docCreate(config, {
    dataset: b.dataset,
    id: typeof b.id === "string" ? b.id : undefined,
    type: b.type,
    doc: b.doc as Record<string, unknown>,
    asDraft: typeof b.asDraft === "boolean" ? b.asDraft : undefined,
  });
}

export async function handleDocsGet(
  config: DocsEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.dataset !== "string" || typeof b.id !== "string") {
    return err("VALIDATION_FAILED", "Request body must include dataset and id as strings", { path: "dataset" });
  }

  const perspective =
    typeof b.perspective === "string" && (b.perspective === "published" || b.perspective === "draft" || b.perspective === "raw")
      ? (b.perspective as "published" | "draft" | "raw")
      : undefined;

  return docGet(config, {
    dataset: b.dataset,
    id: b.id,
    perspective,
  });
}

export async function handleDocsDelete(
  config: DocsEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<Record<string, never>>> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.dataset !== "string" || typeof b.id !== "string") {
    return err("VALIDATION_FAILED", "Request body must include dataset and id as strings", { path: "dataset" });
  }

  return docDelete(config, {
    dataset: b.dataset,
    id: b.id,
    purge: typeof b.purge === "boolean" ? b.purge : undefined,
  });
}

export async function handleDocsPatch(
  config: DocsEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  // Validate patch input using core validator
  const patchInput = validatePatch(body);
  if (!patchInput.ok) {
    return patchInput as ContentfnEnvelope<ContentfnDocument>;
  }

  return docPatch(config, patchInput.result);
}
