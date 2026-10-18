import { wrapWithSchema, type Adapter, type WhereClause } from "@superfunctions/db";
import { estimateSize, redactObject, safeSerialize, type BugReportEvent, type BugSeverity } from "catchfn";
import { z } from "zod";
import { getCatchFnSchema } from "./schema.js";

const reportSchema = z.object({
  id: z.string().min(1).max(200), timestamp: z.number().finite().nonnegative(),
  title: z.string().trim().min(1).max(2000), description: z.string().max(100000).optional(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  tags: z.array(z.string().min(1).max(200)).max(100).optional(),
  app: z.object({ name: z.string().min(1).max(200), version: z.string().optional() }).optional(),
  sessionId: z.string().max(200).optional(), replayId: z.string().max(200).optional(),
}).passthrough();

export class CatchFnValidationError extends Error {}
export class CatchFnConflictError extends Error {}
export interface CatchFnServiceConfig {
  db: Adapter;
  tableName?: string;
  /** Bind this service to an application at the authenticated server boundary. */
  app?: string;
  maxPayloadSize?: number;
  retentionDays?: number;
  now?: () => number;
}
export interface BugFilters {
  app?: string; severity?: BugSeverity; tags?: string[];
  from?: number; to?: number; sessionId?: string; replayId?: string; issueId?: string;
}
interface StoredBug { id: string; app: string; timestamp: number; receivedAt: number; severity: string; payload: BugReportEvent }
const tagKey = (tag: string) => `|${Buffer.from(tag).toString("base64url")}|`;
const stable = (value: any): string => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export class CatchFnService {
  private readonly tableName: string;
  private readonly db: Adapter;
  private readonly maxPayloadSize: number;
  private readonly now: () => number;
  constructor(private readonly config: CatchFnServiceConfig) {
    this.tableName = config.tableName ?? "catchfn_bugs";
    this.db = wrapWithSchema(config.db, getCatchFnSchema(this.tableName));
    this.maxPayloadSize = config.maxPayloadSize ?? 262144;
    this.now = config.now ?? Date.now;
    if (!Number.isInteger(this.maxPayloadSize) || this.maxPayloadSize < 1) throw new CatchFnValidationError("Invalid maxPayloadSize");
    if (config.retentionDays !== undefined && (!Number.isFinite(config.retentionDays) || config.retentionDays < 0)) throw new CatchFnValidationError("Invalid retentionDays");
  }
  getSchema() { return getCatchFnSchema(this.tableName); }
  private scope(extra: WhereClause[] = []): WhereClause[] {
    return [...(this.config.app ? [{field:"app", operator:"eq" as const, value:this.config.app}] : []), ...extra];
  }
  async createBug(input: BugReportEvent): Promise<BugReportEvent> {
    const parsed = reportSchema.safeParse(input);
    if (!parsed.success) throw new CatchFnValidationError("Invalid bug report");
    const report = redactObject(safeSerialize(parsed.data)) as BugReportEvent;
    delete (report as BugReportEvent & {receivedAt?: number}).receivedAt;
    if (estimateSize(report) > this.maxPayloadSize) throw new CatchFnValidationError("Bug report exceeds maxPayloadSize");
    const app = (parsed.data.app?.name ?? this.config.app ?? "default");
    if (this.config.app && app !== this.config.app) throw new CatchFnValidationError("Application does not match service scope");
    const existing = await this.getBug(report.id);
    if (existing) {
      if (stable(existing) !== stable(report)) throw new CatchFnConflictError("Bug id already exists with different content");
      return existing;
    }
    try {
      await this.db.create({model:this.tableName, data:{
        id:report.id, app, timestamp:report.timestamp, receivedAt:this.now(), severity:report.severity,
        tags:(report.tags ?? []).map(tagKey).join(""), sessionId:parsed.data.sessionId ?? null,
        replayId:parsed.data.replayId ?? null, issueId:report.integration?.issueId ?? null, payload:report,
      }});
    } catch (error) {
      const duplicate = await this.getBug(report.id);
      if (duplicate && stable(duplicate) === stable(report)) return duplicate;
      if (duplicate) throw new CatchFnConflictError("Bug id already exists with different content");
      throw error;
    }
    return safeSerialize(report);
  }
  async getBug(id: string): Promise<BugReportEvent | null> {
    const row = await this.db.findOne<StoredBug>({model:this.tableName, where:this.scope([{field:"id", operator:"eq", value:id}])});
    return row ? safeSerialize(row.payload) : null;
  }
  async listBugs(limit = 50, offset = 0, filters: BugFilters = {}): Promise<BugReportEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) throw new CatchFnValidationError("Invalid pagination");
    if (this.config.app && filters.app && filters.app !== this.config.app) throw new CatchFnValidationError("Application does not match service scope");
    const where = this.scope();
    for (const field of ["app", "severity", "sessionId", "replayId", "issueId"] as const) {
      if (filters[field]) where.push({field, operator:"eq", value:filters[field]});
    }
    for (const [field, operator] of [["from", "gte"], ["to", "lte"]] as const) {
      if (filters[field] !== undefined) {
        if (!Number.isFinite(filters[field])) throw new CatchFnValidationError("Invalid time filter");
        where.push({field:"timestamp", operator, value:filters[field]});
      }
    }
    for (const tag of filters.tags ?? []) where.push({field:"tags", operator:"contains", value:tagKey(tag)});
    const rows = await this.db.findMany<StoredBug>({model:this.tableName, where, orderBy:[{field:"timestamp", direction:"desc"},{field:"id",direction:"asc"}], limit, offset});
    return rows.map((row) => safeSerialize(row.payload));
  }
  async cleanup(retentionDays = this.config.retentionDays ?? 30): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays < 0) throw new CatchFnValidationError("Invalid retentionDays");
    return this.db.deleteMany({model:this.tableName, where:this.scope([{field:"receivedAt", operator:"lt", value:this.now() - retentionDays * 86400000}])});
  }
}
