import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { memoryAdapter } from '@superfunctions/db/adapters';
import { createLogger } from '../logging/logger.js';
import { createCmsfnServer } from '../index.js';
import { serveCompatibleStatus } from './compatibleStatus.js';

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

describe('Operational HTTP logging', () => {
  it('records actual role changes and preview minting without request secrets', async () => {
    const records: Record<string, unknown>[] = [];
    const producer = createServer((req, res) => { if (!serveCompatibleStatus(req, res)) { res.statusCode = 404; res.end(); } });
    const upstream = await listen(producer);
    const config = {
      contentfn: { baseUrl: upstream }, datasets: [{ name: 'prod' }], desk: { kind: 'divider' as const }, auth: { kind: 'custom' as const },
      db: memoryAdapter(), authorizeRoles: async () => true,
      getRolesForSubject: async () => [{ id: 'admin', name: 'Admin', rules: [{ datasets: '*' as const, types: '*' as const, actions: '*' as const }] }],
      preview: { enabled: true, targetOrigin: 'https://preview.example', resolveUrl: () => '/' }, previewSecret: 's'.repeat(64),
      logging: { sink: (_level: string, _message: string, meta: Record<string, unknown>) => { records.push(meta); } },
      resolveLogSubject: async () => 'actor-1',
    };
    const server = createCmsfnServer(config); const base = await listen(server);
    const post = (path: string, body: unknown) => fetch(`${base}/cmsfn/${path}`, { method: 'POST', headers: { 'content-type':'application/json', authorization:'Bearer request-secret' }, body: JSON.stringify(body) });
    try {
      expect((await post('roles/upsert', { role: { id:'editor', name:'private-role-name', rules:[] } })).status).toBe(200);
      const response = await post('preview/token', { dataset:'prod', docId:'drafts.one', password:'body-secret' });
      const text = await response.text(); expect(text).toContain('"token"');
      expect(records.filter(record => record.action === 'roles.upsert')).toHaveLength(2);
      expect(records.filter(record => record.action === 'preview.token')).toHaveLength(2);
      expect(records.some(record => record.phase === 'result' && record.roleId === 'editor' && record.subject === 'actor-1')).toBe(true);
      expect(JSON.stringify(records)).not.toMatch(/request-secret|body-secret|private-role-name|"token"/);
    } finally { await close(server); await close(producer); }
  });
});


it('reports denial, storage exceptions and host session outcomes with bounded identity', async () => {
  const records: Record<string, unknown>[] = [];
  const db = memoryAdapter(); let denied = true; let identityFails = false;
  const server = createCmsfnServer({ contentfn:{baseUrl:'http://127.0.0.1:1'}, datasets:[{name:'prod'}], desk:{kind:'divider'},auth:{kind:'custom'}, db,
    authorizeRoles:async()=>!denied, resolveLogSubject:async()=>{ if (identityFails) throw new Error('private-host-error'); return 'verified'; },
    logging:{sink:(_level,_message,meta)=>{records.push(meta);}} });
  const base = await listen(server);
  const post = () => fetch(base+'/cmsfn/roles/upsert', {method:'POST',body:JSON.stringify({role:{id:'editor',name:'private',rules:[]}})});
  try {
    expect(await (await post()).json()).toMatchObject({ok:false,error:{code:'PERMISSION_DENIED'}});
    denied=false; identityFails=true;
    const original = db.create; db.create=async()=>{throw new Error('private-storage-error');};
    try { expect((await post()).status).toBe(500); } finally {db.create=original;}
    server.reportSessionEvent('session.login',{subject:'verified',succeeded:true});
    server.reportSessionEvent('session.logout',{subject:'verified',succeeded:false});
    expect(records.filter(record=>record.phase==='result').map(record=>record.code ?? record.outcome)).toEqual(['PERMISSION_DENIED','INTERNAL_ERROR','succeeded','AUTH_REQUIRED']);
    expect(JSON.stringify(records)).not.toContain('private');
    expect(records.filter(record=>record.action==='roles.upsert' && record.phase==='result')[1].subject).toBeUndefined();
  } finally {await close(server);}
});

it('does not turn a committed role change into a retry when the sink throws or rejects', async () => {
  let reject = false;
  const server = createCmsfnServer({contentfn:{baseUrl:'http://127.0.0.1:1'},datasets:[{name:'prod'}],desk:{kind:'divider'},auth:{kind:'custom'},db:memoryAdapter(),authorizeRoles:async()=>true,
    logging:{sink:()=>{if(reject)return Promise.reject(new Error('private-sink-error'));throw new Error('private-sink-error');}}});
  const base=await listen(server);
  const post=(path:string,body:unknown)=>fetch(base+'/cmsfn/'+path,{method:'POST',body:JSON.stringify(body)});
  try {
    expect(await(await post('roles/upsert',{role:{id:'editor',name:'Editor',rules:[]}})).json()).toMatchObject({ok:true});
    reject=true;
    expect(await(await post('roles/delete',{roleId:'editor'})).json()).toMatchObject({ok:true});
    expect(await(await post('roles/list',{dataset:'prod'})).json()).toMatchObject({ok:true,result:{roles:[]}});
    await new Promise(resolve=>setImmediate(resolve));
    expect(server.loggingStatus()).toEqual({failures:4,pending:0});
  } finally {await close(server);}
});

it('bounds a stalled host subject resolver without trusting request identity', async () => {
  let signal: AbortSignal | undefined;
  const records: Record<string,unknown>[]=[];
  const server=createCmsfnServer({contentfn:{baseUrl:'http://127.0.0.1:1'},datasets:[{name:'prod'}],desk:{kind:'divider'},auth:{kind:'custom'},db:memoryAdapter(),authorizeRoles:async()=>false,
    resolveLogSubject:(_req,abort)=>{signal=abort;return new Promise(()=>{});},logging:{sink:(_level,_message,meta)=>{records.push(meta);}}});
  const base=await listen(server);
  try {const response=await fetch(base+'/cmsfn/roles/delete',{method:'POST',headers:{'x-subject':'untrusted'},body:'{}'});
    expect(await response.json()).toMatchObject({ok:false,error:{code:'PERMISSION_DENIED'}});
    expect(signal?.aborted).toBe(true);expect(records.every(record=>record.subject===undefined)).toBe(true);
  } finally {await close(server);}
});

it('allowlists metadata, bounds stalled sinks, and distinguishes partial and uncertain outcomes', async () => {
  const records: Record<string,unknown>[]=[];
  const logger=createLogger({sink:(_level,_message,meta)=>{records.push(meta);}});
  logger.logMutation(Object.assign({action:'docs.patch',dataset:'prod',body:{secret:'doc-secret'}},{nested:{password:'nested-secret'},assetBytes:'asset-secret',subject:'x'.repeat(513)}));
  const partial=logger.operation('releases.publish',{dataset:'prod',releaseId:'r'});
  partial.finish({ok:true,result:{published:['one'],failures:[{message:'provider-secret'}]}});
  partial.finish({ok:true,result:{}});
  logger.operation('releases.publish').finish({ok:true,result:{published:[],failures:[],execution:{state:'uncertain',pending:['one']}}});
  expect(records[0]).toEqual({action:'docs.patch',dataset:'prod'});
  expect(records.filter(record=>record.phase==='result')).toMatchObject([{outcome:'partial',publishedCount:1,failedCount:1},{outcome:'uncertain',pendingCount:1}]);
  expect(JSON.stringify(records)).not.toContain('secret');
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  const stalled=createLogger({sink:()=>held});
  for(let i=0;i<130;i++)stalled.logAuth({action:'login'});
  expect(stalled.status()).toEqual({failures:2,pending:128});
  release();await new Promise(resolve=>setImmediate(resolve));expect(stalled.status()).toEqual({failures:2,pending:0});
});

it('logs actual manual release success and lost acknowledgement as distinct outcomes', async () => {
  const { createRelease, addDocToRelease } = await import('../storage/releases.js');
  const records: Record<string,unknown>[]=[]; let drop=false;
  const producer=createServer(async(req,res)=>{
    if(serveCompatibleStatus(req,res))return;
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw) as {id:string};
    if(req.url==='/contentfn/docs/get'){res.end(JSON.stringify({ok:true,result:{_id:body.id,_type:'post',_rev:'secret-revision',_cms:{state:'approved'},body:'document-secret'}}));return;}
    if(drop){res.destroy();return;}
    res.end(JSON.stringify({ok:true,result:{_id:body.id,_type:'post',_rev:'published'}}));
  });
  const upstream=await listen(producer);const db=memoryAdapter();
  const server=createCmsfnServer({contentfn:{baseUrl:upstream},datasets:[{name:'prod'}],desk:{kind:'divider'},auth:{kind:'custom'},db,
    getRolesForSubject:async()=>[{id:'admin',name:'Admin',rules:[{datasets:'*',types:'*',actions:'*'}]}],
    logging:{sink:(_level,_message,meta)=>{records.push(meta);}}});
  const base=await listen(server);
  try{
    for(const loseAck of [false,true]){
      drop=loseAck;
      const created=await createRelease({db},{dataset:'prod',name:'hidden-title'});if(!created.ok)throw new Error('Create failed');
      await addDocToRelease({db},{dataset:'prod',releaseId:created.result.releaseId,docId:'one'});
      const response=await fetch(base+'/cmsfn/releases/publish',{method:'POST',body:JSON.stringify({dataset:'prod',releaseId:created.result.releaseId})});
      expect(await response.json()).toMatchObject({ok:true});
    }
    expect(records.filter(record=>record.phase==='result')).toMatchObject([
      {action:'releases.publish',origin:'manual',dataset:'prod',outcome:'succeeded',publishedCount:1},
      {action:'releases.publish',origin:'manual',dataset:'prod',outcome:'uncertain',pendingCount:1},
    ]);
    expect(JSON.stringify(records)).not.toMatch(/document-secret|secret-revision|hidden-title/);
  }finally{await close(server);await close(producer);}
});
