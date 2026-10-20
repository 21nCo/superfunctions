import type { WhereClause } from "@superfunctions/db";

export const EVENT_PROJECTION_VERSION = 1;
export const EVENT_INDEX_FIELDS = {
  type: "eventType", "app.name": "eventApp", "report.severity": "eventSeverity",
  "integration.issueId": "eventIssueId", sessionId: "eventSessionId", replayId: "eventReplayId",
} as const;

// Match QueryEngine's own-property precedence, including explicit null/undefined.
function field(event: any, path: string): unknown {
  const parts = path.split(".");
  let value = event != null && Object.prototype.hasOwnProperty.call(event, parts[0]) ? event : event?.properties;
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

/** Projections and the payload must always be written in the same database operation. */
export function projectEvent(payload: any): Record<string, string | number | null> {
  const result: Record<string, string | number | null> = { projectionVersion: EVENT_PROJECTION_VERSION };
  for (const [path, column] of Object.entries(EVENT_INDEX_FIELDS)) {
    const value = field(payload, path);
    // Preserve unusually long legacy values in JSON rather than overflowing
    // portable VARCHAR indexes. Version 0 deliberately retains scan fallback.
    if (typeof value === "string" && value.length > 255) {
      result.projectionVersion = 0;
      result[column] = null;
    } else result[column] = typeof value === "string" ? value : null;
  }
  const raw = payload?.timestamp === undefined ? payload?.ts : payload.timestamp;
  const timestamp = typeof raw === "number" ? raw : raw instanceof Date ? raw.getTime() : typeof raw === "string" && raw.trim() ? Date.parse(raw) : NaN;
  result.eventTimestamp = Number.isFinite(timestamp) ? timestamp : null;
  return result;
}

/** Only exact string predicates and already-resolved epoch bounds are pushed down. */
export function eventProjectionWhere(options: any): WhereClause[] {
  const where: WhereClause[] = [];
  for (const [path, column] of Object.entries(EVENT_INDEX_FIELDS)) {
    const filter = options?.where?.[path];
    const value = filter && typeof filter === "object" && !Array.isArray(filter) ? filter.eq : filter;
    if (typeof value === "string") where.push({ field: column, operator: "eq", value });
  }
  const range = options?.resolvedTimeRange;
  if (range && typeof range.from === "number" && typeof range.to === "number" && range.from <= range.to) {
    if (Number.isFinite(range.from)) where.push({ field: "eventTimestamp", operator: "gte", value: range.from });
    if (Number.isFinite(range.to)) where.push({ field: "eventTimestamp", operator: "lte", value: range.to });
  }
  return where;
}
