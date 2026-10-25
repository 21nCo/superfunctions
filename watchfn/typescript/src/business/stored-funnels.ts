import { createHash } from 'node:crypto';
import { wrapWithSchema, type Adapter } from '@superfunctions/db';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import type { StorageAdapter } from '../storage/types';
import { QueryEngine, QueryValidationError } from '../query/query-engine';
import type { QueryOptions } from '../query/types';
import { TimeRangeParser } from '../query/time-range';
import { logField } from '../storage/log-index/values';
import { BUSINESS_DEFINITIONS, getBusinessSchema } from './schema';

type Scalar = string | number | boolean | null;
export interface StoredFunnelStep { event: string; name?: string; filters?: Record<string,Scalar> }
export interface CreateFunnelOptions { name: string; steps: StoredFunnelStep[]; timeWindow: string }
export interface FunnelQueryOptions { name: string; timeRange: NonNullable<QueryOptions['timeRange']>; groupBy?: string }
export interface DropoffQueryOptions extends Omit<FunnelQueryOptions,'name'> { funnel: string; step: number }
export interface FunnelStepResult { event: string; name: string; count: number; conversionRate: number }
export interface FunnelSummary { steps: FunnelStepResult[]; overallConversion: number }
export interface FunnelResult extends FunnelSummary { name: string; groups?: (FunnelSummary & {group:Scalar})[]; ignoredIdentityEvents: number; ordering: 'strict-timestamp' }
interface Definition { protocol: 'funnel-v1'; config: CreateFunnelOptions }
interface Host { name: string; database?: Adapter; storage: StorageAdapter; admit<T>(operation:()=>Promise<T>):Promise<T> }
const copy = <T>(value:T):T=>JSON.parse(JSON.stringify(value));
function record(value:unknown):value is Record<string,unknown> {return !!value && typeof value==='object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));}
function text(value:unknown,max=255):value is string {return typeof value==='string' && !!value.trim() && value.length<=max && Buffer.from(value,'utf8').toString('utf8')===value;}
function field(value:unknown):asserts value is string {if(!text(value,255)||value.split('.').some(p=>!p||['__proto__','constructor','prototype'].includes(p))) throw new TypeError('Invalid funnel field');}
function scalar(value:unknown):value is Scalar {return value===null||typeof value==='string'&&value.length<=1024&&Buffer.from(value,'utf8').toString('utf8')===value||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value);}
export function businessEvent(name:string,properties:unknown,app:string):Record<string,unknown> {
 if(!text(name)||!text(app)||!record(properties))throw new TypeError('Business events require a name and properties object');
 const serialized=JSON.stringify({type:'track',name,app:{name:app},timestamp:new Date(),properties});
 if(Buffer.byteLength(serialized,'utf8')>65536)throw new TypeError('Business event exceeds 64KiB');
 return JSON.parse(serialized);
}
function validate(input:CreateFunnelOptions):CreateFunnelOptions {
 if(!record(input)||!text(input.name)||!Array.isArray(input.steps)||input.steps.length<2||input.steps.length>32||Object.keys(input).some(k=>!['name','steps','timeWindow'].includes(k))) throw new TypeError('Invalid funnel definition');
 if(typeof input.timeWindow!=='string') throw new TypeError('Invalid funnel window');
 const window=TimeRangeParser.parseDuration(input.timeWindow); if(window>366*86400000) throw new TypeError('Funnel window exceeds one year');
 const steps=input.steps.map(step=>{
  if(!record(step)||!text(step.event)||step.name!==undefined&&!text(step.name)||Object.keys(step).some(k=>!['event','name','filters'].includes(k))) throw new TypeError('Invalid funnel step');
  if(step.filters!==undefined){
   if(!record(step.filters)||Object.keys(step.filters).length>16) throw new TypeError('Invalid funnel filters');
   for(const [key,value]of Object.entries(step.filters)){field(key);if(!scalar(value))throw new TypeError('Funnel filters require finite scalar values');}
  }
  return {event:step.event,...(step.name===undefined?{}:{name:step.name}),...(step.filters===undefined?{}:{filters:step.filters})} as StoredFunnelStep;
 });
 const config=copy({name:input.name,steps,timeWindow:input.timeWindow});
 if(Buffer.byteLength(JSON.stringify(config),'utf8')>32768) throw new TypeError('Funnel definition exceeds 32KiB');
 return config;
}
/** Uses canonical retained events, never a disconnected business-event cache. */
export class StoredFunnels {
 private readonly db:Adapter;
 constructor(private readonly host:Host){if(!text(host.name,255))throw new TypeError('Invalid business namespace');this.db=wrapWithSchema(host.database??memoryAdapter(),getBusinessSchema());}
 private id(name:string){return createHash('sha256').update(JSON.stringify([this.host.name,'funnel',name])).digest('hex');}
 create(input:CreateFunnelOptions):Promise<CreateFunnelOptions>{
  const config=validate(input);
  return this.host.admit(async()=>{
   await this.db.create({model:BUSINESS_DEFINITIONS,data:{id:this.id(config.name),namespace:this.host.name,kind:'funnel',name:config.name,payload:{protocol:'funnel-v1',config}}});
   return copy(config);
  });
 }
 private async definition(name:string):Promise<CreateFunnelOptions>{
  if(!text(name))throw new TypeError('Invalid funnel name');
  const row=await this.db.findOne<{namespace:string;kind:string;name:string;payload:Definition}>({model:BUSINESS_DEFINITIONS,where:[{field:'id',operator:'eq',value:this.id(name)},{field:'namespace',operator:'eq',value:this.host.name}]});
  if(!row)throw new Error('Funnel not found');
  if(row.kind!=='funnel'||row.name!==name||row.payload?.protocol!=='funnel-v1')throw new Error('Unsupported stored funnel definition');
  const config=validate(row.payload.config);if(config.name!==name)throw new Error('Invalid stored funnel identity');return config;
 }
 get(options:FunnelQueryOptions):Promise<FunnelResult>{
  if(!record(options)||!text(options.name)||options.timeRange==null||Object.keys(options).some(k=>!['name','timeRange','groupBy'].includes(k)))throw new TypeError('Invalid funnel query');
  if(options.groupBy!==undefined)field(options.groupBy);
  const input=copy(options);
  return this.host.admit(()=>this.evaluate(input));
 }
 dropoff(options:DropoffQueryOptions){
  if(!record(options)||!Number.isSafeInteger(options.step)||options.step<1||Object.keys(options).some(k=>!['funnel','step','timeRange','groupBy'].includes(k)))throw new TypeError('Invalid dropoff query');
  const step=options.step;
  return this.get({name:options.funnel,timeRange:options.timeRange,groupBy:options.groupBy}).then(result=>{
   if(step>=result.steps.length)throw new TypeError('Dropoff step must precede another step');
   const summarize=(value:FunnelSummary)=>{const entered=value.steps[step-1].count,advanced=value.steps[step].count;return {entered,advanced,dropped:entered-advanced,dropoffRate:entered?(entered-advanced)/entered*100:0};};
   return {name:result.name,step,...summarize(result),...(result.groups?{groups:result.groups.map(group=>({group:group.group,...summarize(group)}))}:{})};
  });
 }
 private async evaluate(input:FunnelQueryOptions):Promise<FunnelResult>{
  const config=await this.definition(input.name),window=TimeRangeParser.parseDuration(config.timeWindow);
  const storage=this.host.storage;
  const bounded:StorageAdapter={add(){throw new Error('Read only');},query(){throw new Error('Streaming required');},async *iterateQuery(options){
   if(!storage.iterateQuery)throw new QueryValidationError('Funnels require streaming storage');
   let count=0,bytes=0;
   for await(const event of storage.iterateQuery({...options,requireStreaming:true})){
    if(++count>10000)throw new QueryValidationError('Funnel candidate capacity exceeded');
    const size=Buffer.byteLength(JSON.stringify(event),'utf8');bytes+=size;
    if(size>65536||bytes>16*1024*1024)throw new QueryValidationError('Funnel payload capacity exceeded');
    yield event;
   }
  }};
  const rows=(await new QueryEngine(bounded).execute({where:{type:'track'},timeRange:input.timeRange})).data;
  const events=rows.map(event=>({event,time:new Date(event.timestamp??event.ts).getTime()})).filter(row=>Number.isFinite(row.time)).sort((a,b)=>a.time-b.time);
  type User={depth:number;starts:({start:number;last:number}|undefined)[];group:Scalar;entered:number};
  const users=new Map<string,User>();let ignoredIdentityEvents=0;
  let batchTime:number|undefined;const priorStates=new Map<string,User['starts']>();
  for(const {event,time}of events){
   if(batchTime!==time){batchTime=time;priorStates.clear();}
   const matches=config.steps.map(step=>event.name===step.event&&Object.entries(step.filters??{}).every(([key,value])=>logField(event,key)===value));
   if(!matches.some(Boolean))continue;
   if(typeof event.app?.name!=='string'||!event.app.name)throw new QueryValidationError('Business event ownership is missing; migrate legacy events before funnel evaluation');
   if(event.app.name!==this.host.name)continue;
   const identity=logField(event,'userId');if(!text(identity,1024)){ignoredIdentityEvents++;continue;}
   let user=users.get(identity);
   if(!user&&matches[0]){
    const group=input.groupBy===undefined?null:logField(event,input.groupBy)??null;
    if(!scalar(group))throw new QueryValidationError('Funnel cohort group must be a finite scalar');
    user={depth:0,starts:[],group,entered:time};users.set(identity,user);
   }
   if(!user)continue;
   if(!priorStates.has(identity))priorStates.set(identity,user.starts.slice());
   const prior=priorStates.get(identity)!;
   if(matches[0]&&time===user.entered&&input.groupBy!==undefined){const group=logField(event,input.groupBy)??null;if(!scalar(group)||group!==user.group)throw new QueryValidationError('Ambiguous first-entry funnel cohort');}
   // Descending updates prevent one event satisfying multiple consecutive steps.
   // Strict timestamps avoid inventing order among simultaneous stored events.
   for(let index=config.steps.length-1;index>0;index--){
    const previous=prior[index-1];
    if(matches[index]&&previous&&previous.last<time&&time-previous.start<=window){
     if(!user.starts[index]||previous.start>user.starts[index]!.start)user.starts[index]={start:previous.start,last:time};
     user.depth=Math.max(user.depth,index+1);
    }
   }
   if(matches[0]){user.starts[0]={start:time,last:time};user.depth=Math.max(user.depth,1);}
  }
  const summarize=(values:User[]):FunnelSummary=>{
   const counts=config.steps.map((_,index)=>values.filter(user=>user.depth>index).length);
   return {steps:config.steps.map((step,index)=>({event:step.event,name:step.name??step.event,count:counts[index],conversionRate:index?(counts[index-1]?counts[index]/counts[index-1]*100:0):(counts[0]?100:0)})),overallConversion:counts[0]?counts[counts.length-1]/counts[0]*100:0};
  };
  const values=[...users.values()];let groups:(FunnelSummary&{group:Scalar})[]|undefined;
  if(input.groupBy!==undefined){const grouped=new Map<string,{group:Scalar;users:User[]}>();for(const user of values){const key=JSON.stringify(user.group);let group=grouped.get(key);if(!group){if(grouped.size>=1000)throw new QueryValidationError('Funnel group capacity exceeded');group={group:user.group,users:[]};grouped.set(key,group);}group.users.push(user);}groups=[...grouped.entries()].sort(([a],[b])=>Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8'))).map(([,group])=>({group:group.group,...summarize(group.users)}));}
  return {name:config.name,...summarize(values),...(groups?{groups}:{}),ignoredIdentityEvents,ordering:'strict-timestamp'};
 }
}
