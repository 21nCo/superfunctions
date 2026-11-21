import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AwsSesAdapter } from '../src/email/aws-ses-adapter';

const message = { from: 'from@example.test', to: ['to@example.test'], subject: 'test', text: 'body' };
const xml = '<SendEmailResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><SendEmailResult><MessageId>local-id</MessageId></SendEmailResult><ResponseMetadata><RequestId>local-request</RequestId></ResponseMetadata></SendEmailResponse>';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(respond: (res: ServerResponse) => void, options = {}) {
  let requests = 0;
  let sockets = 0;
  const server = createServer((req, res) => { requests++; req.resume(); respond(res); });
  server.on('connection', socket => { sockets++; socket.once('close', () => { sockets--; }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const provider = new AwsSesAdapter({ region: 'us-east-1', accessKeyId: 'local', secretAccessKey: 'local', endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 1000, ...options });
  cleanup.push(() => provider.close());
  return { provider, requests: () => requests, sockets: () => sockets };
}

describe('owned SES transport', () => {
  it('sends simple and raw messages using the real signed SDK transport', async () => {
    const f = await fixture(res => res.end(xml));
    const raw = await fixture(res => res.end(xml.replaceAll('SendEmail', 'SendRawEmail')));
    const results = await Promise.all([f.provider.sendEmail(message), raw.provider.sendEmail({ ...message, headers: { 'X-Local': 'yes' } })]);
    expect(results.map(result => result.providerMessageId)).toEqual(['local-id', 'local-id']);
    expect(f.requests() + raw.requests()).toBe(2);
  });
  it('never internally retries a retryable provider response', async () => {
    const f = await fixture(res => { res.statusCode = 503; res.end('<ErrorResponse><Error><Code>ServiceUnavailable</Code><Message>local</Message></Error></ErrorResponse>'); });
    expect((await f.provider.sendEmail(message)).success).toBe(false);
    expect(f.requests()).toBe(1);
  });
  it('does not replay an accepted request whose response is lost', async () => {
    const f = await fixture(res => res.socket!.destroy());
    expect((await f.provider.sendEmail(message)).success).toBe(false);
    await expect.poll(f.sockets).toBe(0);
    expect(f.requests()).toBe(1);
  });
  it('external abort closes the active response before fallback cleanup', async () => {
    let received!: () => void;
    const ready = new Promise<void>(resolve => { received = resolve; });
    const f = await fixture(res => { res.writeHead(200); res.write('<SendEmailResponse>'); received(); });
    const controller = new AbortController();
    const pending = f.provider.sendEmail(message, { signal: controller.signal });
    await ready;
    controller.abort();
    expect((await pending).success).toBe(false);
    await expect.poll(f.sockets).toBe(0);
    expect(f.requests()).toBe(1);
  });
  it('rejects pre-aborted calls without a request', async () => {
    const f = await fixture(res => res.end(xml));
    const controller = new AbortController(); controller.abort();
    expect((await f.provider.sendEmail(message, { signal: controller.signal })).success).toBe(false);
    expect(f.requests()).toBe(0);
  });
  it.each(['headers', 'body'] as const)('aborts stalled %s and drains', async mode => {
    const f = await fixture(res => { if (mode === 'body') { res.writeHead(200); res.write('<SendEmailResponse>'); } }, { timeoutMs: 100 });
    expect((await f.provider.sendEmail(message)).success).toBe(false);
    await f.provider.close();
    await expect.poll(f.sockets).toBe(0);
    expect(f.requests()).toBe(1);
  });
  it('caps bytes before parsing and closes an unfinished response', async () => {
    const f = await fixture(res => { res.writeHead(200); res.write('x'.repeat(1025)); }, { maxResponseBytes: 1024 });
    const result = await f.provider.sendEmail(message);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('configured limit');
    await expect.poll(f.sockets).toBe(0);
    expect(f.requests()).toBe(1);
  });
  it('close aborts admitted sends, drains them, and rejects new admission', async () => {
    let received!: () => void;
    const ready = new Promise<void>(resolve => { received = resolve; });
    const f = await fixture(res => { res.writeHead(200); res.write('<SendEmailResponse>'); received(); });
    const pending = f.provider.sendEmail(message);
    await ready;
    await Promise.all([f.provider.close(), f.provider.close()]);
    expect((await pending).success).toBe(false);
    await expect.poll(f.sockets).toBe(0);
    expect((await f.provider.sendEmail(message)).success).toBe(false);
    expect(f.requests()).toBe(1);
  });
  it.each([xml.replace('<MessageId>local-id</MessageId>', ''), xml.replace('local-id', ''), '<html>not a receipt</html>'])('rejects successful HTTP without a usable receipt', async response => {
    const f = await fixture(res => res.end(response));
    expect((await f.provider.sendEmail(message)).success).toBe(false);
    expect(f.requests()).toBe(1);
  });
  it('validates bounds and trusted endpoint configuration eagerly', () => {
    const base = { region: 'us-east-1', accessKeyId: 'local', secretAccessKey: 'local' };
    for (const timeoutMs of [0, -1, NaN, Infinity, 0.1]) expect(() => new AwsSesAdapter({ ...base, timeoutMs })).toThrow();
    expect(() => new AwsSesAdapter({ ...base, endpoint: 'file:///tmp/ses' })).toThrow();
  });
});
