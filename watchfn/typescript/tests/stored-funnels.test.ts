import { afterEach, expect, it } from 'vitest';
import { WatchFn } from '../src/core/watch-fn';
const watches: WatchFn[] = [];
afterEach(async () => { for (const watch of watches.splice(0)) { await watch.flush().catch(() => {}); await watch.stop().catch(() => {}); } });
function create() { const watch = new WatchFn({name:'funnels',storage:'memory',infra:{enabled:false}}); watches.push(watch); watch.start(); return watch; }
it('counts only ordered identified conversions from actual persisted business events', async () => {
 const watch=create();
 await watch.business.createFunnel({name:'checkout',steps:[{event:'product.viewed'},{event:'purchase.completed',filters:{paid:true}}],timeWindow:'1h'});
 watch.business.track('purchase.completed',{userId:'backwards',paid:true});
 await new Promise(resolve=>setTimeout(resolve,3));
 watch.business.track('product.viewed',{userId:'backwards'});
 watch.business.track('product.viewed',{userId:'buyer'});
 await new Promise(resolve=>setTimeout(resolve,3));
 watch.business.track('purchase.completed',{userId:'buyer',paid:true});
 watch.business.track('purchase.completed',{userId:'buyer',paid:true});
 watch.business.track('purchase.completed',{paid:true});
 await watch.flush();
 const result=await watch.business.getFunnel({name:'checkout',timeRange:'last-1h'});
 expect(result.steps.map((step:any)=>step.count)).toEqual([2,1]);
 expect(result.overallConversion).toBe(50);
});

it('enforces windows, repeated attempts, strict order and first-entry cohorts', async()=>{
 const watch=create();const now=Date.now();
 await watch.business.createFunnel({name:'three',steps:[{event:'start'},{event:'middle'},{event:'end'}],timeWindow:'1m'});
 const event=(name:string,userId:string,time:number,source='organic')=>({type:'track',app:{name:'funnels'},name,timestamp:now+time,properties:{userId,source}});
 await watch.ingest([
  event('end','wrong',30),event('middle','wrong',20),event('start','wrong',25),
  event('start','expired',0),event('middle','expired',60001),event('end','expired',60002),
  event('start','restart',0,'paid'),event('middle','restart',60001),event('start','restart',60002,'changed'),event('middle','restart',60003),event('end','restart',60004),
  event('start','equal',0),event('middle','equal',0),event('end','equal',1),
  event('start','good',0),event('middle','good',10),event('end','good',20),event('end','good',25),
 ]);
 const result=await watch.business.getFunnel({name:'three',timeRange:{from:now,to:now+70000},groupBy:'source'});
 expect(result.steps.map(row=>row.count)).toEqual([5,2,2]);
 expect(result.groups?.map(row=>[row.group,row.steps.map(step=>step.count)])).toEqual([['organic',[4,1,1]],['paid',[1,1,1]]]);
 expect(await watch.business.getDropoffAnalysis({funnel:'three',step:1,timeRange:{from:now,to:now+70000}})).toMatchObject({entered:5,advanced:2,dropped:3,dropoffRate:60});
});

it('snapshots definitions, rejects duplicates and invalid inputs, and never fabricates missing funnels',async()=>{
 const watch=create();const input={name:'immutable',steps:[{event:'a',filters:{ok:true}},{event:'b'}],timeWindow:'1h'};
 const created=await watch.business.createFunnel(input);input.steps[0].event='changed';created.steps[0].event='changed-again';
 await expect(watch.business.createFunnel({...input,name:'immutable'})).rejects.toThrow();
 const result=await watch.business.getFunnel({name:'immutable',timeRange:'last-1h'});expect(result.steps[0].event).toBe('a');expect(result.overallConversion).toBe(0);
 await expect(watch.business.getFunnel({name:'absent',timeRange:'last-1h'})).rejects.toThrow('not found');
 await expect(watch.business.createFunnel({name:'bad',steps:[{event:'a',filters:{'constructor.x':true}},{event:'b'}],timeWindow:'1h'})).rejects.toThrow('field');
 await expect(watch.business.getFunnel({name:'immutable',timeRange:null as any})).rejects.toThrow();
 await expect(watch.business.getDropoffAnalysis({funnel:'immutable',step:2,timeRange:'last-1h'})).rejects.toThrow();
 await watch.flush().catch(()=>{});await watch.stop();
 await expect(watch.business.getFunnel({name:'immutable',timeRange:'last-1h'})).rejects.toThrow('unavailable');
});

it('rejects ambiguous first-entry cohort labels and reports missing identities without merging them',async()=>{
 const watch=create(),now=Date.now();await watch.business.createFunnel({name:'groups',steps:[{event:'a'},{event:'b'}],timeWindow:'1h'});
 await watch.ingest([{type:'track',app:{name:'funnels'},name:'a',timestamp:now,properties:{source:'x'}},{type:'track',app:{name:'funnels'},name:'b',timestamp:now+1,properties:{}},{type:'track',app:{name:'funnels'},name:'a',timestamp:now,userId:null,properties:{userId:'nested'}}]);
 expect(await watch.business.getFunnel({name:'groups',timeRange:{from:now,to:now+2}})).toMatchObject({ignoredIdentityEvents:3,overallConversion:0});
 await watch.ingest([{type:'track',app:{name:'funnels'},name:'a',timestamp:now,properties:{userId:'u',source:'x'}},{type:'track',app:{name:'funnels'},name:'a',timestamp:now,properties:{userId:'u',source:'y'}}]);
 await expect(watch.business.getFunnel({name:'groups',timeRange:{from:now,to:now+2},groupBy:'source'})).rejects.toThrow('Ambiguous');
});

it('snapshots business capture and refuses to guess legacy ownership',async()=>{
 const watch=create();await watch.business.createFunnel({name:'capture',steps:[{event:'a'},{event:'b'}],timeWindow:'1h'});
 const props={userId:'original'};watch.business.track('a',props);props.userId='changed';await new Promise(resolve=>setTimeout(resolve,2));watch.business.track('b',{userId:'original'});await watch.flush();
 expect((await watch.business.getFunnel({name:'capture',timeRange:'last-1h'})).overallConversion).toBe(100);
 await watch.ingest([{type:'track',name:'a',timestamp:Date.now(),properties:{userId:'legacy'}}]);
 await expect(watch.business.getFunnel({name:'capture',timeRange:'last-1h'})).rejects.toThrow('ownership');
});

it('joins admitted definition writes on stop and rejects later admission',async()=>{
 const {memoryAdapter}=await import('@superfunctions/db/adapters/memory');
 const adapter=memoryAdapter();const original=adapter.create.bind(adapter);let release!:()=>void;let entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const admission=new Promise<void>(resolve=>{entered=resolve;});
 adapter.create=(async(options:any)=>{if(options.model==='watchfn_business_definitions'){entered();await gate;}return original(options);}) as typeof adapter.create;
 const watch=new WatchFn({name:'drain',storage:'database',database:adapter,infra:{enabled:false}});watches.push(watch);watch.start();
 const creating=watch.business.createFunnel({name:'pending',steps:[{event:'a'},{event:'b'}],timeWindow:'1h'});await admission;
 let stopped=false;const stopping=watch.stop().then(()=>{stopped=true;});await new Promise(resolve=>setTimeout(resolve,3));expect(stopped).toBe(false);
 await expect(watch.business.createFunnel({name:'late',steps:[{event:'a'},{event:'b'}],timeWindow:'1h'})).rejects.toThrow('unavailable');
 release();await creating;await stopping;expect(stopped).toBe(true);
});

it('fails a bounded candidate scan without returning partial conversions and closes the iterator',async()=>{
 const {StoredFunnels}=await import('../src/business/stored-funnels');let closed=false;
 const manager=new StoredFunnels({name:'bounded',admit:operation=>operation(),storage:{add(){},query(){return[];},async *iterateQuery(){try{for(let i=0;i<10001;i++)yield {type:'track',name:'a',app:{name:'bounded'},timestamp:Date.now(),properties:{userId:String(i)}};}finally{closed=true;}}}});
 await manager.create({name:'bounded',steps:[{event:'a'},{event:'b'}],timeWindow:'1h'});
 await expect(manager.get({name:'bounded',timeRange:'last-1h'})).rejects.toThrow('capacity');expect(closed).toBe(true);
});

// Simultaneous newer attempts must not erase an older valid chain merely because
// the database returned equal-timestamp rows in a different order.
it('keeps prior chains stable across simultaneous newer attempts',async()=>{
 for(const order of [['b','c'],['c','b']]){
  const watch=create(),now=Date.now();await watch.business.createFunnel({name:'ties',steps:[{event:'a'},{event:'b'},{event:'c'}],timeWindow:'1h'});
  const event=(name:string,offset:number)=>({type:'track',name,app:{name:'funnels'},timestamp:now+offset,properties:{userId:'u'}});
  await watch.ingest([event('a',0),event('b',1),event('a',2),...order.map(name=>event(name,3))]);
  expect((await watch.business.getFunnel({name:'ties',timeRange:{from:now,to:now+4}})).steps.map(row=>row.count)).toEqual([1,1,1]);
 }
});
