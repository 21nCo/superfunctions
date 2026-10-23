import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const temporary=await mkdtemp(join(tmpdir(),'watchfn-alert-consumer-'));
const npm=process.env.WATCHFN_NPM_CLI;
const runNpm=(args,cwd)=>execFileSync(npm?process.execPath:'npm',npm?[npm,...args]:args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
try {
 const packages=new Map();
 for(const path of execFileSync('rg',['--files','-g','package.json'],{cwd:root,encoding:'utf8'}).trim().split('\n')) {
  const manifest=JSON.parse(await readFile(join(root,path),'utf8'));
  if(manifest.name)packages.set(manifest.name,{path:resolve(root,path,'..'),manifest});
 }
 const closure=new Map();
 function add(name){if(closure.has(name)||!packages.has(name))return;const item=packages.get(name);closure.set(name,item);for(const dependency of Object.keys(item.manifest.dependencies??{}))add(dependency);}
 add('@watchfn/core');
 const dependencies={};
 for(const [name,item] of closure){const [packed]=JSON.parse(runNpm(['pack','--ignore-scripts','--json','--pack-destination',temporary],item.path));dependencies[name]='file:'+join(temporary,packed.filename);}
 await writeFile(join(temporary,'package.json'),JSON.stringify({private:true,type:'module',dependencies,overrides:Object.fromEntries(Object.keys(dependencies).map(name=>[name,'$'+name]))}));
 runNpm(['install','--ignore-scripts'],temporary);
 const body=`
 const {createServer}=await import('node:http');
 const {memoryAdapter}=await import('@superfunctions/db/adapters/memory');
 const received=[];let drop=false;
 const server=createServer((request,response)=>{const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{const body=JSON.parse(Buffer.concat(chunks).toString());received.push(body);if(drop){request.socket.destroy();return;}response.writeHead(202,{'content-type':'application/json'});response.end(JSON.stringify({status:'success',dedup_key:body.dedup_key}));});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const database=memoryAdapter();
 const create=()=>new WatchFn({name:'packed-alerts',storage:'database',database,infra:{enabled:false},alerts:{pagerDutyEndpoint:'http://127.0.0.1:'+server.address().port+'/events'}});
 const first=create(),second=create();first.start();second.start();
 const drain=async watch=>{for(let index=0;index<8;index++)await watch.alerts.processNotifications();};
 try{
 const alert=await first.alerts.create({name:'packed incident',condition:{metric:'latency',window:'1m',operator:'gt',threshold:1},channels:[{type:'pagerduty',integrationKey:'owned-private-route',severity:'critical'}]});
 await first.alerts.trigger(alert.id);await first.alerts.acknowledge(alert.id,{acknowledgedBy:'operator'});await first.alerts.resolve(alert.id,{resolvedBy:'operator'});
 await Promise.all([drain(first),drain(second)]);
 assert.deepEqual(received.map(value=>value.event_action),['trigger','acknowledge','resolve']);
 assert.equal(new Set(received.map(value=>value.dedup_key)).size,1);
 assert.equal(received[0].payload.severity,'critical');
 assert.equal((await first.alerts.get(alert.id)).pendingNotifications,0);
 assert.deepEqual((await first.alerts.notifications()).map(value=>value.outcome),['delivered','delivered','delivered']);
 assert.ok(!JSON.stringify(await first.alerts.list()).includes('owned-private-route'));
 drop=true;await second.alerts.trigger(alert.id);await second.alerts.acknowledge(alert.id,{acknowledgedBy:'operator'});await second.alerts.resolve(alert.id,{resolvedBy:'operator'});await drain(second);
 assert.equal(received.length,4);const job=(await first.alerts.notifications()).find(value=>value.outcome==='unknown');assert.ok(job);
 drop=false;await drain(first);assert.equal(received.length,4);
 assert.equal(await first.alerts.reconcileNotification(job.id,{outcome:'delivered',actor:'operator',reason:'Owned protocol acceptance verified'}),true);
 await drain(first);assert.equal(received.length,6);assert.equal((await first.alerts.get(alert.id)).pendingNotifications,0);
 assert.notEqual(received[0].dedup_key,received[3].dedup_key);
 await assert.rejects(first.alerts.migrateStoppedLegacyNamespace(),/existing ts-v1/);
 await assert.rejects(first.flush(),error=>error instanceof AggregateError && error.errors.length===1 && /existing ts-v1/.test(error.errors[0].message));
 }finally{const stopped=await Promise.allSettled([first.stop(),second.stop()]);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));const failures=stopped.filter(result=>result.status==='rejected').map(result=>result.reason);if(failures.length)throw new AggregateError(failures,'Installed consumer cleanup failed');}
 `;
 for(const [extension,imports] of [['mjs',"import assert from 'node:assert/strict';import {WatchFn} from '@watchfn/core';"],['cjs',"const assert=require('node:assert/strict');const {WatchFn}=require('@watchfn/core');"]]){
  const path=join(temporary,'consumer.'+extension);await writeFile(path,imports+'\n(async()=>{'+body+'})().catch(error=>{console.error(error);process.exitCode=1;});');execFileSync(process.execPath,[path],{cwd:temporary,stdio:'inherit',timeout:30000});
 }
 console.log(`Fresh ${closure.size}-tarball ESM/CJS durable PagerDuty ESM/CJS consumers passed`);
}finally{await rm(temporary,{recursive:true,force:true});}
