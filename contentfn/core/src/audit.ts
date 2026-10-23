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

