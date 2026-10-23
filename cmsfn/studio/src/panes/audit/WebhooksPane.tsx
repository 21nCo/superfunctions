/**
 * Webhook deliveries pane: list delivery attempts (webhookId, status, attempt, timestamps), deterministic order.
 */

import { record, useAuditPage } from "./useAuditPage.js";
import type { CmsfnWebhookDeliveryStatus } from "cmsfn";

export interface WebhooksPaneProps {
  cmsfnApiUrl: string;
  dataset: string;
  /** When false, show deterministic "no access" state. */
  hasAuditRead?: boolean;
}

function parseDelivery(value: unknown, dataset: string): CmsfnWebhookDeliveryStatus | null {
  if (!record(value) || value.dataset !== dataset || typeof value.webhookId !== "string" || typeof value.eventId !== "string" || typeof value.attempt !== "number" || !Number.isSafeInteger(value.attempt) || value.attempt < 0 || !(value.updatedAt === null || typeof value.updatedAt === "string")) return null;
  if (value.status !== "pending" && value.status !== "processing" && value.status !== "delivered" && value.status !== "failed") return null;
  return { webhookId: value.webhookId, dataset, eventId: value.eventId, attempt: value.attempt, status: value.status, updatedAt: value.updatedAt, url: null };
}

export function WebhooksPane({ cmsfnApiUrl, dataset, hasAuditRead = true }: WebhooksPaneProps) {
  const { rows: deliveries, cursor: nextCursor, loading, error, denied, load } = useAuditPage(cmsfnApiUrl, dataset, hasAuditRead, "webhooks", parseDelivery);

  if (denied) {
    return (
      <div data-audit-webhooks-pane data-audit-denied>
        <p data-audit-denied-message>No access</p>
        {hasAuditRead && <button type="button" onClick={() => void load()}>Retry</button>}
      </div>
    );
  }

  return (
    <div data-audit-webhooks-pane data-dataset={dataset}>
      <h2 data-audit-webhooks-title>Webhook deliveries</h2>
      {error && <p role="alert" data-audit-webhooks-error>{error}</p>}
      {loading && deliveries.length === 0 && <p data-audit-webhooks-loading>Loading…</p>}
      <button type="button" onClick={() => void load()} disabled={loading} data-audit-webhooks-refresh>Refresh</button>
      {error && <button type="button" onClick={() => void load(nextCursor)} disabled={loading}>Retry</button>}
      {!loading && !error && deliveries.length === 0 && <p data-audit-empty>No webhook deliveries.</p>}
      <ul data-audit-webhooks-list>
        {deliveries.map((d, i) => (
          <li key={`${d.webhookId}-${d.eventId}-${i}`} data-audit-delivery data-webhook-id={d.webhookId}>
            <span data-audit-delivery-webhook>{d.webhookId}</span>
            <span data-audit-delivery-event>{d.eventId}</span>
            <span data-audit-delivery-status>{d.status}</span>
            <span data-audit-delivery-attempt>{d.attempt}</span>
            <span data-audit-delivery-updated>{d.updatedAt ?? "Timestamp unknown"}</span>
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
