import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { CheerioProvider } from '../src/web/providers/cheerio.js';

it('routes actual requests through a CONNECT proxy and closes its dispatcher', async () => {
  const origin = createServer((_request, response) => response.end('<title>through proxy</title>'));
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  const targetPort = (origin.address() as AddressInfo).port;
  const proxy = createServer();
  const connections: string[] = [];
  proxy.on('connect', (request, client, head) => {
    connections.push(request.url!);
    const upstream = connect(targetPort, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.write(head); upstream.pipe(client); client.pipe(upstream); });
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const page = await new CheerioProvider().getPage(`http://127.0.0.1:${targetPort}`, { proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` });
    expect(page.metadata.title).toBe('through proxy'); expect(connections).toEqual([`127.0.0.1:${targetPort}`]);
  } finally {
    origin.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => origin.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))]);
  }
});
