import { expect, it, vi } from 'vitest';
import { WebScraper } from '../src/web/scraper.js';
import { BrowseFn } from '../src/core/browse-fn.js';
import { createBrowseFnRouter } from '../src/router/http-router.js';
import type { MetadataOptions } from '../src/core/types.js';

const urls = (count: number) => Array.from({ length: count }, (_, i) => `https://example.test/${i}`);
function fixture() {
  const scraper = new WebScraper();
  const call = vi.fn(async (url: string) => ({ url, content: '', provider: 'owned', metadata: { url, title: url } }));
  scraper.registerProvider({name: 'owned', capabilities: {formats:['html'],javascript:false,screenshots:false,cookies:false,headers:false,selectors:false}, getPage: call, isAvailable: async () => true});
  return {scraper, call};
}
it('accepts exactly 100 and rejects 101 before provider admission even with override', async () => {
  const {scraper, call} = fixture();
  expect(await scraper.getMultipleMetadata(urls(100))).toHaveLength(100);
  expect(call).toHaveBeenCalledTimes(100); call.mockClear();
  for (const options of [{}, {maxBatchOverride: 101}, {maxBatchOverride: 1000}]) {
    await expect(scraper.getMultipleMetadata(urls(101), options)).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  }
  expect(call).not.toHaveBeenCalled();
});
it('snapshots URLs and fields before awaiting providers and progress callbacks', async () => {
  const {scraper, call} = fixture();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  call.mockImplementationOnce(async url => { await gate; return {url, content:'',provider:'owned',metadata:{url,title:'first'}}; });
  const input = urls(2), fields: NonNullable<MetadataOptions['fields']> = ['title'];
  const progress: number[][] = [];
  const work = scraper.getMultipleMetadata(input, {concurrency:1,fields,onProgress:(done,total) => {progress.push([done,total]);if(done===1) input.push('https://example.test/late');}});
  input.push(...urls(100)); fields.splice(0, 1, 'description'); release();
  const result = await work;
  expect(result).toHaveLength(2); expect(call).toHaveBeenCalledTimes(2);
  expect(result[0].data?.title).toBe('first'); expect(progress).toEqual([[1,2],[2,2]]);
});
it.each([0,-1,1.5,NaN,Infinity,101,'2',true])('rejects malformed bounded concurrency/override %s', async value => {
  const {scraper,call}=fixture();
  for (const key of ['concurrency','maxBatchOverride']) await expect(scraper.getMultipleMetadata(urls(1), {[key]:value} as MetadataOptions)).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  expect(call).not.toHaveBeenCalled();
});
it('rejects invalid URL collections before work', async () => {
  const {scraper,call}=fixture();
  for (const input of [null,{},[1],['https://example.test',null]]) await expect(scraper.getMultipleMetadata(input as string[])).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  expect(call).not.toHaveBeenCalled();
});
it('real router preserves 100 result positions and cannot raise 100 ceiling', async () => {
  const router=createBrowseFnRouter(new BrowseFn({}));
  for (const count of [100,101]) {
    const response=await router.handle(new Request('http://localhost/web/metadata',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({urls:Array(count).fill('http://127.0.0.1/never-request'),options:count===101?{maxBatchOverride:1000}:{}})}));
    const body=await response.json();
    expect(response.status).toBe(count===100?200:400);
    if(count===100) expect(body.data).toHaveLength(100); else expect(body.error.code).toBe('INVALID_ARGUMENT');
  }
});
it('fetches exactly 100 metadata pages from an owned HTTP server', async () => {
  const {createServer}=await import('node:http');
  const {CheerioProvider}=await import('../src/web/providers/cheerio.js');
  let hits=0;
  const server=createServer((_request,response)=>{hits++;response.end('<title>Owned</title>');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address(); if(!address || typeof address==='string') throw new Error('Missing address');
    const scraper=new WebScraper(); scraper.registerProvider(new CheerioProvider());
    const result=await scraper.getMultipleMetadata(Array.from({length:100},(_,i)=>`http://127.0.0.1:${address.port}/${i}`),{security:{allowPrivateHosts:true},concurrency:5});
    expect(result).toHaveLength(100);expect(result.every(item=>item.success && item.data?.title==='Owned')).toBe(true);expect(hits).toBe(100);
  } finally { server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
