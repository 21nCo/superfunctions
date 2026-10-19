import {afterEach,describe,expect,it,vi} from 'vitest';
import {WatchFn} from '../../src/core/watch-fn';
import {compareDeploymentMetrics} from '../../src/analysis/deployment-comparison';
const options={deploymentId:'deploy-1',beforeWindow:'1m',afterWindow:'1m'};
async function fixture(events:any[]) {
 const watch=new WatchFn({name:'deployments',storage:'memory',infra:{enabled:false}});watch.start();
 await watch.ingest(events); return watch;
}
afterEach(()=>vi.useRealTimers());
describe('deployment comparisons',()=>{
 it('calculates real count ratios and latency changes using disjoint windows',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(120000);
  const watch=await fixture([
   {name:'deployment.completed',timestamp:60000,properties:{deploymentId:'deploy-1'}},
   ...[0,59999].map(timestamp=>({name:'api.request',timestamp,properties:{duration:10}})),
   ...[60000,119999].map(timestamp=>({name:'api.request',timestamp,properties:{duration:20}})),
   {name:'api.request',timestamp:120000,properties:{duration:999}},
   ...[1,60000,60001].map(timestamp=>({name:'api.error',timestamp})),
  ]);
  try {
   const result=await watch.compareDeploymentMetrics(options);
   expect(result.errorRate).toEqual({before:0.5,after:1,delta:0.5,increase:100});
   expect(result.latency).toEqual({before:10,after:20,delta:10,increase:100});
   expect(result.samples.before.requests).toBe(2);expect(result.samples.after.requests).toBe(2);
   expect(result.windows.complete).toBe(true);
  } finally {await watch.stop();vi.restoreAllMocks();}
 });
 it('does not fabricate baselines, relative changes from zero, or incomplete-window conclusions',async()=>{
  vi.useFakeTimers();vi.setSystemTime(90000);
  const watch=await fixture([{name:'deployment.completed',timestamp:60000,deploymentId:'deploy-1'},{name:'api.request',timestamp:1,duration:0},{name:'api.request',timestamp:60000,duration:10},{name:'api.error',timestamp:60000}]);
  try {
   let result=await watch.compareDeploymentMetrics(options);
   expect(result.windows.complete).toBe(false);expect(result.latency.increase).toBeNull();
   vi.setSystemTime(120000);result=await watch.compareDeploymentMetrics(options);
   expect(result.latency.delta).toBe(10);expect(result.latency.increase).toBeNull();expect(result.errorRate.increase).toBeNull();
  } finally {await watch.stop();}
  const empty=await fixture([{name:'deployment.completed',timestamp:60000,deploymentId:'deploy-1'}]);
  try {expect((await empty.compareDeploymentMetrics(options)).errorRate.before).toBeNull();}finally{await empty.stop();}
 });
 it('rejects missing or ambiguous deployment identities and invalid windows',async()=>{
  const watch=await fixture([{name:'deployment.completed',timestamp:60000,deploymentId:'duplicate'},{name:'deployment.completed',timestamp:70000,deploymentId:'duplicate'}]);
  try {
   await expect(watch.compareDeploymentMetrics(options)).rejects.toThrow(/missing/);
   await expect(watch.compareDeploymentMetrics({...options,deploymentId:'duplicate'})).rejects.toThrow(/ambiguous/);
   await expect(watch.compareDeploymentMetrics({...options,beforeWindow:'0m'})).rejects.toThrow(/windows/);
  }finally{await watch.stop();}
 });
 it('does not call a partial snapshot complete when a query crosses the window boundary',async()=>{
  vi.useFakeTimers();vi.setSystemTime(90000);
  const result=await compareDeploymentMetrics(async query=>{
   if(query.metric==='deployment.completed') return [{timestamp:60000}];
   vi.setSystemTime(130000);return [];
  },options);
  expect(result.observedAt).toBe(90000);expect(result.windows.complete).toBe(false);
 });
 it('supports configured request metrics and ignores invalid latency samples',async()=>{
  vi.useFakeTimers();vi.setSystemTime(120000);
  const watch=await fixture([{name:'deployment.completed',ts:'1970-01-01T00:01:00Z',deploymentId:'deploy-1'},
   {name:'http.request',timestamp:0,properties:{timing:{ms:10}}},{name:'http.request',timestamp:60000,properties:{timing:{ms:20}}},
   {name:'http.request',timestamp:1,properties:{timing:{ms:-1}}}]);
  try {const result=await watch.compareDeploymentMetrics({...options,requestMetric:'http.request',durationField:'timing.ms'});expect(result.latency.increase).toBe(100);expect(result.samples.before.latency).toBe(1);expect(result.errorRate.increase).toBe(0);}finally{await watch.stop();}
 });
});
