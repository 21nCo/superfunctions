import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { SegmentEvaluator } from '../core/segments';
import { FlagEvaluator } from '../core/flags';
import type { SegmentRule, UserTraits } from '../types';
const vectors = JSON.parse(readFileSync(new URL('../../../python/tests/fixtures/segment-semantics.json', import.meta.url), 'utf8')) as Array<{id:string;operator:SegmentRule['operator'];traits:UserTraits;value:unknown;expected:boolean}>;
it.each(vectors)('shared segment semantics: $id', vector => {
 const rule:SegmentRule={id:vector.id,field:'subject',operator:vector.operator,value:vector.value};
 const segments = new SegmentEvaluator([{id:'segment',name:'segment',rules:[rule]}]);
 expect(segments.evaluate('segment',vector.traits)).toBe(vector.expected);
 const flags = new FlagEvaluator([{key:'target',enabled:true,defaultValue:false,variations:[{id:'match',value:true}],rules:[{id:'inline',constraints:[rule],variationId:'match'}]}],segments);
 expect(flags.getFlag('target',false,{id:'person',traits:vector.traits})).toBe(vector.expected);
});
it('rejects non-JSON operands rather than granting negative comparisons',()=>{
 const engine=new SegmentEvaluator();const cycle:any={};cycle.self=cycle;
 for(const trait of [NaN,Infinity,cycle,new Date()]) for(const operator of ['equals','does_not_equal','in','not_in'] as const){
  expect(engine.matchesRule({id:'r',field:'subject',operator,value:operator==='in'||operator==='not_in'?[1]:1},{subject:trait})).toBe(false);
 }
 const traits={};Object.defineProperty(traits,'subject',{get(){throw new Error('must not evaluate');}});
 expect(engine.matchesRule({id:'r',field:'subject',operator:'does_not_exist'},traits)).toBe(false);
 expect(engine.matchesRule({id:'r',field:'toString',operator:'exists'},{})).toBe(false);
});
