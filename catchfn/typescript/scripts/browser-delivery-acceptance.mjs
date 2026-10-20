// Build CatchFn/WatchFn/shared DB first. Requires native SQLite and installed Chrome.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const watchModule = process.env.CATCHFN_WATCH_CORE ? pathToFileURL(process.env.CATCHFN_WATCH_CORE).href : new URL('../../../watchfn/typescript/dist/index.mjs', import.meta.url).href;
const { WatchFn, getWatchFnSchema } = await import(watchModule);
const root = resolve(new URL('../../..', import.meta.url).pathname);
const temporary = await mkdtemp(join(tmpdir(), 'catchfn-browser-delivery-'));
const sql = new Kysely({dialect:new SqliteDialect({database:new Database(join(temporary,'events.sqlite'))})});
const watch = new WatchFn({name:'bugs',storage:'database',database:kyselyAdapter({db:sql,dialect:'sqlite',schema:{watchfn_events:'watchfn_events'}}),infra:{enabled:false},auth:{enabled:true,apiKey:'browser-fixture-key'}});
let api,ui,browser,origin,endpoint;
let mode='503'; let allowCors=true; let preflights=0; const arrivals=[];
const close = async server => {if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
try {
  let migration=sql.schema.createTable('watchfn_events');
  for(const [name,field] of Object.entries(getWatchFnSchema().watchfn_events.fields)) migration=migration.addColumn(name,'text',column=>name==='id'?column.primaryKey():field.required?column.notNull():column);
  await migration.execute(); watch.start();
  api=createServer(async(req,res)=>{
    try {
      const cors=req.headers.origin===origin&&allowCors;
      if(cors){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
      if(req.method==='OPTIONS'){
        preflights++; res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','authorization,content-type');res.setHeader('Access-Control-Max-Age','0');res.writeHead(cors?204:403);res.end();return;
      }
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
      if(req.url==='/ingest'){
        if(!cors){res.writeHead(403);res.end();return;}
        arrivals.push({body:JSON.parse(body.toString()),auth:req.headers.authorization});
        if(mode==='503'){res.writeHead(503);res.end();return;}
      }
      const response=await watch.httpRouter.handle(new Request('http://fixture'+req.url,{method:req.method,headers:req.headers,body}));
      if(req.url==='/ingest'&&response.ok&&mode==='lost'){mode='ok';return; /* Client timeout aborts this accepted response. */}
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));endpoint=`http://127.0.0.1:${api.address().port}/ingest`;
  const bundle=join(temporary,'app.js');
  await build({stdin:{contents:`import {catchFn} from './catchfn/typescript/src/index.ts';window.catcher=catchFn({name:'browser-app',sessionId:'browser-session',reporter:{screenshot:false,floatingButton:true},beforeSend:event=>({...event,metadata:{password:'private-fixture',safe:true}}),watch:{endpoint:${JSON.stringify(endpoint)},apiKey:'browser-fixture-key',retries:0,timeoutMs:1000}});`,resolveDir:root},bundle:true,platform:'browser',format:'iife',outfile:bundle});
  ui=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?await readFile(bundle):'<!doctype html><html><body><script src="/app.js"></script></body></html>');});
  await new Promise(resolve=>ui.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${ui.address().port}`;
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext();const page=await context.newPage();await page.goto(origin);
  const open=async title=>{await page.evaluate(()=>window.catcher.closeReporter());await page.getByRole('button',{name:'Report a bug',exact:true}).click();await page.locator('input[name=title]').fill(title);};
  const submit=()=>page.getByRole('button',{name:'Submit report',exact:true}).click();
  const failed=()=>page.getByRole('status').filter({hasText:'Delivery is unconfirmed.'}).waitFor();
  const retry=()=>page.getByRole('button',{name:'Retry same report',exact:true}).click();
  const success=()=>page.getByRole('status').filter({hasText:'Report submitted.'}).waitFor();
  const records=async id=>{
    const response=await fetch(endpoint.replace('/ingest','/query'),{method:'POST',headers:{Authorization:'Bearer browser-fixture-key','Content-Type':'application/json'},body:JSON.stringify({where:{id}})});
    assert.equal(response.status,200);return (await response.json()).results;
  };
  await open('503 recovery');await submit();await failed();assert.equal(arrivals.length,1);
  assert.equal(await page.locator('input[name=title]').isDisabled(),true);
  const original=arrivals[0].body[0];assert.equal((await records(original.id)).length,0);
  await retry();await failed();assert.equal(arrivals.length,2);assert.deepEqual(arrivals[1].body,[original]);
  mode='ok';await retry();await success();assert.equal(arrivals.length,3);assert.deepEqual(arrivals[2].body,[original]);
  assert.deepEqual(await records(original.id),[original]);assert.equal(original.context.custom.password,'[REDACTED]');assert.equal(original.report.title,'503 recovery');
  assert.ok(arrivals.every(value=>value.auth==='Bearer browser-fixture-key'));
  await open('Offline recovery');await context.setOffline(true);const beforeOffline=arrivals.length;
  await submit();await failed();assert.equal(arrivals.length,beforeOffline);
  await context.setOffline(false);await retry();await success();assert.equal(arrivals.length,beforeOffline+1);
  const offline=arrivals.at(-1).body[0];assert.deepEqual(await records(offline.id),[offline]);
  await open('CORS recovery');allowCors=false;const beforeCors=arrivals.length;
  await submit();await failed();assert.equal(arrivals.length,beforeCors);
  allowCors=true;await retry();await success();assert.equal(arrivals.length,beforeCors+1);assert.ok(preflights>0);
  await open('Lost response');mode='lost';await submit();await failed();const lost=arrivals.at(-1).body[0];
  assert.equal((await records(lost.id)).length,1);await retry();await success();assert.equal(arrivals.at(-1).body[0].id,lost.id);
  assert.equal((await records(lost.id)).length,2); // At-least-once transport, never a deduplication claim.
  await open('Original queued report');mode='503';await submit();await failed();const queued=arrivals.at(-1).body[0];
  await page.getByRole('button',{name:'Start a new report',exact:true}).click();
  await page.locator('input[name=title]').fill('Explicit new report');mode='ok';await submit();await success();
  const batch=arrivals.at(-1).body;assert.equal(batch.length,2);assert.equal(batch[0].id,queued.id);assert.notEqual(batch[1].id,queued.id);
  assert.equal(batch[1].report.title,'Explicit new report');
  console.log('Actual Chrome cross-origin WatchFn/SQLite acceptance passed: same-ID503 retry, offline/CORS recovery, authentication/redaction, lost-response at-least-once arrivals, and explicit new-report choice');
} finally {
  if(browser)await browser.close();await close(ui);await close(api);await watch.stop().catch(()=>{});await sql.destroy();await rm(temporary,{recursive:true,force:true});
}
