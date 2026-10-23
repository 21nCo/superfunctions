import { lookup } from 'node:dns/promises';
import { createServer, request, type IncomingMessage } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { isPublicAddress, denied } from '../../utils/destination-policy.js';

/** Preflight rejects private initial navigation; the proxy rechecks at each connection. */
export async function assertBrowserDestination(input: string): Promise<void> {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw denied();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw denied();
}

/** Internal transport; browser isolation must additionally prevent alternate egress. */
export async function createBrowserEgressProxy(options: {
  timeoutMs: number;
  maxConnections?: number;
}): Promise<{ port: number; assertAllowed(): void; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  let policyDenied = false;
  let closed = false;
  let pendingTargets = 0;
  let activeRequests = 0;
  const limit = options.maxConnections ?? 32;
  const maxBytes = 10 * 1024 * 1024;
  const block = () => { policyDenied = true; return denied(); };
  const target = async (input: string) => {
    if (closed || pendingTargets >= limit) throw new Error('Proxy capacity exceeded');
    pendingTargets++;
    try {
      const url = new URL(input);
      if (url.protocol !== 'http:' || url.username || url.password) throw block();
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw block();
      if (closed) throw new Error('Proxy closed');
      return { url, address: addresses[0].address, family: addresses[0].family };
    } finally { pendingTargets--; }
  };
  const own = (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(options.timeoutMs, () => socket.destroy());
    return socket;
  };
  const cleanHeaders = (message: IncomingMessage) => {
    const headers = { ...message.headers };
    const connectionFields = String(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase());
    for (const name of ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'upgrade', 'transfer-encoding', 'te', 'trailer', ...connectionFields]) delete headers[name];
    return headers;
  };
  const server = createServer(async (req, res) => {
    if (closed || activeRequests >= limit) { res.destroy(); return; }
    activeRequests++;
    res.once('close', () => { activeRequests--; });
    let upstream: ReturnType<typeof request> | undefined;
    try {
      // Forward proxies require an absolute-form HTTP URL. Never interpret Host as a destination.
      if (!/^http:\/\//i.test(req.url ?? '')) throw block();
      const { url, address, family } = await target(req.url!);
      if (req.destroyed || closed) return;
      const headers = cleanHeaders(req);
      headers.host = url.host;
      upstream = request({ hostname: address, family, port: Number(url.port || 80), method: req.method,
        path: url.pathname + url.search, headers, agent: false }, response => {
        if (Number(response.headers['content-length']) > maxBytes) { response.destroy(); res.destroy(); return; }
        let size = 0;
        res.writeHead(response.statusCode ?? 502, cleanHeaders(response));
        response.on('data', chunk => { size += chunk.length; if (size > maxBytes) { response.destroy(); res.destroy(); } });
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      upstream.on('socket', own);
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
      let requestBytes = 0;
      req.on('data', chunk => { requestBytes += chunk.length; if (requestBytes > maxBytes) { upstream?.destroy(); req.destroy(); } });
      res.once('close', () => upstream?.destroy());
      req.on('error', () => upstream?.destroy());
      req.pipe(upstream);
    } catch {
      upstream?.destroy();
      if (!res.destroyed) res.writeHead(403, { connection: 'close' }).end();
    }
  });
  server.maxHeadersCount = 100;
  server.headersTimeout = Math.min(options.timeoutMs, 10_000);
  server.requestTimeout = options.timeoutMs;
  server.on('connection', socket => {
    if (closed || sockets.size >= limit * 2) { socket.destroy(); return; }
    own(socket);
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', async (req, socket, head) => {
    const downstream = socket as Socket;
    let outgoing: ReturnType<typeof request> | undefined;
    try {
      if (!/^http:\/\//i.test(req.url ?? '') || req.headers.upgrade?.toLowerCase() !== 'websocket') throw block();
      const { url, address, family } = await target(req.url!);
      if (downstream.destroyed || closed) return;
      outgoing = request({ hostname: address, family, port: Number(url.port || 80), method: 'GET',
        path: url.pathname + url.search, agent: false,
        headers: { ...cleanHeaders(req), host: url.host, connection: 'Upgrade', upgrade: 'websocket' } });
      outgoing.on('socket', own);
      outgoing.on('error', () => downstream.destroy());
      downstream.once('close', () => outgoing?.destroy());
      outgoing.on('response', response => { response.destroy(); downstream.destroy(); });
      outgoing.on('upgrade', (response, upstream, upstreamHead) => {
        if (closed || downstream.destroyed) { upstream.destroy(); return; }
        downstream.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n`);
        for (let i = 0; i < response.rawHeaders.length; i += 2) downstream.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
        downstream.write('\r\n');
        let size = head.length + upstreamHead.length;
        const count = (chunk: Buffer) => { size += chunk.length; if (size > maxBytes * 2) { downstream.destroy(); upstream.destroy(); } };
        downstream.on('data', count); upstream.on('data', count);
        upstream.on('error', () => downstream.destroy());
        upstream.once('close', () => downstream.destroy());
        downstream.once('close', () => upstream.destroy());
        if (head.length) upstream.write(head);
        if (upstreamHead.length) downstream.write(upstreamHead);
        downstream.pipe(upstream).pipe(downstream);
      });
      outgoing.end();
    } catch { outgoing?.destroy(); if (!downstream.destroyed) downstream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  server.on('connect', async (req, socket, head) => {
    const downstream = socket as Socket;
    try {
      if (!req.url || !/^(?:\[[0-9a-f:]+\]|[^\s:/@?#]+):\d+$/i.test(req.url)) throw block();
      const { url, address, family } = await target(`http://${req.url}`);
      if (downstream.destroyed || closed) return;
      const upstream = own(connect({ host: address, family, port: Number(url.port || 80) }));
      const stop = () => { upstream.destroy(); downstream.destroy(); };
      upstream.once('error', stop);
      downstream.once('close', () => upstream.destroy());
      upstream.once('close', () => downstream.destroy());
      let total = head.length;
      const count = (chunk: Buffer) => { total += chunk.length; if (total > maxBytes * 2) stop(); };
      downstream.on('data', count);
      upstream.on('data', count);
      upstream.once('connect', () => {
        if (closed || downstream.destroyed) return stop();
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        downstream.pipe(upstream).pipe(downstream);
      });
    } catch { if (!downstream.destroyed) downstream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const timer = setTimeout(() => { closed = true; for (const socket of sockets) socket.destroy(); }, options.timeoutMs);
  return {
    port: (server.address() as { port: number }).port,
    assertAllowed() { if (policyDenied) throw denied(); },
    async close() {
      closed = true;
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
