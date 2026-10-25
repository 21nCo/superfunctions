import {defaultRedactor} from '@logfn/core';
import {type SyntheticCheck,type CheckResult,type Assertion,validateCheck} from './types';

const redact=defaultRedactor();
class SyntheticCheckError extends Error {}
export class HttpCheckRunner {
  async run(input:SyntheticCheck, signal?:AbortSignal):Promise<CheckResult> {
    const check=validateCheck(input);
    const startedAt=Date.now(),start=performance.now();
    const controller=new AbortController();
    const cancel=()=>controller.abort(signal?.reason??new Error('Synthetic check cancelled'));
    signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)cancel();
    const timeout=setTimeout(()=>controller.abort(new SyntheticCheckError('Synthetic HTTP deadline exceeded')),check.timeout);
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try {
      const response=await fetch(check.url!,{method:check.method,headers:check.headers,signal:controller.signal});
      reader=response.body?.getReader();
      const chunks:Uint8Array[]=[];let size=0;
      if(reader)for(;;){
        const next=await reader.read();if(next.done)break;
        size+=next.value.byteLength;if(size>check.maxResponseBytes)throw new SyntheticCheckError('Synthetic response byte limit exceeded');
        chunks.push(next.value);
      }
      if(controller.signal.aborted)throw controller.signal.reason;
      const duration=performance.now()-start;
      if(duration>=check.timeout)throw new SyntheticCheckError('Synthetic HTTP deadline exceeded');
      const text=Buffer.concat(chunks,size).toString('utf8');
      for(const assertion of check.assertions??[])this.validateAssertion(assertion,response,text,duration);
      const headers:Record<string,string>={};response.headers.forEach((value,key)=>{headers[key]=value;});
      return {checkId:check.id!,checkName:check.name,startedAt,timestamp:Date.now(),success:true,duration,response:{status:response.status,headers:redact(headers) as Record<string,string>,bodySize:size}};
    }catch(error){
      return {checkId:check.id!,checkName:check.name,startedAt,timestamp:Date.now(),success:false,duration:performance.now()-start,error:error instanceof SyntheticCheckError?error.message:controller.signal.reason instanceof SyntheticCheckError?controller.signal.reason.message:controller.signal.aborted?'Synthetic HTTP attempt cancelled':'Synthetic HTTP request failed'};
    }finally{
      clearTimeout(timeout);signal?.removeEventListener('abort',cancel);
      controller.abort();
      if(reader){try{await reader.cancel();}catch{}finally{reader.releaseLock();}}
    }
  }
  private validateAssertion(assertion:Assertion,response:Response,body:string,duration:number):void {
    const actual=assertion.type==='status'?response.status:assertion.type==='responseTime'?duration:assertion.type==='body'?body:response.headers.get(assertion.key!);
    const passed=assertion.operator==='eq'?actual===assertion.value:assertion.operator==='contains'?typeof actual==='string'&&actual.includes(String(assertion.value)):typeof actual==='number'&&typeof assertion.value==='number'&&(assertion.operator==='lt'?actual<assertion.value:actual>assertion.value);
    if(!passed)throw new SyntheticCheckError(`Assertion failed: ${assertion.type} ${assertion.operator}`);
  }
}
