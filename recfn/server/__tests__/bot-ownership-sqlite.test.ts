import { expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { validateBotConfig } from '@recfn/core';
import { createDbStore } from '../src/store/db.js';
import { getRecFnSchema } from '../src/store/schema.js';
import { MemoryQueueAdapter } from '../src/integrations/flowfn.js';

it('recovers lost queue work once across independent workers and never takes over a killed owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recfn-owner-native-')); const filename = join(root, 'state.sqlite'); const calls = join(root, 'provider-calls.txt');
  const schema = getRecFnSchema(); const names = Object.fromEntries(Object.keys(schema).map(key => [key, key]));
  let db: Kysely<any> | undefined;
  const children: Array<{ process: ReturnType<typeof spawn>; exited: Promise<unknown>; stdout: string; stderr: string }> = [];
  const connect = () => { db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(filename) }) }); return kyselyAdapter({ db, dialect: 'sqlite', schema: names }); };
  const input = { namespace: 'ns', meetingUrl: 'https://zoom.us/j/123', platform: 'zoom' as const, config: validateBotConfig({ enableRealTimeTranscript: false, recordingFormat: 'audio_only' }) };
  try {
    let adapter = connect();
    for (const [name, table] of Object.entries(schema)) {
      let query = db!.schema.createTable(name);
      for (const [field, definition] of Object.entries(table.fields)) query = query.addColumn(field, definition.type === 'number' ? 'real' : definition.type === 'boolean' ? 'integer' : 'text', column => {
        if (field === 'id') column = column.primaryKey(); else if (definition.unique) column = column.unique(); return definition.required ? column.notNull() : column;
      });
      await query.execute();
    }
    let store = createDbStore({ adapter, durable: true, maxConcurrentBots: 1 }); const bot = await store.createBot(input);
    const queue = new MemoryQueueAdapter(); const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = async (...args) => { await enqueue(...args); throw new Error('ACK lost'); };
    await expect(queue.enqueue('recfn.bot.join', { type: 'bot.join', data: { botId: bot.id, namespace: 'ns' }, createdAt: new Date().toISOString() })).rejects.toThrow('ACK lost');
    expect(await queue.dequeue('recfn.bot.join')).not.toBeNull(); // Dequeued worker crashes before invoking provider.
    await adapter.close(); db = undefined;
    const child = (hang: boolean, admission = false) => {
      const source = `import Database from 'better-sqlite3';import {Kysely,SqliteDialect}from'kysely';import{kyselyAdapter}from'@superfunctions/db/adapters';import{createDbStore,createBotWorker,MemoryQueueAdapter,MemoryLogger}from ${JSON.stringify(resolve('dist/index.js'))};import{appendFileSync}from'node:fs';import{once}from'node:events';
const native=new Database(${JSON.stringify(filename)});native.pragma('busy_timeout = 3000');const db=new Kysely({dialect:new SqliteDialect({database:native})});const base=kyselyAdapter({db,dialect:'sqlite',schema:${JSON.stringify(names)}});const adapter={...base,transaction:fn=>base.transaction(tx=>fn({...tx,update:async args=>{const result=await tx.update(args);if(args.model==='botWork'&&args.data.state==='uncertain'){console.log('error-transition-locked');await new Promise(resolve=>setTimeout(resolve,200));}return result;}}))};const store=createDbStore({adapter,durable:true,maxConcurrentBots:1});
const worker=createBotWorker({environment:'test',store,queue:new MemoryQueueAdapter(),logger:new MemoryLogger(),recoveryNamespaces:['ns'],platformAdapterFactories:new Map([['zoom',()=>({async join(){appendFileSync(${JSON.stringify(calls)},'join\\n');console.log('provider-started');${hang ? "await new Promise(()=>{});" : "await new Promise(resolve=>setTimeout(resolve,100));throw new Error('remote accepted, ACK lost');"}},async leave(){}})]])});console.log('ready');await once(process.stdin,'data');${admission ? `try{await store.createBot(${JSON.stringify(input)});console.log('unexpected-admission')}catch(error){console.log(error.code)}` : `const processed=await worker.processNext();await worker.cancelCaptures();console.log(JSON.stringify({processed}));`}await adapter.close();process.stdin.destroy();`;
      const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
      const result = { process, exited: once(process, 'exit'), stdout: '', stderr: '' }; children.push(result);
      process.stdout!.on('data', data => { result.stdout += String(data); }); process.stderr!.on('data', data => { result.stderr += String(data); }); return result;
    };
    const racers = [child(false), child(false)];
    const racingAdmission = child(false, true);
    await expect.poll(() => racers.every(value => value.stdout.includes('ready\n')), { timeout: 5000 }).toBe(true);
    for (const value of racers) value.process.stdin!.end('go\n');
    await expect.poll(() => racers.some(value => value.stdout.includes('error-transition-locked\n')) && racingAdmission.stdout.includes('ready\n'), { timeout: 5000 }).toBe(true);
    racingAdmission.process.stdin!.end('go\n');
    await Promise.all([...racers, racingAdmission].map(value => value.exited));
    expect(racingAdmission.process.exitCode, racingAdmission.stderr).toBe(0);
    expect(racingAdmission.stdout).toContain('RATE_LIMIT_EXCEEDED');
    expect(racingAdmission.stdout).not.toContain('unexpected-admission');
    for (const value of racers) { expect(value.process.exitCode, value.stderr).toBe(0); }
    expect(await readFile(calls, 'utf8')).toBe('join\n');
    adapter = connect(); store = createDbStore({ adapter, durable: true, maxConcurrentBots: 1 });
    const uncertain = await store.getBotWork(bot.id, 'ns'); expect(uncertain).toMatchObject({ state: 'uncertain', heldTerminalCapacity: true });
    expect(await store.getBot(bot.id, 'ns')).toMatchObject({ status: 'error' });
    await expect(store.createBot(input)).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    await sql`CREATE TRIGGER reject_owner_completion BEFORE UPDATE ON bots BEGIN SELECT RAISE(ABORT, 'fixture atomic completion failure'); END`.execute(db!);
    await expect(store.completeBotWork(bot.id, 'ns', uncertain!.ownerToken!, 'error', 'Local fixture stop established')).rejects.toThrow('fixture atomic completion failure');
    expect(await store.getBotWork(bot.id, 'ns')).toMatchObject({ state: 'uncertain', heldTerminalCapacity: true });
    await expect(store.createBot(input)).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    await sql`DROP TRIGGER reject_owner_completion`.execute(db!);
    await store.reconcileBotWork(bot.id, 'ns', uncertain!.ownerToken!, { workerStopped: true, providerStopped: true, reason: 'Fixture worker processes exited; local provider has no external session.' });
    const killedBot = await store.createBot(input); await adapter.close(); db = undefined;
    const killed = child(true);
    await expect.poll(() => killed.stdout.includes('ready\n'), { timeout: 5000 }).toBe(true); killed.process.stdin!.end('go\n');
    await expect.poll(() => killed.stdout.includes('provider-started\n'), { timeout: 5000 }).toBe(true);
    killed.process.kill('SIGKILL'); await killed.exited; expect(killed.process.signalCode).toBe('SIGKILL');
    const reopened = child(false);
    await expect.poll(() => reopened.stdout.includes('ready\n'), { timeout: 5000 }).toBe(true); reopened.process.stdin!.end('go\n'); await reopened.exited;
    expect(reopened.process.exitCode, reopened.stderr).toBe(0); expect(reopened.stdout).toContain('"processed":false');
    expect(await readFile(calls, 'utf8')).toBe('join\njoin\n');
    adapter = connect(); store = createDbStore({ adapter, durable: true, maxConcurrentBots: 1 });
    expect(await store.getBotWork(killedBot.id, 'ns')).toMatchObject({ state: 'owned' });
    expect(await store.getBot(killedBot.id, 'ns')).toMatchObject({ status: 'joining' });
    await expect(store.createBot(input)).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  } finally {
    for (const value of children) { if (value.process.exitCode === null && value.process.signalCode === null) value.process.kill('SIGKILL'); await value.exited; }
    await db?.destroy(); await rm(root, { recursive: true, force: true });
  }
}, 15000);
