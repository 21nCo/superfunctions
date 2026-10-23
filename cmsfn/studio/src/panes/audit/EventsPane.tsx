/**
 * Audit events pane: list event metadata (no raw doc bodies), deterministic order and pagination.
 */

import { record, useAuditPage } from "./useAuditPage.js";
import type { CmsfnAuditEvent } from "cmsfn";

export interface EventsPaneProps {
  cmsfnApiUrl: string;
  dataset: string;
  hasAuditRead?: boolean;
}

function parseEvent(value: unknown, dataset: string): CmsfnAuditEvent | null {
  if (!record(value) || value.dataset !== dataset || typeof value.eventId !== "string" || typeof value.type !== "string" || typeof value.timestamp !== "string") return null;
  if (value.targetIds !== undefined && (!Array.isArray(value.targetIds) || !value.targetIds.every(id => typeof id === "string"))) return null;
  if (value.document !== undefined && (!record(value.document) || typeof value.document._id !== "string" || typeof value.document._type !== "string")) return null;
  return { eventId: value.eventId, dataset, type: value.type, timestamp: value.timestamp,
    ...(Array.isArray(value.targetIds) ? { targetIds: value.targetIds.filter((id): id is string => typeof id === "string") } : {}),
    ...(record(value.document) && typeof value.document._id === "string" && typeof value.document._type === "string" ? { document: { _id: value.document._id, _type: value.document._type } } : {}) };
}

export function EventsPane({ cmsfnApiUrl, dataset, hasAuditRead = true }: EventsPaneProps) {
  const { rows: events, cursor: nextCursor, loading, error, denied, load } = useAuditPage(cmsfnApiUrl, dataset, hasAuditRead, "events", parseEvent);

  if (denied) {
    return (
      <div data-audit-events-pane data-audit-denied>
        <p data-audit-denied-message>No access</p>
        {hasAuditRead && <button type="button" onClick={() => void load()}>Retry</button>}
      </div>
    );
  }

  return (
    <div data-audit-events-pane data-dataset={dataset}>
      <h2 data-audit-events-title>Events</h2>
      {error && <p role="alert" data-audit-events-error>{error}</p>}
      {loading && events.length === 0 && <p data-audit-events-loading>Loading…</p>}
      <button type="button" onClick={() => void load()} disabled={loading} data-audit-events-refresh>Refresh</button>
      {error && <button type="button" onClick={() => void load(nextCursor)} disabled={loading}>Retry</button>}
      {!loading && !error && events.length === 0 && <p data-audit-empty>No audit events.</p>}
      <ul data-audit-events-list>
        {events.map((evt) => (
          <li key={evt.eventId} data-audit-event data-event-id={evt.eventId}>
            <span data-audit-event-type>{evt.type}</span>
            <span data-audit-event-time>{evt.timestamp}</span>
            {evt.document && <span data-audit-event-doc-id>{evt.document._id}</span>}
            {evt.targetIds && <span data-audit-event-targets>{evt.targetIds.join(", ")}</span>}
          </li>
        ))}
      </ul>
      {nextCursor && (
        <button type="button" onClick={() => load(nextCursor)} disabled={loading} data-audit-events-load-more>
          Load more
        </button>
      )}
    </div>
  );
}
