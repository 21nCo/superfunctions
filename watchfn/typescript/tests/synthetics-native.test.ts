import {afterEach,describe,expect,it} from 'vitest';
import {createServer,type RequestListener} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {Kysely,SqliteDialect} from 'kysely';
import {kyselyAdapter} from '@superfunctions/db/adapters';
import {WatchFn} from '../src/core/watch-fn';
import {HttpCheckRunner} from '../src/synthetics/http-check';
import {getWatchFnSchema} from '../src/storage/schema';
const watches:WatchFn[]=[],servers:ReturnType<typeof createServer>[]=[],databases:Kysely<any>[]=[],directories:string[]=[];
afterEach(async()=>{
  for(const watch of watches.splice(0))await watch.stop().catch(()=>{});
  for(const server of servers.splice(0))await new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});
  for(const db of databases.splice(0))await db.destroy();
  for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});
});
async function endpoint(handler:RequestListener){
  const server=createServer(handler);servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
}
async function until(predicate:()=>boolean|Promise<boolean>){const end=Date.now()+3000;while(!await predicate()){if(Date.now()>=end)throw new Error('Fixture did not reach expected state');await new Promise(resolve=>setTimeout(resolve,10));}}
async function persistent(){
  const directory=await mkdtemp(join(tmpdir(),'watch-synthetic-'));directories.push(directory);const file=join(directory,'db.sqlite');
  function connect(){const db=new Kysely<any>({dialect:new SqliteDialect({database:new Database(file)})});databases.push(db);return db;}
  const db=connect();for(const [name,table]of Object.entries(getWatchFnSchema())){let migration=db.schema.createTable(name);for(const [field,options]of Object.entries(table.fields))migration=migration.addColumn(field,options.type==='number'?'integer':'text',column=>field==='id'?column.primaryKey():options.required?column.notNull():column);await migration.execute();}
  return (name='native-synthetic')=>{const watch=new WatchFn({name,storage:'database',database:kyselyAdapter({db:connect(),dialect:'sqlite',schema:Object.fromEntries(Object.keys(getWatchFnSchema()).map(key=>[key,key]))}),infra:{enabled:false}});watches.push(watch);watch.start();return watch;};
}
describe('native synthetic HTTP and stored reports',()=>{
  it('bounds a stalled body, cancels the owned socket and limits bytes',async()=>{
    let closed=false;const url=await endpoint((_request,response)=>{response.writeHead(200);response.write('x');response.on('close',()=>{closed=true;});});
    const runner=new HttpCheckRunner();const result=await runner.run({id:'stall',name:'stall',type:'http',url,interval:'1m',timeout:100});
    expect(result).toMatchObject({success:false});await until(()=>closed);
    const large=await endpoint((_request,response)=>response.end('large payload'));
    expect(await runner.run({id:'cap',name:'cap',type:'http',url:large,interval:'1m',maxResponseBytes:4})).toMatchObject({success:false,error:'Synthetic response byte limit exceeded'});
  });
  it('stop cancels and joins an active HTTP attempt without publishing a false failure',async()=>{
    let received=0,closed=false;const url=await endpoint((_request,response)=>{received++;response.writeHead(200);response.write('x');response.on('close',()=>{closed=true;});});
    const watch=new WatchFn({name:'stop-synthetic',storage:'memory',infra:{enabled:false}});watches.push(watch);watch.start();
    await watch.synthetics.create({name:'owned',type:'http',url,interval:10,timeout:10000});await until(()=>received===1);
    await new Promise(resolve=>setTimeout(resolve,50));expect(received).toBe(1);await watch.stop();await until(()=>closed);
    watch.start();expect(await watch.synthetics.getUptime({checkId:'owned'})).toMatchObject({observed:false,total:0,uptime:null});
  });
  it('retries real HTTP, persists the result and reports after independent SQLite reopen',async()=>{
    let attempts=0;const url=await endpoint((_request,response)=>{attempts++;response.statusCode=attempts===1?503:200;response.end('healthy');});
    const reopen=await persistent(),watch=reopen();await watch.synthetics.create({name:'health',type:'http',url,interval:'1m',retries:1,assertions:[{type:'status',operator:'eq',value:200}]});
    await until(async()=>{await watch.flush();return (await watch.synthetics.getUptime({checkId:'health'})).total===1;});
    expect(attempts).toBe(2);await watch.stop();const independent=reopen();
    const other=reopen('different-app');expect(await other.synthetics.getUptime({checkId:'health'})).toMatchObject({observed:false,total:0});
    expect(await independent.synthetics.getUptime({checkId:'health'})).toMatchObject({total:1,successful:1,uptime:100,basis:'completed-checks'});
    const rows=await independent.query({metric:'synthetics.check'});expect(rows[0].properties).toMatchObject({attempts:2,checkId:'health',success:true});
    const trend=await independent.synthetics.getPerformanceTrend({checkId:'health',metric:'responseTime',interval:'1h'});expect(trend.buckets.reduce((sum,row)=>sum+row.count,0)).toBe(1);
  });
  it('uses observed chronological failures and recovery across report windows',async()=>{
    const watch=new WatchFn({name:'report-synthetic',storage:'memory',infra:{enabled:false}});watches.push(watch);watch.start();
    const now=Date.now();for(const [offset,success]of [[-100,true],[-90,false],[-80,false],[-20,true],[-10,false]] as const)await watch.ingest([{type:'track',name:'synthetics.check',app:{name:'report-synthetic'},timestamp:now+offset,properties:{checkId:'health',runId:String(offset),timestamp:now+offset,success,duration:10}}]);
    const options={checkId:'health',timeRange:{from:now-50,to:now}};
    expect(await watch.synthetics.getUptime(options)).toMatchObject({total:2,successful:1,uptime:50});
    expect(await watch.synthetics.getIncidents({...options,status:'resolved'})).toEqual([{checkId:'health',startedAt:now-90,resolvedAt:now-20,status:'resolved',failures:2,leftCensored:false}]);
    expect(await watch.synthetics.getIncidents({...options,status:'active'})).toHaveLength(1);
    const trend=await watch.synthetics.getPerformanceTrend({...options,metric:'responseTime',interval:25});expect(trend.buckets.map(bucket=>bucket.count)).toEqual([0,2]);
  });
});

it('uses canonical envelope time and rejects conflicting duplicate run identities',async()=>{
  const watch=new WatchFn({name:'canonical-result',storage:'memory',infra:{enabled:false}});watches.push(watch);watch.start();const now=Date.now();
  await watch.ingest([{type:'track',name:'synthetics.check',app:{name:'canonical-result'},timestamp:now,properties:{checkId:'id',runId:'run',timestamp:now-1000,success:true,duration:5}}]);
  expect(await watch.synthetics.getUptime({checkId:'id',timeRange:{from:now,to:now}})).toMatchObject({total:1,uptime:100});
  expect((await watch.synthetics.getPerformanceTrend({checkId:'id',timeRange:{from:now,to:now},metric:'responseTime',interval:'1m'})).buckets[0]).toMatchObject({count:1,average:5});
  await watch.ingest([{type:'track',name:'synthetics.check',app:{name:'canonical-result'},timestamp:now,properties:{checkId:'id',runId:'run',timestamp:now-1000,success:false,duration:5}}]);
  await expect(watch.synthetics.getUptime({checkId:'id'})).rejects.toThrow('Conflicting');
});

it('fails closed on relevant legacy synthetic rows with unknown app ownership',async()=>{
  const watch=new WatchFn({name:'legacy-result',storage:'memory',infra:{enabled:false}});watches.push(watch);watch.start();const now=Date.now();
  await watch.ingest([{type:'track',name:'synthetics.check',timestamp:now,properties:{checkId:'id',timestamp:now,success:true,duration:5}}]);
  await expect(watch.synthetics.getUptime({checkId:'id'})).rejects.toThrow('ownership');
});
