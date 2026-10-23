/**
 * CmsFn server API types (SPEC.md) — canonical I/O shapes for endpoints.
 */

import type { CmsfnEnvelope } from "../envelope.js";
import type { CmsfnRole } from "../roles/types.js";
import type { CmsfnRelease, CmsfnReleasePublishResult } from "../releases/types.js";

export interface CmsfnStatusResult {
  serverTime: string; // ISO 8601
  capabilities: string[];
  datasets: string[];
}

export interface CmsfnPreviewTokenResult {
  token: string;
  expiresAt: string; // ISO 8601
  dataset: string;
  docIds: string[];
}

export interface CmsfnAuditEvent {
  eventId: string;
  dataset: string;
  type: string;
  timestamp: string; // ISO 8601
  actor?: { subject?: string };
  /** Authoritative audit targets; no document body or inferred type. */
  targetIds?: string[];
  document?: { _id: string; _type: string; _rev?: string };
  diff?: { changedPaths?: string[] };
}

export interface CmsfnWebhookDeliveryStatus {
  webhookId: string;
  dataset: string;
  url: string | null;
  eventId: string;
  attempt: number;
  status: "pending" | "processing" | "delivered" | "failed";
  lastError?: string;
  updatedAt: string | null; // Legacy history may have no known timestamp.
  timestampKnown?: boolean;
}

export interface CmsfnServerAPI {
  status: () => Promise<CmsfnEnvelope<CmsfnStatusResult>>;
  roles: {
    list: (input: { dataset: string }) => Promise<CmsfnEnvelope<{ roles: CmsfnRole[] }>>;
    upsert: (input: { role: CmsfnRole }) => Promise<CmsfnEnvelope<{ role: CmsfnRole }>>;
    delete: (input: { roleId: string }) => Promise<CmsfnEnvelope<Record<string, never>>>;
  };
  preview: {
    token: (input: { dataset: string; docIds: string[] }) => Promise<CmsfnEnvelope<CmsfnPreviewTokenResult>>;
  };
  releases: {
    create: (input: { dataset: string; name: string; publishAt?: string | null }) => Promise<CmsfnEnvelope<{ releaseId: string }>>;
    list: (input: { dataset: string }) => Promise<CmsfnEnvelope<{ releases: CmsfnRelease[] }>>;
    add: (input: { dataset: string; releaseId: string; docId: string }) => Promise<CmsfnEnvelope<Record<string, never>>>;
    publish: (input: { dataset: string; releaseId: string }) => Promise<CmsfnEnvelope<CmsfnReleasePublishResult>>;
  };
  ops: {
    export: (input: { dataset: string }) => Promise<CmsfnEnvelope<{ artifact: unknown }>>;
    import: (input: { dataset: string; artifact: unknown }) => Promise<CmsfnEnvelope<Record<string, never>>>;
  };
  audit: {
    events: (input: { dataset: string; limit?: number; cursor?: string | null }) => Promise<CmsfnEnvelope<{ events: CmsfnAuditEvent[]; nextCursor: string | null }>>;
    webhooks: (input: { dataset: string; limit?: number; cursor?: string | null }) => Promise<CmsfnEnvelope<{ deliveries: CmsfnWebhookDeliveryStatus[]; nextCursor: string | null }>>;
  };
}
