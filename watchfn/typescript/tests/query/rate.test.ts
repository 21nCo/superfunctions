import { describe, expect, it } from 'vitest';
import { QueryEngine, QueryValidationError } from '../../src/query/query-engine';
import { MemoryStorage } from '../../src/storage/memory-storage';
import { WatchFn } from '../../src/core/watch-fn';

const rate = {operation:'rate' as const, numerator:{metric:'api.error'},denominator:{metric:'api.request'}};
function engine(events: any[]) {
  const storage = new MemoryStorage();
  for (const event of events) storage.add(event);
  return new QueryEngine(storage);
}

describe('metric ratio aggregation', () => {
  it('uses separately selected numerator events while ordinary stats retain the outer metric', async () => {
    const query = engine([
      {name:'api.request',timestamp:100,properties:{endpoint:'/a',duration:10}},
      {name:'api.request',timestamp:200,properties:{endpoint:'/a',duration:20}},
      {name:'api.error',timestamp:200,properties:{endpoint:'/a',duration:999}},
      {name:'unrelated',timestamp:100,properties:{endpoint:'/other'}},
      {name:'api.error',timestamp:0,properties:{endpoint:'/a'}},
    ]);
    expect((await query.execute({metric:'api.request',timeRange:{from:100,to:200},groupBy:'endpoint',aggregations:{requests:{operation:'count'},latency:{operation:'avg',field:'duration'},error_rate:rate}})).data)
      .toEqual([{endpoint:'/a',requests:2,latency:15,error_rate:0.5}]);
  });

  it('applies global filters and time buckets to both selectors and reports missing denominators honestly', async () => {
    const query = engine([
      {name:'api.request',timestamp:100,tenant:'a'},
      {name:'api.error',timestamp:100,tenant:'a'},
      {name:'api.request',timestamp:100,tenant:'b'},
      {name:'api.error',timestamp:1500,tenant:'a'},
      {name:'noise',timestamp:3000,tenant:'a'},
    ]);
    expect((await query.execute({where:{tenant:'a'},groupBy:{interval:'1s'},aggregations:{ratio:rate}})).data)
      .toEqual([{timestamp:0,ratio:1},{timestamp:1000,ratio:null}]);
    expect((await engine([]).execute({aggregations:{ratio:rate}})).data).toEqual([{ratio:null}]);
    expect((await engine([{type:'api.request'}]).execute({aggregations:{ratio:rate}})).data).toEqual([{ratio:0}]);
  });

  it('does not push the outer metric into storage when ratio selectors need other metrics', async () => {
    let received: any;
    const query = new QueryEngine({add(){},getAll:async()=>[],executeQuery:async(options:any)=>{received=options;return [{name:'api.error'},{name:'api.request'}];}} as any);
    expect((await query.execute({metric:'api.request',aggregations:{ratio:rate}})).data).toEqual([{ratio:1}]);
    expect(received.metric).toBeUndefined();
  });

  it('rejects incomplete or ambiguous metric selectors before accessing storage', async () => {
    const query = engine([]);
    for(const config of [{operation:'rate'}, {...rate,numerator:{metric:''}}, {...rate,denominator:{metric:'api.request',where:{}}}]) {
      await expect(query.execute({aggregations:{ratio:config as any}})).rejects.toBeInstanceOf(QueryValidationError);
    }
  });

  it('supports the public scalar aggregation helper', async () => {
    const watch = new WatchFn({name:'rates',storage:'memory',infra:{enabled:false}});
    watch.start();
    try {
      await watch.ingest([{name:'api.request'},{name:'api.request'},{name:'api.error'}]);
      expect(await watch.aggregate({aggregation:'rate',numerator:rate.numerator,denominator:rate.denominator})).toEqual([{value:0.5}]);
    } finally { await watch.stop(); }
  });
});
