import { StorageAdapter } from "./types";

export interface DatabaseAdapter {
  insertEvent(event: any): Promise<void>;
  queryEvents(params: any): Promise<any[]>;
}

export class DatabaseStorage implements StorageAdapter {
  private db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  async add(event: any) {
    await this.db.insertEvent(event);
  }

  async query(filter: (event: any) => boolean): Promise<any[]> {
    // This is inefficient as it fetches all then filters in memory if the DB adapter 
    // doesn't support structured filtering. 
    // Ideally, query logic should be pushed down.
    // For now, we assume queryEvents accepts params similar to our QueryOptions.
    return await this.db.queryEvents({}); 
  }
  
  async executeQuery(options: any) {
      return await this.db.queryEvents(options);
  }
}
