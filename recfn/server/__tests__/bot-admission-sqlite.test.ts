import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
const input = { namespace: 'ns', meetingUrl: 'https://zoom.us/j/123', platform: 'zoom' as const, config: validateBotConfig({ enableRealTimeTranscript: false, recordingFormat: 'audio_only' }) };

it('serializes independent SQLite processes, retains policy after reopen, and rolls back failed admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recfn-admission-native-')); const filename = join(root, 'state.sqlite');
  const schema = getRecFnSchema(); const names = Object.fromEntries(Object.keys(schema).map(key => [key, key]));
  let db: Kysely<any> | undefined;
  const children: Array<{ process: ReturnType<typeof spawn>; exited: Promise<unknown> }> = [];
  const connect = () => { db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(filename) }) }); return kyselyAdapter({ db, dialect: 'sqlite', schema: names }); };
  try {
    let adapter = connect();
    for (const [name, table] of Object.entries(schema)) {
      let query = db!.schema.createTable(name);
      for (const [field, definition] of Object.entries(table.fields)) query = query.addColumn(field, definition.type === 'number' ? 'real' : definition.type === 'boolean' ? 'integer' : 'text', column => {
        if (field === 'id') column = column.primaryKey(); else if (definition.unique) column = column.unique(); return definition.required ? column.notNull() : column;
      });
      await query.execute();
    }
    await adapter.close(); db = undefined;
    const source = `import Database from 'better-sqlite3';import {Kysely,SqliteDialect}from'kysely';import{kyselyAdapter}from'@superfunctions/db/adapters';import{createDbStore}from ${JSON.stringify(resolve('dist/store/db.js'))};import{once}from'node:events';
const native=new Database(${JSON.stringify(filename)});native.pragma('busy_timeout = 3000');const queries=[];
const db=new Kysely({dialect:new SqliteDialect({database:native}),log:event=>{if(event.level==='query')queries.push(event.query.sql)}});
const base=kyselyAdapter({db,dialect:'sqlite',schema:${JSON.stringify(names)}});
const adapter={...base,transaction:fn=>base.transaction(tx=>fn({...tx,upsert:async args=>{const result=await tx.upsert(args);if(args.model==='botAdmission')await new Promise(resolve=>setTimeout(resolve,100));return result;}}))};
const store=createDbStore({adapter,durable:true,maxConcurrentBots:1});console.log('ready');await once(process.stdin,'data');
let result;try{const bot=await store.createBot(${JSON.stringify(input)});result={accepted:true,id:bot.id};}catch(error){result={accepted:false,code:error.code,message:error.message};}await base.close();console.log(JSON.stringify({result,queries}));process.stdin.destroy();`;
    const outputs: Array<{ stdout: string; stderr: string }> = [];
    for (let i = 0; i < 2; i++) {
      const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
      children.push({ process, exited: once(process, 'exit') }); const output = { stdout: '', stderr: '' }; outputs.push(output);
      process.stdout!.on('data', data => { output.stdout += String(data); }); process.stderr!.on('data', data => { output.stderr += String(data); });
    }
    await expect.poll(() => outputs.every(output => output.stdout.includes('ready\n')), { timeout: 5000 }).toBe(true);
    for (const child of children) child.process.stdin!.end('go\n');
    await Promise.all(children.map(child => child.exited));
    for (const child of children) expect(child.process.exitCode).toBe(0);
    const receipts = outputs.map(output => { if (output.stderr) throw new Error(output.stderr); return JSON.parse(output.stdout.trim().split('\n').at(-1)!); });
    expect(receipts.filter(receipt => receipt.result.accepted)).toHaveLength(1);
    expect(receipts.find(receipt => !receipt.result.accepted).result.code).toBe('RATE_LIMIT_EXCEEDED');
    for (const receipt of receipts) {
      const statements = receipt.queries.filter((query: string) => !/^(begin|commit|rollback)/i.test(query));
      expect(statements[0]).toMatch(/insert into "botAdmission"/);
      expect(statements[0]).toMatch(/on conflict/);
    }
    adapter = connect(); let store = createDbStore({ adapter, durable: true, maxConcurrentBots: 1 });
    const [existing] = (await store.listBots('ns', { limit: 100 })).items;
    await expect(store.createBot(input)).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    await expect(createDbStore({ adapter, durable: true, maxConcurrentBots: 2 }).createBot(input)).rejects.toThrow('persisted namespace policy');
    await store.updateBot(existing.id, 'ns', { status: 'done' });
    await sql`CREATE TRIGGER reject_admitted_bot BEFORE INSERT ON bots BEGIN SELECT RAISE(ABORT, 'fixture admission rollback'); END`.execute(db!);
    await expect(store.createBot(input)).rejects.toThrow('fixture admission rollback');
    expect((await store.listBots('ns', { limit: 100 })).items).toHaveLength(1);
    await sql`DROP TRIGGER reject_admitted_bot`.execute(db!);
    await adapter.close(); db = undefined;
    adapter = connect(); store = createDbStore({ adapter, durable: true, maxConcurrentBots: 1 });
    expect(await store.createBot(input)).toMatchObject({ status: 'creating' });
    // Explicit offline policy update: lowering below occupancy permits draining, not new admission.
    await db!.updateTable('botAdmission').set({ maximum: 2 }).where('namespace', '=', 'ns').execute();
    const higher = createDbStore({ adapter, durable: true, maxConcurrentBots: 2 }); await higher.createBot(input);
    await db!.updateTable('botAdmission').set({ maximum: 1 }).where('namespace', '=', 'ns').execute();
    store = createDbStore({ adapter, durable: true, maxConcurrentBots: 1 });
    await expect(store.createBot(input)).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    for (const bot of (await store.listBots('ns', { limit: 100 })).items) await store.updateBot(bot.id, 'ns', { status: 'done' });
    expect(await store.createBot(input)).toMatchObject({ status: 'creating' });
  } finally {
    for (const child of children) { if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGKILL'); await child.exited; }
    await db?.destroy(); await rm(root, { recursive: true, force: true });
  }
}, 15000);
