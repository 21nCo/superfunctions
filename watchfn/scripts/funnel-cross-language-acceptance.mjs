/** Build WatchFn first. Uses owned local SQLite and a configured installed Python. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import Database from 'better-sqlite3';
import {Kysely,SqliteDialect} from 'kysely';
import {kyselyAdapter} from '@superfunctions/db/adapters';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'watch-funnel-wire-'));
let db,watch,syntheticServer;
try{
 const npm=(args,cwd=directory)=>execFileSync(process.env.NPM_CLI?process.execPath:'npm',process.env.NPM_CLI?[process.env.NPM_CLI,...args]:args,{cwd,encoding:'utf8'});
 const tarballs=['packages/observability','packages/http','packages/db','logfn/typescript','watchfn/typescript'].map(path=>{const [pack]=JSON.parse(npm(['pack','--json','--ignore-scripts','--pack-destination',directory],join(root,path)));return join(directory,pack.filename);});
 await writeFile(join(directory,'package.json'),JSON.stringify({private:true,type:'module'}));
 npm(['install','--ignore-scripts','--no-audit','--no-fund',...tarballs]);
 const {WatchFn,getWatchFnSchema,getBusinessSchema}=await import(pathToFileURL(join(directory,'node_modules/@watchfn/core/dist/index.mjs')).href);
 const file=join(directory,'shared.sqlite');db=new Kysely({dialect:new SqliteDialect({database:new Database(file)})});
 const schema={...getWatchFnSchema(),...getBusinessSchema()};
 for(const [name,table]of Object.entries(schema)){
  let migration=db.schema.createTable(name);
  for(const [field,options]of Object.entries(table.fields))migration=migration.addColumn(field,options.type==='number'?'integer':'text',column=>field==='id'?column.primaryKey():options.required?column.notNull():column);
  await migration.execute();
 }
 watch=new WatchFn({name:'wire-✓',storage:'database',database:kyselyAdapter({db,dialect:'sqlite',schema:Object.fromEntries(Object.keys(schema).map(key=>[key,key]))}),infra:{enabled:false}});watch.start();
 await watch.business.createFunnel({name:'typescript-definition',steps:[{event:'cart'},{event:'paid'},{event:'receipt'}],timeWindow:'1h'});
 watch.business.track('cart',{userId:'buyer',source:1});await watch.flush();await new Promise(resolve=>setTimeout(resolve,3));
 watch.business.track('paid',{userId:'buyer',source:1.0});await watch.flush();
 await watch.business.createFunnel({name:'shared-tie-vector',steps:[{event:'a',filters:{enabled:true}},{event:'b'}],timeWindow:'1m'});
 const vector=[['x','a',1,true],['x','a',2,true],['x','b',2,true],['y','a',1,true],['y','b',2,true],['y','a',2,true],['excluded','a',1,1],['excluded','b',2,true]];
 await watch.ingest(vector.map(([userId,name,timestamp,enabled])=>({type:'track',name,timestamp,app:{name:'wire-✓'},properties:{userId,enabled}})));
 assert.deepEqual((await watch.business.getFunnel({name:'shared-tie-vector',timeRange:{from:0,to:100}})).steps.map(step=>step.count),[2,2]);
 await watch.business.createFunnel({name:'submillisecond',steps:[{event:'micro-a'},{event:'micro-b'}],timeWindow:'1m'});
 await watch.ingest(['micro-a','micro-b'].map((name,index)=>({type:'track',name,app:{name:'wire-✓'},timestamp:'2026-01-01T00:00:00.000'+(index?'900':'100')+'Z',properties:{userId:'micro'}})));
 assert.deepEqual((await watch.business.getFunnel({name:'submillisecond',timeRange:{from:'2026-01-01T00:00:00Z',to:'2026-01-01T00:00:01Z'}})).steps.map(step=>step.count),[1,0]);
 await assert.rejects(watch.business.createFunnel({name:'invalid',steps:[{event:'a',filters:{value:'\ud800'}},{event:'b'}],timeWindow:'1m'}));
 await watch.business.createFunnel({name:'exact-window',steps:[{event:'bound-a'},{event:'bound-b'}],timeWindow:'1m'});
 await watch.ingest([['bound-a',4001],['bound-b',64001]].map(([name,timestamp])=>({type:'track',name,timestamp,app:{name:'wire-✓'},properties:{userId:'boundary'}})));
 assert.deepEqual((await watch.business.getFunnel({name:'exact-window',timeRange:{from:4001,to:64001}})).steps.map(step=>step.count),[1,1]);
 assert.deepEqual((await watch.business.getFunnel({name:'exact-window',timeRange:{from:4001.5,to:64001}})).steps.map(step=>step.count),[0,0]);
 const goal={name:'typescript-goal',target:100,metric:'purchase.completed.total',aggregation:'sum',period:'month',startDate:'2026-01-31'};
 await watch.business.createGoal(goal);
 await watch.ingest([25,-5].map((total,index)=>({type:'track',name:'purchase.completed',app:{name:'wire-✓'},timestamp:`2026-02-0${index+1}T00:00:00Z`,properties:{total}})));
 assert.equal((await watch.business.getGoalProgress({name:goal.name,date:'2026-02-14'})).actual,20);
 syntheticServer=createServer((_req,res)=>{res.end('healthy');});
 await new Promise(resolve=>syntheticServer.listen(0,'127.0.0.1',resolve));
 await watch.synthetics.create({name:'wire-http',type:'http',url:`http://127.0.0.1:${syntheticServer.address().port}`,interval:'1h',assertions:[{type:'status',operator:'eq',value:200}]});
 const deadline=Date.now()+5000;
 while(!(await watch.synthetics.getUptime({checkId:'wire-http'})).observed){assert.ok(Date.now()<deadline,'synthetic result not persisted');await new Promise(resolve=>setTimeout(resolve,10));}
 const python=String.raw`
import json,sys
from sqlalchemy import create_engine
from superfunctions_sqlalchemy import create_adapter
from watchfn import WatchFn
from watchfn.storage.events import decode_event
engine=create_engine('sqlite:///'+sys.argv[1])
watch=WatchFn('wire-✓',storage='database',database=create_adapter(engine))
watch.system_metrics.start=lambda:None
watch.process_metrics.start=lambda:None
watch.start()
try:
 assert watch.synthetics.get_uptime({'checkId':'wire-http'})['uptime']==100
 assert watch.synthetics.get_incidents({'checkId':'wire-http'})==[]
 assert sum(bucket['count'] for bucket in watch.synthetics.get_performance_trend({'checkId':'wire-http','metric':'responseTime'})['buckets'])==1
 progress=watch.business.get_goal_progress({'name':'typescript-goal','date':'2026-02-14'})
 assert (progress['actual'],progress['elapsedPercent'],progress['expected'])==(20,50,50),progress
 watch.business.create_goal({'name':'python-goal','target':100,'metric':'purchase.completed.total','aggregation':'sum','period':'month','startDate':'2026-01-31'})
 boundary=watch.business.get_funnel({'name':'exact-window','timeRange':{'from':4001,'to':64001}})
 assert [step['count'] for step in boundary['steps']]==[1,1],boundary
 fractional=watch.business.get_funnel({'name':'exact-window','timeRange':{'from':4001.5,'to':64001}})
 assert [step['count'] for step in fractional['steps']]==[0,0],fractional
 micro=watch.business.get_funnel({'name':'submillisecond','timeRange':{'from':'2026-01-01T00:00:00Z','to':'2026-01-01T00:00:01Z'}})
 assert [step['count'] for step in micro['steps']]==[1,0],micro
 tie=watch.business.get_funnel({'name':'shared-tie-vector','timeRange':{'from':0,'to':100}})
 assert [step['count'] for step in tie['steps']]==[2,2],tie
 before=watch.business.get_funnel({'name':'typescript-definition','timeRange':'last-1h','groupBy':'source'})
 assert [step['count'] for step in before['steps']]==[1,1,0],before
 assert len(before['groups'])==1 and before['groups'][0]['group']==1
 watch.business.track('receipt',{'userId':'buyer','source':1})
 watch.flush()
 after=watch.business.get_funnel({'name':'typescript-definition','timeRange':'last-1h'})
 assert [step['count'] for step in after['steps']]==[1,1,1],after
 watch.business.create_funnel({'name':'python-definition','steps':[{'event':'cart'},{'event':'paid'}],'timeWindow':'1h'})
 try:watch.business.create_funnel({'name':'typescript-definition','steps':[{'event':'x'},{'event':'y'}],'timeWindow':'1h'})
 except Exception:pass
 else:raise AssertionError('duplicate definition replaced')
 print(json.dumps({'pythonReadTsDefinition':True,'pythonReadTsEvents':True,'pythonProducedCanonicalTrack':True,'counts':[step['count'] for step in after['steps']]}))
finally:
 watch.stop();engine.dispose()
`;
 const script=join(directory,'check.py');await writeFile(script,python);
 const run=spawnSync(process.env.WATCH_PYTHON??'python3',[script,file],{encoding:'utf8',timeout:30000,env:process.env,cwd:directory});
 assert.equal(run.status,0,run.stdout+'\n'+run.stderr);process.stdout.write(run.stdout);
 const result=await watch.business.getFunnel({name:'typescript-definition',timeRange:'last-1h'});assert.deepEqual(result.steps.map(step=>step.count),[1,1,1]);
 assert.deepEqual((await watch.business.getFunnel({name:'python-definition',timeRange:'last-1h'})).steps.map(step=>step.count),[1,1]);
 assert.equal((await watch.business.getGoalProgress({name:'python-goal',date:'2026-02-14'})).actual,20);
 console.log('Installed Python reports read an actual TypeScript scheduled HTTP result');
 console.log('Installed bilateral stored goals and calendar progress passed');
 console.log('Actual shared SQLite: TS and Python definitions/events/query roundtrip passed');
}finally{
 try{if(watch)await watch.stop();}finally{try{if(db)await db.destroy();}finally{try{if(syntheticServer?.listening)await new Promise(resolve=>syntheticServer.close(resolve));}finally{await rm(directory,{recursive:true,force:true});}}}
}
