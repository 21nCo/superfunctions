import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createContentfnServer } from '@contentfn/server';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
const db = memoryAdapter();
let allowed = true;
const content = createContentfnServer({ db, context: request => ({ subject: request.headers.get('x-fixture-identity') }), authorize: async (_ctx, action) => action !== 'docs.publish' || allowed });
const http = createServer(content.handler);
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
try {
 const base = `http://127.0.0.1:${http.address().port}`;
 const post = async (path, input, identity='scheduler', key) => (await fetch(base+'/contentfn/'+path, {method:'POST',headers:{'content-type':'application/json','x-fixture-identity':identity,...(key?{'idempotency-key':key}:{})},body:JSON.stringify(input)})).json();
 assert.equal((await post('datasets/create',{dataset:'prod'})).ok,true);
 assert.equal((await post('schema/upsert',{dataset:'prod',schema:{version:1,documentTypes:[{name:'post',fields:[]}]}})).ok,true);
 const draft = await post('docs/create',{dataset:'prod',id:'one',type:'post',doc:{},asDraft:true});
 assert.equal(draft.ok,true);
 const input={dataset:'prod',id:'one',ifRev:draft.result._rev};
 const first=await post('docs/publish',input,'scheduler','stable');
 assert.equal(first.ok,true);
 assert.equal((await post('docs/get',{dataset:'prod',id:'drafts.one'})).ok,false);
 assert.deepEqual(await post('docs/publish',input,'scheduler','stable'),first);
 assert.equal((await post('docs/publish',input,'other','stable')).error.code,'VALIDATION_FAILED');
 allowed=false;
 assert.equal((await post('docs/publish',input,'scheduler','stable')).error.code,'PERMISSION_DENIED');
 const status=await (await fetch(base+'/contentfn/status')).json();
 assert.ok(status.result.capabilities.includes('content.docs.publish.idempotency.v1'));
 console.log('Installed actual HTTP actor-bound publish replay passed',process.version);
} finally { http.closeAllConnections(); await new Promise(resolve=>http.close(resolve)); await db.close(); }
