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
  limit?: number;
  offset?: number;
}

