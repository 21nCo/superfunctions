import {afterEach,describe,expect,it,vi} from 'vitest';
import {HttpCheckRunner} from '../src/synthetics/http-check';
import {SyntheticScheduler} from '../src/synthetics/scheduler';
import {WatchFn} from '../src/core/watch-fn';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
afterEach(()=>vi.restoreAllMocks());
describe('synthetic HTTP ownership',()=>{
  it('keeps the timeout active while reading a stalled response body',async()=>{
    let body!:ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch',vi.fn(async(_url,init)=>new Response(new ReadableStream({start(c){body=c;init.signal.addEventListener('abort',()=>c.error(init.signal.reason),{once:true});}}))));
    try{
      const running=new HttpCheckRunner().run({id:'body',name:'body',type:'http',url:'http://example.test',interval:1000,timeout:30});
      const result=await Promise.race([running,delay(200).then(()=>null)]);
      if(result===null)body.close();
      await running;
      expect(result).toMatchObject({success:false});
    }finally{vi.unstubAllGlobals();}
  });
  it('rejects unsupported browser execution before admitting a check',async()=>{
    const watch=new WatchFn({name:'synthetic',storage:'memory',infra:{enabled:false}});watch.start();
    try{await expect(watch.synthetics.create({name:'browser',type:'browser',interval:'1m'})).rejects.toThrow('browser');}
    finally{await watch.stop();}
  });
  it('does not overlap active attempts and joins them on stop',async()=>{
    let resolve!:()=>void;const held=new Promise<void>(r=>resolve=r);let calls=0;
    vi.spyOn(HttpCheckRunner.prototype,'run').mockImplementation(async check=>{calls++;await held;return {checkId:check.id!,timestamp:Date.now(),success:true,duration:1};});
    const scheduler=new SyntheticScheduler({started:true,ingest:vi.fn().mockResolvedValue(undefined)} as unknown as WatchFn,'owned');
    try{await scheduler.create({name:'slow',type:'http',url:'http://example.test',interval:10});await delay(40);expect(calls).toBe(1);let stopped=false;const stopping=scheduler.stop().then(()=>{stopped=true;});await delay(10);expect(stopped).toBe(false);resolve();await stopping;expect(stopped).toBe(true);}
    finally{resolve();await scheduler.stop();}
  });
});

it('validates interval strings, limits, snapshots and duplicate identities',async()=>{
  const watch=new WatchFn({name:'validate-check',storage:'memory',infra:{enabled:false}});watch.start();
  vi.spyOn(HttpCheckRunner.prototype,'run').mockImplementation(async check=>({checkId:check.id!,timestamp:Date.now(),success:true,duration:1}));
  try{
    const input={name:'health',type:'http' as const,url:'http://example.test',interval:'1m',headers:{test:'original'}};
    const created=await watch.synthetics.create(input);input.headers.test='mutated';
    expect(created).toMatchObject({id:'health',interval:60000,headers:{test:'original'}});
    await expect(watch.synthetics.create(input)).rejects.toThrow('already exists');
    for(const bad of [{interval:'0m'},{interval:'bad'},{timeout:0},{retries:6},{locations:['us-east']},{alerts:{consecutive_failures:2}}])await expect(watch.synthetics.create({...input,name:'invalid',...bad})).rejects.toThrow();
    await watch.stop();await expect(watch.synthetics.create({...input,name:'late'})).rejects.toThrow('unavailable');
    watch.start();await expect(watch.synthetics.create(input)).resolves.toMatchObject({id:'health'});
  }finally{await watch.stop();}
});
it('retains persistence failures even when an adapter rejects without an Error',async()=>{
  vi.spyOn(HttpCheckRunner.prototype,'run').mockResolvedValue({checkId:'failed-store',timestamp:Date.now(),success:true,duration:1});
  const ingest=vi.fn().mockRejectedValue(undefined);
  const scheduler=new SyntheticScheduler({started:true,ingest},'owned');
  await scheduler.create({name:'failed-store',type:'http',url:'http://example.test',interval:10});
  await delay(30);expect(ingest).toHaveBeenCalledTimes(1);
  await expect(scheduler.stop()).rejects.toBeInstanceOf(AggregateError);
});

it('preserves direct construction with a configured Watch instance',async()=>{
  const watch=new WatchFn({name:'direct',storage:'memory',infra:{enabled:false}});
  const scheduler=new SyntheticScheduler(watch);expect(watch.applicationName).toBe('direct');await scheduler.stop();
});

it('redacts stored response secrets and never echoes assertion body values',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('private-page-secret',{headers:{'set-cookie':'session=private-cookie-secret','authorization':'Bearer private-token','x-contact':'person@example.test'}})));
  try{
    const runner=new HttpCheckRunner();const input={id:'privacy',name:'privacy',type:'http' as const,url:'http://example.test',interval:'1m'};
    const success=await runner.run(input);expect(success.success).toBe(true);expect(success.response?.headers?.['set-cookie']).toBe('[redacted]');expect(JSON.stringify(success)).not.toMatch(/private-cookie-secret|private-token|person@example/);
    const failure=await runner.run({...input,assertions:[{type:'body',operator:'contains',value:'expected-private-secret'}]});
    expect(failure).toMatchObject({success:false,error:'Assertion failed: body contains'});expect(JSON.stringify(failure)).not.toContain('private');
    vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('https://secret.test/?token=unstructured-secret');}));
    expect(await runner.run(input)).toMatchObject({success:false,error:'Synthetic HTTP request failed'});
    await expect(runner.run({...input,url:'http://example.test/'+ 'x'.repeat(4096)})).rejects.toThrow('4096');
    await expect(runner.run({...input,headers:{a:'x'.repeat(6000),b:'x'.repeat(6000),c:'x'.repeat(6000)}})).rejects.toThrow('aggregate');
  }finally{vi.unstubAllGlobals();}
});
