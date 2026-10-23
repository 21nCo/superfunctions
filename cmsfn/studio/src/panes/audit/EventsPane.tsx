/**
 * Audit events pane: list event metadata (no raw doc bodies), deterministic order and pagination.
 */

import { useState, useCallback, useEffect } from "react";
import type { CmsfnAuditEvent } from "cmsfn";

export interface EventsPaneProps {
  cmsfnApiUrl: string;
  dataset: string;
  hasAuditRead?: boolean;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

const DEFAULT_LIMIT = 20;

export function EventsPane({ cmsfnApiUrl, dataset, hasAuditRead = true }: EventsPaneProps) {
  const [events, setEvents] = useState<CmsfnAuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string | null) => {
      if (!dataset || !hasAuditRead) return;
      setLoading(true);
      setError(null);
      const base = normalizeBaseUrl(cmsfnApiUrl);
      const body: Record<string, unknown> = { dataset, limit: DEFAULT_LIMIT };
      if (cursor != null) body.cursor = cursor;
      const res = await fetch(`${base}/cmsfn/audit/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setLoading(false);
      if (data.ok && data.result) {
        if (cursor) {
          setEvents((prev) => [...prev, ...(data.result.events ?? [])]);
        } else {
          setEvents(data.result.events ?? []);
        }
        setNextCursor(data.result.nextCursor ?? null);
      } else {
        setError(data?.error?.message ?? "Failed to load events");
        if (!cursor) setEvents([]);
      }
    },
    [cmsfnApiUrl, dataset, hasAuditRead]
  );

  useEffect(() => {
    load();
  }, [load]);

  if (!hasAuditRead) {
    return (
      <div data-audit-events-pane data-audit-denied>
        <p data-audit-denied-message>No access</p>
      </div>
    );
  }

  return (
    <div data-audit-events-pane data-dataset={dataset}>
      <h2 data-audit-events-title>Events</h2>
      {error && <p data-audit-events-error>{error}</p>}
      {loading && events.length === 0 && <p data-audit-events-loading>Loading…</p>}
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
