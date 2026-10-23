import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { lookup } from 'node:dns/promises';
import { isPublicAddress } from '../src/utils/destination-policy.js';
import { createBrowserEgressProxy } from '../src/web/isolation/egress-proxy.js';
vi.mock('node:dns/promises', async original => { const real = await original<typeof import('node:dns/promises')>(); return { ...real, lookup: vi.fn(real.lookup) }; });
vi.mock('../src/utils/destination-policy.js', async original => { const real = await original<typeof import('../src/utils/destination-policy.js')>(); return { ...real, isPublicAddress: vi.fn(real.isPublicAddress) }; });
const cleanup: Array<() => Promise<void>> = [];
beforeEach(async()=>{
  vi.mocked(lookup).mockReset();vi.mocked(isPublicAddress).mockReset();
  const real=await vi.importActual<typeof import('../src/utils/destination-policy.js')>('../src/utils/destination-policy.js');
  vi.mocked(isPublicAddress).mockImplementation(real.isPublicAddress);
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture() {
  let calls = 0;
  const server = createServer((_req, res) => { calls++; res.end('owned fixture'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${(server.address() as {port:number}).port}`, calls: () => calls };
}
async function proxy() {
  const result = await createBrowserEgressProxy({ timeoutMs: 5000 }); cleanup.push(result.close); return result;
}
function get(port: number, url: string): Promise<{status: number; body: string}> {
  return new Promise((resolve, reject) => {
    const req = request({host:'127.0.0.1',port,path:url,agent:false}, res => {
      const chunks: Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode!,body:Buffer.concat(chunks).toString()}));
    }); req.on('error', reject);req.end();
  });
}
it('denies loopback HTTP and CONNECT without contacting the actual listening target', async () => {
  const target = await fixture(), lease = await proxy();
  expect((await get(lease.port,target.url)).status).toBe(403);
  const response = await new Promise<string>((resolve,reject) => {
    const socket=connect(lease.port,'127.0.0.1');let text='';socket.on('error',reject);socket.on('data',chunk=>text+=chunk);socket.on('end',()=>resolve(text));
    socket.on('connect',()=>socket.write(`CONNECT ${new URL(target.url).host} HTTP/1.1\r\nHost: ignored.test\r\n\r\n`));
  });
  expect(response).toContain('403');expect(target.calls()).toBe(0);expect(()=>lease.assertAllowed()).toThrow();
});
it('pins the checked DNS address, and rejects a subsequent rebinding answer', async () => {
  const target=await fixture(),lease=await proxy();
  vi.mocked(isPublicAddress).mockImplementation(address=>address==='127.0.0.1');
  vi.mocked(lookup).mockResolvedValueOnce([{address:'127.0.0.1',family:4}]).mockResolvedValueOnce([{address:'::1',family:6}]);
  const url=target.url.replace('127.0.0.1','owned.test');
  expect(await get(lease.port,url)).toEqual({status:200,body:'owned fixture'});
  expect((await get(lease.port,url)).status).toBe(403);
  expect(lookup).toHaveBeenCalledTimes(2);expect(target.calls()).toBe(1);
});
it('rejects mixed DNS answers and credential-bearing URLs before connection', async()=>{
  const target=await fixture(),lease=await proxy();
  vi.mocked(lookup).mockResolvedValueOnce([{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]);
  expect((await get(lease.port,target.url.replace('127.0.0.1','mixed.test'))).status).toBe(403);
  expect((await get(lease.port,target.url.replace('http://','http://user:secret@'))).status).toBe(403);
  expect(target.calls()).toBe(0);
});
it('forwards a checked CONNECT tunnel to exactly the owned target',async()=>{
  const target=await fixture(),lease=await proxy();vi.mocked(isPublicAddress).mockImplementation(address=>address==='127.0.0.1');
  const result=await new Promise<string>((resolve,reject)=>{
    const socket=connect(lease.port,'127.0.0.1');let text='',sent=false;
    socket.on('error',reject);socket.on('data',chunk=>{text+=chunk;if(!sent&&text.includes('\r\n\r\n')){sent=true;socket.write('GET / HTTP/1.1\r\nHost: owned.test\r\nConnection: close\r\n\r\n');}});
    socket.on('close',()=>resolve(text));socket.on('connect',()=>socket.write(`CONNECT ${new URL(target.url).host} HTTP/1.1\r\nHost: ignored.test\r\n\r\n`));
  });
  expect(result).toContain('200 Connection Established');expect(result).toContain('owned fixture');expect(target.calls()).toBe(1);
});
it.each(['HTTP','CONNECT'])('does not connect after %s DNS completes beyond the operation deadline',async(protocol)=>{
  const target=await fixture();
  vi.mocked(isPublicAddress).mockImplementation(address=>address==='127.0.0.1');
  let resolveLookup!: (value:any)=>void;
  const resolving=new Promise<any>(resolve=>{resolveLookup=resolve;});
  let lookupStarted!: ()=>void;
  const started=new Promise<void>(resolve=>{lookupStarted=resolve;});
  vi.mocked(lookup).mockImplementation((()=>{lookupStarted();return resolving;}) as never);
  const lease=await createBrowserEgressProxy({timeoutMs:100});cleanup.push(lease.close);
  const socket=connect(lease.port,'127.0.0.1');socket.on('error',()=>{});
  const closed=once(socket,'close');
  await once(socket,'connect');
  const url=target.url.replace('127.0.0.1','late.test');
  socket.write(protocol==='HTTP'?`GET ${url} HTTP/1.1\r\nHost: ignored\r\n\r\n`:`CONNECT ${new URL(url).host} HTTP/1.1\r\nHost: ignored\r\n\r\n`);
  await started;await closed;
  resolveLookup([{address:'127.0.0.1',family:4}]);
  await new Promise(resolve=>setTimeout(resolve,30));
  expect(target.calls()).toBe(0);
});
it('bounds pipelined requests while DNS is unresolved',async()=>{
  const lease=await createBrowserEgressProxy({timeoutMs:1000,maxConnections:2});cleanup.push(lease.close);
  const resolvers:Array<(value:any)=>void>=[];
  vi.mocked(lookup).mockImplementation((()=>new Promise(resolve=>resolvers.push(resolve))) as never);
  const socket=connect(lease.port,'127.0.0.1');socket.on('error',()=>{});
  const closed=once(socket,'close');await once(socket,'connect');
  socket.write('GET http://pending.test/ HTTP/1.1\r\nHost: ignored\r\n\r\n'.repeat(20));
  await closed;expect(resolvers.length).toBeLessThanOrEqual(2);
  for(const resolve of resolvers) resolve([]);
});
it.each(['declared','streamed'])('aborts an oversized %s response instead of returning a truncated success',async kind=>{
  const server=createServer((_req,res)=>{
    if(kind==='declared')res.setHeader('content-length',11*1024*1024);
    if(kind==='streamed')res.write(Buffer.alloc(1024));
    res.end(Buffer.alloc(11*1024*1024));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanup.push(()=>new Promise(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  vi.mocked(isPublicAddress).mockImplementation(address=>address==='127.0.0.1');
  const lease=await proxy();let received=0;
  const outcome=await new Promise<string>(resolve=>{
    const req=request({host:'127.0.0.1',port:lease.port,path:`http://127.0.0.1:${(server.address() as {port:number}).port}`,agent:false},res=>{
      res.on('data',chunk=>{received+=chunk.length;});res.on('aborted',()=>resolve('aborted'));res.on('error',()=>resolve('aborted'));res.on('end',()=>resolve('complete'));
    });req.on('error',()=>resolve('aborted'));req.end();
  });
  expect(outcome).toBe('aborted');expect(received).toBeLessThanOrEqual(10*1024*1024);
});
