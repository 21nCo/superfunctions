import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzleAdapter } from "@superfunctions/db/adapters/drizzle";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StorageAdapter, StoredEvent } from "../src/index.js";

/** A SQLite file opened through `@superfunctions/db`'s Drizzle adapter, owned by the test. */
export interface SqliteFile {
  file: string;
  connect(): { sqlite: Database.Database; adapter: ReturnType<typeof drizzleAdapter> };
  cleanup(): void;
}

export function sqliteFile(): SqliteFile {
  const dir = mkdtempSync(path.join(tmpdir(), "watchfn-sqlite-"));
  const file = path.join(dir, "events.db");
  const opened: Database.Database[] = [];
  return {
    file,
    connect() {
      const sqlite = new Database(file);
      opened.push(sqlite);
      return { sqlite, adapter: drizzleAdapter({ db: drizzle(sqlite), dialect: "sqlite" }) };
    },
    cleanup() {
      for (const sqlite of opened) if (sqlite.open) sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Wraps a storage adapter so tests can count calls and inject failures. */
export function instrument(inner: StorageAdapter) {
  const calls = { open: 0, close: 0, write: 0, query: 0 };
  const control: { failWrites?: Error; throwOnWrite?: { thrown: unknown }; gate?: Promise<void>; written: StoredEvent[][] } = { written: [] };
  const storage: StorageAdapter = {
    kind: inner.kind,
    durable: inner.durable,
    async open() {
      calls.open += 1;
      await inner.open?.();
    },
    async close() {
      calls.close += 1;
      await inner.close?.();
    },
    async write(events) {
      calls.write += 1;
      if (control.gate !== undefined) await control.gate;
      if (control.failWrites) throw control.failWrites;
      if (control.throwOnWrite) throw control.throwOnWrite.thrown;
      await inner.write(events);
      control.written.push([...events]);
    },
    async query(query) {
      calls.query += 1;
      return inner.query(query);
    },
  };
  return { storage, calls, control };
}
