/** Validate and project audit metadata; never return arbitrary document/actor/diff fields. */
import type { CmsfnAuditEvent } from "cmsfn";
import { contentfnRequest, isRecord } from "../contentfn/response.js";
export interface AuditEventsConfig { contentfnBaseUrl: string }

function toSafeEvent(value: unknown): CmsfnAuditEvent | null {
  if (!isRecord(value) || typeof value.eventId !== "string" || typeof value.dataset !== "string" ||
    typeof value.type !== "string" || typeof value.timestamp !== "string") return null;
  const event: CmsfnAuditEvent = { eventId: value.eventId, dataset: value.dataset, type: value.type, timestamp: value.timestamp };
  if (value.document !== undefined) {
    const doc = value.document;
    if (!isRecord(doc) || typeof doc._id !== "string" || typeof doc._type !== "string" ||
      (doc._rev !== undefined && typeof doc._rev !== "string")) return null;
    event.document = { _id: doc._id, _type: doc._type, ...(doc._rev === undefined ? {} : { _rev: doc._rev }) };
  }
  if (value.actor !== undefined) {
    if (!isRecord(value.actor) || (value.actor.subject !== undefined && typeof value.actor.subject !== "string")) return null;
    event.actor = value.actor.subject === undefined ? {} : { subject: value.actor.subject };
  }
  if (value.diff !== undefined) {
    if (!isRecord(value.diff)) return null;
    const paths = value.diff.changedPaths;
    if (paths !== undefined && (!Array.isArray(paths) || !paths.every((p): p is string => typeof p === "string"))) return null;
    event.diff = paths === undefined ? {} : { changedPaths: [...paths] };
  }
  return event;
}
export function contentfnAuditEvents(config: AuditEventsConfig, input: { dataset: string; limit?: number; cursor?: string | null }) {
  return contentfnRequest(config.contentfnBaseUrl, "/contentfn/audit/events", { ...input }, value => {
    if (!isRecord(value) || !Array.isArray(value.events) ||
      (value.nextCursor !== null && typeof value.nextCursor !== "string")) return null;
    const events: CmsfnAuditEvent[] = [];
    for (const raw of value.events) {
      const event = toSafeEvent(raw);
      if (!event || event.dataset !== input.dataset) return null;
      events.push(event);
    }
    return { events, nextCursor: value.nextCursor };
  });
}
