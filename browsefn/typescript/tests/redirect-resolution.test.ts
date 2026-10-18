import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { CheerioProvider } from '../src/web/providers/cheerio.js';
it('resolves links and images against the final redirect URL', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/old') { res.writeHead(302, { location: '/new/directory/page' }); res.end(); }
    else { res.end('<html><head><title>Redirected</title></head><body><a href="child">Child</a><img src="image.png"></body></html>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const page = await new CheerioProvider().getPage(base + '/old', { includeLinks: true, includeImages: true, format: 'json' });
    expect(page.url).toBe(base + '/new/directory/page');
    expect(page.links).toContain(base + '/new/directory/child');
    expect(page.images).toContain(base + '/new/directory/image.png');
    expect(JSON.parse(page.content).links).toEqual(page.links);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
