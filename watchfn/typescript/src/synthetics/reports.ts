import {QueryEngine,QueryValidationError} from '../query/query-engine';
import {TimeRangeParser,type TimeRange} from '../query/time-range';
import type {StorageAdapter} from '../storage/types';
import {durationMilliseconds,type CheckResult} from './types';
export interface SyntheticReportOptions {checkId:string;timeRange?:TimeRange}
export interface SyntheticIncidentOptions extends SyntheticReportOptions {status?:'active'|'resolved'}
export interface SyntheticTrendOptions extends SyntheticReportOptions {metric:'responseTime';interval?:string|number}
export interface SyntheticIncident {checkId:string;startedAt:number;resolvedAt:number|null;status:'active'|'resolved';failures:number;leftCensored:boolean}
export class SyntheticReports {
  constructor(private readonly storage:StorageAdapter,private readonly app:string){}
  private options(options:SyntheticReportOptions){
    if(!options||typeof options.checkId!=='string'||!options.checkId||options.checkId.length>256)throw new QueryValidationError('Invalid synthetic check ID');
    const range=TimeRangeParser.parse(options.timeRange??'last-24h');
    if(!Number.isFinite(range.from)||!Number.isFinite(range.to)||range.from>range.to||Math.max(Math.abs(range.from),Math.abs(range.to))>8640000000000000)throw new QueryValidationError('Invalid synthetic report range');
    return range;
  }
  private async results(options:SyntheticReportOptions,history=false){
    const range=this.options(options),storage=this.storage;
    const bounded:StorageAdapter={add(){throw new Error('Read only');},query(){throw new Error('Streaming required');},async *iterateQuery(query){
      if(!storage.iterateQuery)throw new QueryValidationError('Synthetic reports require streaming storage');
      let count=0,bytes=0;
      for await(const event of storage.iterateQuery({...query,requireStreaming:true})){
        if(++count>10000)throw new QueryValidationError('Synthetic report scan count exceeded');
        const size=Buffer.byteLength(JSON.stringify(event));bytes+=size;
        if(size>65536||bytes>16777216)throw new QueryValidationError('Synthetic report scan bytes exceeded');
        yield event;
      }
    }};
    const events=(await new QueryEngine(bounded).execute({metric:'synthetics.check',where:{type:'track'},timeRange:{from:history?-8640000000000000:range.from,to:range.to}})).data;
    const results:CheckResult[]=[];const runs=new Map<string,string>();
    for(const event of events){
      const result=event.properties;
      if(!result||result.checkId!==options.checkId)continue;
      if(typeof event.app?.name!=='string'||!event.app.name)throw new QueryValidationError('Legacy synthetic result has no application ownership; explicit migration required');
      if(event.app.name!==this.app)continue;
      if(typeof result.success!=='boolean'||typeof result.timestamp!=='number'||!Number.isFinite(result.timestamp)||typeof result.duration!=='number'||!Number.isFinite(result.duration)||result.duration<0)throw new QueryValidationError('Invalid stored synthetic result');
      // Query windows and ordering share the canonical envelope timestamp. The
      // result's own timestamp can precede capture by a few milliseconds.
      const timestamp=event.timestamp instanceof Date?event.timestamp.getTime():typeof event.timestamp==='number'?event.timestamp:Date.parse(event.timestamp);
      if(!Number.isFinite(timestamp))throw new QueryValidationError('Invalid synthetic envelope timestamp');
      if(result.runId!==undefined){
        if(typeof result.runId!=='string'||!result.runId||result.runId.length>256)throw new QueryValidationError('Invalid synthetic run identity');
        const signature=JSON.stringify([timestamp,result.success,result.duration]);
        if(runs.has(result.runId)){if(runs.get(result.runId)!==signature)throw new QueryValidationError('Conflicting synthetic run results');continue;}
        runs.set(result.runId,signature);
      }
      results.push({...result,timestamp});
    }
    results.sort((a,b)=>a.timestamp-b.timestamp||(a.runId??'').localeCompare(b.runId??''));
    // Conflicting simultaneous outcomes have no reliable incident ordering.
    for(let i=1;i<results.length;i++)if(results[i].timestamp===results[i-1].timestamp&&results[i].success!==results[i-1].success)throw new QueryValidationError('Ambiguous simultaneous synthetic outcomes');
    return {range,results};
  }
  async getUptime(options:SyntheticReportOptions){
    const {range,results}=await this.results(options);const successful=results.filter(result=>result.success).length;
    return {checkId:options.checkId,timeRange:range,basis:'completed-checks' as const,observed:results.length>0,total:results.length,successful,failed:results.length-successful,uptime:results.length?successful/results.length*100:null};
  }
  async getIncidents(options:SyntheticIncidentOptions){
    if(options?.status!==undefined&&!['active','resolved'].includes(options.status))throw new QueryValidationError('Invalid incident status');
    const {range,results}=await this.results(options,true);const incidents:SyntheticIncident[]=[];let open:SyntheticIncident|undefined;
    for(let i=0;i<results.length;i++){
      const result=results[i];
      if(!result.success){if(!open){open={checkId:options.checkId,startedAt:result.timestamp,resolvedAt:null,status:'active',failures:0,leftCensored:i===0};incidents.push(open);}open.failures++;}
      else if(open){open.resolvedAt=result.timestamp;open.status='resolved';open=undefined;}
    }
    return incidents.filter(incident=>(incident.resolvedAt===null||incident.resolvedAt>=range.from)&&incident.startedAt<=range.to&&(!options.status||incident.status===options.status));
  }
  async getPerformanceTrend(options:SyntheticTrendOptions){
    if(options?.metric!=='responseTime')throw new QueryValidationError('Only responseTime synthetic trend is supported');
    const {range,results}=await this.results(options);const interval=durationMilliseconds(options.interval??'1h');
    const buckets=(range.from===range.to?[range]:TimeRangeParser.getBuckets(range,interval,10000)).map(bucket=>({...bucket,count:0,successful:0,failed:0,total:0,min:null as number|null,max:null as number|null}));
    for(const result of results){
      // Half-open buckets, with the exact report upper endpoint included in the last.
      const index=Math.min(buckets.length-1,Math.floor((result.timestamp-range.from)/interval));if(index<0)continue;
      const bucket=buckets[index];bucket.count++;if(result.success)bucket.successful++;else bucket.failed++;bucket.total+=result.duration;bucket.min=Math.min(bucket.min??result.duration,result.duration);bucket.max=Math.max(bucket.max??result.duration,result.duration);
    }
    return {checkId:options.checkId,metric:'responseTime' as const,timeRange:range,interval,buckets:buckets.map(({total,...bucket})=>({...bucket,average:bucket.count?total/bucket.count:null}))};
  }
}
