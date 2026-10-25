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
 add('@watchfn/core');add('sendfn');
 const dependencies={};
 for(const [name,item] of closure){const [packed]=JSON.parse(runNpm(['pack','--ignore-scripts','--json','--pack-destination',temporary],item.path));dependencies[name]='file:'+join(temporary,packed.filename);}
 await writeFile(join(temporary,'package.json'),JSON.stringify({private:true,type:'module',dependencies,overrides:Object.fromEntries(Object.keys(dependencies).map(name=>[name,'$'+name]))}));
 runNpm(['install','--ignore-scripts'],temporary);
 const body=`
 const {createServer}=await import('node:http');
 const {memoryAdapter}=await import('@superfunctions/db/adapters/memory');
 const received=[],emails=[];let drop=false,emailDrop=false;
 const server=createServer((request,response)=>{const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{if(request.headers['content-type']?.includes('application/x-www-form-urlencoded')){emails.push(new URLSearchParams(Buffer.concat(chunks).toString()));if(emailDrop){request.socket.destroy();return;}response.end('<SendEmailResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><SendEmailResult><MessageId>packed-email-id</MessageId></SendEmailResult></SendEmailResponse>');return;}const body=JSON.parse(Buffer.concat(chunks).toString());received.push(body);if(drop){request.socket.destroy();return;}response.writeHead(202,{'content-type':'application/json'});response.end(JSON.stringify({status:'success',dedup_key:body.dedup_key}));});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const database=memoryAdapter();
 const create=()=>new WatchFn({name:'packed-alerts',storage:'database',database,infra:{enabled:false},alerts:{email:{from:'alerts@example.test',awsSes:{region:'us-east-1',accessKeyId:'packed-local-key',secretAccessKey:'packed-local-secret',endpoint:'http://127.0.0.1:'+server.address().port}},pagerDutyEndpoint:'http://127.0.0.1:'+server.address().port+'/events'}});
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
 await new Promise(resolve=>setTimeout(resolve,2));
 const uncertainPrune=await first.alerts.pruneNotifications({completedBefore:Date.now()});assert.equal(uncertainPrune.deleted,2);assert.equal((await first.alerts.get(alert.id)).pendingNotifications,3);
 drop=false;await drain(first);assert.equal(received.length,4);
 assert.equal(await first.alerts.reconcileNotification(job.id,{outcome:'delivered',actor:'operator',reason:'Owned protocol acceptance verified'}),true);
 await drain(first);assert.equal(received.length,6);assert.equal((await first.alerts.get(alert.id)).pendingNotifications,0);
 assert.notEqual(received[0].dedup_key,received[3].dedup_key);
 await database.updateMany({model:'watchfn_alert_runtime',where:[{field:'id',operator:'eq',value:'packed-alerts'}],data:{protocol:'ts-v2'}});
 await database.updateMany({model:'watchfn_alert_outbox',where:[{field:'namespace',operator:'eq',value:'packed-alerts'}],data:{completedAt:null,predecessorId:null}});
 for(let index=0;index<20;index++){const result=await first.alerts.migrateReceiptRetention({limit:1});if(result.done)break;}
 assert.equal((await first.alerts.receiptRetentionStatus()).protocol,'ts-v3');
 await new Promise(resolve=>setTimeout(resolve,2));
 let after,removed=0;for(let index=0;index<10;index++){const result=await second.alerts.pruneNotifications({completedBefore:Date.now(),limit:1,after});removed+=result.deleted;after=result.nextCursor;if(!after)break;}
 assert.equal(removed,3);assert.equal((await first.alerts.notifications()).length,1);
 const emailAlert=await first.alerts.create({name:'packed email',condition:{metric:'latency',window:'1m',operator:'gt',threshold:1},channels:[{type:'email',recipients:['operator@example.test']}]});
 await first.alerts.trigger(emailAlert.id);await Promise.all([drain(first),drain(second)]);assert.equal(emails.length,1);assert.equal((await first.alerts.get(emailAlert.id)).pendingNotifications,0);
 emailDrop=true;await first.alerts.resolve(emailAlert.id,{resolvedBy:'operator'});await drain(second);await drain(first);assert.equal(emails.length,2);assert.equal((await first.alerts.get(emailAlert.id)).pendingNotifications,1);assert.ok(!JSON.stringify(await first.alerts.list()).includes('packed-local-secret'));
 const measured=await first.alerts.create({name:'calculated context',condition:{metric:'measured',window:'1m',operator:'gt',threshold:5},channels:[],autoResolve:{enabled:true,condition:{metric:'measured',window:'1s',operator:'lt',threshold:2}}});
 await first.ingest([{type:'log',message:'packed error',level:'error',service:'api',timestamp:Date.now()},{type:'track',message:'packed error',level:'error',service:'api',timestamp:Date.now()}]);
 assert.equal((await first.logs.query({level:'error',search:'packed error',filters:{service:'api'}})).length,1);
 assert.deepEqual(await first.logs.aggregate({groupBy:['level'],aggregation:'count'}),[{level:'error',value:1}]);
 const traceNow=Date.now();await first.ingest([{type:'track',name:'trace.span',timestamp:traceNow,properties:{id:'packed-root',traceId:'packed-trace',name:'checkout',service:'api',startTime:traceNow-20,endTime:traceNow,duration:20,tags:{},logs:[]}},{type:'track',name:'trace.span',timestamp:traceNow,properties:{id:'packed-child',parentId:'packed-root',traceId:'packed-trace',name:'lookup',service:'db',startTime:traceNow-10,endTime:traceNow,duration:10,tags:{error:true},logs:[]}},{type:'log',message:'trace error',traceId:'packed-trace',timestamp:traceNow}]);
 assert.equal((await first.trace.query({operation:'lookup',status:'error',duration:{gte:10}}))[0].id,'packed-child');
 const trace=await first.trace.getTrace({traceId:'packed-trace',includeSpans:true,includeLogs:true});assert.equal(trace.spans.length,2);assert.equal(trace.logs[0].message,'trace error');assert.equal(trace.status,'error');
 assert.deepEqual((await first.trace.getServiceMap({})).edges,[{source:'api',target:'db',calls:1,errors:1,averageDuration:10}]);
 await first.trace.startWithHeaders('packed request',{traceparent:'00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',tracestate:'vendor=packed'},async span=>{await Promise.resolve();const headers=first.trace.injectHeaders();assert.equal(headers.traceparent,'00-4bf92f3577b34da6a3ce929d0e0e4736-'+span.id+'-00');assert.equal(headers.tracestate,'vendor=packed');assert.equal(span.parentId,'00f067aa0ba902b7');});
 const sampled=new WatchFn({name:'packed-sampling',storage:'memory',infra:{enabled:false},trace:{enabled:true,sampleRate:0,serviceName:'sample-service'}});sampled.start();try{sampled.trace.startSpan('omitted').finish();await sampled.flush();assert.deepEqual(await sampled.trace.query({}),[]);await sampled.trace.startWithHeaders('kept-parent',{traceparent:'00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'},async()=>{});await sampled.flush();assert.equal((await sampled.trace.query({}))[0].service,'sample-service');}finally{await sampled.stop();}
 const contexts=[];first.alerts.onTrigger((alert,context)=>{if(alert.id===measured.id){alert.name='modified';context.value=-1;}});
 first.alerts.onTrigger((alert,context)=>{if(alert.id===measured.id){assert.equal(alert.name,'calculated context');contexts.push(context);}});
 first.alerts.onResolve((alert,context)=>{if(alert.id===measured.id)contexts.push(context);});
 const moment=Date.now();await first.ingest([{type:'metric',name:'measured',value:10,timestamp:moment},{type:'metric',name:'measured',value:20,timestamp:moment}]);
 await first.alerts.evaluate({now:moment});assert.equal(contexts[0].value,15);assert.equal(contexts[0].threshold,5);
 await first.ingest([{type:'metric',name:'measured',value:0,timestamp:moment+10000}]);await first.alerts.evaluate({now:moment+10000});
 assert.equal(contexts[1].value,0);assert.equal(contexts[1].threshold,2);assert.equal(contexts[1].duration,10000);
 await assert.rejects(first.alerts.migrateStoppedLegacyNamespace(),/existing ts-v1/);
 await assert.rejects(first.flush(),error=>error instanceof AggregateError && error.errors.length===1 && /existing ts-v1/.test(error.errors[0].message));
 }finally{const stopped=await Promise.allSettled([first.stop(),second.stop()]);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));const failures=stopped.filter(result=>result.status==='rejected').map(result=>result.reason);if(failures.length)throw new AggregateError(failures,'Installed consumer cleanup failed');}
 `;
 for(const [extension,imports] of [['mjs',"import assert from 'node:assert/strict';import {WatchFn} from '@watchfn/core';"],['cjs',"const assert=require('node:assert/strict');const {WatchFn}=require('@watchfn/core');"]]){
  const path=join(temporary,'consumer.'+extension);await writeFile(path,imports+'\n(async()=>{'+body+'})().catch(error=>{console.error(error);process.exitCode=1;});');execFileSync(process.execPath,[path],{cwd:temporary,stdio:'inherit',timeout:30000});
 }
 await writeFile(join(temporary,'consumer.ts'), `import {WatchFn, type AlertLifecycleContext, type AlertLifecycleListener, type TraceQueryOptions, type TraceDetailsOptions, type ServiceMapOptions} from '@watchfn/core';
 const callback:AlertLifecycleListener=(_alert,context:AlertLifecycleContext)=>{const threshold:number|undefined=context.threshold;return threshold;};
 const watch=new WatchFn({name:'typed',storage:'memory',alerts:{email:{from:'alerts@example.test',awsSes:{region:'us-east-1',accessKeyId:'local',secretAccessKey:'local',timeoutMs:1000,maxResponseBytes:1024}}}});
 watch.alerts.onTrigger(callback);watch.alerts.onResolve(callback);
 const tq:TraceQueryOptions={operation:'checkout',duration:{gt:10}};const td:TraceDetailsOptions={traceId:'t',includeSpans:true};const sm:ServiceMapOptions={minCalls:2};void watch.trace.query(tq);void watch.trace.getTrace(td);void watch.trace.getServiceMap(sm);void watch.trace.startWithHeaders('typed',{},async span=>{const headers:Record<string,string>=watch.trace.injectHeaders({},span);return headers;});
 async function maintenance(){const status=await watch.alerts.receiptRetentionStatus();const migration=await watch.alerts.migrateReceiptRetention({limit:1});const page=await watch.alerts.pruneNotifications({completedBefore:Date.now(),limit:1});if(page.nextCursor)await watch.alerts.pruneNotifications({completedBefore:Date.now(),after:page.nextCursor});const done:boolean=migration.done;const protocol:string|undefined=status?.protocol;return {done,protocol};}void maintenance;`);
 execFileSync(process.execPath,[resolve(root,'node_modules/typescript/bin/tsc'),'--strict','--skipLibCheck','--noEmit','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','consumer.ts'],{cwd:temporary,stdio:'inherit',timeout:30000});
 await rm(join(temporary,'node_modules/sendfn'),{recursive:true,force:true});
 const missing=join(temporary,'missing-email.mjs');
 await writeFile(missing,`import assert from 'node:assert/strict';import {WatchFn} from '@watchfn/core';
 const watch=new WatchFn({name:'missing-email',storage:'memory',infra:{enabled:false},alerts:{email:{from:'alerts@example.test',awsSes:{region:'us-east-1',accessKeyId:'local',secretAccessKey:'local'}}}});watch.start();
 try{const alert=await watch.alerts.create({name:'optional email',condition:{metric:'x',window:'1m',operator:'gt',threshold:1},channels:[{type:'email',recipients:['operator@example.test']}]});await watch.alerts.trigger(alert.id);await assert.rejects(watch.alerts.processNotifications(),/requires SendFn/);assert.equal((await watch.alerts.notifications())[0].state,'pending');assert.equal((await watch.alerts.get(alert.id)).pendingNotifications,1);await assert.rejects(watch.flush(),error=>error instanceof AggregateError&&error.errors.length===1&&/requires SendFn/.test(error.errors[0].message));}finally{await watch.stop();}`);
 execFileSync(process.execPath,[missing],{cwd:temporary,stdio:'inherit',timeout:30000});
 execFileSync(process.execPath,[resolve(root,'node_modules/typescript/bin/tsc'),'--strict','--skipLibCheck','--noEmit','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','consumer.ts'],{cwd:temporary,stdio:'inherit',timeout:30000});
 console.log(`Fresh ${closure.size}-tarball typed ESM/CJS durable PagerDuty, SES email, optional-peer and receipt-retention consumers passed`);
}finally{await rm(temporary,{recursive:true,force:true});}
