import type { Adapter } from '@superfunctions/db';
import type { BugReportEvent } from 'catchfn';

export interface CatchFnServiceConfig {
  db: Adapter;
  tableName?: string;
}

export class CatchFnService {
  private tableName: string;
  private db: Adapter;

  constructor(config: CatchFnServiceConfig) {
    this.db = config.db;
    this.tableName = config.tableName || 'catchfn_bugs';
  }

  async createBug(report: BugReportEvent): Promise<BugReportEvent> {
    // In a real implementation, we would probably separate the ID generation
    // and validation here, but we trust the client for now or overwrite the ID
    const bug = {
      ...report,
      receivedAt: Date.now(),
    };
    
    await this.db.create({
      model: this.tableName,
      data: bug,
    });
    return bug;
  }

  async getBug(id: string): Promise<BugReportEvent | null> {
    return this.db.findOne<BugReportEvent>({
      model: this.tableName,
      where: [{ field: 'id', operator: 'eq', value: id }],
    });
  }

  async listBugs(limit = 50, offset = 0): Promise<BugReportEvent[]> {
    return this.db.findMany<BugReportEvent>({
      model: this.tableName,
      where: [],
      orderBy: [{ field: 'timestamp', direction: 'desc' }],
      limit,
      offset,
    });
  }
}
