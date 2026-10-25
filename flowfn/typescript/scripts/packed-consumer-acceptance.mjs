/** Verify packed FlowFn and local shared prerequisites in an isolated install. */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const npm = (args, cwd = fixture) => run(process.env.NPM_CLI ? process.execPath : 'npm', process.env.NPM_CLI ? [process.env.NPM_CLI, ...args] : args, cwd);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'flowfn-packed-'));
function run(program, args, cwd = fixture) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const packages = ['packages/observability', 'packages/http', 'mcpfn/core', 'packages/admin', 'flowfn/typescript', 'flowfn/admin'];
  const tars = packages.map(path => {
    const result = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', fixture], join(root, path)))[0];
    if (path === 'flowfn/typescript' && result.files.some(file => /^(src|tests|scripts)\//.test(file.path)))
      throw new Error('Core archive contains development-only files');
    return join(fixture, result.filename);
  });
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'flowfn-packed-acceptance', private: true, version: '1.0.0' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tars]);
  npm(['install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', 'typescript@5.9.3', '@types/node@20', ...(process.env.FLOWFN_POSTGRES_URL ? ['pg@8.23.1'] : []), ...(process.env.FLOWFN_REDIS_URL ? ['ioredis@5.11.1'] : [])]);
  npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  const installed = JSON.parse(npm(['ls', '--omit=dev', '--all', '--json']));
  assert.ok(installed.dependencies['@flowfn/core']);
  const body = `
let observed = 0;
const instrumentation = new FlowInstrumentation({ tracer: { startActiveSpan: (_name, _options, callback) => { observed++; return callback({ end() {}, recordException() {}, setStatus() {} }); } } });
instrumentation.enable();
const flow = createFlow({ adapter: new MemoryAdapter() });
const queue = flow.queue('packed');
queue.process(async job => job.data * 2);
const job = await queue.add('work', 21);
await queue.drain();
if ((await queue.getJob(job.id)).returnvalue !== 42) throw new Error('Packed processing failed');
const stream = flow.stream('partitioned', { partitions: 3 });
const first = await stream.publish(1, { key: 'tenantα' });
const later = await stream.publish(2, { key: 'tenantα' });
const other = await stream.publish(3, { partition: 0 });
const history = await stream.getMessages('-', '+');
if (history.map(m => m.partition).join(',') !== '2,2,0') throw new Error('Packed partition routing failed');
const delivered = [];
const consumer = stream.createConsumer('packed-owner', { groupId: 'packed-group', fromBeginning: true, autoCommit: false, maxInFlight: 3 });
await consumer.subscribe(async message => { delivered.push(message); });
await new Promise(resolve => setImmediate(resolve));
if (delivered.map(m => m.id).join(',') !== [first,other].join(',')) throw new Error('Packed partition exclusion failed');
await delivered[0].ack();
await new Promise(resolve => setImmediate(resolve));
if (delivered[2]?.id !== later) throw new Error('Packed partition progress failed');
for (const message of delivered) await message.ack();
await flow.close({ timeout: 1000 });
instrumentation.disable();
if (observed < 2) throw new Error('Packed instrumentation entry point does not share runtime state');
if (typeof RedisAdapter !== 'function' || typeof PostgresAdapter !== 'function') throw new Error('Missing adapter export');
if (typeof PostgresAdapter.prototype.migrateQueueOrderingSchema !== 'function') throw new Error('Missing explicit queue ordering migration');
`;
  writeFileSync(join(fixture, 'consumer.mjs'), `import { createFlow } from '@flowfn/core';\nimport { FlowInstrumentation } from '@flowfn/core/instrumentation';\nimport { MemoryAdapter } from '@flowfn/core/adapters/memory';\nimport { RedisAdapter } from '@flowfn/core/adapters/redis';\nimport { PostgresAdapter } from '@flowfn/core/adapters/postgres';\nimport * as admin from '@flowfn/admin';\nif (!admin.flowFnAdminCapability) throw new Error('Missing admin export');\n${body}`);
  writeFileSync(join(fixture, 'consumer.cjs'), `const { createFlow } = require('@flowfn/core');\nconst { FlowInstrumentation } = require('@flowfn/core/instrumentation');\nconst { MemoryAdapter } = require('@flowfn/core/adapters/memory');\nconst { RedisAdapter } = require('@flowfn/core/adapters/redis');\nconst { PostgresAdapter } = require('@flowfn/core/adapters/postgres');\n(async () => {${body}})().catch(error => { console.error(error); process.exitCode = 1; });`);

  run(process.execPath, ['-e', "const pkg=require('@flowfn/core/package.json');if(typeof require('@flowfn/core')[pkg.superfunctions.initFunction]!=='function')throw Error('Invalid initializer metadata')"]);
  const types = `import { FlowInstrumentation } from '@flowfn/core/instrumentation';\nnew FlowInstrumentation().enable();\nimport { createFlow, type Job, type BackoffStrategy } from '@flowfn/core';\nimport { MemoryAdapter } from '@flowfn/core/adapters/memory';\nimport { RedisAdapter } from '@flowfn/core/adapters/redis';\nimport { PostgresAdapter } from '@flowfn/core/adapters/postgres';\nconst strategy: BackoffStrategy = (attempt, error, job) => attempt;\nconst queue = createFlow({ adapter: new MemoryAdapter() }).queue<{ value: number }>('typed', { backoffStrategies: { strategy } });\nqueue.process(async job => job.data.value);\nvoid queue.close({ timeout: 1000 });\nvoid RedisAdapter; void PostgresAdapter.prototype.migrateQueueOrderingSchema;\n`;
  writeFileSync(join(fixture, 'consumer.mts'), types);
  writeFileSync(join(fixture, 'consumer.cts'), types);
  writeFileSync(join(fixture, 'admin.mts'), `import {createFlow,MemoryJobStorage,MemoryDLQManager,MemoryEventLog} from '@flowfn/core';
import {createFlowFnDomainAdminAdapter} from '@flowfn/admin';
const flow=createFlow({adapter:'memory'});
createFlowFnDomainAdminAdapter({flow,jobs:new MemoryJobStorage(),dlq:new MemoryDLQManager(),events:new MemoryEventLog(),installationId:'i',workspaceId:'w',projectId:'p',environmentId:'e',namespace:''});`);
  writeFileSync(join(fixture, 'admin.cts'), `async function load(){const api=await import('@flowfn/admin');return api.createFlowFnDomainAdminAdapter;}void load;`);
  for (const mode of ['Node16', 'NodeNext']) run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--noEmit', '--module', mode, '--moduleResolution', mode, '--target', 'ES2022', 'consumer.mts', 'consumer.cts', 'admin.mts', 'admin.cts']);
  writeFileSync(join(fixture, 'admin.mjs'), `import assert from 'node:assert/strict';
import {createFlow,MemoryJobStorage,MemoryDLQManager,MemoryEventLog} from '@flowfn/core';
import {createFlowFnDomainAdminAdapter} from '@flowfn/admin';
import {createAdminDispatcher,createAdminRegistry,MemoryAdminIdempotencyStore} from '@superfunctions/admin';
const flow=createFlow({adapter:'memory',namespace:'tenant'});
try {
 const scope={installationId:'i',workspaceId:'w',projectId:'p',environmentId:'e',namespace:'tenant'};
 const adapter=createFlowFnDomainAdminAdapter({flow,jobs:new MemoryJobStorage(),dlq:new MemoryDLQManager(),events:new MemoryEventLog(),...scope});
 const dispatch=createAdminDispatcher({registry:createAdminRegistry({adapters:[adapter],enabledModules:['flowfn']}),idempotency:new MemoryAdminIdempotencyStore()});
 flow.queue('packed');
 const context={scope,actor:{id:'operator',type:'user',permissions:['*']},requestId:'packed',source:'console'};
 const listed=await dispatch.dispatch({operationId:'flowfn.queues.list',input:{},context});
 assert.equal(listed.ok,true,JSON.stringify(listed));assert.equal(listed.data.items[0].id,'packed');
 const denied=await dispatch.dispatch({operationId:'flowfn.queues.list',input:{},context:{...context,scope:{...scope,namespace:'other'}}});
 assert.equal(denied.ok,false);
} finally {await flow.close({timeout:1000});}`);
  writeFileSync(join(fixture, 'admin.cjs'), `import('./admin.mjs').catch(error=>{console.error(error);process.exitCode=1;});`);
  for (const version of (process.env.FLOWFN_NODE_VERSIONS ?? '20.0.0,20.20.0,22.23.3').split(',')) {
    for (const consumer of ['consumer.mjs','consumer.cjs','admin.mjs','admin.cjs']) npm(['exec','--yes',`--package=node@${version}`,'--','node',consumer]);
    console.log(JSON.stringify({node:version,coreESM:'passed',coreCJS:'passed',adminESM:'passed',adminDynamicCJS:'passed'}));
  }
  if (process.env.FLOWFN_POSTGRES_URL) {
    writeFileSync(join(fixture, 'partition-consumer.mjs'), readFileSync(new URL('./packed-partition-consumer.mjs', import.meta.url)));
    const result = spawnSync(process.execPath, ['partition-consumer.mjs'], { cwd: fixture, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(`Installed partition consumer failed\n${result.stdout}\n${result.stderr}`);
    console.log(result.stdout.trim());
  }
  if (process.env.FLOWFN_REDIS_URL) {
    writeFileSync(join(fixture, 'redis-partition-consumer.mjs'), readFileSync(new URL('./packed-redis-partition-consumer.mjs', import.meta.url)));
    const result = spawnSync(process.execPath, ['redis-partition-consumer.mjs'], { cwd: fixture, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(`Installed Redis partition consumer failed\n${result.stdout}\n${result.stderr}`);
    console.log(result.stdout.trim());
  }
  const audit = JSON.parse(npm(['audit', '--omit=dev', '--json']));
  assert.equal(audit.metadata.vulnerabilities.total,0);
  const lock=JSON.parse(readFileSync(join(fixture,'package-lock.json'),'utf8'));
  assert.equal(lock.packages['node_modules/@superfunctions/http'].version,'0.3.1');
  console.log(JSON.stringify({ runtime: process.version, esm: 'passed', commonjs: 'passed', types: 'passed', audit: audit.metadata.vulnerabilities, localPrerequisites: packages.slice(0, 4) }));
} finally { rmSync(fixture, { recursive: true, force: true }); }
