import {describe,it,expect} from 'vitest';
import {WatchFn} from '../src/core/watch-fn';
import {countRegexValues,validateLogPattern} from '../src/logs/regex';
import {ConditionEvaluator,validateAlertCondition} from '../src/alerts/conditions';

const pattern = {engine:'ecmascript' as const,source:'authentication failed',flags:'i'};
describe('durable log pattern conditions',()=>{
  it('registers actual stored canonical logs, observes zero and uses the exact requested window',async()=>{
    const sent:unknown[]=[];
    const watch=new WatchFn({name:'regex',storage:'memory',infra:{enabled:false},alerts:{namedChannels:{ops:{type:'email',recipients:['ops@example.test']}},emailSender:async n=>{sent.push(n);}}});
    watch.start();
    try{
      const now=Date.now();
      const alert=await watch.logs.createPattern({name:'auth-failures',pattern:/authentication failed/ig,threshold:{count:2,window:'5m'},alert:{enabled:true,severity:'warning',channels:['ops']}});
      expect(alert.condition).toEqual({type:'log-pattern',field:'message',pattern:{...pattern,flags:'gi'},threshold:2,window:'5m',operator:'gte'});
      expect((await watch.alerts.evaluate({now})).results[0]).toMatchObject({observed:true,matched:false});
      await watch.ingest([{type:'log',message:'authentication failed',timestamp:now-300001},{type:'log',message:'AUTHENTICATION FAILED',timestamp:now-300000},{type:'metric',message:'authentication failed',timestamp:now},{type:'log',message:'authentication failed',timestamp:now+1}]);
      expect((await watch.alerts.evaluate({now})).results[0].matched).toBe(false);
      await watch.ingest([{type:'log',message:'authentication failed',timestamp:now}]);
      expect((await watch.alerts.evaluate({now})).results[0].alert.state).toBe('triggered');
      expect(sent).toHaveLength(0);
      await watch.alerts.processNotifications();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({value:2,threshold:2});
      await watch.stop();
      await expect(watch.alerts.evaluate()).rejects.toThrow('unavailable');
      await expect(watch.logs.createPattern({name:'late',pattern:/x/,threshold:{count:1,window:'1m'},alert:{enabled:true,channels:[]}})).rejects.toThrow('unavailable');
    }finally{await watch.stop().catch(()=>{});}
  });
  it('reads canonical properties messages while preserving explicit top-level null',async()=>{
    const watch=new WatchFn({name:'canonical-pattern',storage:'memory',infra:{enabled:false}});watch.start();
    try{
      await watch.logs.createPattern({name:'canonical',pattern:/failure/,threshold:{count:2,window:'1m'},alert:{enabled:true,channels:[]}});
      const now=Date.now();
      await watch.ingest([{type:'log',properties:{message:'failure'},timestamp:now},{type:'log',message:null,properties:{message:'failure'},timestamp:now}]);
      expect((await watch.alerts.evaluate({now})).results[0]).toMatchObject({observed:true,matched:false});
      await watch.ingest([{type:'log',properties:{message:'failure'},timestamp:now}]);
      expect((await watch.alerts.evaluate({now})).results[0]).toMatchObject({observed:true,matched:true});
    }finally{await watch.stop();}
  });
  it('rejects unknown aliases and invalid persisted engines without creating definitions',async()=>{
    const watch=new WatchFn({name:'invalid-regex',storage:'memory',infra:{enabled:false}});watch.start();
    try{
      await expect(watch.logs.createPattern({name:'missing',pattern:/x/,threshold:{count:1,window:'1m'},alert:{enabled:true,channels:['missing']}})).rejects.toThrow('Unknown named');
      expect(await watch.alerts.list()).toEqual([]);
      for(const invalid of [{...pattern,engine:'python-re'},{...pattern,flags:'v'},{...pattern,flags:'ii'},{...pattern,source:'('}]) expect(()=>validateLogPattern(invalid as typeof pattern)).toThrow();
      expect(()=>validateAlertCondition({type:'log-pattern',field:'message',pattern,threshold:1,window:'1m',operator:'gte'})).not.toThrow();
      expect(new ConditionEvaluator().evaluateResult({type:'log-pattern',field:'message',pattern,threshold:1,window:'1m',operator:'gte'},new Map()).matched).toBeNull();
    }finally{await watch.stop();}
  });
  it('honors configured observation bounds before transitions and rejects impossible thresholds',async()=>{
    const watch=new WatchFn({name:'bounded-pattern',storage:'memory',infra:{enabled:false},alerts:{maxObservations:1}});watch.start();
    try{
      await expect(watch.logs.createPattern({name:'impossible',pattern:/x/,threshold:{count:10001,window:'1m'},alert:{enabled:true,channels:[]}})).rejects.toThrow('condition');
      const alert=await watch.logs.createPattern({name:'bounded',pattern:/x/,threshold:{count:1,window:'1m'},alert:{enabled:true,channels:[]}});
      const now=Date.now();await watch.ingest([{type:'log',message:'x',timestamp:now},{type:'log',message:'x',timestamp:now}]);
      await expect(watch.alerts.evaluate({now})).rejects.toThrow('observation limit');
      expect((await watch.alerts.get(alert.id)).state).toBe('normal');
      expect(await watch.alerts.notifications()).toEqual([]);
    }finally{await watch.stop().catch(()=>{});}
  });
  it('bounds concurrent worker admission without retaining a queue',async()=>{
    const pending=Array.from({length:4},()=>countRegexValues({...pattern,source:'x',flags:''},['x']));
    await expect(countRegexValues(pattern,[])).rejects.toThrow('capacity');
    expect(await Promise.all(pending)).toEqual([1,1,1,1]);
    expect(await countRegexValues(pattern,[])).toBe(0);
  });
  it('terminates catastrophic backtracking off-thread and remains usable',async()=>{
    let ticked=false;const timer=setTimeout(()=>{ticked=true;},25);
    try{
      await expect(countRegexValues({...pattern,source:'(a+)+$',flags:''},['a'.repeat(12000)+'!'])).rejects.toThrow('deadline');
      expect(ticked).toBe(true);
      expect(await countRegexValues({...pattern,source:'x',flags:'g'},['x','x','y'])).toBe(2);
      await expect(countRegexValues(pattern,['x'.repeat(16385)])).rejects.toThrow('bytes');
    }finally{clearTimeout(timer);}
  });
});
