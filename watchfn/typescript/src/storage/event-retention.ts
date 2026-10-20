import type { Adapter, TransactionAdapter } from "@superfunctions/db";
import { DEFAULT_RETENTION_MS } from "./time-series/retention";
import { BUG_ISSUES_TABLE } from "../integrations/botfn/schema";

export const DEFAULT_EVENT_TTL_MS = DEFAULT_RETENTION_MS;
export interface EventRetentionConfig {
  /** Trusted server-owned application allowlist, not a client-selected tenant scope. */
  apps: string[];
  defaultTtlMs?: number;
  bugReportTtlMs?: number;
}
export interface RetentionPageOptions { after?: string; limit?: number; }
export interface RetentionPageResult { scanned: number; deleted: number; retained: number; nextCursor: string | null; }
export interface ReceiptBackfillOptions extends RetentionPageOptions { receivedAt: number; }
interface EventRow { id: string; payload: Record<string, any>; receivedAt: number | null; }

export function retentionPage(options: RetentionPageOptions): number {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || (options.after !== undefined && (typeof options.after !== "string" || !options.after.length || options.after.length > 512))) throw new TypeError("Invalid retention page");
  return limit;
}

/** Explicit host-scheduled cleanup. It never removes an outbox receipt. */
export class EventRetention {
  private readonly apps: Set<string>;
  private readonly defaultTtlMs: number;
  private readonly bugReportTtlMs: number;
  constructor(private readonly db: Adapter, config: EventRetentionConfig, private readonly table: string, private readonly namespace?: string) {
    if (!db.capabilities?.transactions?.supported || typeof db.transaction !== "function") throw new TypeError("Event retention requires transactional shared storage");
    if (!config || !Array.isArray(config.apps) || !config.apps.length || config.apps.length > 100 || config.apps.some(app => typeof app !== "string" || !app.trim() || app.length > 200)) throw new TypeError("Invalid retention application allowlist");
    this.apps = new Set(config.apps);
    this.defaultTtlMs = config.defaultTtlMs ?? DEFAULT_EVENT_TTL_MS;
    this.bugReportTtlMs = config.bugReportTtlMs ?? this.defaultTtlMs;
    for (const ttl of [this.defaultTtlMs, this.bugReportTtlMs]) if (!Number.isSafeInteger(ttl) || ttl < 1) throw new TypeError("Retention TTL must be a positive safe integer in milliseconds");
  }
  private expired(row: EventRow, now: number): boolean {
    // Only canonical top-level app identity authorizes deletion. No property fallback.
    const app = row.payload?.app?.name;
    const ttl = row.payload?.type === "bug_report" ? this.bugReportTtlMs : this.defaultTtlMs;
    return typeof app === "string" && this.apps.has(app) && Number.isSafeInteger(row.receivedAt) && row.receivedAt! >= 0 && row.receivedAt! < now - ttl;
  }
  private async safeToExpire(row: EventRow, tx: TransactionAdapter): Promise<boolean> {
    if (!row.id.startsWith("bug_")) return true;
    if (!this.namespace) return false;
    const receipts = await tx.findMany<{ state: string; namespace: string; app: string; reportId: string; eventId: string; target: string; project: string; issueId: string | null; issueUrl: string | null }>({ model: BUG_ISSUES_TABLE,
      where: [{ field: "eventId", operator: "eq", value: row.id }], limit: 2 });
    const receipt = receipts[0];
    const integration = row.payload?.integration;
    return receipts.length === 1 && receipt.namespace === this.namespace && receipt.state === "linked" && receipt.app === row.payload?.app?.name && receipt.reportId === row.payload?.id &&
      typeof receipt.issueId === "string" && receipt.issueId.length > 0 && typeof receipt.issueUrl === "string" && receipt.issueUrl.length > 0 &&
      integration?.target === receipt.target && integration?.project === receipt.project && integration?.issueId === receipt.issueId && integration?.issueUrl === receipt.issueUrl;
  }
  async cleanup(options: RetentionPageOptions = {}): Promise<RetentionPageResult> {
    const limit = retentionPage(options); const now = Date.now();
    const rows = await this.db.findMany<EventRow>({ model: this.table,
      where: options.after === undefined ? [] : [{ field: "id", operator: "gt", value: options.after }],
      select: ["id", "payload", "receivedAt"], orderBy: [{ field: "id", direction: "asc" }], limit });
    let deleted = 0;
    for (const candidate of rows) {
      if (!this.expired(candidate, now)) continue;
      deleted += await this.db.transaction(async tx => {
        const row = await tx.findOne<EventRow>({ model: this.table, where: [{ field: "id", operator: "eq", value: candidate.id }] });
        if (!row || !this.expired(row, now) || !await this.safeToExpire(row, tx)) return 0;
        const count = await tx.deleteMany({ model: this.table, where: [{ field: "id", operator: "eq", value: row.id }, { field: "receivedAt", operator: "eq", value: row.receivedAt }] });
        if (count > 1) throw new Error("Retention deleted multiple records for one storage ID");
        return count;
      });
    }
    return { scanned: rows.length, deleted, retained: rows.length - deleted, nextCursor: rows.length === limit ? rows[rows.length - 1].id : null };
  }
}

/** Offline initialization only: a fixed host-selected anchor never comes from event JSON. */
export async function backfillReceivedAt(db: Adapter, table: string, options: ReceiptBackfillOptions): Promise<{ processed: number; initialized: number; nextCursor: string | null }> {
  const limit = retentionPage(options); const receivedAt = options.receivedAt;
  if (!Number.isSafeInteger(receivedAt) || receivedAt < 0 || receivedAt > Date.now()) throw new TypeError("Invalid receivedAt migration anchor");
  const rows = await db.findMany<EventRow>({ model: table, select: ["id", "receivedAt"],
    where: options.after === undefined ? [] : [{ field: "id", operator: "gt", value: options.after }], orderBy: [{ field: "id", direction: "asc" }], limit });
  let initialized = 0;
  for (const row of rows) if (row.receivedAt == null) initialized += await db.updateMany({ model: table,
    where: [{ field: "id", operator: "eq", value: row.id }, { field: "receivedAt", operator: "eq", value: null }], data: { receivedAt } });
  return { processed: rows.length, initialized, nextCursor: rows.length === limit ? rows[rows.length - 1].id : null };
}
