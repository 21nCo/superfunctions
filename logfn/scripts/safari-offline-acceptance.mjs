/** Native Safari HTTP-unavailability/IndexedDB reload acceptance. Does not change browser settings. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const namespace = 'safari-' + randomUUID();
let online = false, failures = 0;
const received = [];
const server = createServer(async (request, response) => {
  if (request.url === '/ingest') {
    const available = online;
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) { response.writeHead(413).end(); return; } chunks.push(chunk); }
    if (!available) { failures++; response.writeHead(503).end(); return; }
    try { received.push(JSON.parse(Buffer.concat(chunks).toString())); response.writeHead(202).end(); }
    catch { response.writeHead(400).end(); }
    return;
  }
  if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>LogFn owned Safari acceptance</title>'); return; }
  const path = resolve(root, request.url.slice(1));
  if (!path.startsWith(resolve(root, 'logfn/typescript/dist') + '/')) { response.writeHead(404).end(); return; }
  try { response.setHeader('content-type', 'text/javascript'); response.end(await readFile(path)); }
  catch { response.writeHead(404).end(); }
});
const reservation = createServer();
await new Promise((done,fail)=>{reservation.once('error',fail);reservation.listen(0,'127.0.0.1',done);});
const port = reservation.address().port;
await new Promise((done,fail)=>reservation.close(error=>error?fail(error):done()));
const driver = spawn('/usr/bin/safaridriver',['-p',String(port)],{stdio:['ignore','pipe','pipe']});
let driverError;
driver.once('error',error=>{driverError=error;});
let diagnostics='';
for(const stream of [driver.stdout,driver.stderr]) stream.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-8192);});
const exited = new Promise(resolve=>{driver.once('exit',(code,signal)=>resolve({code,signal}));driver.once('error',error=>resolve({error:String(error)}));});
let session, primaryError, databaseDeleted = false;
const command = async(method,path,body)=>{
  const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});
  const result=await response.json();
  if(!response.ok || result.value?.error) throw new Error(`Safari WebDriver ${path}: ${JSON.stringify(result.value)}`);
  return result.value;
};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  const deadline=Date.now()+10000;
  for(;;){
    if(driverError || driver.exitCode!==null) throw driverError ?? new Error(`Safari driver exited: ${diagnostics}`);
    try { await command('GET','/status'); break; }
    catch(error){if(Date.now()>=deadline)throw error;await pause(100);}
  }
  const created=await command('POST','/session',{capabilities:{alwaysMatch:{browserName:'safari'}}});
  session=created.sessionId;
  if(typeof session!=='string' || !session)throw new Error('Safari returned no owned session ID');
  await command('POST',`/session/${session}/timeouts`,{script:20000,pageLoad:20000});
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done);});
  await command('POST',`/session/${session}/url`,{url:`http://127.0.0.1:${server.address().port}`});
  const evaluate = async (fn, ...args) => {
    const result = await command('POST', `/session/${session}/execute/async`, {
      script: `const done=arguments[arguments.length-1];Promise.resolve((${fn.toString()})(...arguments[0])).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}));`, args: [args],
    });
    if (!result.ok) throw new Error('Safari browser assertion: ' + result.error);
    return result.value;
  };
  const readRows = async () => {
    const db = await new Promise((resolve,reject)=>{const request=indexedDB.open('logfn-http-queue');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    try { return await new Promise((resolve,reject)=>{const transaction=db.transaction('events');const request=transaction.objectStore('events').getAll();transaction.oncomplete=()=>resolve(request.result);transaction.onabort=()=>reject(transaction.error);}); }
    finally { db.close(); }
  };
  const first = await evaluate(async key => {
    const {sinkHttp,createLogger}=await import('/logfn/typescript/dist/index.js');
    const sink=sinkHttp({url:'/ingest',offlineBuffer:'indexeddb',offlineKey:key,retry:{attempts:1},timeoutMs:1000,flushIntervalMs:60000});
    const logger=createLogger({name:'native-safari',sinks:[sink],correlation:{userId:'owned-private-user'},pipeline:[event=>({...event,extra:{apiKey:'owned-private-pipeline'}})]});
    logger.info('survives Safari page reload',{password:'owned-private-password',nested:{token:'owned-private-token'}});
    let rejected=false;try{await logger.flush();}catch{rejected=true;}
    return {rejected,userAgent:navigator.userAgent};
  }, namespace);
  assert.equal(first.rejected,true);assert.ok(failures>=1);assert.equal(received.length,0);
  const before=await evaluate(readRows);assert.equal(before.length,1);
  const serialized=JSON.stringify(before);
  for(const secret of ['owned-private-user','owned-private-password','owned-private-token','owned-private-pipeline'])assert.ok(!serialized.includes(secret));
  assert.ok(serialized.includes('[redacted]'));
  await command('POST',`/session/${session}/refresh`,{});
  const retained=await evaluate(readRows);assert.equal(retained.length,1);assert.equal(retained[0].event.msg,'survives Safari page reload');
  online=true;
  await evaluate(async key=>{const {sinkHttp}=await import('/logfn/typescript/dist/index.js');await sinkHttp({url:'/ingest',offlineBuffer:'indexeddb',offlineKey:key,retry:{attempts:1},timeoutMs:1000}).close();},namespace);
  assert.ok(received.length>=1);assert.equal(received[0].events[0].ctx.password,'[redacted]');assert.equal(received[0].events[0].userId,'[redacted]');assert.equal(received[0].events[0].extra.apiKey,'[redacted]');
  assert.equal((await evaluate(readRows)).length,0);
  const delivered=received.length;
  await command('POST',`/session/${session}/refresh`,{});
  await evaluate(async key=>{const {sinkHttp}=await import('/logfn/typescript/dist/index.js');await sinkHttp({url:'/ingest',offlineBuffer:'indexeddb',offlineKey:key,retry:{attempts:1}}).close();},namespace);
  assert.equal(received.length,delivered);assert.equal((await evaluate(readRows)).length,0);
  const metrics=await evaluate(async key=>{
    const {sinkHttp}=await import('/logfn/typescript/dist/index.js');
    const options={url:'/ingest',offlineBuffer:'indexeddb',offlineKey:key+'-overflow',maxQueue:2,batch:10,flushIntervalMs:60000,retry:{attempts:1}};
    const first=sinkHttp(options),second=sinkHttp(options);const event=msg=>({ts:new Date().toISOString(),level:'info',msg,name:'overflow',version:'0'});
    try{await first([event('evicted'),event('retained-one')]);await second([event('retained-two')]);const before=[first.overflowEvictions,second.overflowEvictions];let rejected=false;try{await first([event('must-rollback'),{...event('invalid'),ctx:{fn:()=>{}}}]);}catch{rejected=true;}await first.flush();return{before,after:[first.overflowEvictions,second.overflowEvictions],rejected};}
    finally{await Promise.all([first.close(),second.close()]);}
  },namespace);
  assert.deepEqual(metrics,{before:[0,1],after:[0,1],rejected:true});
  assert.deepEqual(received.at(-1).events.map(event=>event.msg),['retained-one','retained-two']);
  assert.equal((await evaluate(readRows)).length,0);
  console.log(JSON.stringify({engine:'native-safari',browser:created.capabilities?.browserVersion,userAgent:first.userAgent,failedHttpPersisted:true,pageReloadRecovered:true,defaultPrivacyBeforeIndexedDB:true,acknowledgedRecordsRemoved:true,committedOverflowMetrics:metrics,osOfflineConnectivityTested:false,processRestartTested:false}));
} catch(error) { primaryError=error; }
finally {
  const errors=[];
  let sessionDeleted=false;
  if(session)try{const result=await command('POST',`/session/${session}/execute/async`,{script:"const done=arguments[arguments.length-1];const request=indexedDB.deleteDatabase('logfn-http-queue');request.onsuccess=()=>done(true);request.onerror=()=>done(false);request.onblocked=()=>done(false);",args:[]});databaseDeleted=result===true;if(!databaseDeleted)errors.push(new Error('Owned IndexedDB cleanup unconfirmed'));}catch(error){errors.push(error);}
  if(session)try{await command('DELETE',`/session/${session}`);sessionDeleted=true;}catch(error){errors.push(error);}
  driver.kill('SIGTERM');
  let closed=await Promise.race([exited,pause(3000).then(()=>null)]);
  if(!closed){driver.kill('SIGKILL');closed=await Promise.race([exited,pause(3000).then(()=>null)]);}
  if(!closed)errors.push(new Error('Owned Safari driver exit could not be confirmed'));
  if(server.listening)await new Promise(resolve=>{server.closeAllConnections();server.close(error=>{if(error)errors.push(error);resolve();});});
  console.error(JSON.stringify({cleanup:{driverPid:driver.pid,driverExited:Boolean(closed),sessionCreated:Boolean(session),sessionDeleted,databaseDeleted,serverClosed:!server.listening}}));
  if(errors.length)throw new AggregateError([...(primaryError?[primaryError]:[]),...errors],'Safari acceptance cleanup failed');
}
if(primaryError)throw primaryError;
