import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { lookup } from 'node:dns';
import { browseFn } from '../src/core/browse-fn.js';
import { createBrowseFnRouter } from '../src/router/http-router.js';
import { fetchPublicPage } from '../src/utils/public-page.js';
import { fetchImageBytes } from '../src/images/download.js';
import { normalizePolicyHost, permitsPrivateHost } from '../src/utils/destination-policy.js';
vi.mock('node:dns',async original=>{const real=await original<typeof import('node:dns')>();return {...real,lookup:vi.fn(real.lookup)};});
let server:Server, deniedServer:Server, base:string, deniedUrl:string, calls:string[], deniedCalls:number;
beforeEach(async()=>{
  calls=[];deniedCalls=0;
  deniedServer=createServer((_req,res)=>{deniedCalls++;res.end('private');});deniedServer.listen(0,'::1');await once(deniedServer,'listening');
  deniedUrl=`http://[::1]:${(deniedServer.address() as {port:number}).port}`;
  server=createServer((req,res)=>{calls.push(req.url!);if(req.url==='/escape'){res.writeHead(302,{location:deniedUrl}).end();return;}res.end('<html><title>owned</title></html>');});
  server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  vi.mocked(lookup).mockReset();vi.mocked(lookup).mockImplementation(((host:string,_options:unknown,callback:Function)=>callback(null,[{address:host==='private.test'?'::1':'127.0.0.1',family:host==='private.test'?6:4}])) as never);
});
afterEach(async()=>{for(const item of [server,deniedServer]){item.closeAllConnections();await new Promise<void>(resolve=>item.close(()=>resolve()));}});
it('normalizes exact IDNA, trailing-dot and IPv4-mapped IPv6 rules without suffix matching',()=>{
  expect(normalizePolicyHost('BÜCHER.Example.')).toBe('xn--bcher-kva.example');
  expect(normalizePolicyHost('[::ffff:127.0.0.1]')).toBe('::ffff:7f00:1');
  expect(permitsPrivateHost('LOCALHOST.',{allowedHosts:['localhost']})).toBe(true);
  expect(permitsPrivateHost('child.localhost',{allowedHosts:['localhost']})).toBe(false);
  expect(permitsPrivateHost('other.public',{allowedHosts:['localhost']})).toBe(false);
});
it.each(['*.example.com','https://example.com','example.com:80','user@example.com','127.1','0x7f000001','127.000.0.1','example..com','example.com..','[::1%lo0]'])('rejects malformed or ambiguous host rule %s before DNS',async host=>{
  await expect(fetchPublicPage(base.replace('127.0.0.1','owned.test'),{security:{allowedHosts:[host]}})).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  expect(lookup).not.toHaveBeenCalled();expect(calls).toEqual([]);
});
it('rejects malformed arrays before DNS',async()=>{
  for(const allowedHosts of ['localhost',[1],null])await expect(fetchPublicPage(base.replace('127.0.0.1','owned.test'),{security:{allowedHosts} as any})).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  expect(lookup).not.toHaveBeenCalled();expect(calls).toEqual([]);
});
it('pins an exact allowed DNS host, but rechecks redirect destinations',async()=>{
  const url=base.replace('127.0.0.1','Owned.Test.');
  expect((await fetchPublicPage(url,{security:{allowedHosts:['owned.test']}})).bytes.length).toBeGreaterThan(0);
  expect(lookup).toHaveBeenCalledTimes(1);
  await expect(fetchPublicPage(url+'/escape',{security:{allowedHosts:['owned.test']}})).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});
  expect(calls).toEqual(['/','/escape']);expect(deniedCalls).toBe(0);
});
it('blocked hosts override broad and scoped private opt-ins before DNS',async()=>{
  for(const policy of [{allowPrivateHosts:true},{allowedHosts:['owned.test']}])await expect(fetchPublicPage(base.replace('127.0.0.1','owned.test'),{security:{...policy,blockedHosts:['OWNED.TEST.']}})).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});
  expect(lookup).not.toHaveBeenCalled();expect(calls).toEqual([]);
});
it('applies global hostname policy to page, metadata and images, preserving router strictness',async()=>{
  const browse=browseFn({security:{allowedHosts:['127.0.0.1']},cache:{enabled:true}});
  expect((await browse.web.getPage(base)).metadata.title).toBe('owned');
  expect((await browse.web.getMultipleMetadata([base]))[0].data?.title).toBe('owned');
  const count=calls.length;
  await expect(browse.web.getPage(base,{security:{blockedHosts:['127.0.0.1']}})).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});
  const router=createBrowseFnRouter(browse);
  for(const path of ['/web/page','/images/download']){
    const response=await router.handle(new Request('http://router'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:base,options:{allowPrivateHosts:true,security:{allowPrivateHosts:true,allowedHosts:['127.0.0.1']}}})}));
    expect(response.status).toBe(403);
  }
  expect(calls.length).toBe(count);
  const blocked=browseFn({security:{allowPrivateHosts:true,blockedHosts:['127.0.0.1']}});
  await expect(blocked.web.getPage(base,{security:{allowedHosts:['127.0.0.1'],blockedHosts:[]}})).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});
  await expect(blocked.images.download(base,{allowPrivateHosts:true})).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});
  expect(calls.length).toBe(count);
});
it('applies exact exceptions and blocked precedence to the actual image transport',async()=>{
  expect((await fetchImageBytes(base,{security:{allowedHosts:['127.0.0.1']}})).length).toBeGreaterThan(0);
  await expect(fetchImageBytes(base,{allowPrivateHosts:true,security:{blockedHosts:['127.0.0.1']}})).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});
  await expect(fetchImageBytes(base+'/escape',{security:{allowedHosts:['127.0.0.1']}})).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});
  expect(deniedCalls).toBe(0);
});
it('matches normalized IDNA rules at the actual DNS connection boundary',async()=>{
  const url=base.replace('127.0.0.1','bücher.example');
  await fetchPublicPage(url,{security:{allowedHosts:['XN--BCHER-KVA.EXAMPLE.']}});
  expect(lookup).toHaveBeenCalledWith('xn--bcher-kva.example',expect.anything(),expect.any(Function));expect(calls).toEqual(['/']);
});
it('denies mapped IPv6 by default and permits only its explicit canonical exception',async()=>{
  const url=base.replace('127.0.0.1','[::ffff:127.0.0.1]');
  await expect(fetchPublicPage(url,{security:{}})).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});expect(calls).toEqual([]);
  await fetchPublicPage(url,{security:{allowedHosts:['[::ffff:7f00:1]']}});expect(calls).toEqual(['/']);
});
