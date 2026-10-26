import {createHash} from 'node:crypto';
import type {StorageAdapter} from '../storage/types';
import {QueryEngine} from '../query/query-engine';
import {logField} from '../storage/log-index/values';
export interface GoalConfig {name:string;target:number;metric:string|{event:string;field:string};aggregation:'sum'|'count'|'avg'|'min'|'max';period:'day'|'week'|'month'|'year';startDate:string;timezone?:'UTC';alerts?:{on_track_check:string;notify_below_pace:boolean;channels:string[]}}
export interface GoalProgress {name:string;date:number;periodStart:number;periodEnd:number;actual:number|null;target:number;progressPercent:number|null;elapsedPercent:number;expected:number;belowPace:boolean|null;observed:boolean;eventCount:number}
export interface GoalCondition {type:'business-goal';goal:GoalConfig;app:string;operator:'below-pace'|'on-pace'}
const text=(v:unknown,n=255):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=n&&Buffer.from(v).toString()===v;
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function goalId(app:string,name:string,kind='goal'){if(!text(app)||!text(name))throw new TypeError('Invalid business identity');return createHash('sha256').update(JSON.stringify([app,kind,name])).digest('hex');}
export function validateGoal(input:GoalConfig):GoalConfig {
 if(!object(input)||Object.keys(input).some(k=>!['name','target','metric','aggregation','period','startDate','timezone','alerts'].includes(k))||!text(input.name)||typeof input.target!=='number'||!Number.isFinite(input.target)||input.target<=0||!['sum','count','avg','min','max'].includes(input.aggregation)||!['day','week','month','year'].includes(input.period)||input.timezone!==undefined&&input.timezone!=='UTC')throw new TypeError('Invalid business goal');
 if(typeof input.startDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)||Number(input.startDate.slice(0,4))<1000||!Number.isFinite(Date.parse(input.startDate))||new Date(input.startDate).toISOString().slice(0,10)!==input.startDate)throw new TypeError('Invalid UTC goal startDate');
 let metric=input.metric;
 if(typeof metric==='string'){const at=metric.lastIndexOf('.');if(at<=0||at>=metric.length-1)throw new TypeError('Goal metric requires event and field');metric={event:metric.slice(0,at),field:metric.slice(at+1)};}
 if(!object(metric)||Object.keys(metric).sort().join(',')!=='event,field'||!text(metric.event)||!text(metric.field)||metric.field.split('.').some(p=>!p||['__proto__','constructor','prototype'].includes(p)))throw new TypeError('Goal metric requires event and field');
 if(input.alerts!==undefined){const a=input.alerts;if(!object(a)||Object.keys(a).some(k=>!['on_track_check','notify_below_pace','channels'].includes(k))||typeof a.notify_below_pace!=='boolean'||typeof a.on_track_check!=='string'||!/^\d+(?:\.\d+)?%$/.test(a.on_track_check)||Number.parseFloat(a.on_track_check)<0||Number.parseFloat(a.on_track_check)>100||!Array.isArray(a.channels)||a.channels.length>10||new Set(a.channels).size!==a.channels.length||a.channels.some(c=>!text(c,128)))throw new TypeError('Invalid goal pace alerts');}
 const config=JSON.parse(JSON.stringify({...input,metric,timezone:'UTC'}));if(Buffer.byteLength(JSON.stringify(config))>16384)throw new TypeError('Goal definition too large');return config;
}
export function goalDate(value:unknown):number {if(typeof value==='string'){const prefix=value.slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(prefix)||new Date(Date.parse(prefix)).toISOString().slice(0,10)!==prefix||value.length>10&&!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value))throw new TypeError('Invalid goal date');}const at=typeof value==='number'?value:typeof value==='string'&&(/^\d{4}-\d{2}-\d{2}$/.test(value)||/(?:Z|[+-]\d\d:\d\d)$/.test(value))?Date.parse(value):NaN;if(!Number.isFinite(at)||at<Date.parse('1000-01-01')||at>Date.parse('9999-12-31T23:59:59.999Z')||typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(at).toISOString().slice(0,10)!==value)throw new TypeError('Invalid goal date');return at;}
export function goalPeriod(config:GoalConfig,now:number):[number,number]{
 const start=Date.parse(config.startDate),base=new Date(start);if(now<start)throw new RangeError('Goal date precedes startDate');
 if(config.period==='day'||config.period==='week'){const duration=(config.period==='day'?1:7)*86400000,from=start+Math.floor((now-start)/duration)*duration;if(from+duration>Date.parse('9999-12-31T23:59:59.999Z'))throw new RangeError('Goal period exceeds supported calendar');return [from,from+duration];}
 const step=config.period==='month'?1:12;
 const bound=(index:number)=>{const total=base.getUTCFullYear()*12+base.getUTCMonth()+index*step,year=Math.floor(total/12),month=total%12;if(year>9999)throw new RangeError('Goal period exceeds supported calendar');return Date.UTC(year,month,Math.min(base.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate()));};
 const date=new Date(now);let index=Math.floor(((date.getUTCFullYear()-base.getUTCFullYear())*12+date.getUTCMonth()-base.getUTCMonth())/step);if(bound(index)>now)index--;return [bound(index),bound(index+1)];
}
export async function goalProgress(storage:StorageAdapter,app:string,source:GoalConfig,date:unknown,maximum=10000):Promise<GoalProgress>{
 const goal=validateGoal(source),now=goalDate(date),[from,to]=goalPeriod(goal,now);let count=0,bytes=0;
 const bounded:StorageAdapter={add(){throw new Error('Read only');},query(){throw new Error('Streaming required');},async *iterateQuery(options){if(!storage.iterateQuery)throw new Error('Goals require streaming storage');for await(const event of storage.iterateQuery({...options,requireStreaming:true})){const size=Buffer.byteLength(JSON.stringify(event));if(++count>Math.min(maximum,10000)||size>65536||(bytes+=size)>16777216)throw new Error('Goal observation capacity exceeded');yield event;}}};
 const rows=(await new QueryEngine(bounded).execute({where:{type:'track'},timeRange:{from,to:now}})).data,values:number[]=[];
 const metric=goal.metric as {event:string;field:string};
 for(const row of rows){if(row.name!==metric.event)continue;if(typeof row.app?.name!=='string'||!row.app.name)throw new Error('Business event ownership missing; migration required');if(row.app.name!==app)continue;if(goal.aggregation==='count'){values.push(1);continue;}const value=logField(row,metric.field);if(typeof value!=='number'||!Number.isFinite(value))throw new TypeError('Goal event requires finite numeric value');values.push(value);}
 const observed=values.length>0||goal.aggregation==='count'||goal.aggregation==='sum';let actual:number|null=null;
 if(observed){actual=goal.aggregation==='count'?values.length:goal.aggregation==='min'?Math.min(...values):goal.aggregation==='max'?Math.max(...values):values.reduce((sum,v)=>sum+(goal.aggregation==='avg'?v/values.length:v),0);if(!Number.isFinite(actual))throw new Error('Goal aggregate overflow');}
 if(actual!==null&&!Number.isFinite(actual/goal.target*100))throw new Error('Goal progress overflow');
 const elapsed=(now-from)/(to-from),expected=goal.target*elapsed,eligible=elapsed*100>=Number.parseFloat(goal.alerts?.on_track_check??'0%');
 return {name:goal.name,date:now,periodStart:from,periodEnd:to,actual,target:goal.target,progressPercent:actual===null?null:actual/goal.target*100,elapsedPercent:elapsed*100,expected,belowPace:!eligible||actual===null?null:actual<expected,observed,eventCount:values.length};
}
export function goalDecision(condition:GoalCondition,progress:GoalProgress|undefined){return !progress||progress.belowPace===null?{matched:null,dataPoints:progress?.eventCount??0}:{matched:condition.operator==='below-pace'?progress.belowPace:!progress.belowPace,value:progress.actual??undefined,dataPoints:progress.eventCount};}
