import { afterEach, expect, it, vi } from 'vitest';
import { UserFnClient } from '../index';
import type { FlagConfig } from '../types';
const flag: FlagConfig = { key:'target', enabled:true, defaultValue:'default', variations:[{id:'first',value:'same'},{id:'chosen',value:'same'}], rules:[{id:'rule-2',variationId:'chosen'}] };
const client = (extra = {}) => new UserFnClient({apiKey:'unrelated', exposures:{endpoint:'https://watch.example/ingest',apiKey:'watch-secret',app:'test',...extra}});
afterEach(() => { vi.unstubAllGlobals(); });
it('records chosen provenance, excludes traits/value and does not emit prerequisite traversals', async () => {
 const bodies: any[]=[]; vi.stubGlobal('fetch',vi.fn(async (_url, init) => {bodies.push(...JSON.parse(init.body)); return new Response(null,{status:202});}));
 const c=client(); c.identify('person',{secret:'never send'}); c.setFlags([{...flag,key:'dependency'}, {...flag,prerequisites:[{key:'dependency',expectedValue:'same'}]}]);
 expect(c.getFlag('target')).toBe('same'); await c.flushExposures();
 expect(bodies).toHaveLength(1); expect(bodies[0].properties).toEqual({flagKey:'target',variationId:'chosen',ruleId:'rule-2',reason:'rule'}); expect(bodies[0].user).toEqual({id:'person'}); expect(JSON.stringify(bodies)).not.toContain('never send'); expect(bodies[0].properties).not.toHaveProperty('value');
});
it('preserves value while failed deliveries retain stable IDs and queue overflow is visible', async () => {
 const attempts:any[]=[]; let failed=true; vi.stubGlobal('fetch',vi.fn(async (_url,init) => {attempts.push(JSON.parse(init.body)); return new Response(null,{status:failed?503:202});}));
 const c=client({maxQueueSize:1}); c.setFlags([flag]); expect(c.getFlag('target')).toBe('same'); await expect(c.flushExposures()).rejects.toThrow('retained');
 expect(c.getFlag('target')).toBe('same'); expect(c.getExposureStatus()).toMatchObject({pending:1,dropped:1}); failed=false; await expect(c.flushExposures()).rejects.toThrow('rejected before delivery'); await c.flushExposures(); expect(attempts[0][0].id).toBe(attempts[1][0].id); expect(c.getExposureStatus().pending).toBe(0);
 await c.closeExposures(); expect(c.getFlag('target')).toBe('same'); expect(c.getExposureStatus()).toMatchObject({closed:true,dropped:2});
});
it('keeps default, environment and unavailable provenance separate despite equal values', async () => {
 const events:any[]=[]; vi.stubGlobal('fetch',vi.fn(async (_url,init) => {events.push(...JSON.parse(init.body));return new Response(null,{status:202});}));
 const c=new UserFnClient({apiKey:'unused',environment:'prod',exposures:{endpoint:'https://watch.example/ingest',apiKey:'key',app:'test'}});
 c.setFlags([{...flag,rules:[],defaultVariationId:'first',environmentOverrides:{prod:{defaultVariationId:'chosen'}}},{...flag,key:'plain',rules:[]}]);
 c.getFlag('target'); c.getFlag('plain'); c.getFlag('missing'); await c.flushExposures();
 expect(events.map(e=>e.properties)).toEqual([{flagKey:'target',variationId:'chosen',ruleId:null,reason:'default_variation',environment:'prod'},{flagKey:'plain',variationId:null,ruleId:null,reason:'default_value',environment:'prod'},{flagKey:'missing',variationId:null,ruleId:null,reason:'unavailable',environment:'prod'}]);
});
it('requires explicit secure endpoint configuration and bounds oversized metadata without affecting values',async()=>{
 expect(()=>client({endpoint:'http://watch.example/ingest'})).toThrow();
 const c=client(); c.getFlag('x'.repeat(70000),'fallback'); expect(c.getExposureStatus()).toMatchObject({pending:0,dropped:1}); await expect(c.closeExposures()).rejects.toThrow('rejected before delivery');
});

it('marks bootstrap exposure until definitions are replaced',async()=>{
 const events:any[]=[]; vi.stubGlobal('fetch',vi.fn(async (_url,init)=>{events.push(...JSON.parse(init.body));return new Response(null,{status:202});}));
 const c=new UserFnClient({apiKey:'unused',bootstrapFlags:{boot:0},exposures:{endpoint:'https://watch.example/ingest',apiKey:'key',app:'test'}});
 expect(c.getFlag('boot')).toBe(0);await c.flushExposures();expect(events[0].properties.reason).toBe('bootstrap');
 c.setFlags([{...flag,key:'boot',rules:[]}]);c.getFlag('boot');await c.flushExposures();expect(events[1].properties.reason).toBe('default_value');
});
