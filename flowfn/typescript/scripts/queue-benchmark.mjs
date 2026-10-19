/** Local queue measurements, not certification of production performance. */
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { createFlow, MemoryAdapter, RedisAdapter, PostgresAdapter } from '../dist/index.mjs';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
const count = Number(process.env.FLOWFN_BENCHMARK_JOBS ?? 1000);
const producers = Number(process.env.FLOWFN_BENCHMARK_PRODUCERS ?? 1);
if (!Number.isInteger(producers) || producers < 1) throw new Error("Invalid producer count");
if (!Number.isInteger(count) || count < 1) throw new Error('Invalid benchmark job count');
const p99 = values => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * .99) - 1)] ?? null;
const cases = [{ name: 'memory', setup: async () => ({ adapter: new MemoryAdapter(), cleanup: async () => {} }) }];
if (process.env.FLOWFN_REDIS_URL) cases.push({ name: 'redis', setup: async () => {
  const redis = new Redis(process.env.FLOWFN_REDIS_URL);
  const prefix = `flowfn-benchmark-${randomUUID()}:`;
  return { adapter: new RedisAdapter({ connection: redis, prefix }), cleanup: async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
  } };
} });
if (process.env.FLOWFN_POSTGRES_URL) cases.push({ name: 'postgres', setup: async () => {
  const pool = new Pool({ connectionString: process.env.FLOWFN_POSTGRES_URL });
  const schema = `flowfn_benchmark_${randomUUID().replaceAll('-', '')}`;
  const adapter = new PostgresAdapter({ db: drizzle(pool), schema });
  await adapter.initialize();
  return { adapter, cleanup: async () => { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); } };
} });
for (const entry of cases) {
  const { adapter, cleanup } = await entry.setup();
  const enqueue = [], dequeue = [], latency = [];
  const original = adapter.dequeue.bind(adapter);
  adapter.dequeue = async (...args) => {
    const start = performance.now();
    const job = await original(...args);
    if (job) dequeue.push(performance.now() - start);
    return job;
  };
  const flow = createFlow({ adapter });
  const queue = flow.queue('benchmark');
  let processed = 0;
  global.gc?.();
  const baseline = process.memoryUsage();
  const start = performance.now();
  queue.process(16, async job => { processed++; latency.push(Date.now() - job.timestamp); return job.data.value + 1; });
  try {
    let next = 0;
    await Promise.all(Array.from({ length: producers }, async () => {
      for (;;) {
        const value = next++;
        if (value >= count) return;
        const before = performance.now();
        await queue.add('work', { value });
        enqueue.push(performance.now() - before);
      }
    }));
    await queue.drain();
    const elapsedMs = performance.now() - start;
    global.gc?.();
    const memory = process.memoryUsage();
    if (processed !== count) throw new Error('Benchmark lost or duplicated jobs');
    const result = { adapter: entry.name, node: process.version, jobs: count, producers, concurrency: 16, elapsedMs, jobsPerSecond: count * 1000 / elapsedMs, enqueueP99Ms: p99(enqueue), dequeueP99Ms: p99(dequeue), queueToHandlerP99Ms: p99(latency), rssBefore: baseline.rss, rssAfter: memory.rss, heapDeltaPerRetainedJob: (memory.heapUsed - baseline.heapUsed) / count, gcControlled: typeof global.gc === 'function' };
    result.targets = { enqueueP99: result.enqueueP99Ms < 5, dequeueP99: result.dequeueP99Ms < 10, queueToHandlerP99: result.queueToHandlerP99Ms < 100, throughput: entry.name === 'memory' ? null : result.jobsPerSecond >= (entry.name === 'redis' ? 10000 : 1000) };
    console.log(JSON.stringify(result));
  } finally {
    await queue.close();
    // Redis owns its connection: delete owned keys before flow.close disconnects it.
    await cleanup();
    await flow.close();
  }
}
