import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { serverLogger } from './factory.js';
it('server preset flushes to its configured real HTTP endpoint', async () => {
  const received: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(202).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const address = server.address() as { port: number };
    const logger = serverLogger({ name: 'preset', url: `http://127.0.0.1:${address.port}` });
    logger.info('delivered');
    await logger.flush();
    expect(received).toEqual([{ events: [expect.objectContaining({ name: 'preset', msg: 'delivered' })] }]);
  } finally {
    output.mockRestore();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
