import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseQueueAdapter,
  createSqliteQueueClient,
  queueJobsMigrationSql,
  type QueueSqlClient,
} from '../index.js';
import { describeQueueContract } from './contract.js';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const tempDirs: string[] = [];

function tempFile(name = 'queue.db'): string {
  const dir = mkdtempSync(join(tmpdir(), 'sf-queue-sqlite-'));
  tempDirs.push(dir);
  return join(dir, name);
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function openQueue(file: string, now?: () => number) {
  const db = new Database(file);
  const queue = new DatabaseQueueAdapter<unknown>({ client: createSqliteQueueClient(db), now });
  await queue.migrate();
  return { db, queue };
}

describeQueueContract('sqlite (better-sqlite3 file)', async (now) => {
  const { db, queue } = await openQueue(tempFile(), now);
  return { queue, cleanup: async () => void db.close() };
});

describe('DatabaseQueueAdapter on SQLite', () => {
  const open: Database.Database[] = [];
  afterEach(() => {
    for (const db of open.splice(0)) {
      if (db.open) db.close();
    }
  });
  const reopen = async (file: string, now?: () => number) => {
    const handle = await openQueue(file, now);
    open.push(handle.db);
    return handle;
  };

  it('keeps pending and leased jobs across a restart', async () => {
    const file = tempFile();
    let time = 1_000;
    const now = () => time;

    const first = await reopen(file, now);
    const { id } = await first.queue.enqueue('jobs', { durable: true }, { dedupeKey: 'once' });
    first.db.close();

    const second = await reopen(file, now);
    expect(await second.queue.enqueue('jobs', { durable: false }, { dedupeKey: 'once' })).toEqual({
      id,
      deduplicated: true,
    });
    expect(await second.queue.claim('jobs', { leaseMs: 5_000 })).toEqual({ id, payload: { durable: true }, attempt: 1 });
    second.db.close();

    const third = await reopen(file, now);
    expect(await third.queue.claim('jobs', { leaseMs: 5_000 })).toBeNull();
    time += 5_000;
    expect(await third.queue.claim('jobs', { leaseMs: 5_000 })).toMatchObject({ id, attempt: 2 });
  });

  it('keeps a dead-lettered job with its reason', async () => {
    const { db, queue } = await reopen(tempFile());
    const { id } = await queue.enqueue('jobs', 'poison');
    await queue.claim('jobs', { leaseMs: 1_000 });
    await queue.fail(id, { deadLetter: true, reason: 'cannot parse' });

    expect(db.prepare('SELECT id, state, attempt, lease_until, last_error FROM queue_jobs').all()).toEqual([
      { id: Number(id), state: 'dead', attempt: 1, lease_until: null, last_error: 'cannot parse' },
    ]);
  });

  it('never reuses the id of an acked job', async () => {
    const { queue } = await reopen(tempFile());
    const first = await queue.enqueue('jobs', 'a');
    await queue.claim('jobs', { leaseMs: 1_000 });
    await queue.ack(first.id);

    const second = await queue.enqueue('jobs', 'b');
    expect(Number(second.id)).toBeGreaterThan(Number(first.id));
    await queue.claim('jobs', { leaseMs: 1_000 });
    await expect(queue.ack(first.id)).rejects.toThrow('FLOWFN_QUEUE_JOB_NOT_LEASED');
  });

  it('claims with one atomic UPDATE … RETURNING statement', async () => {
    const db = new Database(':memory:');
    open.push(db);
    const inner = createSqliteQueueClient(db);
    const statements: string[] = [];
    const client: QueueSqlClient = {
      dialect: 'sqlite',
      query: (sql, params) => {
        statements.push(sql);
        return inner.query(sql, params);
      },
    };
    const queue = new DatabaseQueueAdapter<string>({ client });
    await queue.migrate();
    await queue.enqueue('jobs', 'x');
    statements.length = 0;

    expect(await queue.claim('jobs', { leaseMs: 1_000 })).toMatchObject({ payload: 'x', attempt: 1 });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^UPDATE "queue_jobs" SET .* WHERE id = \(SELECT id FROM "queue_jobs" .* LIMIT 1\) RETURNING /);
  });

  it('rejects payloads that are not JSON-serializable', async () => {
    const { queue } = await reopen(tempFile());
    await expect(queue.enqueue('jobs', undefined)).rejects.toThrow('FLOWFN_QUEUE_PAYLOAD_INVALID');
    await expect(queue.enqueue('jobs', { n: 1n })).rejects.toThrow('FLOWFN_QUEUE_PAYLOAD_INVALID');
    expect(await queue.size('jobs')).toBe(0);
  });

  it('uses a custom table name and rejects unsafe ones', async () => {
    const db = new Database(':memory:');
    open.push(db);
    const client = createSqliteQueueClient(db);
    const queue = new DatabaseQueueAdapter<string>({ client, tableName: 'app_jobs' });
    await queue.migrate();
    await queue.migrate();
    await queue.enqueue('jobs', 'x');
    expect(db.prepare('SELECT COUNT(*) AS n FROM app_jobs').get()).toEqual({ n: 1 });
    expect(() => new DatabaseQueueAdapter({ client, tableName: 'jobs; DROP TABLE x' })).toThrow(
      'FLOWFN_QUEUE_TABLE_NAME_INVALID'
    );
  });

  it('works on a table created from the shipped migration file', async () => {
    const sql = readFileSync(join(packageRoot, 'migrations/sqlite/0001_queue_jobs.sql'), 'utf8');
    expect(sql).toBe(queueJobsMigrationSql('sqlite'));
    const db = new Database(':memory:');
    open.push(db);
    db.exec(sql);
    db.exec(sql);
    const queue = new DatabaseQueueAdapter<string>({ client: createSqliteQueueClient(db) });
    await queue.enqueue('jobs', 'x', { dedupeKey: 'k' });
    expect(await queue.enqueue('jobs', 'y', { dedupeKey: 'k' })).toMatchObject({ deduplicated: true });
  });

  it('ships a Postgres migration matching the generated DDL', () => {
    const sql = readFileSync(join(packageRoot, 'migrations/postgres/0001_queue_jobs.sql'), 'utf8');
    expect(sql).toBe(queueJobsMigrationSql('postgres'));
  });
});

describe('SQLite concurrency', () => {
  let modulePath: string;

  beforeAll(async () => {
    // Worker threads cannot load the TypeScript sources directly, so bundle them.
    const result = await build({
      entryPoints: [join(packageRoot, 'src/index.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
    });
    const file = tempFile('queue-bundle.mjs');
    writeFileSync(file, result.outputFiles[0].text);
    modulePath = pathToFileURL(file).href;
  });

  it('acks each of 500 jobs exactly once across 8 claimer threads', async () => {
    const file = tempFile();
    const { db, queue } = await openQueue(file);
    db.pragma('journal_mode = WAL');
    for (let n = 0; n < 500; n += 1) {
      await queue.enqueue('jobs', { n });
    }

    const workers = Array.from(
      { length: 8 },
      () =>
        new Worker(new URL('./fixtures/sqlite-claimer.mjs', import.meta.url), {
          workerData: { modulePath, file, queueName: 'jobs' },
        })
    );
    try {
      const results = workers.map(
        (worker) =>
          new Promise<string[]>((resolve, reject) => {
            worker.on('error', reject);
            worker.on('message', (message: { ready?: true; acked?: string[]; error?: string }) => {
              if (message.error) reject(new Error(message.error));
              if (message.acked) resolve(message.acked);
            });
          })
      );
      await Promise.all(
        workers.map((worker) => new Promise((resolve) => worker.once('message', resolve)))
      );
      for (const worker of workers) worker.postMessage('go');

      const perWorker = await Promise.all(results);
      const acked = perWorker.flat();
      expect(acked).toHaveLength(500);
      expect(new Set(acked).size).toBe(500);
      expect(perWorker.filter((ids) => ids.length > 0).length).toBeGreaterThan(1);
      expect(await queue.size('jobs')).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM queue_jobs').get()).toEqual({ n: 0 });
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      db.close();
    }
  }, 60_000);
});
