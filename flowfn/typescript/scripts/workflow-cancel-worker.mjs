import { createFlow, RedisAdapter, PostgresAdapter } from '../dist/index.mjs';
import { Redis } from 'ioredis';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
const config = JSON.parse(process.env.FLOWFN_CANCEL_CONFIG);
let pool;
const adapter = config.kind === 'redis'
  ? new RedisAdapter({ connection: new Redis(process.env.FLOWFN_REDIS_URL), prefix: config.scope })
  : new PostgresAdapter({ db: drizzle(pool = new pg.Pool({ connectionString: process.env.FLOWFN_POSTGRES_URL })), schema: config.scope });
const flow = createFlow({ adapter });
const workflow = flow.workflow(config.name).ownership({ leaseDuration: 1000 })
  .saga('effect', {
    execute: async () => { await flow.stream(config.name).publish({ phase: 'effect' }); },
    compensate: async () => { await flow.stream(config.name).publish({ phase: 'compensated' }); },
  })
  .step('wait', async ctx => {
    process.send({ executionId: ctx.executionId });
    await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true }));
  }).build();
let executionId = config.executionId;
if (executionId) await workflow.startRecovery({ interval: 20 });
else executionId = (await workflow.execute({})).id;
const result = await workflow.waitForCompletion(executionId);
process.send({ result });
await flow.close();
await pool?.end();
process.disconnect();
