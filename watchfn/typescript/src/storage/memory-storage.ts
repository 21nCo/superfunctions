import { StorageAdapter } from "./types";
import { equalitySeek, indexValue, logField, validateIndexFields } from './log-index/values';

export class MemoryStorage implements StorageAdapter {
  private events: any[] = [];
  private policies = new Map<any, readonly string[]>();
  private indexes = new Map<string, Set<any>>();
  constructor(private limit: number = 1000) {}

  add(event: any, options?: { indexFields: readonly string[] }) {
    const fields = event?.type === 'log' && options ? validateIndexFields(options.indexFields) : undefined;
    const snapshot = event?.type === 'log' ? structuredClone(event) : event;
    const entries = (fields ?? []).flatMap(field => {
      const scalar = indexValue(logField(snapshot, field));
      return scalar ? [`${field}\0${scalar.valueType}\0${scalar.valueKey}`] : [];
    });
    this.events.push(snapshot);
    if (fields) {
      this.policies.set(snapshot, fields);
      for (const key of entries) {
        const bucket = this.indexes.get(key) ?? new Set<any>(); bucket.add(snapshot); this.indexes.set(key, bucket);
      }
    }
    if (this.events.length > this.limit) {
      const removed = this.events.shift(); this.policies.delete(removed);
      for (const [key, bucket] of this.indexes) { bucket.delete(removed); if (!bucket.size) this.indexes.delete(key); }
    }
  }
  query(filter: (event: any) => boolean) { return this.getAll().filter(filter); }
  async *iterateQuery(options: any = {}) {
    const seek = equalitySeek(options.where);
    const matches = seek ? this.indexes.get(`${seek.field}\0${seek.valueType}\0${seek.valueKey}`) : undefined;
    for (const event of this.events) {
      if (!seek || matches?.has(event) || !this.policies.get(event)?.includes(seek.field)) yield event?.type === 'log' ? structuredClone(event) : event;
    }
  }
  clear() { this.events = []; this.policies.clear(); this.indexes.clear(); }
  getAll() { return this.events.map(event => event?.type === 'log' ? structuredClone(event) : event); }
}
