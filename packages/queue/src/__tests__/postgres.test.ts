import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseQueueAdapter, createPostgresQueueClient, type QueueSqlClient } from '../index.js';
import { describeQueueContract, drainConcurrently } from './contract.js';

/**
 * PGlite runs the real Postgres engine in-process, so the Postgres SQL is
 * exercised on every run. A server in `SUPERFUNCTIONS_QUEUE_POSTGRES_URL`
 * additionally covers concurrent connections and `FOR UPDATE SKIP LOCKED`.
 */
const postgresUrl = process.env.SUPERFUNCTIONS_QUEUE_POSTGRES_URL;
let tableCounter = 0;
const nextTable = () => `queue_jobs_t${process.pid}_${++tableCounter}`;

describe('Postgres claim statement', () => {
  it('locks the selected row with FOR UPDATE SKIP LOCKED inside one statement', async () => {
    const statements: string[] = [];
    const client: QueueSqlClient = {
      dialect: 'postgres',
      async query(sql) {
        statements.push(sql);
        return [];
      },
    };
    const queue = new DatabaseQueueAdapter({ client });
    expect(await queue.claim('jobs', { leaseMs: 1_000 })).toBeNull();
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(
      /^UPDATE "queue_jobs" SET .* WHERE id = \(SELECT id FROM "queue_jobs" .* LIMIT 1 FOR UPDATE SKIP LOCKED\) RETURNING /
    );
    expect(statements[0]).not.toContain('?');
  });
});

describe('PGlite', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterAll(async () => {
    await db?.close();
  });

  describeQueueContract('postgres (PGlite)', async (now) => {
    const tableName = nextTable();
    const queue = new DatabaseQueueAdapter<unknown>({ client: createPostgresQueueClient(db), tableName, now });
    await queue.migrate();
    return { queue, cleanup: async () => void (await db.query(`DROP TABLE "${tableName}"`)) };
  });

  it('stores the payload as JSON and keeps a dead-lettered row', async () => {
    const tableName = nextTable();
    const queue = new DatabaseQueueAdapter<unknown>({ client: createPostgresQueueClient(db), tableName });
    await queue.migrate();
    await queue.migrate();
    const { id } = await queue.enqueue('jobs', { nested: { ok: true } });
    await queue.claim('jobs', { leaseMs: 1_000 });
    await queue.fail(id, { deadLetter: true, reason: 'boom' });

    const { rows } = await db.query<{ type: string; state: string; last_error: string; nestedOk: unknown }>(
      `SELECT pg_typeof(payload)::text AS type, state, last_error, payload->'nested'->>'ok' AS "nestedOk" FROM "${tableName}"`
    );
    expect(rows).toEqual([{ type: 'json', state: 'dead', last_error: 'boom', nestedOk: 'true' }]);
    await db.query(`DROP TABLE "${tableName}"`);
  });
});

describe.skipIf(!postgresUrl)('Postgres server', () => {
  const pools: pg.Pool[] = [];
  const tables: string[] = [];
  let admin: pg.Pool;

  beforeAll(() => {
    admin = new pg.Pool({ connectionString: postgresUrl, max: 2 });
    pools.push(admin);
  });
  afterAll(async () => {
    for (const table of tables) {
      await admin.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    await Promise.all(pools.map((pool) => pool.end()));
  });

  describeQueueContract('postgres (server)', async (now) => {
    const tableName = nextTable();
    tables.push(tableName);
    const queue = new DatabaseQueueAdapter<unknown>({ client: createPostgresQueueClient(admin), tableName, now });
    await queue.migrate();
    return { queue };
  });

  it('acks each of 500 jobs exactly once across 8 claimers on separate connections', async () => {
    const tableName = nextTable();
    tables.push(tableName);
    const seed = new DatabaseQueueAdapter<{ n: number }>({ client: createPostgresQueueClient(admin), tableName });
    await seed.migrate();
    for (let n = 0; n < 500; n += 1) {
      await seed.enqueue('jobs', { n });
    }

    const claimers = Array.from({ length: 8 }, () => {
      // One dedicated connection per claimer, so claims race inside Postgres.
      const pool = new pg.Pool({ connectionString: postgresUrl, max: 1 });
      pools.push(pool);
      return new DatabaseQueueAdapter<unknown>({ client: createPostgresQueueClient(pool), tableName });
    });
    const perClaimer = await drainConcurrently(claimers, 'jobs');
    const acked = perClaimer.flat();

    expect(acked).toHaveLength(500);
    expect(new Set(acked).size).toBe(500);
    expect(perClaimer.filter((ids) => ids.length > 0).length).toBeGreaterThan(1);
    expect(await seed.size('jobs')).toBe(0);
    const { rows } = await admin.query(`SELECT COUNT(*)::int AS n FROM "${tableName}"`);
    expect(rows).toEqual([{ n: 0 }]);
  }, 120_000);

  it('deduplicates concurrent enqueues with the same key to one job', async () => {
    const tableName = nextTable();
    tables.push(tableName);
    const pool = new pg.Pool({ connectionString: postgresUrl, max: 8 });
    pools.push(pool);
    const queue = new DatabaseQueueAdapter<number>({ client: createPostgresQueueClient(pool), tableName });
    await queue.migrate();

    const results = await Promise.all(
      Array.from({ length: 16 }, (_, n) => queue.enqueue('jobs', n, { dedupeKey: 'same' }))
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
    expect(await queue.size('jobs')).toBe(1);
  });
});
