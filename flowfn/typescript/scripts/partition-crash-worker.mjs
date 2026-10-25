import { PostgresAdapter, RedisAdapter } from '../dist/index.mjs';
const { provider = 'postgres', schema, prefix, stream, group } = JSON.parse(process.env.FLOWFN_PARTITION_CRASH_CONFIG);
let adapter;
if (provider === 'redis') {
  const { default: Redis } = await import('ioredis');
  adapter = new RedisAdapter({ connection: new Redis(process.env.FLOWFN_REDIS_URL), prefix });
} else {
  const { default: pg } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  adapter = new PostgresAdapter({ db: drizzle(new pg.Pool({ connectionString: process.env.FLOWFN_POSTGRES_URL })), schema, pollInterval: 10 });
}
// Owned acceptance child: the parent kills it after the first durable delivery.
setTimeout(() => process.exit(2), 30_000).unref();
await adapter.consume(stream, group, 'killed-owner', async message => {
  process.send({ id: message.id, partition: message.partition });
  await new Promise(() => {});
}, { groupId: group, fromBeginning: true, maxInFlight: 1, autoCommit: false, visibilityTimeout: 300 });
