import { describe, expect, it } from 'vitest';
import { WatchFn } from '../src/core/watch-fn';

describe('stored log pattern discovery', () => {
  it('discovers variable-bearing templates from real stored logs', async () => {
    const watch = new WatchFn({name:'patterns',storage:'memory',infra:{enabled:false}});
    watch.start();
    try {
      await watch.ingest([
        {type:'log',timestamp:'2026-10-25T09:00:00Z',message:'order 123 failed'},
        {type:'log',timestamp:'2026-10-25T09:01:00Z',message:'order 456 failed'},
        {type:'log',timestamp:'2026-10-25T09:02:00Z',message:'order 789 accepted'},
        {type:'trace.span',timestamp:'2026-10-25T09:03:00Z',message:'order 789 failed'},
      ]);
      const patterns = await watch.logs.detectPatterns({fields:['message'],minOccurrences:2});
      expect(patterns).toHaveLength(1);
      expect(patterns[0]).toMatchObject({field:'message',pattern:'order <number> failed',count:2});
    } finally {await watch.stop();}
  });
  it('rejects discovery when storage is stopped', async () => {
    const watch = new WatchFn({name:'patterns',storage:'memory',infra:{enabled:false}});
    await expect(watch.logs.detectPatterns({fields:['message'],minOccurrences:2})).rejects.toThrow('unavailable');
  });
});


import {readFileSync} from 'node:fs';
import {patternTokens, discoverLogPatterns} from '../src/logs/patterns';
import {MemoryStorage} from '../src/storage/memory-storage';
it('shares deterministic templates and stable IDs with Python', async () => {
  const vectors = JSON.parse(readFileSync(new URL('../../python/tests/fixtures/log-pattern-golden.json',import.meta.url),'utf8'));
  for (const vector of vectors) {
    const storage=new MemoryStorage();
    for (const value of vector.values) {
      expect(patternTokens(value),vector.name).toEqual(vector.tokens);
      storage.add({type:'log',message:value});
    }
    const [result]=await discoverLogPatterns(storage,{fields:[vector.field],minOccurrences:1});
    expect(result.id,vector.name).toBe(vector.id);
    expect(result.count).toBe(vector.values.length);
  }
});
it('fails explicit scan limits without reporting partial occurrence counts', async () => {
  let stopped=false;
  const storage={add(){},query(){return [];},async *iterateQuery(){try {for(let i=0;i<10001;i++) yield {type:'log',message:'repeated'};}finally{stopped=true;}}};
  await expect(discoverLogPatterns(storage,{minOccurrences:1})).rejects.toThrow('event limit');
  expect(stopped).toBe(true);
});
it('validates options and separates literal markers, fields and time windows', async () => {
  const storage=new MemoryStorage();
  storage.add({type:'log',timestamp:'2026-10-25T00:00:00Z',message:'order 123',error:'order 123'});
  storage.add({type:'log',timestamp:'2026-10-25T00:01:00Z',message:'order <number>',error:'order 456'});
  const result=await discoverLogPatterns(storage,{minOccurrences:1,fields:['message','error'],timeRange:['2026-10-25T00:00:00Z','2026-10-25T00:01:00Z']});
  expect(result).toHaveLength(3);expect(result[0]).toMatchObject({field:'error',count:2});
  expect(new Set(result.map(row=>row.id)).size).toBe(3);
  await expect(discoverLogPatterns(storage,{fields:['message','message']})).rejects.toThrow();
  await expect(discoverLogPatterns(storage,{fields:['constructor']})).rejects.toThrow();
  expect(()=>patternTokens('\ud800')).toThrow();
});
