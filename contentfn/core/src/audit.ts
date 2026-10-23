export interface AuditRecord {
  id: string;
  dataset: string;
  action: string;
  actor: { subject: string } | null;
  targetIds: string[];
  timestamp: string;
}
export interface AuditQuery {
  dataset: string;
  action?: string;
  /** Timestamp direction; id is always ascending for deterministic equal-timestamp ordering. */
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}


/** Latest durable delivery state; legacy history can lack a timestamp or destination. */
export interface WebhookAuditRecord {
  id: string;
  dataset: string;
  webhookId: string;
  eventId: string;
  url: string | null;
  attempt: number;
  status: "pending" | "processing" | "delivered" | "failed";
  lastError: string | null;
  updatedAt: string | null;
  timestampKnown: boolean;
}
/** Known timestamps descending, then unknown timestamps; identity ascending breaks ties. */
export interface WebhookAuditQuery { dataset: string; limit?: number; offset?: number }
