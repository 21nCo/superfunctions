import { afterEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { FirecrawlProvider } from '../src/web/providers/firecrawl.js';
import { JinaProvider } from '../src/web/providers/jina.js';
import { htmlToMarkdown, applySelectors } from '../src/utils/html-utils.js';
import { fetchImageBytes } from '../src/images/download.js';
vi.mock('../src/images/download.js', () => ({ fetchImageBytes: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const html = '<title>Page</title><main><p>first <a href="/next">Next</a></p><h2>Second</h2><ul><li>list item</li></ul><pre><code>const a = 1;</code></pre><img src="/photo.png"></main><aside>exclude me</aside>';
it('preserves ordered Markdown content, lists, code and all matching selectors', () => {
  const result = htmlToMarkdown(html);
  expect(result.indexOf('first')).toBeLessThan(result.indexOf('## Second'));
  expect(result).toContain('[Next](/next)'); expect(result).toContain('list item'); expect(result).toContain('```\nconst a = 1;');
  expect(applySelectors('<p>one</p><p>two</p>', { include: ['p'] })).toBe('<p>one</p>\n<p>two</p>');
});
it('Firecrawl sends supported formats, target credentials, selectors and provider proxy mode', async () => {
  const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, data: { html, metadata: { sourceURL: 'https://example.com/final' } } })));
  const page = await new FirecrawlProvider({ apiKey: 'api-secret', waitForMs: 25 }).getPage('https://example.com/start', { format: 'text', headers: { Authorization: 'target-secret' }, cookies: [{ name: 'session', value: 'abc' }, {name:'wrong',value:'no',domain:'other.test'}], selectors: { exclude: ['aside'] }, proxy: 'enhanced', includeLinks: true, includeImages: true });
  const request = mock.mock.calls[0][1]!; const body = JSON.parse(request.body as string);
  expect(body.formats).toEqual(['html']); expect(body.waitFor).toBe(25); expect(body.proxy).toBe('enhanced'); expect(body.headers.authorization).toBe('target-secret'); expect(body.headers.cookie).toBe('session=abc'); expect(body.excludeTags).toEqual(['aside']);
  expect(request.headers).toMatchObject({ Authorization: 'Bearer api-secret' }); expect(request.signal).toBeInstanceOf(AbortSignal);
  expect(page.content).not.toContain('exclude me'); expect(page.links).toEqual(['https://example.com/next']); expect(page.images).toEqual(['https://example.com/photo.png']); expect(page.url).toBe('https://example.com/final');
});
it('Firecrawl securely downloads screenshot URL and encodes requested type', async () => {
  vi.mocked(fetchImageBytes).mockResolvedValue(await sharp({ create: { width: 2, height: 3, channels: 3, background: 'red' } }).png().toBuffer());
  const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, data: { html, screenshot: 'https://images.example.com/shot.png' } })));
  const page = await new FirecrawlProvider({ apiKey: 'key' }).getPage('https://example.com', { screenshot: { fullPage: true, format: 'jpeg', quality: 50 } });
  expect(JSON.parse(mock.mock.calls[0][1]!.body as string).formats).toContain('screenshot@fullPage');
  expect(fetchImageBytes).toHaveBeenCalledWith('https://images.example.com/shot.png', { maxPayloadBytes: 25 * 1024 * 1024, maxRedirects: 5 });
  expect((await sharp(page.screenshot).metadata()).format).toBe('jpeg');
});
it('rejects failed remote envelopes', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ success: false, code: 403, error: 'denied', message: 'denied' })));
  await expect(new FirecrawlProvider({}).getPage('https://example.com')).rejects.toMatchObject({code:'PROVIDER_ERROR'});
  await expect(new JinaProvider().getPage('https://example.com')).rejects.toMatchObject({code:'PROVIDER_ERROR'});
});
it('Jina preserves HTTPS, separates credentials, returns actual HTML and downloads screenshots', async () => {
  vi.mocked(fetchImageBytes).mockResolvedValue(await sharp({ create: { width: 2, height: 3, channels: 3, background: 'red' } }).png().toBuffer());
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, request) => {
    const body = JSON.parse(request!.body as string);
    return new Response(JSON.stringify({ code: 200, data: body.respondWith === 'pageshot' ? { pageshotUrl: 'https://images.example.com/shot.png' } : { html, url: body.url, title: 'Remote title' } }));
  });
  const page = await new JinaProvider({ apiKey: 'api-secret' }).getPage('https://example.com/path', { format: 'html', headers: { Authorization: 'target-secret' }, cookies: [{name:'sid',value:'abc'}], proxy: 'http://proxy.example:8080', includeLinks: true, includeImages: true, selectors: { include: ['main'] }, mobile: true, waitFor: 'networkidle', screenshot: {fullPage:true} });
  const request = mock.mock.calls[0][1]!, body = JSON.parse(request.body as string);
  expect(mock.mock.calls[0][0]).toBe('https://r.jina.ai/'); expect(body.url).toBe('https://example.com/path'); expect(body.customHeader.Authorization).toBe('target-secret'); expect(request.headers).toMatchObject({Authorization:'Bearer api-secret'}); expect(body.respondWith).toBe('html'); expect(body.proxyUrl).toBe('http://proxy.example:8080'); expect(body.respondTiming).toBe('network-idle'); expect(body.viewport.isMobile).toBe(true); expect(body.setCookies).toEqual(['sid=abc; Domain=example.com; Path=/']);
  expect(page.content).toContain('<main>'); expect(page.content).not.toContain('exclude me'); expect(page.links).toEqual(['https://example.com/next']); expect(page.images).toEqual(['https://example.com/photo.png']); expect(page.screenshot).toBeInstanceOf(Uint8Array);
});
it('rejects vendor-inexpressible lifecycle/custom proxy options before transport', async () => {
  const mock = vi.spyOn(globalThis, 'fetch');
  await expect(new FirecrawlProvider({}).getPage('https://example.com', { waitFor:'load' })).rejects.toMatchObject({code:'UNSUPPORTED_PROVIDER_CAPABILITY'});
  await expect(new FirecrawlProvider({}).getPage('https://example.com', { proxy:'http://proxy.example' })).rejects.toMatchObject({code:'UNSUPPORTED_PROVIDER_CAPABILITY'});
  await expect(new JinaProvider().getPage('https://example.com', { waitFor:'domcontentloaded' })).rejects.toMatchObject({code:'UNSUPPORTED_PROVIDER_CAPABILITY'});
  expect(mock).not.toHaveBeenCalled();
});
it('preserves service and target error status for retries', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ code:503, success:true, data:{html,metadata:{statusCode:503}} })));
  await expect(new JinaProvider().getPage('https://example.com')).rejects.toMatchObject({details:{statusCode:503}});
  await expect(new FirecrawlProvider({}).getPage('https://example.com')).rejects.toThrow('HTTP 503');
});

it('propagates image-only security caps to remote screenshot transfer without private exceptions',async()=>{
  vi.mocked(fetchImageBytes).mockResolvedValue(await sharp({ create: { width: 2, height: 3, channels: 3, background: 'red' } }).png().toBuffer());
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, data: { html, screenshot: 'https://images.example.com/shot.png' } })));
  await new FirecrawlProvider({apiKey:'unused'}).getPage('https://example.com',{screenshot:true,security:{allowPrivateHosts:true,maxDownloadBytes:1024}});
  expect(fetchImageBytes).toHaveBeenLastCalledWith('https://images.example.com/shot.png',{maxPayloadBytes:1024,maxRedirects:5});
});
