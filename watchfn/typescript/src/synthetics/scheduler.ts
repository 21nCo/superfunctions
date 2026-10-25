import {randomUUID} from 'node:crypto';
import type {WatchFn} from '../core/watch-fn';
import {HttpCheckRunner} from './http-check';
import {type SyntheticCheck,validateCheck} from './types';
interface OwnedCheck {check:ReturnType<typeof validateCheck> & {id:string};controller:AbortController;timer?:ReturnType<typeof setTimeout>;task?:Promise<void>;failed?:boolean;failure?:unknown}
export class SyntheticScheduler {
  private readonly checks=new Map<string,OwnedCheck>();
  private readonly httpRunner=new HttpCheckRunner();
  private stopping?:Promise<void>;
  private readonly app:string;
  constructor(private readonly watch:Pick<WatchFn,'started'|'ingest'> & Partial<Pick<WatchFn,'applicationName'>>,app?:string){
    this.app=app??watch.applicationName??'';
    if(!this.app.trim())throw new TypeError('Synthetic scheduler requires an application identity');
  }
  async create(input:SyntheticCheck){
    if(!this.watch.started||this.stopping)throw new Error('Synthetic scheduler is unavailable');
    const validated=validateCheck(input),id=validated.id??validated.name;
    if(this.checks.has(id))throw new Error('Synthetic check ID already exists');
    if(this.checks.size>=100)throw new Error('Synthetic check capacity exceeded');
    const owned:OwnedCheck={check:{...validated,id},controller:new AbortController()};
    this.checks.set(id,owned);this.launch(owned);
    return structuredClone(owned.check);
  }
  private launch(owned:OwnedCheck):void {
    owned.task=this.run(owned).catch(error=>{owned.failed=true;owned.failure=error;}).finally(()=>{
      if(!owned.controller.signal.aborted&&this.checks.get(owned.check.id)===owned&&!owned.failed)
        owned.timer=setTimeout(()=>this.launch(owned),owned.check.interval);
    });
  }
  private async run(owned:OwnedCheck):Promise<void> {
    const startedAt=Date.now(),start=performance.now(),runId=randomUUID();
    for(let attempt=0;attempt<=owned.check.retries;attempt++){
      if(owned.controller.signal.aborted)return;
      const result=await this.httpRunner.run(owned.check,owned.controller.signal);
      if(owned.controller.signal.aborted)return;
      if(result.success||attempt===owned.check.retries){
        await this.watch.ingest([{type:'track',name:'synthetics.check',app:{name:this.app},timestamp:result.timestamp,properties:{...result,startedAt,runId,attempts:attempt+1,totalDuration:performance.now()-start}}]);return;
      }
    }
  }
  stop():Promise<void>{
    if(this.stopping)return this.stopping;
    const owned=[...this.checks.values()];this.checks.clear();
    for(const check of owned){clearTimeout(check.timer);check.controller.abort(new Error('Synthetic scheduler stopped'));}
    const stopping=Promise.all(owned.map(check=>check.task)).then(()=>{
      const failures=owned.filter(check=>check.failed).map(check=>check.failure);
      if(failures.length)throw new AggregateError(failures,'Synthetic scheduler failed');
    });
    this.stopping=stopping;
    void stopping.then(()=>{if(this.stopping===stopping)this.stopping=undefined;},()=>{if(this.stopping===stopping)this.stopping=undefined;});
    return stopping;
  }
}
