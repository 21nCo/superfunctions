import { StorageAdapter } from "./types";

export class MemoryStorage implements StorageAdapter {
  private events: any[] = [];
  private limit: number;

  constructor(limit: number = 1000) {
    this.limit = limit;
  }

  add(event: any) {
    this.events.push(event);
    if (this.events.length > this.limit) {
      this.events.shift();
    }
  }

  query(filter: (event: any) => boolean) {
    return this.events.filter(filter);
  }
  
  clear() {
      this.events = [];
  }
  
  getAll() {
      return this.events;
  }
}
