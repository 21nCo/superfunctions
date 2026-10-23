/** Actual installed Firefox, fresh owned profile, localhost-only storage assertions. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { storageContract } from './browser-storage-contract.mjs';
const require=createRequire(import.meta.url);
const {build}=require('esbuild');
const bundle=await build({stdin:{contents:'export {CacheFn} from "./src/core/cache.ts";export {IndexedDBStorage} from "./src/storage/indexeddb-storage.ts";',resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,format:'iife',globalName:'Acceptance',write:false,platform:'browser'});
const directory=await realpath(await mkdtemp(join(tmpdir(),'cachefn-native-firefox-')));
const token=randomUUID();
let resolveResult,rejectResult;
const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
void result.catch(()=>{});
const server=createServer(async(request,response)=>{
  if(request.method==='GET' && request.url===`/${token}`){response.setHeader('content-type','text/html');response.end(`<!doctype html><title>CacheFn owned Firefox acceptance</title><script src="/${token}.js"></script>`);return;}
  if(request.method==='GET' && request.url===`/${token}.js`){response.setHeader('content-type','text/javascript');response.end(bundle.outputFiles[0].text+`;(${storageContract.toString()})().then(value=>({ok:true,value}),error=>({ok:false,error:String(error)})).then(value=>fetch('/${token}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}));`);return;}
  if(request.method==='POST' && request.url===`/${token}`){
    try{let data='';for await(const chunk of request){data+=chunk;if(data.length>65536)throw new Error('Oversized browser result');}const parsed=JSON.parse(data);response.end('received');resolveResult(parsed);}catch(error){response.statusCode=400;response.end('invalid');rejectResult(error);}return;
  }
  response.statusCode=404;response.end();
});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let browser, timer, diagnostics='', failure;
try {
  // Only this disposable profile is configured; no installed-profile settings are read or changed.
  await writeFile(join(directory,'user.js'),'user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.startup.homepage_override.mstone", "ignore");\nuser_pref("datareporting.policy.dataSubmissionEnabled", false);\nuser_pref("toolkit.telemetry.enabled", false);\n');
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser=spawn(process.env.FIREFOX_EXECUTABLE_PATH ?? '/Applications/Firefox.app/Contents/MacOS/firefox',['-no-remote','-headless','-profile',directory,`http://127.0.0.1:${server.address().port}/${token}`],{detached:true,stdio:['ignore','pipe','pipe']});
  browser.once('error',rejectResult);
  browser.once('exit',(code,signal)=>rejectResult(new Error(`Firefox exited before receipt: ${code}/${signal}: ${diagnostics}`)));
  for(const stream of [browser.stdout,browser.stderr])stream.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-8192);});
  timer=setTimeout(()=>rejectResult(new Error(`Native Firefox acceptance deadline: ${diagnostics}`)),30000);
  const receipt=await result;
  if(!receipt.ok || !Number.isInteger(receipt.value?.assertions) || !/Firefox\//.test(receipt.value?.userAgent))throw new Error(`Invalid native Firefox result: ${JSON.stringify(receipt)}`);
  console.log(JSON.stringify({engine:'native-firefox',...receipt.value,offlineConnectivityTested:false}));
} catch(error){failure=error;}
finally {
  clearTimeout(timer);
  const alive=()=>{if(!browser?.pid)return false;try{process.kill(-browser.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
  const signal=value=>{try{if(browser?.pid)process.kill(-browser.pid,value);}catch(error){if(error.code!=='ESRCH')throw error;}};
  try{
    signal('SIGTERM');let until=Date.now()+3000;while(alive()&&Date.now()<until)await pause(25);
    if(alive()){signal('SIGKILL');until=Date.now()+3000;while(alive()&&Date.now()<until)await pause(25);}
    if(alive())throw new Error('Owned Firefox process group exit unconfirmed');
    await rm(directory,{recursive:true,force:true});
    console.error(JSON.stringify({cleanup:{browserPid:browser?.pid,processGroupExited:true,profileRemoved:true}}));
  }catch(error){failure=new AggregateError([...(failure?[failure]:[]),error],'Firefox cleanup failed');}
  if(server.listening)await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
}
if(failure)throw failure;
