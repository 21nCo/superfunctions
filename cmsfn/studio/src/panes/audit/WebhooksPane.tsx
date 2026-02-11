/**
 * Webhook deliveries pane: list delivery attempts (webhookId, status, attempt, timestamps), deterministic order.
 */

import { useState, useCallback, useEffect } from "react";
import type { CmsfnWebhookDeliveryStatus } from "@cmsfn/core";

export interface WebhooksPaneProps {
  cmsfnApiUrl: string;
  dataset: string;
  /** When false, show deterministic "no access" state. */
  hasAuditRead?: boolean;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

const DEFAULT_LIMIT = 20;

export function WebhooksPane({ cmsfnApiUrl, dataset, hasAuditRead = true }: WebhooksPaneProps) {
  const [deliveries, setDeliveries] = useState<CmsfnWebhookDeliveryStatus[]>([]);
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
      const res = await fetch(`${base}/cmsfn/audit/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setLoading(false);
      if (data.ok && data.result) {
        if (cursor) {
          setDeliveries((prev) => [...prev, ...(data.result.deliveries ?? [])]);
        } else {
          setDeliveries(data.result.deliveries ?? []);
        }
        setNextCursor(data.result.nextCursor ?? null);
      } else {
        setError(data?.error?.message ?? "Failed to load deliveries");
        if (!cursor) setDeliveries([]);
      }
    },
    [cmsfnApiUrl, dataset, hasAuditRead]
  );

  useEffect(() => {
    load();
  }, [load]);

  if (!hasAuditRead) {
    return (
      <div data-audit-webhooks-pane data-audit-denied>
        <p data-audit-denied-message>No access</p>
      </div>
    );
  }

  return (
    <div data-audit-webhooks-pane data-dataset={dataset}>
      <h2 data-audit-webhooks-title>Webhook deliveries</h2>
      {error && <p data-audit-webhooks-error>{error}</p>}
      {loading && deliveries.length === 0 && <p data-audit-webhooks-loading>Loading…</p>}
      <ul data-audit-webhooks-list>
        {deliveries.map((d, i) => (
          <li key={`${d.webhookId}-${d.eventId}-${i}`} data-audit-delivery data-webhook-id={d.webhookId}>
            <span data-audit-delivery-status>{d.status}</span>
            <span data-audit-delivery-attempt>{d.attempt}</span>
            <span data-audit-delivery-updated>{d.updatedAt}</span>
          </li>
        ))}
      </ul>
      {nextCursor && (
        <button type="button" onClick={() => load(nextCursor)} disabled={loading} data-audit-webhooks-load-more>
          Load more
        </button>
      )}
    </div>
  );
}
