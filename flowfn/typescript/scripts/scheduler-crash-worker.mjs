import { createFlow, DurableScheduler, RedisAdapter, PostgresAdapter } from '../dist/index.mjs';
import { Redis } from 'ioredis';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
const config = JSON.parse(process.env.FLOWFN_CRASH_CONFIG);
let pool;
const adapter = config.kind === 'redis'
  ? new RedisAdapter({ connection: new Redis(process.env.FLOWFN_REDIS_URL), prefix: config.scope })
  : new PostgresAdapter({ db: drizzle(pool = new pg.Pool({ connectionString: process.env.FLOWFN_POSTGRES_URL })), schema: config.scope });
const flow = createFlow({ adapter });
const scheduler = new DurableScheduler(adapter, config.name, 180);
await scheduler.schedule('work', { every: 20, limit: 1 }, async (_data, context) => {
  await flow.stream(config.name).publish({ occurrence: context.occurrence });
  if (!config.resume) { process.send({ started: true }); await new Promise(() => undefined); }
});
if (config.resume) {
  while ((await scheduler.list()).length) await new Promise(resolve => setTimeout(resolve, 10));
  process.send({ completed: true });
  await scheduler.close(); await flow.close(); await pool?.end(); process.disconnect();
}
