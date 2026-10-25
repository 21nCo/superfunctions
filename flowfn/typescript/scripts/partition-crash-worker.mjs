import { PostgresAdapter } from '../dist/index.mjs';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
const { schema, stream, group } = JSON.parse(process.env.FLOWFN_PARTITION_CRASH_CONFIG);
const pool = new pg.Pool({ connectionString: process.env.FLOWFN_POSTGRES_URL });
const adapter = new PostgresAdapter({ db: drizzle(pool), schema, pollInterval: 10 });
// Owned acceptance child: the parent kills it after the first durable delivery.
setTimeout(() => process.exit(2), 30_000).unref();
await adapter.consume(stream, group, 'killed-owner', async message => {
  process.send({ id: message.id, partition: message.partition });
  await new Promise(() => {});
}, { groupId: group, fromBeginning: true, maxInFlight: 1, autoCommit: false, visibilityTimeout: 300 });
