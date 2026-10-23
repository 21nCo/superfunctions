import { appendAudit } from "./audit.js";
import type { ContentfnEnvelope } from "@contentfn/core";
import { err, ok } from "@contentfn/core";
import type { ContentfnDatabase } from "./database.js";
import { atomicMutation } from "./database.js";
import { docGet } from "./docs.js";
import { docPublish } from "./publish.js";
import { documentStorageId } from "./documentIdentity.js";

export const SCHEDULES_TABLE = "contentfn_schedules";
export async function schedulePublish(config: { db: ContentfnDatabase }, input: unknown): Promise<ContentfnEnvelope<{ scheduleId: string; publishAt: string }>> {
  if ("transaction" in config.db) return atomicMutation(config.db, db => schedulePublish({ db }, input));
  const value = input as Record<string, unknown> | null;
  if (!value || typeof value.dataset !== "string" || typeof value.id !== "string" || typeof value.publishAt !== "string" || !Number.isFinite(Date.parse(value.publishAt))) return err("VALIDATION_FAILED", "dataset, id and a valid publishAt timestamp are required", {});
  if (value.ifRev !== undefined && typeof value.ifRev !== "string") return err("VALIDATION_FAILED", "ifRev must be a string", { path: "ifRev" });
  const draftId = value.id.startsWith("drafts.") ? value.id : `drafts.${value.id}`;
  const draft = await docGet(config, { dataset: value.dataset, id: draftId, perspective: "draft" });
  if (!draft.ok) return draft;
  if (value.ifRev !== undefined && value.ifRev !== draft.result._rev) return err("REV_CONFLICT", "Draft changed before scheduling", { expectedRev: value.ifRev, actualRev: draft.result._rev });
  const id = documentStorageId(value.dataset, draftId);
  const publishAt = new Date(value.publishAt).toISOString();
  const data = { id, dataset: value.dataset, documentId: draftId, publishAt, ifRev: draft.result._rev, status: "pending", lastError: null };
  const existing = await config.db.findOne({ model: SCHEDULES_TABLE, where: [{ field: "id", operator: "eq", value: id }] });
  if (existing) await config.db.updateMany({ model: SCHEDULES_TABLE, where: [{ field: "id", operator: "eq", value: id }], data });
  else await config.db.create({ model: SCHEDULES_TABLE, data });
  return ok({ scheduleId: id, publishAt });
}
export async function cancelScheduledPublish(config: { db: ContentfnDatabase }, input: unknown): Promise<ContentfnEnvelope<Record<string, never>>> {
  const value = input as Record<string, unknown> | null;
  if (!value || typeof value.dataset !== "string" || typeof value.id !== "string") return err("VALIDATION_FAILED", "dataset and id are required", {});
  const draftId = value.id.startsWith("drafts.") ? value.id : `drafts.${value.id}`;
  await config.db.deleteMany({ model: SCHEDULES_TABLE, where: [{ field: "id", operator: "eq", value: documentStorageId(value.dataset, draftId) }] });
  return ok({});
}
/** Invoke periodically from the deployment scheduler; persisted schedules survive process restarts. */
export async function processScheduledPublishes(config: { db: ContentfnDatabase; onPublished?: (dataset: string, document: Record<string, unknown>) => void | Promise<void> }): Promise<{ published: number; failed: number }> {
  const rows = await config.db.findMany({ model: SCHEDULES_TABLE, where: [{ field: "status", operator: "eq", value: "pending" }] });
  let published = 0, failed = 0;
  for (const candidate of rows) {
    if (Date.parse(String(candidate.publishAt)) > Date.now()) continue;
    if (!("transaction" in config.db)) throw new Error("Scheduled worker requires the root database adapter");
    const result = await atomicMutation(config.db, async db => {
      const row = await db.findOne({ model: SCHEDULES_TABLE, where: [{ field: "id", operator: "eq", value: candidate.id }, { field: "status", operator: "eq", value: "pending" }] });
      if (!row || Date.parse(String(row.publishAt)) > Date.now()) return ok(null);
      const claim = await db.updateMany({ model: SCHEDULES_TABLE, where: [{ field: "id", operator: "eq", value: row.id }, { field: "status", operator: "eq", value: "pending" }], data: { status: "processing" } });
      if (claim !== 1) return ok(null);
      const publication = await docPublish({ db }, { dataset: String(row.dataset), id: String(row.documentId), ifRev: String(row.ifRev) });
      if (!publication.ok) return publication;
      await appendAudit(db, "docs.publish", { dataset: row.dataset, id: row.documentId }, publication.result, "system:scheduler");
      await db.deleteMany({ model: SCHEDULES_TABLE, where: [{ field: "id", operator: "eq", value: row.id }] });
      return ok({ dataset: String(row.dataset), document: publication.result });
    });
    if (result.ok) { if (result.result) { published++; try { await config.onPublished?.(result.result.dataset, result.result.document); } catch { /* Publication is already committed. */ } } }
    else {
      failed++;
      await config.db.updateMany({ model: SCHEDULES_TABLE, where: [{ field: "id", operator: "eq", value: candidate.id }, { field: "ifRev", operator: "eq", value: candidate.ifRev }, { field: "publishAt", operator: "eq", value: candidate.publishAt }, { field: "status", operator: "eq", value: "pending" }], data: { status: "failed", lastError: result.error.code } });
    }
  }
  return { published, failed };
}
