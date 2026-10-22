// Build CatchFn, @watchfn/browser, @watchfn/core and shared DB first.
// Requires the local native better-sqlite3 and kysely acceptance dependencies.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { pathToFileURL } from 'node:url';
const watchModule = process.env.CATCHFN_WATCH_CORE ? pathToFileURL(process.env.CATCHFN_WATCH_CORE).href : new URL('../../../watchfn/typescript/dist/index.mjs', import.meta.url).href;
const { WatchFn, getWatchFnSchema } = await import(watchModule);
import { catchFn } from '../dist/index.js';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
let browser;
let uploadMode = 'ok'; let uploadCalls = 0;
const uploads = [];
let base;

const directory = await mkdtemp(join(tmpdir(), 'catchfn-watch-http-'));
const databasePath = join(directory, 'events.sqlite');
let sql;
let watch;
let server;
const catchers = [];
const requests = [];
let failBeforeStorage = 0;
const connect = () => {
  sql = new Kysely({ dialect: new SqliteDialect({ database: new Database(databasePath) }) });
  const database = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { watchfn_events: 'watchfn_events' } });
  watch = new WatchFn({ name: 'bugs', storage: 'database', database,
    infra: { enabled: false }, auth: { enabled: true, apiKey: 'acceptance-only' } });
  watch.start();
};
try {
  connect();
  let migration = sql.schema.createTable('watchfn_events');
  for (const [name, field] of Object.entries(getWatchFnSchema().watchfn_events.fields)) {
    migration = migration.addColumn(name, field.type === 'number' ? 'real' : 'text', column => name === 'id' ? column.primaryKey() : field.required ? column.notNull() : column);
  }
  await migration.execute();
  for (const index of getWatchFnSchema().watchfn_events.indexes ?? []) await sql.schema.createIndex(index.name).on('watchfn_events').columns(index.fields).execute();
  server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.url === '/app.js') { outgoing.setHeader('Content-Type','application/javascript'); outgoing.end(await readFile(join(directory,'app.js'))); return; }
      if (incoming.url === '/') { outgoing.setHeader('Content-Type','text/html'); outgoing.end('<!doctype html><html><body><script src="/app.js"></script></body></html>'); return; }
      if (incoming.url?.startsWith('/files/')) {
        const file = uploads.find(file => incoming.url === '/files/' + file.id);
        if (!file) { outgoing.writeHead(404); outgoing.end(); return; }
        outgoing.end(await readFile(file.path)); return;
      }
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (incoming.url === '/upload') {
        uploadCalls++;
        if (incoming.headers.authorization !== 'Bearer upload-only') { outgoing.writeHead(401); outgoing.end(); return; }
        if (body.length > 1024 * 1024) { outgoing.writeHead(413); outgoing.end(); return; }
        if (uploadMode === 'deny') { outgoing.writeHead(401); outgoing.end(); return; }
        if (uploadMode === 'fail') { outgoing.writeHead(503); outgoing.end(); return; }
        if (uploadMode === 'invalid') { outgoing.setHeader('Content-Type','application/json'); outgoing.end('{}'); return; }
        const id = String(uploads.length + 1); const path = join(directory, id + '.blob');
        await writeFile(path, body, {mode:0o600}); uploads.push({id,path});
        outgoing.setHeader('Content-Type','application/json'); outgoing.end(JSON.stringify({url:base+'/files/'+id})); return;
      }
      if (incoming.url === '/ingest') {
        requests.push(JSON.parse(body.toString()));
        if (failBeforeStorage > 0) { failBeforeStorage--; outgoing.writeHead(503); outgoing.end(); return; }
      }
      const response = await watch.httpRouter.handle(new Request('http://local' + incoming.url, {
        method: incoming.method, headers: incoming.headers, body,
      }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/ingest`;
  base = endpoint.replace('/ingest','');
  const query = async (where, options = {}) => {
    const response = await fetch(endpoint.replace('/ingest', '/query'), {
      method: 'POST', headers: { Authorization: 'Bearer acceptance-only', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...options, where }), signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 200);
    return (await response.json()).results;
  };
  const bytes = Buffer.alloc(96 * 1024); for (let i=0;i<bytes.length;i++) bytes[i]=i%251;
  const attachment = {id:'large-file',name:'large.bin',type:'application/octet-stream',size:0,dataUrl:'data:application/octet-stream;base64,'+bytes.toString('base64')};
  const uploader = async (blob, item) => {
    assert.equal(item.id,attachment.id);
    const response = await fetch(base+'/upload',{method:'POST',headers:{authorization:'Bearer upload-only'},body:blob,signal:AbortSignal.timeout(2000)});
    if(!response.ok) throw new Error('Upload failed '+response.status);
    return response.json();
  };
  const catcher=catchFn({name:'attachment-app',uploadAttachment:uploader,watch:{endpoint,apiKey:'acceptance-only',retries:0,timeoutMs:1000}});
  catchers.push(catcher);
  failBeforeStorage=1;
  let failure;
  try { await catcher.captureBug({title:'Large upload',attachments:[attachment]}); } catch(error) { failure=error; }
  assert.equal(typeof failure?.retry,'function');
  assert.equal(uploadCalls,1); assert.equal(uploads.length,1);
  const report=await failure.retry();
  assert.equal(report.delivery,'sent'); assert.equal(uploadCalls,1);
  const saved=await query({id:report.id}); assert.equal(saved.length,1);
  assert.equal(saved[0].attachments[0].size,bytes.length);
  assert.equal(saved[0].attachments[0].dataUrl,undefined);
  const reference=saved[0].attachments[0].url;
  assert.deepEqual(Buffer.from(await (await fetch(reference)).arrayBuffer()),bytes);
  for(const mode of ['fail','invalid','deny']) {
    uploadMode=mode; const before=requests.length;
    await assert.rejects(catcher.captureBug({title:'Rejected '+mode,attachments:[attachment]}));
    assert.equal(requests.length,before); assert.equal(uploads.length,1);
  }
  uploadMode='ok';
  const beforeOversize=requests.length;
  await assert.rejects(catcher.captureBug({title:'Oversized upload',attachments:[{...attachment,dataUrl:'data:application/octet-stream;base64,'+Buffer.alloc(1024*1024+1).toString('base64')}]}),/Upload failed 413/);
  assert.equal(requests.length,beforeOversize);assert.equal(uploads.length,1);
  await build({stdin:{contents:`import {catchFn} from ${JSON.stringify(new URL('../dist/index.js',import.meta.url).pathname)};window.catcher=catchFn({name:'browser-upload',uploadAttachment:async blob=>{const response=await fetch('/upload',{method:'POST',headers:{authorization:'Bearer upload-only'},body:blob});if(!response.ok)throw new Error('Upload failed');return response.json();},watch:{endpoint:${JSON.stringify(endpoint)},apiKey:'acceptance-only',retries:0}});`,resolveDir:directory},bundle:true,platform:'browser',format:'iife',outfile:join(directory,'app.js')});
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage(); await page.goto(base);
  const browserReport=await page.evaluate(async()=>{
    const bytes=new Uint8Array(96*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
    let binary='';for(const value of bytes)binary+=String.fromCharCode(value);
    return window.catcher.captureBug({title:'Browser large file',attachments:[{id:'browser-file',name:'large.bin',type:'application/octet-stream',size:0,dataUrl:'data:application/octet-stream;base64,'+btoa(binary)}]});
  });
  assert.equal(browserReport.delivery,'sent');
  const browserSaved=await query({id:browserReport.id});assert.equal(browserSaved.length,1);
  assert.deepEqual(Buffer.from(await(await fetch(browserSaved[0].attachments[0].url)).arrayBuffer()),bytes);
  await page.evaluate(()=>window.catcher.stop()); await browser.close();browser=undefined;
  await watch.stop();await sql.destroy();sql=undefined;connect();
  assert.deepEqual(await query({id:report.id}),saved);
  assert.deepEqual(await query({id:browserReport.id}),browserSaved);
  assert.deepEqual(await readFile(uploads[0].path),bytes);
  console.log('Actual Node/Chrome upload -> file bytes -> Watch HTTP/SQLite/reopen passed; ingestion retry reuses upload, failed/invalid uploads do not deliver reports');
} finally {
  if(browser)await browser.close();
  for(const catcher of catchers)catcher.stop();
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(watch)await watch.stop().catch(()=>{});
  if(sql)await sql.destroy();
  await rm(directory,{recursive:true,force:true});
}
