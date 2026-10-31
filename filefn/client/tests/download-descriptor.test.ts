import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createFileFnClient, FileFnHttpError } from '../src/index.js';
import { createFileRoutes } from '../../server/src/files/routes.js';
import { createRouter } from '../../server/src/router.js';

let server: Server; let baseUrl: string; let requests: string[]; let closed: Set<string>;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean) { for (let i=0;i<100&&!check();i++) await pause(10); expect(check()).toBe(true); }
beforeEach(async () => {
 requests=[];closed=new Set();
 const fileRoutes=createFileRoutes({auth:{resolveSession:async request=>request.headers.get('authorization')==='Bearer owned'?{principalId:'owner'}:null},service:{async getDownloadUrl(fileId:string,version:string|undefined,context:any){expect(context.principalId).toBe('owner');return {url:`/proxy/files/${fileId}/${version??'current'}`,headers:{'x-download-token':'owned-download'}};}} as any});
 const router=createRouter({fileRoutes,uploadRoutes:{} as any} as any);
 server=createServer(async(req,res)=>{
  const path=req.url!;requests.push(path);res.once('close',()=>closed.add(path));
  if(path.startsWith('/redirect/')){res.writeHead(302,{location:'/file_1/download'});res.end();return;}
  if(path.startsWith('/drop/')){res.destroy();return;}
  if(path.startsWith('/hugeheaders/')){res.end(JSON.stringify({ok:true,data:{url:'/safe',headers:{x:'x'.repeat(16384)}}}));return;}
  if(path.startsWith('/stallheaders/')) return;
  if(path.startsWith('/stallbody/')) {res.writeHead(200,{'content-type':'application/json'});res.write('{');return;}
  if(path.startsWith('/oversize/')){res.writeHead(200);res.write('x'.repeat(1024));return;}
  if(path.startsWith('/error/')){res.writeHead(403);res.end('secret-provider-body');return;}
  if(path.startsWith('/invalid/')){res.end(JSON.stringify({ok:true,data:{url:'/safe',headers:{x:'secret\r\nInjected: yes'}}}));return;}
  if(path.startsWith('/many/')){res.end(JSON.stringify({ok:true,data:{url:'/safe',headers:Object.fromEntries(Array.from({length:65},(_,i)=>['x-'+i,'v']))}}));return;}
  if(path.startsWith('/malformed/')){res.end('secret-not-json');return;}
  const response=await router.handle(new Request(baseUrl+path,{headers:req.headers as Record<string,string>}));
  if(!response){res.writeHead(404);res.end();return;}
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');baseUrl=`http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
const client=()=>createFileFnClient({baseUrl,getAuthHeaders:()=>({authorization:'Bearer owned'})});
describe('bounded public download descriptor',()=>{
 it('uses actual authenticated FileFn version route and preserves headers/relative URL',async()=>{
  expect(await client().downloadDescriptor('file_1',{versionId:'version_2'})).toEqual({url:'/proxy/files/file_1/version_2',headers:{'x-download-token':'owned-download'}});
  expect(requests).toEqual(['/file_1/versions/version_2/download']);
  expect(await client().downloadUrl('file_1',{versionId:'version_2'})).toBe('/proxy/files/file_1/version_2');
  await expect(createFileFnClient({baseUrl}).downloadDescriptor('file_1')).rejects.toMatchObject({status:401});
 });
 for(const name of ['stallheaders','stallbody']) it(`deadline closes ${name} transport before cleanup`,async()=>{
  await expect(client().downloadDescriptor(name,{timeoutMs:100})).rejects.toMatchObject({name:'TimeoutError'});
  await waitFor(()=>closed.has(`/${name}/download`));expect(requests).toHaveLength(1);
 });
 it('external abort closes in-flight body',async()=>{
  const controller=new AbortController();const operation=client().downloadDescriptor('stallbody',{signal:controller.signal});
  const rejected=expect(operation).rejects.toMatchObject({name:'AbortError'});
  await waitFor(()=>requests.length===1);controller.abort(new Error('secret-abort-reason'));await rejected;
  await waitFor(()=>closed.has('/stallbody/download'));
 });
 it('bounds chunked bytes and closes excess body without retry',async()=>{
  await expect(client().downloadDescriptor('oversize',{maxResponseBytes:64})).rejects.toThrow('Download descriptor request failed');
  await waitFor(()=>closed.has('/oversize/download'));expect(requests).toHaveLength(1);
 });
 it('never leaks provider error bodies or invalid descriptor values',async()=>{
  for(const name of ['error','invalid','many','hugeheaders','malformed']){
   const error=await client().downloadDescriptor(name).catch(error=>error);
   expect(error).toBeInstanceOf(Error);expect(JSON.stringify(error)+error.message).not.toContain('secret');
  }
 });
 it('preserves custom IDs supported by actual raw-segment router',async()=>{
  expect((await client().downloadDescriptor('report:2026+final',{versionId:'v@2'})).url).toBe('/proxy/files/report:2026+final/v@2');
 });
 it('captures the original cancellation signal for listener cleanup',async()=>{
  const original=new AbortController(),replacement=new AbortController();
  const removed=vi.spyOn(original.signal,'removeEventListener');
  const options={signal:original.signal,timeoutMs:1000};
  const operation=client().downloadDescriptor('stallbody',options);
  const rejected=expect(operation).rejects.toMatchObject({name:'AbortError'});
  await waitFor(()=>requests.length===1);options.signal=replacement.signal;original.abort();await rejected;
  expect(removed).toHaveBeenCalledWith('abort',expect.any(Function));await waitFor(()=>closed.has('/stallbody/download'));
 });
 it('rejects redirect without requesting destination',async()=>{
  await expect(client().downloadDescriptor('redirect')).rejects.toThrow();expect(requests).toEqual(['/redirect/download']);
 });
 it('honors exact response byte boundary',async()=>{
  const data={url:'/proxy/files/file_1/current',headers:{'x-download-token':'owned-download'}};
  const bytes=Buffer.byteLength(JSON.stringify({ok:true,data,warnings:[]}));
  expect(await client().downloadDescriptor('file_1',{maxResponseBytes:bytes})).toEqual(data);
  await expect(client().downloadDescriptor('file_1',{maxResponseBytes:bytes-1})).rejects.toThrow();
 });
 it('does not retry accepted request with dropped response',async()=>{
  await expect(client().downloadDescriptor('drop')).rejects.toThrow('Download descriptor request failed');
  expect(requests).toEqual(['/drop/download']);
 });
 it('pre-aborted request never starts transport or exposes caller reason',async()=>{
  const controller=new AbortController();controller.abort(new Error('secret-reason'));
  const error=await client().downloadDescriptor('file_1',{signal:controller.signal}).catch(error=>error);
  expect(error.name).toBe('AbortError');expect(error.message).not.toContain('secret');expect(requests).toEqual([]);
 });
 it('rejects malformed signals and clears the timer if listener registration throws',async()=>{
  await expect(client().downloadDescriptor('file_1',{signal:{} as AbortSignal})).rejects.toThrow('Invalid download descriptor signal');
  const cleared=vi.spyOn(globalThis,'clearTimeout');
  try {
   const signal={aborted:false,addEventListener(){throw new Error('invalid registration');},removeEventListener(){}} as unknown as AbortSignal;
   await expect(client().downloadDescriptor('file_1',{signal,timeoutMs:2147483647})).rejects.toThrow();
   expect(cleared).toHaveBeenCalled();expect(requests).toEqual([]);
  } finally {cleared.mockRestore();}
 });
 it('rejects malformed bounds and path identities before transport',async()=>{
  for(const options of [{timeoutMs:0},{maxResponseBytes:NaN},{maxResponseBytes:16777217},{versionId:'../escape'}])await expect(client().downloadDescriptor('file_1',options)).rejects.toThrow();
  expect(requests).toEqual([]);
 });
 it('bounds an uncooperative auth callback and prevents late transport',async()=>{
  let resolve!:(value:Record<string,string>)=>void;
  const waiting=createFileFnClient({baseUrl,getAuthHeaders:()=>new Promise(r=>{resolve=r;})});
  await expect(waiting.downloadDescriptor('file_1',{timeoutMs:20})).rejects.toMatchObject({name:'TimeoutError'});
  resolve({authorization:'Bearer owned'});await pause(25);expect(requests).toEqual([]);
 });
});
