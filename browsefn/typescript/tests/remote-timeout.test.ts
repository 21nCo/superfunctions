import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { FirecrawlProvider } from '../src/web/providers/firecrawl.js';
import { JinaProvider } from '../src/web/providers/jina.js';
it.each(['firecrawl','jina'])('aborts a real stalled %s request at its timeout', async (name) => {
  const server = createServer(() => {});
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const config = { endpoint:`http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    const provider = name === 'firecrawl' ? new FirecrawlProvider(config) : new JinaProvider(config);
    const start = Date.now();
    await expect(provider.getPage('https://example.com',{timeout:50})).rejects.toMatchObject({name:'TimeoutError'});
    expect(Date.now() - start).toBeLessThan(1000);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
