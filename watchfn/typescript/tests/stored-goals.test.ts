import {afterEach,expect,it} from 'vitest';
import {WatchFn} from '../src/core/watch-fn';
import {goalPeriod,goalDate,validateGoal,type GoalConfig} from '../src/business/goals';
const watches:WatchFn[]=[];
afterEach(async()=>{for(const w of watches.splice(0))await w.stop().catch(()=>{});});
const config=(extra:Partial<GoalConfig>={}):GoalConfig=>({name:'sales',target:100,metric:'purchase.completed.total',aggregation:'sum',period:'month',startDate:'2026-01-31',...extra});
function watch(){const sent:any[]=[];const w=new WatchFn({name:'goals',storage:'memory',infra:{enabled:false},alerts:{namedChannels:{ops:{type:'email',recipients:['ops@example.test']}},emailSender:async n=>{sent.push(n);}}});w.start();watches.push(w);return {w,sent};}
it('uses original named metric, immutable storage and UTC anchored calendar boundaries',async()=>{
 const {w}=watch();await w.business.createGoal(config());
 await w.ingest([{type:'track',name:'purchase.completed',app:{name:'goals'},timestamp:'2026-02-01T00:00:00Z',properties:{total:25}},{type:'track',name:'purchase.completed',app:{name:'goals'},timestamp:'2026-02-02T00:00:00Z',properties:{total:-5}}]);
 expect(await w.business.getGoalProgress({name:'sales',date:'2026-02-14'})).toMatchObject({actual:20,eventCount:2,periodStart:Date.parse('2026-01-31'),periodEnd:Date.parse('2026-02-28'),elapsedPercent:50,expected:50});
 expect(await w.business.getGoalProgress({name:'sales',date:'2026-02-28'})).toMatchObject({actual:0,periodEnd:Date.parse('2026-03-31')});
 await expect(w.business.createGoal(config())).rejects.toThrow();await w.flush().catch(()=>{});await w.stop();w.start();expect((await w.business.getGoalProgress({name:'sales',date:'2026-02-14'})).actual).toBe(20);
});
it('persists pace episodes and rolls over without an intermediate evaluation',async()=>{
 const {w,sent}=watch();await w.business.createGoal(config({alerts:{on_track_check:'50%',notify_below_pace:true,channels:['ops']}}));
 await w.alerts.evaluate({now:Date.parse('2026-02-14')});await w.alerts.evaluate({now:Date.parse('2026-03-16')});
 await w.alerts.processNotifications();expect(sent.map(n=>n.event)).toEqual(expect.arrayContaining(['triggered','resolved','triggered']));expect(sent).toHaveLength(3);
 await w.alerts.evaluate({now:Date.parse('2026-03-16')});await w.alerts.processNotifications();expect(sent).toHaveLength(3);
 await expect(w.alerts.evaluate({now:Date.parse('2026-02-14')})).rejects.toThrow();
});
it('validates unknown channels, invalid dates, leap anchors, no observations and overflow',async()=>{
 const {w}=watch();await expect(w.business.createGoal(config({alerts:{on_track_check:'50%',notify_below_pace:true,channels:['missing']}}))).rejects.toThrow();
 await w.business.createGoal(config({aggregation:'avg'}));expect(await w.business.getGoalProgress({name:'sales',date:'2026-02-14'})).toMatchObject({actual:null,observed:false,belowPace:null});
 expect(()=>goalDate('2026-02-30')).toThrow();expect(()=>goalPeriod(validateGoal(config({period:'day',startDate:'9999-12-31'})),goalDate('9999-12-31'))).toThrow();
 expect(goalPeriod(validateGoal(config({period:'year',startDate:'2024-02-29'})),goalDate('2025-02-28'))).toEqual([Date.parse('2025-02-28'),Date.parse('2026-02-28')]);
});
it('rejects an intervening disable after committing period rollover',async()=>{
 const {w}=watch();await w.business.createGoal(config({alerts:{on_track_check:'50%',notify_below_pace:true,channels:['ops']}}));
 const first=await w.alerts.evaluate({now:Date.parse('2026-02-14')});const id=first.results[0].alert.id;
 w.alerts.onResolve(async()=>{await w.alerts.update(id,{name:'sales',enabled:false,condition:first.results[0].alert.condition,channels:[{type:'email',recipients:['ops@example.test']}]});});
 await expect(w.alerts.evaluate({now:Date.parse('2026-03-16')})).rejects.toThrow('changed during goal period rollover');
 expect((await w.alerts.get(id))?.enabled).toBe(false);
});
it('keeps future goals ineligible while evaluating ordinary alerts and rejects invalid identities',async()=>{
 const {w}=watch();await w.business.createGoal(config({startDate:'2030-01-01',alerts:{on_track_check:'50%',notify_below_pace:true,channels:['ops']}}));
 const ordinary=await w.alerts.create({name:'ordinary',condition:{metric:'missing',operator:'gte',threshold:0,window:'1h'},channels:[]});
 const result=await w.alerts.evaluate({now:Date.parse('2026-02-14')});expect(result.results).toHaveLength(2);expect(result.results.find(x=>x.alert.id!==ordinary.id)?.matched).toBeNull();
 expect(()=>validateGoal(config({metric:'missingdot'}))).toThrow();
 const {goalId}=await import('../src/business/goals');expect(()=>goalId('\ud800','sales')).toThrow();
});
it('aggregates more than the query default page and refuses observation overflow',async()=>{
 const {goalProgress}=await import('../src/business/goals');
 const storage={add(){},query(){return[];},async *iterateQuery(){for(let i=0;i<1001;i++)yield {type:'track',name:'purchase.completed',app:{name:'goals'},timestamp:Date.parse('2026-02-01'),properties:{total:1}};}};
 expect((await goalProgress(storage,'goals',config(),'2026-02-14')).actual).toBe(1001);
 await expect(goalProgress(storage,'goals',config(),'2026-02-14',1000)).rejects.toThrow('capacity');
});
