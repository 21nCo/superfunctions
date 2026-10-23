/** Native Safari WebDriver correctness fixture. Never changes remote-automation settings. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { storageContract } from './browser-storage-contract.mjs';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const bundle = await build({stdin:{contents:'export {CacheFn} from "./src/core/cache.ts"; export {IndexedDBStorage} from "./src/storage/indexeddb-storage.ts";',resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,format:'iife',globalName:'Acceptance',write:false,platform:'browser'});
const server = createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end('<!doctype html><title>CacheFn owned Safari acceptance</title>');});
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
let session, primaryError;
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
  await command('POST',`/session/${session}/execute/sync`,{script:bundle.outputFiles[0].text+';window.Acceptance=Acceptance;',args:[]});
  const result=await command('POST',`/session/${session}/execute/async`,{script:`const done=arguments[arguments.length-1];(${storageContract.toString()})().then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}));`,args:[]});
  if(!result.ok)throw new Error(`Safari storage contract: ${result.error}`);
  console.log(JSON.stringify({engine:'native-safari',browser:created.capabilities?.browserVersion,...result.value,offlineConnectivityTested:false}));
} catch(error) { primaryError=error; }
finally {
  const errors=[];
  let sessionDeleted=false;
  if(session)try{await command('DELETE',`/session/${session}`);sessionDeleted=true;}catch(error){errors.push(error);}
  driver.kill('SIGTERM');
  let closed=await Promise.race([exited,pause(3000).then(()=>null)]);
  if(!closed){driver.kill('SIGKILL');closed=await Promise.race([exited,pause(3000).then(()=>null)]);}
  if(!closed)errors.push(new Error('Owned Safari driver exit could not be confirmed'));
  if(server.listening)await new Promise(resolve=>{server.closeAllConnections();server.close(error=>{if(error)errors.push(error);resolve();});});
  console.error(JSON.stringify({cleanup:{driverPid:driver.pid,driverExited:Boolean(closed),sessionCreated:Boolean(session),sessionDeleted,serverClosed:!server.listening}}));
  if(errors.length)throw new AggregateError([...(primaryError?[primaryError]:[]),...errors],'Safari acceptance cleanup failed');
}
if(primaryError)throw primaryError;
