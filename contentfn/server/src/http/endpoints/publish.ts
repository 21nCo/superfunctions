import type { ContentfnEnvelope, ContentfnDocument } from "@contentfn/core";
import { err } from "@contentfn/core";
import { docPublish, docUnpublish } from "../../storage/publish.js";
import type { PublishStorageConfig } from "../../storage/publish.js";

export interface PublishEndpointsConfig extends PublishStorageConfig {}

export async function handleDocsPublish(
  config: PublishEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.dataset !== "string" || typeof b.id !== "string") {
    return err("VALIDATION_FAILED", "Request body must include dataset and id as strings", {
      path: "dataset",
    });
  }

  return docPublish(config, {
    dataset: b.dataset,
    id: b.id,
    ifRev: typeof b.ifRev === "string" ? b.ifRev : undefined,
  });
}

export async function handleDocsUnpublish(
  config: PublishEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<Record<string, never>>> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.dataset !== "string" || typeof b.id !== "string") {
    return err("VALIDATION_FAILED", "Request body must include dataset and id as strings", {
      path: "dataset",
    });
  }

  return docUnpublish(config, {
    dataset: b.dataset,
    id: b.id,
    ifRev: typeof b.ifRev === "string" ? b.ifRev : undefined,
  });
}
