import { drizzleAdapter } from '@superfunctions/db/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseQueueAdapter, createD1QueueClient, type D1DatabaseLike } from '../index.js';
import { describeQueueContract } from './contract.js';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

// A Worker that drives the adapter from inside workerd against its D1 binding.
const workerEntry = `
import { drizzleAdapter } from '@superfunctions/db/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import { DatabaseQueueAdapter, createD1QueueClient } from './src/index.ts';

export default {
  async fetch(request, env) {
    const { table, jobs, claimers, via } = await request.json();
    const queue =
      via === 'drizzle'
        ? new DatabaseQueueAdapter({ db: drizzleAdapter({ db: drizzle(env.DB), dialect: 'sqlite' }), tableName: table })
        : new DatabaseQueueAdapter({ client: createD1QueueClient(env.DB), tableName: table });
    await queue.migrate();
    for (let n = 0; n < jobs; n += 1) {
      await queue.enqueue('jobs', { n });
    }
    const acked = await Promise.all(
      Array.from({ length: claimers }, async () => {
        const ids = [];
        for (;;) {
          const job = await queue.claim('jobs', { leaseMs: 60000 });
          if (!job) return ids;
          await queue.ack(job.id, { attempt: job.attempt });
          ids.push(job.id);
        }
      })
    );
    return Response.json({ acked, size: await queue.size('jobs') });
  },
};
`;

let mf: Miniflare;
let d1: D1DatabaseLike;
let tableCounter = 0;

beforeAll(async () => {
  const bundle = await build({
    stdin: { contents: workerEntry, resolveDir: packageRoot, sourcefile: 'worker.mjs', loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
  });
  mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2025-11-13',
    d1Databases: { DB: 'queue-test' },
  });
  d1 = (await mf.getD1Database('DB')) as unknown as D1DatabaseLike;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describeQueueContract('D1 (workerd)', async (now) => {
  const queue = new DatabaseQueueAdapter<unknown>({
    client: createD1QueueClient(d1),
    tableName: `queue_jobs_${++tableCounter}`,
    now,
  });
  await queue.migrate();
  return { queue };
});

describeQueueContract('D1 (workerd, @superfunctions/db drizzleAdapter)', async (now) => {
  const queue = new DatabaseQueueAdapter<unknown>({
    db: drizzleAdapter({ db: drizzle(d1 as never), dialect: 'sqlite' }),
    tableName: `queue_jobs_${++tableCounter}`,
    now,
  });
  await queue.migrate();
  return { queue };
});

describe('D1 inside a Worker', () => {
  it.each(['client', 'drizzle'])('runs the claim statement in workerd and acks every job exactly once (%s)', async (via) => {
    const response = await mf.dispatchFetch('http://queue.test/', {
      method: 'POST',
      body: JSON.stringify({ table: `queue_jobs_worker_${via}`, jobs: 60, claimers: 4, via }),
    });
    expect(response.status).toBe(200);
    const { acked, size } = (await response.json()) as { acked: string[][]; size: number };
    const all = acked.flat();
    expect(all).toHaveLength(60);
    expect(new Set(all).size).toBe(60);
    expect(size).toBe(0);
  });

  it('uses the shipped SQLite migration on D1', async () => {
    const sql = readFileSync(join(packageRoot, 'migrations/sqlite/0001_queue_jobs.sql'), 'utf8').replaceAll(
      '"queue_jobs',
      '"queue_jobs_shipped'
    );
    for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
      await d1.prepare(statement).bind().all();
    }
    const queue = new DatabaseQueueAdapter<string>({ client: createD1QueueClient(d1), tableName: 'queue_jobs_shipped' });
    const { id } = await queue.enqueue('jobs', 'x', { dedupeKey: 'k' });
    expect(await queue.enqueue('jobs', 'y', { dedupeKey: 'k' })).toEqual({ id, deduplicated: true });
    expect(await queue.claim('jobs', { leaseMs: 1_000 })).toEqual({ id, payload: 'x', attempt: 1 });
  });
});
