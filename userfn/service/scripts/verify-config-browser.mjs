/** Actual Chrome WebCrypto/CORS acceptance. Build SDK/service/shared packages first. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserFnService } from '../dist/index.js';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
const { chromium } = await import(process.env.USERFN_PLAYWRIGHT_MODULE ?? 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = await mkdtemp(join(tmpdir(), 'userfn-config-browser-'));
const servers = []; let browser;
const listen = async handler => { const server = createServer(handler); servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; };
try {
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'userfn/typescript/dist/index.js'), '--bundle', '--format=esm', '--platform=browser', '--outfile=' + join(directory, 'sdk.js')], { stdio: 'pipe' });
  const bundle = await readFile(join(directory, 'sdk.js'));
  const app = async (request, response) => { response.setHeader('content-type', request.url === '/sdk.js' ? 'text/javascript' : 'text/html'); response.end(request.url === '/sdk.js' ? bundle : '<!doctype html><title>UserFn browser acceptance</title>'); };
  const origin = await listen(app); const blockedOrigin = await listen(app);
  const keys = generateKeyPairSync('ed25519'); const trustedKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const service = createUserFnService({ database: memoryAdapter(), allowedOrigins: [origin], flagConfigSigning: { privateKey: keys.privateKey, keyId: 'key-1' }, auth: { async authenticate(request) {
    return request.headers.get('authorization') === 'Bearer key' ? { id: 'key', type: 'api-key', subject: { actorId: 'test', actorType: 'api-key', tenantId: 'tenant' }, scopes: ['userfn:config:read', 'userfn:config:write'] } : null;
  } } });
  let mode = 'normal'; const seen = [];
  const endpoint = await listen(async (incoming, outgoing) => {
    try {
      seen.push({ method: incoming.method, cookie: incoming.headers.cookie, origin: incoming.headers.origin, conditional: incoming.headers['if-none-match'] });
      const headers = new Headers(incoming.headers); if (mode !== 'normal') headers.delete('if-none-match');
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const response = await service.router.handle(new Request('http://localhost' + incoming.url, { method: incoming.method, headers, ...(incoming.method === 'PUT' ? { body: Buffer.concat(chunks) } : {}) }));
      if (mode === 'signature' && incoming.method === 'GET') response.headers.set('x-userfn-signature', 'A'.repeat(86));
      if (mode === 'delay' && incoming.method === 'GET') await new Promise(resolve => setTimeout(resolve, 150));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end('fixture failure'); }
  });
  const publication = await fetch(endpoint + '/config/production', { method: 'PUT', headers: { authorization: 'Bearer key', 'content-type': 'application/json', 'if-none-match': '*' }, body: JSON.stringify({ flags: [{ key: 'feature', enabled: true, defaultValue: true, variations: [], rules: [] }], segments: [] }) });
  assert.equal(publication.status, 201);
  browser = await chromium.launch({ headless: true, executablePath: process.env.USERFN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage(); await page.goto(origin);
  const result = await page.evaluate(async ({ endpoint, trustedKey }) => {
    const { UserFnClient } = await import('/sdk.js'); document.cookie = 'ambient=must-not-leak; path=/';
    globalThis.makeClient = (tenantId = 'tenant', timeoutMs = 1000) => new UserFnClient({ apiKey: 'key', endpoint, environment: 'production', bootstrapFlags: { feature: 'bootstrap' }, config: { tenantId, trustedKeys: { 'key-1': trustedKey }, allowInsecureHttp: true, timeoutMs } });
    globalThis.client = globalThis.makeClient();
    return { crypto: !!crypto.subtle, first: await client.refreshConfig(), second: await client.refreshConfig(), value: client.getFlag('feature') };
  }, { endpoint, trustedKey });
  assert.deepEqual(result, { crypto: true, first: true, second: false, value: true });
  assert.ok(seen.some(request => request.method === 'OPTIONS' && request.origin === origin));
  assert.ok(seen.some(request => request.method === 'GET' && request.conditional));
  assert.ok(seen.filter(request => request.method === 'GET').every(request => request.cookie === undefined));
  mode = 'signature';
  assert.deepEqual(await page.evaluate(async () => { let rejected = false; try { await client.refreshConfig(); } catch { rejected = true; } return { rejected, value: client.getFlag('feature') }; }), { rejected: true, value: true });
  mode = 'normal';
  assert.deepEqual(await page.evaluate(async () => { const wrong = makeClient('other'); let rejected = false; try { await wrong.refreshConfig(); } catch { rejected = true; } return { rejected, value: wrong.getFlag('feature') }; }), { rejected: true, value: 'bootstrap' });
  mode = 'delay';
  assert.deepEqual(await page.evaluate(async () => { const slow = makeClient('tenant', 20); let rejected = false; try { await slow.refreshConfig(); } catch { rejected = true; } await new Promise(resolve => setTimeout(resolve, 250)); return { rejected, value: slow.getFlag('feature') }; }), { rejected: true, value: 'bootstrap' });
  mode = 'normal';
  const blocked = await browser.newPage(); await blocked.goto(blockedOrigin);
  assert.equal(await blocked.evaluate(async ({ endpoint, trustedKey }) => { const { UserFnClient } = await import('/sdk.js'); const client = new UserFnClient({ apiKey: 'key', endpoint, environment: 'production', config: { tenantId: 'tenant', trustedKeys: { 'key-1': trustedKey }, allowInsecureHttp: true } }); try { await client.refreshConfig(); return false; } catch { return true; } }, { endpoint, trustedKey }), true);
  console.log(JSON.stringify({ browser: await browser.version(), verifiedRefresh: true, conditional304: true, allowedAndBlockedCors: true, ambientCookiesOmitted: true, invalidSignatureAndTenantPreserveState: true, deadlinePreservesBootstrap: true }));
} finally {
  await browser?.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(directory, { recursive: true, force: true });
}
