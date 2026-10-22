/**
 * Publish a release: for each doc (sorted), check permission + workflow gate, call ContentFn publish.
 * Returns deterministic summary: published[], failures[].
 */

import type { IncomingMessage } from "http";
import { ok } from "cmsfn";
import { CMS_RESERVED_FIELD } from "cmsfn";
import type { CmsfnWorkflowMetadata, CmsfnReleasePublishResult, CmsfnEnvelope } from "cmsfn";
import { authorize } from "../auth/authorize.js";
import type { AuthorizeConfig } from "../auth/authorize.js";
import { canPublish } from "../publish/gates.js";
import { getDraftDoc, contentfnPublish } from "../publish/contentfnClient.js";
import { getRelease } from "../storage/releases.js";
import type { ReleasesStorageConfig } from "../storage/releases.js";

export interface PublishReleaseConfig extends AuthorizeConfig {
  contentfnBaseUrl: string;
  releasesStorage: ReleasesStorageConfig;
}

function getWorkflowState(doc: Record<string, unknown>): string | undefined {
  const cms = doc[CMS_RESERVED_FIELD] as CmsfnWorkflowMetadata | undefined;
  return cms?.state;
}

/**
 * Publish all docs in a release. Doc order: sorted docIds (deterministic).
 * For each doc: check doc.publish for doc's _type, workflow gate, then ContentFn publish.
 * Returns { releaseId, published, failures }.
 */
export async function publishRelease(
  config: PublishReleaseConfig,
  req: IncomingMessage,
  input: { dataset: string; releaseId: string }
): Promise<CmsfnEnvelope<CmsfnReleasePublishResult>> {
  const dataset = typeof input.dataset === "string" ? input.dataset.trim() : "";
  const releaseId = typeof input.releaseId === "string" ? input.releaseId.trim() : "";
  if (!dataset) return { ok: false, error: { code: "VALIDATION_FAILED", message: "dataset is required", details: { path: "dataset" } } };
  if (!releaseId) return { ok: false, error: { code: "VALIDATION_FAILED", message: "releaseId is required", details: { path: "releaseId" } } };

  const release = await getRelease(config.releasesStorage, { dataset, releaseId });
  if (!release) return { ok: false, error: { code: "NOT_FOUND", message: "Release not found", details: { releaseId } } };

  const docIds = [...release.docIds].sort();
  const published: string[] = [];
  const failures: Array<{ docId: string; code: string; message: string }> = [];

  const contentfn = { baseUrl: config.contentfnBaseUrl };

  for (const docId of docIds) {
    const draftRes = await getDraftDoc(contentfn, dataset, docId);
    if (!draftRes.ok) {
      failures.push({
        docId,
        code: draftRes.error.code,
        message: draftRes.error.message,
      });
      continue;
    }
    const draftDoc = draftRes.result as Record<string, unknown>;
    const docType = (draftDoc._type as string) ?? "*";
    const state = getWorkflowState(draftDoc);

    const hasDocPublish = await authorize(config, req, {
      dataset,
      type: docType,
      action: "doc.publish",
    });
    if (!hasDocPublish) {
      failures.push({ docId, code: "PERMISSION_DENIED", message: "Permission denied" });
      continue;
    }
    if (!canPublish(state as "draft" | "in_review" | "approved" | "published", true)) {
      failures.push({
        docId,
        code: "PERMISSION_DENIED",
        message: "Workflow state does not allow publish",
      });
      continue;
    }

    const pubRes = await contentfnPublish(contentfn, dataset, docId);
    if (pubRes.ok) {
      published.push(docId);
    } else {
      failures.push({
        docId,
        code: pubRes.error.code,
        message: pubRes.error.message,
      });
    }
  }

  return ok({
    releaseId,
    published,
    failures,
  });
}
