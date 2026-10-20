import type { ControlPlaneStore } from './store.js';
import { MemoryStore } from './memory-store.js';
import { DatabaseStore } from './database-store.js';
import { CIFN_STATE_TABLE, CIFN_SQLITE_SCHEMA } from './database-schema.js';

export interface RuntimeStore {
  store: ControlPlaneStore;
  mode: 'memory' | 'sqlite';
  close(): Promise<void>;
}

/** Explicit configuration: durable mode never generates keys or falls back to memory. */
export async function createRuntimeStore(env: Record<string, string | undefined> = process.env): Promise<RuntimeStore> {
  const mode = env.CIFN_STORE_ADAPTER ?? 'memory';
  if (mode === 'memory') return { store: new MemoryStore(), mode, close: async () => {} };
  if (mode !== 'sqlite') throw new Error('CIFN_STORE_ADAPTER must be memory or sqlite');
  const path = env.CIFN_SQLITE_PATH;
  if (!path || path === ':memory:' || path.startsWith('file:')) throw new Error('CIFN_SQLITE_PATH must name a persistent filesystem database');
  const encodedKey = env.CIFN_STORE_ENCRYPTION_KEY;
  if (!encodedKey || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) throw new Error('CIFN_STORE_ENCRYPTION_KEY must be a base64-encoded 32-byte deployment key');
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) throw new Error('CIFN_STORE_ENCRYPTION_KEY must be a base64-encoded 32-byte deployment key');

  let database: import('better-sqlite3').Database | undefined;
  let sql: { destroy(): Promise<void> } | undefined;
  try {
    const [{ default: SQLite }, { Kysely, SqliteDialect }, { kyselyAdapter }] = await Promise.all([
      import('better-sqlite3'), import('kysely'), import('@superfunctions/db/adapters'),
    ]);
    database = new SQLite(path);
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    database.pragma('busy_timeout = 5000');
    database.exec(CIFN_SQLITE_SCHEMA);
    sql = new Kysely({ dialect: new SqliteDialect({ database }) });
    const adapter = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { [CIFN_STATE_TABLE]: CIFN_STATE_TABLE } });
    const store = await DatabaseStore.open({ database: adapter, encryptionKey: key, namespace: env.CIFN_STORE_NAMESPACE });
    return { store, mode, close: async () => { await sql!.destroy(); } };
  } catch (cause) {
    if (sql) await sql.destroy();
    else database?.close();
    throw cause;
  } finally {
    key.fill(0);
  }
}
