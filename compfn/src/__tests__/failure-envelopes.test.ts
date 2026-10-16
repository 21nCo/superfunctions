import { it, expect } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/adapters';
import { compFn } from '../compfn.js';

it('preserves storage failures when validating referenced controls and frameworks', async () => {
  const db = memoryAdapter();
  const api = compFn({ database: { ...db, async findOne() { throw new Error('storage unavailable'); } } });
  const results = await Promise.all([
    api.evidence.create({controlId:'c',type:'manual_attestation',actorId:'u',outcome:'pass'}),
    api.checks.create({controlId:'c',name:'check',customConfig:{}}),
    api.frameworks.create({name:'framework',requirements:[{requirementId:'r',controlIds:['c']}]}),
    api.evidence.list({frameworkId:'f'}),
  ]);
  for (const result of results) expect(result).toMatchObject({ok:false,error:{code:'STORAGE_ERROR',message:'storage unavailable'}});
});

it('returns validation envelopes for circular and BigInt evidence instead of rejecting', async () => {
  const db = memoryAdapter();
  await db.initialize();
  const api = compFn({database:db});
  const control = await api.controls.create({name:'test',description:'test',category:'test'});
  if (!control.ok) throw new Error(control.error.message);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const payload of [circular, { value: BigInt(1) }]) {
    await expect(api.evidence.create({controlId:control.result.id,type:'manual_attestation',actorId:'u',outcome:'pass',payload})).resolves.toMatchObject({ok:false,error:{code:'VALIDATION_FAILED'}});
  }
  expect(await api.evidence.list()).toMatchObject({ok:true,result:[]});
});


it('bounds core lists and audit exports without silently dropping records, after tag filtering', async () => {
  const db = memoryAdapter();
  await db.initialize();
  await db.createMany({model:'controls',data:Array.from({length:1001},(_,i)=>({id:String(i),name:'c'+i,description:'d',category:'test',tags:i===1000?['selected']:[],createdAt:i,updatedAt:i}))});
  const api = compFn({database:db});
  expect(await api.controls.list()).toMatchObject({ok:false,error:{code:'VALIDATION_FAILED',details:{limit:1000}}});
  const filtered = await api.controls.list({tags:['selected']});
  expect(filtered).toMatchObject({ok:true,result:[{id:'1000'}]});
  expect(await api.export.auditorPack()).toMatchObject({ok:false,error:{code:'VALIDATION_FAILED'}});
});

it('does not omit storage failures from scoped audit exports or readiness', async () => {
  const db = memoryAdapter();
  await db.initialize();
  const base = compFn({database:db});
  const control = await base.controls.create({name:'n',description:'d',category:'c'});
  if (!control.ok) throw new Error(control.error.message);
  const framework = await base.frameworks.create({name:'f',requirements:[{requirementId:'r',controlIds:[control.result.id]}]});
  if (!framework.ok) throw new Error(framework.error.message);
  const unavailableControls = compFn({database:{...db,findOne:async(params) => {
    if (params.model === 'controls') throw new Error('controls unavailable');
    return db.findOne(params);
  }}});
  expect(await unavailableControls.export.auditorPack({frameworkId:framework.result.id})).toMatchObject({ok:false,error:{code:'STORAGE_ERROR'}});
  const unavailableFrameworks = compFn({database:{...db,findOne:async(params) => {
    if (params.model === 'frameworks') throw new Error('framework unavailable');
    return db.findOne(params);
  }}});
  expect(await unavailableFrameworks.readiness.forControl(control.result.id,framework.result.id)).toMatchObject({ok:false,error:{code:'STORAGE_ERROR'}});
});

it('returns an adapter error for a client returning no evidence', async () => {
  const db = memoryAdapter();
  const api = compFn({database:db,adapters:{invalid:{name:'invalid',runCheck:async()=>undefined as never}}});
  const control=await api.controls.create({name:'n',description:'d',category:'c'});
  if(!control.ok) throw new Error(control.error.message);
  const check=await api.checks.create({name:'check',controlId:control.result.id,adapterName:'invalid',adapterMethod:'run'});
  if(!check.ok) throw new Error(check.error.message);
  expect(await api.checks.run(check.result.id)).toMatchObject({ok:false,error:{code:'ADAPTER_ERROR'}});
});
