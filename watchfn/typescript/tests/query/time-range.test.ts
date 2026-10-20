import {describe,expect,it} from 'vitest';
import {TimeRangeParser} from '../../src/query/time-range';
import {QueryEngine,QueryValidationError} from '../../src/query/query-engine';
import {MemoryStorage} from '../../src/storage/memory-storage';

describe('bounded time range utilities',()=>{
  it('builds ordered buckets and clips the final boundary',()=>{
    expect(TimeRangeParser.getBuckets({from:0,to:25},10)).toEqual([{from:0,to:10},{from:10,to:20},{from:20,to:25}]);
    expect(TimeRangeParser.getBuckets({from:3,to:3},1)).toEqual([]);
    expect(TimeRangeParser.getBuckets({from:-20,to:0},10)).toEqual([{from:-20,to:-10},{from:-10,to:0}]);
  });
  it('rejects sizes and ranges that would loop forever or allocate unbounded buckets',()=>{
    for(const size of [0,-1,NaN,Infinity]) expect(()=>TimeRangeParser.getBuckets({from:0,to:10},size)).toThrow(RangeError);
    for(const range of [{from:NaN,to:1},{from:0,to:Infinity},{from:2,to:1}]) expect(()=>TimeRangeParser.getBuckets(range,1)).toThrow(RangeError);
    expect(()=>TimeRangeParser.getBuckets({from:0,to:100001},1)).toThrow(/maximum/);
    expect(()=>TimeRangeParser.getBuckets({from:0,to:10},1,9)).toThrow(/maximum/);
    expect(()=>TimeRangeParser.getBuckets({from:1e16,to:1e16+2},0.1)).toThrow(/advance/);
    expect(TimeRangeParser.getBuckets({from:0,to:10},1,10)).toHaveLength(10);
  });
  it('validates duration arithmetic before deriving relative bounds',()=>{
    expect(TimeRangeParser.parseDuration('15m')).toBe(900000);
    for(const duration of ['0m','-1h','1.5h','999999999999999999999999d']) expect(()=>TimeRangeParser.parseDuration(duration)).toThrow();
  });
  it('accepts SPEC tuple bounds inclusively through the real query engine',async()=>{
    const storage = new MemoryStorage();
    for(const timestamp of [-1,0,1,2]) storage.add({timestamp});
    const query = new QueryEngine(storage);
    expect((await query.execute({timeRange:[new Date(0),'1970-01-01T00:00:00.001Z']})).data).toEqual([{timestamp:0},{timestamp:1}]);
    for(const timeRange of [[],[0],[0,1,2],[1,0],[null,1],[0,Infinity]]) {
      await expect(query.execute({timeRange:timeRange as any})).rejects.toBeInstanceOf(QueryValidationError);
    }
  });
});
