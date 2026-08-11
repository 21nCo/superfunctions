/**
 * Fetch ContentFn audit events (UI-safe: no raw document bodies).
 * Calls ContentFn POST /contentfn/audit/events; strips any raw doc fields.
 */

import type { CmsfnAuditEvent } from "cmsfn";

export interface AuditEventsConfig {
  contentfnBaseUrl: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** UI-safe event: document only _id, _type, _rev; no raw body. */
function toSafeEvent(raw: Record<string, unknown>): CmsfnAuditEvent {
  const document = raw.document;
  const safeDoc =
    document && typeof document === "object" && document !== null
      ? {
          _id: (document as Record<string, unknown>)._id as string,
          _type: (document as Record<string, unknown>)._type as string,
          _rev: (document as Record<string, unknown>)._rev as string | undefined,
        }
      : undefined;
  return {
    eventId: (raw.eventId as string) ?? "",
    dataset: (raw.dataset as string) ?? "",
    type: (raw.type as string) ?? "",
    timestamp: (raw.timestamp as string) ?? "",
    actor: raw.actor as { subject?: string } | undefined,
    document: safeDoc,
    diff: raw.diff as { changedPaths?: string[] } | undefined,
  };
}

/**
 * Call ContentFn POST /contentfn/audit/events with { dataset, limit?, cursor? }.
 * Returns envelope with events (UI-safe) and nextCursor.
 */
export async function contentfnAuditEvents(
  config: AuditEventsConfig,
  input: { dataset: string; limit?: number; cursor?: string | null }
): Promise<
  | { ok: true; result: { events: CmsfnAuditEvent[]; nextCursor: string | null } }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }
> {
  const base = normalizeBaseUrl(config.contentfnBaseUrl);
  const body: Record<string, unknown> = { dataset: input.dataset };
  if (input.limit != null) body.limit = input.limit;
  if (input.cursor != null) body.cursor = input.cursor;
  const res = await fetch(`${base}/contentfn/audit/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    return {
      ok: false,
      error: {
        code: (data?.error?.code ?? "INTERNAL_ERROR") as string,
        message: (data?.error?.message ?? "Request failed") as string,
        details: (data?.error?.details ?? {}) as Record<string, unknown>,
      },
    };
  }
  const events = Array.isArray(data?.result?.events)
    ? (data.result.events as Record<string, unknown>[]).map(toSafeEvent)
    : [];
  const nextCursor =
    data?.result?.nextCursor !== undefined && data?.result?.nextCursor !== null
      ? String(data.result.nextCursor)
      : null;
  return { ok: true, result: { events, nextCursor } };
}
