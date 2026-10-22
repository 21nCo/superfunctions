/** Real Chrome reload + Python clients against durable UserFn HTTP/SQLite. Build SDK/service first. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { createUserFnService, getUserFnSchema } from '../dist/index.js';
const { chromium } = await import(process.env.USERFN_PLAYWRIGHT_MODULE ?? 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = await mkdtemp(join(tmpdir(), 'userfn-message-browser-'));
let browser, server, adapter;
try {
  const sql = new Kysely({ dialect: new SqliteDialect({ database: new Database(join(directory, 'state.sqlite')) }) });
  adapter = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(Object.keys(getUserFnSchema()).map(key => [key, key])) });
  for (const table of Object.values(getUserFnSchema()).filter(table => table.modelName.startsWith('userfn_message_'))) {
    let migration = sql.schema.createTable(table.modelName);
    for (const [name, field] of Object.entries(table.fields)) migration = migration.addColumn(name, ['number','boolean'].includes(field.type) ? 'integer' : 'text', column => name === 'id' ? column.primaryKey() : column.notNull());
    await migration.execute();
  }
  const service = createUserFnService({ database: adapter, auth: { async authenticate(request) {
    const actorId = request.headers.get('authorization')?.replace('Bearer ', '');
    return actorId ? { id: actorId, type: 'session', subject: { actorType: 'user', actorId, tenantId: 'tenant' }, scopes: ['userfn:messages:write'] } : null;
  } }, messaging: { resolvePolicy: () => ({ enabled: true, perUser: 1, perSession: 1 }), resolveSession: () => 'verified-app-session' } });
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'userfn/typescript/dist/index.js'), '--bundle', '--format=esm', '--platform=browser', '--outfile=' + join(directory, 'sdk.js')], { stdio: 'pipe' });
  const bundle = await readFile(join(directory, 'sdk.js'));
  let dropped = false;
  const reserveKeys = [];
  server = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/sdk.js') { outgoing.setHeader('content-type','text/javascript'); outgoing.end(bundle); return; }
    if (incoming.method === 'GET') { outgoing.setHeader('content-type','text/html'); outgoing.end('<!doctype html><title>Durable message acceptance</title>'); return; }
    try {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const headers = new Headers(); for (const [key,value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const result = await service.router.handle(new Request('http://localhost' + incoming.url, { method: incoming.method, headers, body: Buffer.concat(chunks) }));
      if (incoming.url.endsWith('/reserve') && headers.get('authorization') === 'Bearer browser') {
        reserveKeys.push(headers.get('idempotency-key'));
        if (!dropped && result.ok) { dropped = true; incoming.socket.destroy(); return; }
      }
      outgoing.writeHead(result.status, Object.fromEntries(result.headers)); outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.USERFN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage(); await page.goto(origin);
  const setup = () => page.evaluate(async () => {
    const { UserFnClient } = await import('/sdk.js');
    globalThis.client = new UserFnClient({ apiKey: 'browser', endpoint: location.origin, messaging: { storageKey: 'verified-browser-session', allowInsecureHttp: true } });
    client.identify('local-browser'); client.setCampaigns([{ id: 'campaign', kind: 'modal', enabled: true, content: { title: 'Once', body: 'Persisted admission' }, triggers: [{ type: 'event', pattern: 'show' }], caps: { perUser: 1, session: 1 } }]);
  });
  await setup();
  assert.equal(await page.evaluate(async () => { try { await client.trigger('event', 'show'); return 'unexpected'; } catch { return client.getMessageDeliveryStatus().campaign; } }), 'pending');
  assert.equal(await page.locator('.userfn-modal').count(), 0);
  await page.reload(); await setup(); await page.evaluate(() => client.trigger('event', 'show'));
  assert.equal(await page.locator('.userfn-modal').count(), 1);
  assert.equal(reserveKeys[0], reserveKeys[1], 'Reload replays the persisted reservation key');
  await page.reload(); await setup(); await page.evaluate(() => client.trigger('event', 'show'));
  assert.equal(await page.locator('.userfn-modal').count(), 0, 'New instance remains capped');
  const python = `from userfn.client import UserFnClient\nfrom userfn.types import UserFnOptions, Campaign, CampaignTrigger, MessageContent, CampaignCaps\nimport sys\no=UserFnOptions('python',endpoint=sys.argv[1],messaging_state_path=sys.argv[2],messaging_allow_insecure_http=True)\ndef make():\n c=UserFnClient(o); c.identify('local-python'); c.set_campaigns([Campaign(id='campaign',kind='modal',content=MessageContent(body='once'),triggers=[CampaignTrigger(type='event',pattern='show')],enabled=True,caps=CampaignCaps(per_user=1,session_cap=1))]); return c\nc=make(); assert len(c.trigger('event','show'))==1\nassert make().trigger('event','show')==[]\nc.confirm_message_shown('campaign')\nassert make().trigger('event','show')==[]\nprint('Python persisted admission passed')\n`;
  const result = await promisify(execFile)('uv', ['run', '--isolated', '--no-project', '--python', '3.10', 'python', '-c', python, origin, join(directory,'python','journal.json')], { env: { ...process.env, PYTHONPATH: join(root,'userfn/python/src') }, timeout: 20000 });
  assert.ok(result.stdout.includes('Python persisted admission passed'));
  console.log(JSON.stringify({ passed: true, browserReloadStableReplay: true, nativeSQLite: true, pythonRestartReconciliation: true }));
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await adapter?.close(); await rm(directory, { recursive: true, force: true });
}
