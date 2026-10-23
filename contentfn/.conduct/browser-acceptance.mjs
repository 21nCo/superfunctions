import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
import { createContentfnServer } from '../server/dist/index.js';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
const db = memoryAdapter();
const content = createContentfnServer({ db, context: request => ({ subject: request.headers.get('x-user') ?? 'anonymous' }) });
await content.api.datasets.create({dataset:'browser'});
await content.api.schema.upsert({dataset:'browser',schema:{version:1,documentTypes:[{name:'post',fields:[]}]}});
const source = await readFile(new URL('../client/dist/index.js', import.meta.url));
const http = createServer((request,response)=>{
 if (request.url === '/') { response.setHeader('content-type','text/html');response.end('<!doctype html><title>ContentFn acceptance</title>'); }
 else if(request.url === '/client.js') { response.setHeader('content-type','text/javascript');response.end(source); }
 else content.handler(request,response);
});
await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
const baseUrl=`http://127.0.0.1:${http.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();await page.goto(baseUrl);
 const result=await page.evaluate(async()=>{
  const {createContentfnClient}=await import('/client.js');
  const client=createContentfnClient({baseUrl:location.origin,headers:{'x-user':'browser-user'}});
  const datasets=await client.datasets.list();
  const stream=client.realtime.subscribe({dataset:'browser'});
  const joined=await stream.next();
  const next=stream.next();
  const created=await client.docs.create({dataset:'browser',type:'post',id:'browser-post',doc:{}});
  const changed=await next;
  await stream.return();
  const queries = client.realtime.subscribe({dataset:'browser',query:{dataset:'browser',types:['post']}});
  const snapshot = await queries.next();
  const updated = queries.next();
  const deleted = await client.docs.delete({dataset:'browser',id:'browser-post'});
  const removed = await updated;
  await queries.return();
  return {datasets,joined,created,changed,snapshot,deleted,removed};
 });
 assert.equal(result.datasets.ok,true);assert.equal(result.created.ok,true);
 assert.equal(result.joined.value.result.eventType,'presence.join');
 assert.equal(result.joined.value.result.actor.subject,'browser-user');
 assert.equal(result.changed.value.result.eventType,'doc.created');
 assert.equal(result.snapshot.value.result.eventType,'query.snapshot');
 assert.equal(result.snapshot.value.result.queryResult.data.length,1);
 assert.equal(result.deleted.ok,true);
 assert.equal(result.removed.value.result.eventType,'query.updated');
 assert.equal(result.removed.value.result.queryResult.data.length,0);
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(content.realtime.getConnectionCount(),0);
 console.log('Native Chrome client CRUD, SSE presence/change, cancellation passed');
} finally { await browser.close();http.closeAllConnections();await new Promise(resolve=>http.close(resolve));await db.close(); }
