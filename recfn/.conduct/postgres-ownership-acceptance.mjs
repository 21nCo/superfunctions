/** Owned local PostgreSQL acceptance. Requires a cached postgres:16-bookworm image. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { createDbStore } from '../server/dist/store/db.js';
import { getRecFnSchema } from '../server/dist/store/schema.js';
import { validateBotConfig } from '../core/dist/index.js';

const name = `recfn-pg-acceptance-${randomUUID().slice(0, 8)}`;
const image = 'postgres:16-bookworm';
const root = await mkdtemp(join(tmpdir(), 'recfn-pg-acceptance-'));
const calls = join(root, 'provider-calls');
const children = [];
const databases = new Set();
let containerId;
let result;
const docker = (...args) => {
  const value = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  if (value.status !== 0) throw new Error(`docker ${args[0]}: ${value.stderr || value.error}`);
  return value.stdout.trim();
};
const waitFor = async (test, description, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  while (!await test()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const schema = getRecFnSchema();
const names = Object.fromEntries(Object.keys(schema).map(name => [name, name]));
const input = { namespace: 'native-pg', platform: 'zoom', meetingUrl: 'https://zoom.us/j/123', config: validateBotConfig({ recordingFormat: 'audio_only', enableRealTimeTranscript: false }) };
let connection;
function connect() {
  const pool = new pg.Pool({ ...connection, max: 1, connectionTimeoutMillis: 3000, options: '-c statement_timeout=10000 -c lock_timeout=5000' });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) }); databases.add(db);
  const adapter = kyselyAdapter({ db, dialect: 'postgres', schema: names });
  return { db, adapter, store: createDbStore({ adapter, durable: true, maxConcurrentBots: 1 }), close: async () => { await db.destroy(); databases.delete(db); } };
}
try {
  docker('image', 'inspect', image); // Never pull an unrequested image.
  containerId = docker('run', '--detach', '--name', name, '--label', 'recfn.acceptance=owned', '--cpus', '1', '--memory', '256m',
    '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw,size=128m',
    '--env', 'POSTGRES_USER=recfn', '--env', 'POSTGRES_PASSWORD=local-fixture-only', '--env', 'POSTGRES_DB=recfn', image);
  const port = Number(docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', name));
  connection = { host: '127.0.0.1', port, user: 'recfn', password: 'local-fixture-only', database: 'recfn' };
  await waitFor(() => spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'recfn', '-d', 'recfn'], { timeout: 5000 }).status === 0, 'PostgreSQL readiness', 30000);
  let parent = connect();
  const version = (await sql`select version() as version, current_setting('transaction_isolation') as isolation`.execute(parent.db)).rows[0];
  for (const [name, table] of Object.entries(schema)) {
    let query = parent.db.schema.createTable(name);
    for (const [field, definition] of Object.entries(table.fields)) {
      const type = definition.type === 'number' ? 'double precision' : definition.type === 'boolean' ? 'boolean' : definition.type === 'json' ? (definition.jsonStorageType === 'json-text' ? 'text' : 'jsonb') : definition.type === 'date' ? (definition.dateStorageType === 'iso-text' ? 'text' : 'timestamptz') : 'text';
      query = query.addColumn(field, type, column => {
        if (field === 'id') column = column.primaryKey(); else if (definition.unique) column = column.unique();
        return definition.required ? column.notNull() : column;
      });
    }
    await query.execute();
    for (const index of table.indexes ?? []) {
      let query = parent.db.schema.createIndex(index.name).on(name).columns(index.fields);
      if (index.unique) query = query.unique(); await query.execute();
    }
  }
  await parent.close();
  const start = (mode, namespace = 'native-pg') => {
    const source = `import pg from 'pg';import{Kysely,PostgresDialect}from'kysely';import{kyselyAdapter}from'@superfunctions/db/adapters';import{createDbStore,createBotWorker,MemoryQueueAdapter,MemoryLogger}from${JSON.stringify(new URL('../server/dist/index.js', import.meta.url).href)};import{appendFileSync}from'node:fs';import{once}from'node:events';
const queries=[];const db=new Kysely({dialect:new PostgresDialect({pool:new pg.Pool({...${JSON.stringify(connection)},max:1,connectionTimeoutMillis:3000,options:'-c statement_timeout=10000 -c lock_timeout=5000'})}),log:e=>{if(e.level==='query')queries.push(e.query.sql)}});
const base=kyselyAdapter({db,dialect:'postgres',schema:${JSON.stringify(names)}});const adapter={...base,transaction:fn=>base.transaction(tx=>fn({...tx,upsert:async args=>{const value=await tx.upsert(args);if(args.model==='botAdmission')await new Promise(r=>setTimeout(r,100));return value;}}))};const store=createDbStore({adapter,durable:true,maxConcurrentBots:1});
console.log('ready');await once(process.stdin,'data');let receipt;
if(${JSON.stringify(mode)}==='admit'){try{const bot=await store.createBot(${JSON.stringify({ ...input, namespace })});receipt={accepted:true,id:bot.id}}catch(error){receipt={accepted:false,code:error.code,message:error.message,constraint:error.constraint}}}
else{const worker=createBotWorker({environment:'test',store,queue:new MemoryQueueAdapter(),logger:new MemoryLogger(),recoveryNamespaces:[${JSON.stringify(namespace)}],platformAdapterFactories:new Map([['zoom',()=>({async join(){appendFileSync(${JSON.stringify(calls)},'join\\n');console.log('provider-started');${mode === 'hang' ? 'await new Promise(()=>{});' : "throw new Error('remote accepted, ACK lost');"}},async leave(){}})]])});receipt={processed:await worker.processNext()};await worker.cancelCaptures();}
await adapter.close();console.log(JSON.stringify({receipt,queries}));process.stdin.destroy();`;
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('../..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
    const value = { process, exited: once(process, 'exit'), stdout: '', stderr: '' }; children.push(value);
    process.stdout.on('data', data => { value.stdout += String(data); }); process.stderr.on('data', data => { value.stderr += String(data); });
    return value;
  };
  const runPair = async (mode, namespace = 'native-pg') => {
    const pair = [start(mode, namespace), start(mode, namespace)];
    await waitFor(() => pair.every(value => value.stdout.includes('ready\n')), `${mode} workers ready`);
    for (const value of pair) value.process.stdin.end('go\n');
    await waitFor(() => pair.every(value => value.process.exitCode !== null), `${mode} workers exit`, 15000);
    await Promise.all(pair.map(value => value.exited));
    return pair.map(value => { assert.equal(value.process.exitCode, 0, value.stderr); return JSON.parse(value.stdout.trim().split('\n').at(-1)); });
  };
  // Existing installation: expose the redundant uniqueness failure, then
  // perform the explicit migration only after both old writers have exited.
  parent = connect();
  assert.notEqual(schema.botAdmission.fields.namespace.unique, true);
  await sql`alter table "botAdmission" add constraint fixture_legacy_namespace_uniqueness unique (namespace)`.execute(parent.db);
  await parent.close();
  let legacyConstraint;
  let legacyNamespace;
  let legacyAttempts = 0;
  for (; legacyAttempts < 20 && !legacyConstraint; legacyAttempts++) {
    legacyNamespace = `legacy-pg-${legacyAttempts}`;
    const legacy = await runPair('admit', legacyNamespace);
    assert.equal(legacy.filter(value => value.receipt.accepted).length, 1, JSON.stringify(legacy));
    const loser = legacy.find(value => !value.receipt.accepted).receipt;
    assert.ok(['23505', 'RATE_LIMIT_EXCEEDED'].includes(loser.code), JSON.stringify(legacy));
    if (loser.code === '23505') legacyConstraint = loser.constraint;
  }
  assert.ok(legacyConstraint, 'Bounded legacy race must reproduce namespace uniqueness failure');
  parent = connect();
  const redundant = await sql`select conname from pg_constraint where conrelid = '"botAdmission"'::regclass and contype = 'u'
    and conkey = array[(select attnum from pg_attribute where attrelid = '"botAdmission"'::regclass and attname = 'namespace')]::smallint[]`.execute(parent.db);
  assert.deepEqual(redundant.rows.map(row => row.conname), [legacyConstraint]);
  for (const row of redundant.rows) await sql`alter table ${sql.id('botAdmission')} drop constraint ${sql.id(row.conname)}`.execute(parent.db);
  const primary = await sql`select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = '"botAdmission"'::regclass and contype = 'p'`.execute(parent.db);
  assert.deepEqual(primary.rows.map(row => row.definition), ['PRIMARY KEY (id)']);
  assert.equal((await parent.store.listBots(legacyNamespace, {})).items.length, 1); // Existing records retained.
  await parent.close();
  const admitted = await runPair('admit');
  assert.equal(admitted.filter(value => value.receipt.accepted).length, 1, JSON.stringify(admitted));
  assert.equal(admitted.find(value => !value.receipt.accepted).receipt.code, 'RATE_LIMIT_EXCEEDED', JSON.stringify(admitted));
  for (const value of admitted) {
    const first = value.queries.find(query => !/^(begin|commit|rollback)/i.test(query));
    assert.match(first, /insert into "botAdmission"/); assert.match(first, /on conflict/);
  }
  const botId = admitted.find(value => value.receipt.accepted).receipt.id;
  parent = connect();
  assert.deepEqual((await parent.store.getBot(botId, input.namespace)).config, input.config);
  assert.equal(typeof (await parent.store.getBot(botId, input.namespace)).createdAt, 'string');
  await parent.close();
  // No queue delivery remains: fresh workers must use the durable pending intent.
  await runPair('worker');
  assert.equal(await readFile(calls, 'utf8'), 'join\n');
  parent = connect();
  let work = await parent.store.getBotWork(botId, input.namespace);
  assert.equal(work.state, 'uncertain'); assert.equal(work.heldTerminalCapacity, true);
  assert.equal((await parent.store.getBot(botId, input.namespace)).status, 'error');
  await assert.rejects(parent.store.createBot(input), error => error.code === 'RATE_LIMIT_EXCEEDED');
  await assert.rejects(parent.store.updateBot(botId, input.namespace, { status: 'leaving' }));
  await sql`create function reject_owner_completion() returns trigger language plpgsql as $$ begin raise exception 'fixture completion rollback'; end; $$`.execute(parent.db);
  await sql`create trigger reject_owner_completion before update on bots for each row execute function reject_owner_completion()`.execute(parent.db);
  await assert.rejects(parent.store.completeBotWork(botId, input.namespace, work.ownerToken, 'error', 'Local fixture stopped'), /fixture completion rollback/);
  assert.equal((await parent.store.getBotWork(botId, input.namespace)).state, 'uncertain');
  assert.equal((await parent.store.getBotWork(botId, input.namespace)).heldTerminalCapacity, true);
  await sql`drop trigger reject_owner_completion on bots`.execute(parent.db);
  await parent.close(); parent = connect();
  await assert.rejects(parent.store.createBot(input), error => error.code === 'RATE_LIMIT_EXCEEDED');
  await parent.store.reconcileBotWork(botId, input.namespace, work.ownerToken, { workerStopped: true, providerStopped: true, reason: 'Owned fixture workers exited; local provider has no external session.' });
  work = await parent.store.getBotWork(botId, input.namespace); assert.equal(work.state, 'closed'); assert.equal(work.heldTerminalCapacity, false);
  const killedBot = await parent.store.createBot(input); await parent.close();
  const killed = start('hang'); await waitFor(() => killed.stdout.includes('ready\n'), 'kill fixture ready'); killed.process.stdin.end('go\n');
  await waitFor(() => killed.stdout.includes('provider-started\n'), 'provider invocation before kill'); killed.process.kill('SIGKILL'); await killed.exited; assert.equal(killed.process.signalCode, 'SIGKILL');
  const later = start('worker'); await waitFor(() => later.stdout.includes('ready\n'), 'reopened worker ready'); later.process.stdin.end('go\n');
  await waitFor(() => later.process.exitCode !== null, 'reopened worker exit'); await later.exited; assert.equal(later.process.exitCode, 0, later.stderr);
  assert.equal(JSON.parse(later.stdout.trim().split('\n').at(-1)).receipt.processed, false);
  assert.equal(await readFile(calls, 'utf8'), 'join\njoin\n');
  parent = connect();
  assert.equal((await parent.store.getBotWork(killedBot.id, input.namespace)).state, 'owned');
  await assert.rejects(parent.store.createBot(input), error => error.code === 'RATE_LIMIT_EXCEEDED');
  // A bot and pending intent commit together; failure inserting intent cannot
  // leave a capacity-consuming bot with no recoverable work.
  await sql`create trigger reject_intent_insert before insert on "botWork" for each row execute function reject_owner_completion()`.execute(parent.db);
  await assert.rejects(parent.store.createBot({ ...input, namespace: 'rollback-pg' }), /fixture completion rollback/);
  assert.equal((await parent.store.listBots('rollback-pg', {})).items.length, 0);
  assert.equal((await parent.store.listPendingBotJoins('rollback-pg')).length, 0);
  await sql`drop trigger reject_intent_insert on "botWork"`.execute(parent.db);
  const other = await parent.store.createBot({ ...input, namespace: 'other-pg' });
  await sql`create trigger reject_claim_status before update on bots for each row when (NEW.status = 'joining') execute function reject_owner_completion()`.execute(parent.db);
  await assert.rejects(parent.store.claimBotJoin(other.id, 'other-pg', 'failed-claim'), /fixture completion rollback/);
  assert.equal((await parent.store.getBotWork(other.id, 'other-pg')).state, 'pending');
  assert.equal((await parent.store.getBot(other.id, 'other-pg')).status, 'creating');
  await sql`drop trigger reject_claim_status on bots`.execute(parent.db);
  assert.equal((await parent.store.claimBotJoin(other.id, 'other-pg', 'successful-claim')).status, 'joining');
  await assert.rejects(parent.store.completeBotWork(other.id, 'other-pg', 'wrong-token', 'done', 'No provider was invoked'));
  await parent.store.completeBotWork(other.id, 'other-pg', 'successful-claim', 'done', 'Fixture claimed store only; no provider was invoked');
  await parent.close(); parent = connect();
  assert.equal((await parent.store.getBot(other.id, 'other-pg')).status, 'done');
  assert.equal((await parent.store.getBotWork(other.id, 'other-pg')).state, 'closed');
  await parent.store.createBot({ ...input, namespace: 'other-pg' });
  await assert.rejects(createDbStore({ adapter: parent.adapter, durable: true, maxConcurrentBots: 2 }).createBot({ ...input, namespace: 'other-pg' }), /persisted namespace policy/);
  await parent.db.updateTable('botAdmission').set({ namespace: 'tampered-pg' }).where('namespace', '=', 'other-pg').execute();
  await assert.rejects(parent.store.createBot({ ...input, namespace: 'other-pg' }), /persisted namespace policy/);
  await parent.close();
  result = { postgres: version, legacyAttempts, legacyConstraintViolation: '23505', removedLegacyConstraint: legacyConstraint, idPrimaryKeyPreserved: true, policyAndIdentityMismatchRejected: true, adapter: 'shared Kysely/PostgreSQL', physicalSchema: 'Declared JSON/date TEXT; native PostgreSQL boolean and double precision numbers', independentChildren: children.length, admissionWinners: 1, providerCallsPerBot: 1, heldCapacityReopen: true, atomicCompletionRollback: true, atomicPendingIntentRollback: true, atomicClaimRollback: true, namespaceIsolation: true, successfulClosureReopen: true, killedOwnerNoTakeover: true };
} finally {
  for (const value of children) {
    if (value.process.exitCode === null && value.process.signalCode === null) value.process.kill('SIGKILL');
    await value.exited;
  }
  for (const db of databases) await db.destroy();
  if (containerId) {
    docker('rm', '--force', containerId);
    const check = spawnSync('docker', ['inspect', containerId], { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(check.status, 0, 'Owned container must be absent after removal');
    assert.match(check.stderr, /No such (object|container)/i, 'Readback must prove absence, not a Docker connection error');
  }
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...result, containerRemoved: name, containerId, temporaryDirectoryRemoved: root }, null, 2));
