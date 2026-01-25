import { Adapter, WhereClause } from "@superfunctions/db";
import { TokenUsage, Cost } from "../core/types.js";

export interface TraceRecord {
  id: string;
  startTime: number;
  endTime: number;
  model: string;
  provider: string;
  input: string;
  output: string;
  tokens: TokenUsage;
  latency: number;
  cost?: Cost;
  metadata: Record<string, any>;
  userId?: string;
}

export class TraceStorage {
  private tableName = "langfn_traces";

  constructor(private readonly db: Adapter) {}

  async save(trace: TraceRecord): Promise<void> {
    await this.db.create({
      model: this.tableName,
      data: trace
    });
  }

  async findMany(options: {
    limit?: number;
    offset?: number;
    model?: string;
    provider?: string;
  } = {}): Promise<TraceRecord[]> {
    const where: WhereClause[] = [];
    if (options.model) {
      where.push({ field: "model", operator: "eq", value: options.model });
    }
    if (options.provider) {
      where.push({ field: "provider", operator: "eq", value: options.provider });
    }

    return this.db.findMany<TraceRecord>({
      model: this.tableName,
      where,
      limit: options.limit,
      offset: options.offset,
      orderBy: [{ field: "startTime", direction: "desc" }]
    });
  }

  async findOne(id: string): Promise<TraceRecord | null> {
    return this.db.findOne<TraceRecord>({
      model: this.tableName,
      where: [{ field: "id", operator: "eq", value: id }]
    });
  }
}
