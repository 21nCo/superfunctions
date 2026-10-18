import { it, expect } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/adapters';
import { compFn } from '../compfn.js';

it('records ingestion, check and export events without evidence payloads or adapter error secrets', async () => {
  const messages: unknown[][]=[];
  const log=(...args:unknown[])=>{messages.push(args);};
  const api=compFn({database:memoryAdapter(),logger:{info:log,warn:log,error:log,debug:log},adapters:{
    success:{name:'success',runCheck:async()=>({type:'custom_check',outcome:'pass',payload:{secret:'sensitive-payload-marker'}})},
    failure:{name:'failure',runCheck:async()=>{throw new Error('sensitive-adapter-marker');}},
  }});
  const control=await api.controls.create({name:'n',description:'d',category:'c'});
  if(!control.ok) throw new Error(control.error.message);
  for(const adapterName of ['success','failure']) {
    const check=await api.checks.create({name:adapterName,controlId:control.result.id,adapterName,adapterMethod:'run'});
    if(!check.ok) throw new Error(check.error.message);
    await api.checks.run(check.result.id);
  }
  await api.export.auditorPack();
  const serialized=JSON.stringify(messages);
  for(const event of ['evidence.created','check.run.started','check.run.completed','check.run.error','export.requested','export.completed']) expect(serialized).toContain(event);
  expect(serialized).not.toContain('sensitive-payload-marker');
  expect(serialized).not.toContain('sensitive-adapter-marker');
});
