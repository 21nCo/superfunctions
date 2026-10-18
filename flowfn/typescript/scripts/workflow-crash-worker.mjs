import { createFlow, RedisAdapter, PostgresAdapter } from '../dist/index.mjs';
import { Redis } from 'ioredis';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
const config = JSON.parse(process.env.FLOWFN_CRASH_CONFIG);
let pool;
const adapter = config.kind === 'redis'
  ? new RedisAdapter({ connection: new Redis(process.env.FLOWFN_REDIS_URL), prefix: config.scope })
  : new PostgresAdapter({ db: drizzle(pool = new pg.Pool({ connectionString: process.env.FLOWFN_POSTGRES_URL })), schema: config.scope });
const flow = createFlow({ adapter });
const workflow = flow.workflow(config.name).ownership({ leaseDuration: 180 })
  .step('effect', async ctx => { await flow.stream(config.name).publish({ effect: true, empty: [] }); ctx.set('saved', 5); })
  .waitForEvent('go')
  .step('finish', async (ctx, value) => { ctx.set('total', ctx.get('saved') + value); })
  .waitForApproval('ops', { timeout: 10_000 })
  .step('approved', async (ctx, decision) => { ctx.set('approved', decision.approved); return ctx.get('total'); }).build();
if (!config.executionId) {
  const execution = await workflow.execute({ values: [], nested: { empty: [] } });
  while ((await workflow.getExecution(execution.id)).waiting?.kind !== 'event') await new Promise(resolve => setTimeout(resolve, 5));
  process.send({ executionId: execution.id });
} else {
  await workflow.startRecovery({ interval: 20 });
  const result = await workflow.waitForCompletion(config.executionId);
  process.send({ result });
  await flow.close();
  await pool?.end();
  process.disconnect();
}
