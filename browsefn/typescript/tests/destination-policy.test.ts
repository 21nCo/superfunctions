import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { CheerioProvider } from '../src/web/providers/cheerio.js';
import { ImageBrowser } from '../src/images/browser.js';
import { WebScraper } from '../src/web/scraper.js';
import { createBrowseFnRouter } from '../src/router/http-router.js';
import { lookup } from 'node:dns';
import { isPublicAddress } from '../src/utils/destination-policy.js';
vi.mock('node:dns', async (original) => { const real = await original<typeof import('node:dns')>(); return { ...real, lookup: vi.fn(real.lookup) }; });
vi.mock('../src/utils/destination-policy.js', async (original) => { const real = await original<typeof import('../src/utils/destination-policy.js')>(); return { ...real, isPublicAddress: vi.fn(real.isPublicAddress) }; });
import { fetchPublicPage } from '../src/utils/public-page.js';

let server: Server, base: string, calls: string[];
beforeEach(async () => {
  vi.clearAllMocks();
  calls = [];
  server = createServer((req, res) => {
    calls.push(req.url!);
    if (req.url === '/private-redirect') { res.writeHead(302, { location: `http://127.0.0.2:${(server.address() as {port: number}).port}/private` }).end(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/page' }).end(); return; }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }).end(); return; }
    if (req.url === '/scheme') { res.writeHead(302, { location: 'file:///etc/passwd' }).end(); return; }
    if (req.url === '/slow') return;
    if (req.url === '/encoded') { res.writeHead(200, { 'content-encoding': 'gzip' }).end('encoded'); return; }
    if (req.url === '/chunked') { res.writeHead(200); res.end(Buffer.alloc(10 * 1024 * 1024 + 1)); return; }
    if (req.url === '/large') { res.writeHead(200, { 'content-length': '999999999' }).end(); return; }
    res.end('<html><title>Owned fixture</title><a href="/next">Next</a></html>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
function service() { const web = new WebScraper(undefined, undefined, 'cheerio'); web.registerProvider(new CheerioProvider()); return web; }
function request(path: string, body: unknown) { return new Request(`http://router${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }

describe('router destination policy', () => {
  it('rejects DNS answers containing any private address before socket connect', async () => {
    vi.mocked(lookup).mockImplementationOnce(((_host: unknown, _options: unknown, callback: Function) => callback(null, [
      { address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 },
    ])) as never);
    await expect(fetchPublicPage(base.replace('127.0.0.1', 'mixed.test'), { security: {} })).rejects.toMatchObject({ code: 'SECURITY_POLICY_BLOCKED' });
    expect(calls).toEqual([]); expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('connects to the checked answer without a second DNS lookup', async () => {
    vi.mocked(lookup).mockImplementationOnce(((_host: unknown, _options: unknown, callback: Function) => callback(null, [
      { address: '127.0.0.1', family: 4 },
    ])) as never);
    const result = await fetchPublicPage(base.replace('127.0.0.1', 'pinned.test'), { security: { allowPrivateHosts: true } });
    expect(Buffer.from(result.bytes).toString()).toContain('Owned fixture');
    expect(lookup).toHaveBeenCalledTimes(1); expect(calls).toEqual(['/']);
  });
  it('rechecks redirect destination before sending a request (owned origin classified public only for this fixture)', async () => {
    const original = await vi.importActual<typeof import('../src/utils/destination-policy.js')>('../src/utils/destination-policy.js');
    vi.mocked(isPublicAddress).mockImplementation(address => address === '127.0.0.1' || original.isPublicAddress(address));
    try {
      await expect(fetchPublicPage(`${base}/private-redirect`, { security: {} })).rejects.toMatchObject({ code: 'SECURITY_POLICY_BLOCKED' });
      expect(calls).toEqual(['/private-redirect']);
    } finally { vi.mocked(isPublicAddress).mockImplementation(original.isPublicAddress); }
  });
  it('denies loopback including caller security/cache overrides before any target request', async () => {
    const router = createBrowseFnRouter({ web: service() } as never);
    for (const host of ['127.0.0.1', '2130706433', '0x7f000001', 'localhost']) {
      const response = await router.handle(request('/web/page', { url: base.replace('127.0.0.1', host), options: { security: { allowPrivateHosts: true }, cache: { key: 'override' } } }));
      expect(response.status).toBe(403);
    }
    expect(calls).toEqual([]);
  });
  it('overrides the legacy image private-host bypass at the router', async () => {
    const router = createBrowseFnRouter({ images: new ImageBrowser() } as never);
    const response = await router.handle(request('/images/download', { url: base, options: { allowPrivateHosts: true, security: { allowPrivateHosts: true } } }));
    expect(response.status).toBe(403); expect(calls).toEqual([]);
  });
  it('propagates mandatory policy to metadata and reports per-item denial', async () => {
    const router = createBrowseFnRouter({ web: service() } as never);
    const response = await router.handle(request('/web/metadata', { urls: [base], options: { security: { allowPrivateHosts: true } } }));
    expect(await response.json()).toMatchObject({ data: [{ success: false }] });
    expect(calls).toEqual([]);
  });
  it('does not call custom fallback or retry after a blocked destination', async () => {
    const web = service(); const getPage = vi.fn();
    web.registerProvider({ name: 'custom', capabilities: {}, isAvailable: async () => true, getPage } as never);
    await expect(web.getPage(base, { security: {}, retry: { count: 2, delay: 0 } })).rejects.toMatchObject({ code: 'SECURITY_POLICY_BLOCKED' });
    await expect(web.getPage('https://example.org', { provider: 'custom', security: {} })).rejects.toMatchObject({ code: 'SECURITY_POLICY_BLOCKED' });
    expect(getPage).not.toHaveBeenCalled(); expect(calls).toEqual([]);
  });
  it('supports explicit trusted-library opt-in, redirects and final URL metadata', async () => {
    const result = await service().getPage(`${base}/redirect`, { security: { allowPrivateHosts: true }, includeLinks: true });
    expect(result.url).toBe(`${base}/page`); expect(result.metadata.title).toBe('Owned fixture');
    expect(result.links).toEqual([`${base}/next`]); expect(calls).toEqual(['/redirect', '/page']);
  });
  it('enforces protocol, redirect and payload bounds even with a private-host opt-in', async () => {
    for (const [path, code] of [['/scheme', 'SECURITY_POLICY_BLOCKED'], ['/loop', 'SECURITY_POLICY_BLOCKED'], ['/large', 'DOWNLOAD_TOO_LARGE'], ['/chunked', 'DOWNLOAD_TOO_LARGE'], ['/encoded', 'PROVIDER_ERROR']]) {
      await expect(fetchPublicPage(base + path, { security: { allowPrivateHosts: true } })).rejects.toMatchObject({ code });
    }
    expect(calls.filter(path => path === '/loop')).toHaveLength(6);
    await expect(fetchPublicPage(base + '/slow', { security: { allowPrivateHosts: true }, timeout: 20 })).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });
});

it('does not turn private exceptions into an exclusive public hostname allowlist',async()=>{
  const actual=await vi.importActual<typeof import('../src/utils/destination-policy.js')>('../src/utils/destination-policy.js');
  vi.mocked(isPublicAddress).mockImplementation(address=>address==='127.0.0.1');
  try {
    expect((await fetchPublicPage(base,{security:{allowedHosts:['other-private.test']}})).bytes.length).toBeGreaterThan(0);
    expect(calls).toEqual(['/']);
  } finally {vi.mocked(isPublicAddress).mockImplementation(actual.isPublicAddress);}
});
