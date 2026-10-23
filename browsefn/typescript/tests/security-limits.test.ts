import sharp from 'sharp';
import { transformImage } from '../src/images/transform.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { browseFn } from '../src/core/browse-fn.js';
import { fetchPublicPage } from '../src/utils/public-page.js';
import { fetchImageBytes } from '../src/images/download.js';
import { downloadLimits } from '../src/utils/security-limits.js';
import { mergeSecurity } from '../src/utils/destination-policy.js';
import { createBrowseFnRouter } from '../src/router/http-router.js';
import { FirecrawlProvider } from '../src/web/providers/firecrawl.js';
import { JinaProvider } from '../src/web/providers/jina.js';
import { PlaywrightProvider } from '../src/web/providers/playwright.js';
import { PuppeteerProvider } from '../src/web/providers/puppeteer.js';
let server:Server, base:string, calls:string[];
beforeEach(async()=>{
  calls=[]; server=createServer((req,res)=>{calls.push(req.url!);const n=Number(req.url!.slice(2));
    if(req.url!.startsWith('/r')&&n>0){res.writeHead(302,{location:`/r${n-1}`}).end();return;}
    const bytes=Buffer.from(req.url==='/utf8'?'é'.repeat(8):'x'.repeat(req.url==='/large'?1024:req.url==='/overflow'?17:16));
    if(req.url!=='/stream')res.setHeader('content-length',bytes.length);else res.write(bytes.subarray(0,1));
    res.end(req.url==='/stream'?bytes.subarray(1):bytes);
  });server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterEach(async()=>{vi.restoreAllMocks();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
it('enforces actual page and image body boundaries, declared and streaming',async()=>{
  for(const path of ['/','/utf8','/stream']){
    expect((await fetchPublicPage(base+path,{security:{allowPrivateHosts:true,maxResponseBytes:16}})).bytes.length).toBe(16);
    expect((await fetchImageBytes(base+path,{security:{allowPrivateHosts:true,maxDownloadBytes:16}})).length).toBe(16);
  }
  for(const path of ['/overflow','/stream']){
    await expect(fetchPublicPage(base+path,{security:{allowPrivateHosts:true,maxResponseBytes:15}})).rejects.toMatchObject({code:'DOWNLOAD_TOO_LARGE'});
    await expect(fetchImageBytes(base+path,{security:{allowPrivateHosts:true,maxDownloadBytes:15}})).rejects.toMatchObject({code:'DOWNLOAD_TOO_LARGE'});
  }
});
it('zero redirects never requests target; six explicitly allowed redirects exceed the default five',async()=>{
  for(const image of [false,true]){
    calls=[];
    const fetch=(n:number)=>image?fetchImageBytes(base+'/r6',{security:{allowPrivateHosts:true,maxRedirects:n}}):fetchPublicPage(base+'/r6',{security:{allowPrivateHosts:true,maxRedirects:n}});
    await expect(fetch(0)).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});expect(calls).toEqual(['/r6']);
    calls=[];await fetch(6);expect(calls).toHaveLength(7);
    calls=[];await expect(fetch(5)).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});expect(calls).not.toContain('/r0');
  }
});
it('rejects malformed constructor limits before any request',()=>{
  for(const name of ['maxResponseBytes','maxDownloadBytes','maxRedirects'])for(const value of [-1,1.5,'10',NaN,Infinity,null,Number.MAX_SAFE_INTEGER+1])expect(()=>browseFn({security:{[name]:value} as any})).toThrow();
  expect(calls).toEqual([]);
});
it('tightens explicit global limits, preserves explicit raised limits and legacy image ceilings',()=>{
  expect(mergeSecurity({maxResponseBytes:16,maxRedirects:2},{maxResponseBytes:32,maxRedirects:0})).toMatchObject({maxResponseBytes:16,maxRedirects:0});
  expect(downloadLimits({security:{maxDownloadBytes:30*1024*1024,maxRedirects:6}})).toEqual({maxBytes:30*1024*1024,maxRedirects:6});
  expect(downloadLimits({security:{maxDownloadBytes:16,maxRedirects:2},maxPayloadBytes:32,maxRedirects:1})).toEqual({maxBytes:16,maxRedirects:1});
});
it('applies global page limits, rejects formatted expansion, and rechecks colliding cached content',async()=>{
  const browse=browseFn({security:{allowedHosts:['127.0.0.1'],maxResponseBytes:32},cache:{enabled:true,keyGenerator:()=> 'one-key'}});
  expect((await browse.web.getPage(base,{format:'text'})).content).toHaveLength(16);
  await expect(browse.web.getPage(base,{format:'text',security:{maxResponseBytes:15}})).rejects.toMatchObject({code:'DOWNLOAD_TOO_LARGE'});
  expect(calls).toHaveLength(1);
  const tiny=browseFn({security:{allowedHosts:['127.0.0.1'],maxResponseBytes:16}});
  await expect(tiny.web.getPage(base,{format:'json'})).rejects.toMatchObject({code:'DOWNLOAD_TOO_LARGE'});
  await expect(tiny.web.getPage(base+'/overflow',{security:{maxResponseBytes:100}})).rejects.toMatchObject({code:'DOWNLOAD_TOO_LARGE'});
});
it('passes trusted raised limits through router while preserving strict destinations',async()=>{
  const real=browseFn({security:{maxDownloadBytes:30*1024*1024,maxRedirects:6}});
  const download=vi.fn(async(_url:string,options:any)=>({limits:downloadLimits(options),security:options.security}));
  const router=createBrowseFnRouter({getSecurityLimits:()=>real.getSecurityLimits(),images:{download}} as any);
  const response=await router.handle(new Request('http://router/images/download',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://example.com',options:{maxPayloadBytes:40*1024*1024,maxRedirects:10,security:{allowPrivateHosts:true,maxDownloadBytes:99*1024*1024}}})}));
  expect(response.status).toBe(200);expect(download.mock.calls[0][1].security).toMatchObject({allowPrivateHosts:false,allowedHosts:[]});
  expect((await response.json()).data.limits).toEqual({maxBytes:30*1024*1024,maxRedirects:6});
});
it('rejects unsupported explicit browser and hosted page caps before network or launch',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw new Error('must not send');});
  for(const provider of [new FirecrawlProvider({apiKey:'unused'}),new JinaProvider(),new PlaywrightProvider(),new PuppeteerProvider()])for(const security of [{maxResponseBytes:16},{maxRedirects:0}])await expect(provider.getPage('https://example.com',{security})).rejects.toMatchObject({code:'UNSUPPORTED_PROVIDER_CAPABILITY'});
  expect(fetch).not.toHaveBeenCalled();
});

it('checks configured image input, transformed output and watermark bytes',async()=>{
  const input=await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer();
  const jpeg=await transformImage(input,{format:'jpeg'});
  expect(jpeg.bytes.length).toBeGreaterThan(input.length);
  await expect(transformImage(input,{format:'jpeg',security:{maxDownloadBytes:input.length}})).rejects.toMatchObject({code:'DOWNLOAD_TOO_LARGE'});
  await expect(transformImage(input,{security:{maxDownloadBytes:input.length-1}})).rejects.toMatchObject({code:'DOWNLOAD_TOO_LARGE'});
  await expect(transformImage(input,{security:{allowPrivateHosts:true,maxDownloadBytes:input.length},watermark:{image:base+'/large'}})).rejects.toMatchObject({code:'DOWNLOAD_TOO_LARGE'});
});
