/** Project the supported ContentFn audit/query contract without inventing document metadata. */
import { err, type CmsfnEnvelope, type CmsfnAuditEvent } from "cmsfn";
import { contentfnRequest, isRecord } from "../contentfn/response.js";
export interface AuditEventsConfig { contentfnBaseUrl: string; headers?: NonNullable<RequestInit["headers"]> }
export const AUDIT_RESPONSE_MAX_BYTES = 1024 * 1024;
export const AUDIT_TIMEOUT_MS = 10_000;
export const AUDIT_MAX_LIMIT = 1000;
export const AUDIT_MAX_OFFSET = Number.MAX_SAFE_INTEGER - 1001;

/** Audit errors are metadata-only too: upstream messages/details may echo private content. */
export function safeAuditResponse<T>(response: CmsfnEnvelope<T>): CmsfnEnvelope<T> {
  if (response.ok) return response;
  const { upstreamCode, upstreamStatus } = response.error.details;
  return err(response.error.code, "ContentFn audit request failed", {
    ...(typeof upstreamCode === "string" ? { upstreamCode } : {}),
    ...(typeof upstreamStatus === "number" ? { upstreamStatus } : {}),
  });
}

export function auditOffset(dataset: string, cursor?: string | null): number | null {
  if (cursor === undefined || cursor === null) return 0;
  if (typeof cursor !== "string" || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!isRecord(value) || value.v !== 1 || value.order !== "desc" || value.dataset !== dataset || !Number.isSafeInteger(value.offset) || typeof value.offset !== "number" || value.offset < 0 || value.offset > AUDIT_MAX_OFFSET) return null;
    return value.offset;
  } catch { return null; }
}
function cursorFor(dataset: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, dataset, order: "desc", offset })).toString("base64url");
}
function toSafeEvent(value: unknown, dataset: string): CmsfnAuditEvent | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || value.dataset !== dataset ||
    typeof value.action !== "string" || !value.action || typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp)) ||
    !Array.isArray(value.targetIds) || !value.targetIds.every((id): id is string => typeof id === "string")) return null;
  const event: CmsfnAuditEvent = { eventId: value.id, dataset, type: value.action, timestamp: value.timestamp, targetIds: [...value.targetIds] };
  if (value.actor !== null) {
    if (!isRecord(value.actor) || typeof value.actor.subject !== "string") return null;
    event.actor = { subject: value.actor.subject };
  }
  return event;
}
export function contentfnAuditEvents(config: AuditEventsConfig, input: { dataset: string; limit?: number; cursor?: string | null }) {
  const offset = auditOffset(input.dataset, input.cursor), limit = input.limit ?? 100;
  if (offset === null || !Number.isSafeInteger(limit) || limit < 1 || limit > AUDIT_MAX_LIMIT) return Promise.resolve(err("VALIDATION_FAILED", "Invalid audit pagination"));
  return contentfnRequest(config.contentfnBaseUrl, "/contentfn/audit/query", { dataset: input.dataset, limit, offset, order: "desc" }, value => {
    if (!isRecord(value) || !Array.isArray(value.records) || value.records.length > limit ||
      (value.nextOffset !== null && (!Number.isSafeInteger(value.nextOffset) || value.nextOffset !== offset + limit || value.records.length !== limit || value.nextOffset > AUDIT_MAX_OFFSET))) return null;
    const events: CmsfnAuditEvent[] = [];
    for (const raw of value.records) {
      const event = toSafeEvent(raw, input.dataset);
      if (!event) return null;
      events.push(event);
    }
    return { events, nextCursor: value.nextOffset === null ? null : cursorFor(input.dataset, value.nextOffset as number) };
  }, { headers: config.headers, maxResponseBytes: AUDIT_RESPONSE_MAX_BYTES, timeoutMs: AUDIT_TIMEOUT_MS, redirect: "error" }).then(safeAuditResponse);
}
