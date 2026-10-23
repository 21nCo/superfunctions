import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createBrowseFnRouter } from '../src/router/http-router.js';
import { buildBrowserPageResult } from '../src/web/providers/browser-provider-utils.js';
import { fetchImageBytes } from '../src/images/download.js';
import { transformImage } from '../src/images/transform.js';
const maximum=10*1024*1024;
function router(screenshot:unknown){return createBrowseFnRouter({web:{getPage:async()=>({screenshot})}} as any);}
function request(){return new Request('http://router/web/page',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://example.com'})});}
it('accepts the exact encoded screenshot boundary and rejects one extra raw byte',async()=>{
  const accepted=await router(new Uint8Array(maximum/4*3)).handle(request());expect(accepted.status).toBe(200);
  expect((await accepted.json()).data.screenshot.length).toBe(maximum);
  const encode=vi.spyOn(Buffer.prototype,'toString');
  try {
    const rejected=await router(new Uint8Array(maximum/4*3+1)).handle(request());expect(rejected.status).toBe(413);
    expect(encode.mock.calls.some(args=>args[0]==='base64')).toBe(false);
  }finally{encode.mockRestore();}
});
it('bounds pre-encoded screenshots and uses UTF-8 bytes',async()=>{
  expect((await router('a'.repeat(maximum+1)).handle(request())).status).toBe(413);
  expect((await router('é'.repeat(maximum/2+1)).handle(request())).status).toBe(413);
});
it('rejects oversized decoded HTML before selectors or screenshot capture',async()=>{
  const page={content:vi.fn(async()=>'é'.repeat(maximum/2+1)),screenshot:vi.fn(),evaluate:vi.fn()};
  await expect(buildBrowserPageResult({page,options:{screenshot:true,selectors:{include:['title']}},sanitizedUrl:'https://example.com',provider:'test',startedAt:Date.now()})).rejects.toMatchObject({code:'DOWNLOAD_TOO_LARGE'});
  expect(page.screenshot).not.toHaveBeenCalled();expect(page.evaluate).not.toHaveBeenCalled();
});
it('rejects oversized formatted JSON even when HTML is small',async()=>{
  const page={content:async()=>'<html><body>small</body></html>',screenshot:vi.fn(),evaluate:vi.fn(async()=>({body:'a'.repeat(maximum)}))};
  await expect(buildBrowserPageResult({page:page as any,options:{format:'json'},sanitizedUrl:'https://example.com',provider:'test',startedAt:Date.now()})).rejects.toMatchObject({code:'DOWNLOAD_TOO_LARGE'});
});
let server:Server|undefined;
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}});
it('accepts image bodies above20MiB through25MiB, then rejects declared and streamed overflow',async()=>{
  server=createServer((req,res)=>{
    const size=req.url==='/accepted'?25*1024*1024:25*1024*1024+1;
    if(req.url==='/streamed')res.write(Buffer.alloc(1));else res.setHeader('content-length',size);
    res.end(Buffer.alloc(size));
  });server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  expect((await fetchImageBytes(base+'/accepted',{allowPrivateHosts:true})).length).toBe(25*1024*1024);
  for(const path of ['/declared','/streamed'])await expect(fetchImageBytes(base+path,{allowPrivateHosts:true})).rejects.toMatchObject({code:'DOWNLOAD_TOO_LARGE'});
});
it('rejects oversized transform input before decoding, including explicit lower limits',async()=>{
  await expect(transformImage(Buffer.alloc(25*1024*1024+1),{})).rejects.toMatchObject({code:'DOWNLOAD_TOO_LARGE'});
  await expect(transformImage(Buffer.alloc(11),{maxPayloadBytes:10})).rejects.toMatchObject({code:'DOWNLOAD_TOO_LARGE'});
});
