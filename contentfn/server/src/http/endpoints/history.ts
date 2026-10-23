import type { ContentfnEnvelope, ContentfnDocument } from "@contentfn/core";
import { err } from "@contentfn/core";
import { listHistory, restoreRevision } from "../../storage/revisions.js";
import type { RevisionsStorageConfig } from "../../storage/revisions.js";

export interface HistoryEndpointsConfig extends RevisionsStorageConfig {}

export async function handleDocsHistory(
  config: HistoryEndpointsConfig,
  body: unknown
): Promise<
  ContentfnEnvelope<{
    revisions: ContentfnDocument[];
    nextCursor: string | null;
  }>
> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.dataset !== "string" || typeof b.id !== "string") {
    return err("VALIDATION_FAILED", "Request body must include dataset and id as strings", {
      path: "dataset",
    });
  }

  return listHistory(config, {
    dataset: b.dataset,
    id: b.id,
    limit: typeof b.limit === "number" ? b.limit : undefined,
    cursor: typeof b.cursor === "string" ? b.cursor : b.cursor === null ? null : undefined,
  });
}

export async function handleDocsRestore(
  config: HistoryEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.dataset !== "string" || typeof b.id !== "string" || typeof b.rev !== "string") {
    return err(
      "VALIDATION_FAILED",
      "Request body must include dataset, id, and rev as strings",
      {
        path: "dataset",
      }
    );
  }

  return restoreRevision(config, {
    dataset: b.dataset,
    id: b.id,
    rev: b.rev,
  });
}
