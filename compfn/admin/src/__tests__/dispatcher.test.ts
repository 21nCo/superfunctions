import { it, expect, vi } from 'vitest';
import { compFn } from 'compfn';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createAdminRegistry, createAdminDispatcher, MemoryAdminAuditSink, MemoryAdminIdempotencyStore } from '@superfunctions/admin';
import { createCompFnDomainAdminService, createCompFnAdminAdapter } from '../index.js';
const context={scope:{organizationId:'o',workspaceId:'w',namespace:'n',region:'r'},actor:{id:'u',permissions:['*']},requestId:'req',correlationId:'corr',source:'rest' as const};
async function setup(count=65){
 const db=memoryAdapter();await db.initialize();const api=compFn({database:db,logger:{info(){},error(){},warn(){},debug(){}}});
 for(let i=0;i<count;i++)await api.controls.create({name:`Control ${String(i).padStart(4,'0')}`,description:'Policy',category:i%2?'other':'security',tags:i===count-1?['last']:[]});
 const service=createCompFnDomainAdminService({resolveCompfn:()=>api});const audit=new MemoryAdminAuditSink();
 const dispatcher=createAdminDispatcher({registry:createAdminRegistry({adapters:[createCompFnAdminAdapter(service)],enabledModules:['compfn']}),audit,idempotency:new MemoryAdminIdempotencyStore()});
 const call=(operationId:string,input:unknown={},ctx:any=context)=>dispatcher.dispatch<any>({operationId,input,context:ctx});return{api,service,audit,call};
}
it('paginates real collections and supports search/filter/sort',async()=>{
 const{call}=await setup();const first=await call('compfn.controls.list');if(!first.ok)throw Error(JSON.stringify(first));expect(first.data.items).toHaveLength(50);
 const second=await call('compfn.controls.list',{cursor:first.data.nextCursor});if(!second.ok)throw Error(JSON.stringify(second));expect(second.data.items).toHaveLength(15);expect(second.data.nextCursor).toBeNull();expect(new Set([...first.data.items,...second.data.items].map((x:any)=>x.id)).size).toBe(65);
 const result=await call('compfn.controls.list',{search:'CONTROL 00',filter:{category:'security'},sort:[{field:'name',direction:'asc'}],limit:10});if(!result.ok)throw Error(JSON.stringify(result));expect(result.data.items[0].name).toBe('Control 0000');expect(result.data.items[1].name).toBe('Control 0002');
});
it('rejects tampered/query-changed/full-scope-changed/expired cursors and malformed sorting',async()=>{
 const{call,service}=await setup();const first=await call('compfn.controls.list',{limit:2});if(!first.ok)throw Error(JSON.stringify(first));const cursor=first.data.nextCursor;
 for(const [input,ctx]of [[{cursor:cursor+'0'},context],[{cursor,search:'changed'},context],...['namespace','region','workspaceId'].map(key=>[{cursor},{...context,scope:{...context.scope,[key]:'different'}}])] as any[])expect(await call('compfn.controls.list',input,ctx)).toMatchObject({ok:false,error:{code:'invalid_argument'}});
 const time=vi.spyOn(Date,'now').mockReturnValue(Date.now()+16*60_000);try{expect(await call('compfn.controls.list',{cursor})).toMatchObject({ok:false,error:{code:'invalid_argument'}});}finally{time.mockRestore();}
 await expect(service.listControls({sort:{length:1}as any},context)).rejects.toMatchObject({code:'invalid_argument'});
});
it('pushes core-supported predicates before1000record cap',async()=>{
 const{call,api}=await setup(1001);expect(await call('compfn.controls.list',{filter:{category:'security'},limit:1})).toMatchObject({ok:true});const selected=await api.controls.list({tags:['last']});if(!selected.ok)throw Error(JSON.stringify(selected));
 for(let i=0;i<1001;i++)await api.evidence.create({controlId:selected.result[0].id,type:i===1000?'manual_attestation':'custom_check',actorId:'u',outcome:'pass'});
 const result=await call('compfn.evidence.list',{filter:{controlId:selected.result[0].id,type:'manual_attestation'}});if(!result.ok)throw Error(JSON.stringify(result));expect(result.data.items).toHaveLength(1);
});
it('denies unauthorized mutations, audits and redacts evidence and report payloads',async()=>{
 const{api,call,audit}=await setup(1);const controls=await api.controls.list();if(!controls.ok)throw Error(JSON.stringify(controls));const input={payload:{controlId:controls.result[0].id,type:'manual_attestation',actorId:'u',outcome:'pass',payload:{value:'private-value-marker',secret:'private-secret-marker'}}};
 expect(await call('compfn.evidence.collect-evidence',input,{...context,actor:{id:'denied',permissions:[]}})).toMatchObject({ok:false,error:{code:'forbidden'}});expect(await api.evidence.list()).toMatchObject({ok:true,result:[]});
 const ctx={...context,idempotencyKey:'collect'};const collected=await call('compfn.evidence.collect-evidence',input,ctx);expect(collected.ok,JSON.stringify(collected)).toBe(true);expect((await call('compfn.evidence.collect-evidence',input,ctx)).ok).toBe(true);
 const stored=await api.evidence.list();if(!stored.ok)throw Error(JSON.stringify(stored));expect(stored.result).toHaveLength(1);expect(stored.result[0].payload?.value).toBe('private-value-marker');
 const evidence=await call('compfn.evidence.list');const report=await call('compfn.reports.generate-report',{}, {...context,idempotencyKey:'report'});expect(report.ok,JSON.stringify(report)).toBe(true);
 for(const value of[collected,evidence,report,audit.events]){expect(JSON.stringify(value)).not.toContain('private-value-marker');expect(JSON.stringify(value)).not.toContain('private-secret-marker');}expect(audit.events.some(e=>e.outcome==='denied')).toBe(true);expect(audit.events.some(e=>e.outcome==='succeeded')).toBe(true);
});
it('shares cursors only with an explicit replica secret and preserves optional framework fields',async()=>{
 const{api,service}=await setup();const first=await service.listControls({limit:2},context);const cursor=first.data!.nextCursor as string;
 const another=createCompFnDomainAdminService({resolveCompfn:()=>api});await expect(another.listControls({cursor},context)).rejects.toMatchObject({code:'invalid_argument'});
 const cursorSecret=new Uint8Array(32).fill(7);const one=createCompFnDomainAdminService({resolveCompfn:()=>api,cursorSecret});const two=createCompFnDomainAdminService({resolveCompfn:()=>api,cursorSecret});const page=await one.listControls({limit:2},context);expect((await two.listControls({cursor:page.data!.nextCursor as string},context)).ok).toBe(true);
 await api.frameworks.create({name:'Framework without optional version',requirements:[]});const audit=new MemoryAdminAuditSink();const dispatcher=createAdminDispatcher({registry:createAdminRegistry({adapters:[createCompFnAdminAdapter(service)],enabledModules:['compfn']}),audit});expect(await dispatcher.dispatch({operationId:'compfn.frameworks.list',input:{},context})).toMatchObject({ok:true,data:{items:[{name:'Framework without optional version'}]}});
});
