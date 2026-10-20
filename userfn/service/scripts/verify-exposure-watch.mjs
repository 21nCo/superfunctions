/** Built UserFn SDKs -> real HTTP routers -> SQLite, with close/reopen durability. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { createUserFnService, getUserFnSchema } from '../dist/index.js';
import { UserFnClient } from '../../typescript/dist/index.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { WatchFn, getWatchFnSchema } = await import(pathToFileURL(process.env.USERFN_WATCH_CORE ?? join(root, 'watchfn/typescript/dist/index.mjs')));
const directory = await mkdtemp(join(tmpdir(), 'userfn-exposure-'));
const databasePath = join(directory, 'events.sqlite');
const keys = generateKeyPairSync('ed25519');
const trustedKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const watchKey = 'fixture-watch-key'; const configKey = 'fixture-config-key';
let native, sql, watch, service, browser, mode = 'normal', bundle, release;
const clients = []; const requests = [];
function open() {
  native = new Database(databasePath);
  const schemas = { ...getWatchFnSchema(), userfn_flag_config: getUserFnSchema().userfn_flag_config };
  assert.ok(schemas.watchfn_events.fields.receivedAt, 'current Watch schema required');
  for (const [name, schema] of Object.entries(schemas)) {
    native.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${Object.entries(schema.fields).map(([field, type]) => `"${field}" ${type.type === 'number' ? 'REAL' : 'TEXT'}${field === 'id' ? ' PRIMARY KEY' : ''}`).join(',')})`);
    for (const index of schema.indexes ?? []) native.exec(`CREATE INDEX IF NOT EXISTS "${index.name}" ON "${name}" (${index.fields.map(field => `"${field}"`).join(',')})`);
  }
  sql = new Kysely({ dialect: new SqliteDialect({ database: native }) });
  const adapter = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { watchfn_events: 'watchfn_events', userfn_flag_config: 'userfn_flag_config' } });
  watch = new WatchFn({ name: 'exposure-acceptance', storage: 'database', database: adapter, infra: { enabled: false }, auth: { apiKey: watchKey } }); watch.start();
  service = createUserFnService({ database: adapter, flagConfigSigning: { privateKey: keys.privateKey, keyId: 'key-1' }, auth: { async authenticate(request) {
    return request.headers.get('authorization') === `Bearer ${configKey}` ? { id: 'fixture', type: 'api-key', subject: { actorId: 'fixture', actorType: 'api-key', tenantId: 'tenant' }, scopes: ['userfn:config:read', 'userfn:config:write'] } : null;
  } } });
}
const server = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.url === '/' || incoming.url === '/sdk.js') { outgoing.setHeader('content-type', incoming.url === '/' ? 'text/html' : 'text/javascript'); outgoing.end(incoming.url === '/' ? '<!doctype html><title>Exposure acceptance</title>' : bundle); return; }
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (incoming.url === '/ingest') {
      requests.push({ authorization: incoming.headers.authorization, body: JSON.parse(body.toString()) });
      if (mode === 'hold') await new Promise(resolve => { release = resolve; });
      if (mode === 'unavailable') { outgoing.writeHead(503); outgoing.end('{}'); return; }
    }
    if (incoming.url === '/slow/ingest') { await new Promise(resolve => setTimeout(resolve, 150)); if (outgoing.destroyed) return; }
    const request = new Request('http://localhost' + (incoming.url === '/slow/ingest' ? '/ingest' : incoming.url), { method: incoming.method, headers: new Headers(incoming.headers), ...(body.length ? { body } : {}) });
    const response = await (incoming.url.startsWith('/config/') ? service.router : watch.httpRouter).handle(request);
    if (incoming.url === '/ingest' && mode === 'lost-response') { mode = 'normal'; incoming.socket.destroy(); return; }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { outgoing.writeHead(500); outgoing.end('fixture failure'); console.error(error); }
});
const allEvents = () => native.prepare('SELECT payload FROM watchfn_events').all().map(row => JSON.parse(row.payload));
const flag = (key, extra = {}) => ({ key, enabled: true, defaultValue: false, variations: [], rules: [], ...extra });
const flags = [
  flag('gate', { defaultValue: true }),
  flag('equal', { variations: [{ id: 'same-a', value: true }, { id: 'same-b', value: true }], rules: [{ id: 'base-rule', variationId: 'same-a' }], environmentOverrides: { production: { rules: [{ id: 'production-rule', variationId: 'same-b' }] } } }),
  flag('dependent', { prerequisites: [{ key: 'gate', expectedValue: true }], variations: [{ id: 'on', value: true }], rules: [{ id: 'dependent-rule', variationId: 'on' }] }),
  flag('default-variant', { variations: [{ id: 'control', value: 'control' }], defaultVariationId: 'control' }),
  flag('default-value', { defaultValue: 'plain-default' }),
];
let endpoint;
function make(user, exposures = {}) {
  const client = new UserFnClient({ apiKey: configKey, endpoint, environment: 'production', config: { tenantId: 'tenant', trustedKeys: { 'key-1': trustedKey }, allowInsecureHttp: true }, exposures: { endpoint: endpoint + '/ingest', apiKey: watchKey, app: 'user-app', allowInsecureHttp: true, timeoutMs: 1000, ...exposures } });
  client.identify(user, { privateTrait: 'must-not-transmit' }); clients.push(client); return client;
}
function verify(user) {
  const events = allEvents().filter(event => event.user?.id === user);
  assert.equal(events.length, 5, user);
  assert.ok(events.every(event => event.type === 'track' && event.name === 'userfn.flag_exposure' && event.app.name === 'user-app' && event.properties.environment === 'production'));
  const byKey = Object.fromEntries(events.map(event => [event.properties.flagKey, event.properties]));
  assert.deepEqual(byKey.equal, { flagKey: 'equal', variationId: 'same-b', ruleId: 'production-rule', reason: 'rule', environment: 'production' });
  assert.equal(byKey.dependent.ruleId, 'dependent-rule'); assert.equal(byKey['default-variant'].variationId, 'control');
  assert.equal(byKey['default-value'].reason, 'default_value'); assert.equal(byKey.missing.reason, 'unavailable'); assert.equal(byKey.missing.variationId, null);
  assert.ok(!byKey.gate, 'prerequisite evaluation must not emit an extra exposure');
  const serialized = JSON.stringify(events); for (const forbidden of [watchKey, configKey, 'privateTrait', 'must-not-transmit', 'plain-default']) assert.ok(!serialized.includes(forbidden));
}
try {
  open(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); endpoint = `http://127.0.0.1:${server.address().port}`;
  const publication = await fetch(endpoint + '/config/production', { method: 'PUT', headers: { authorization: `Bearer ${configKey}`, 'content-type': 'application/json', 'if-none-match': '*' }, body: JSON.stringify({ flags, segments: [] }) }); assert.equal(publication.status, 201, await publication.text());
  const client = make('node-user'); assert.equal(await client.refreshConfig(), true);
  for (const [key, expected] of [['equal', true], ['dependent', true], ['default-variant', 'control'], ['default-value', 'plain-default'], ['missing', 'fallback']]) assert.equal(client.getFlag(key, 'fallback'), expected);
  await Promise.all([client.flushExposures(), client.flushExposures()]); verify('node-user');
  // Server failures retain the original event and never change the evaluated value.
  mode = 'unavailable'; const retry = make('retry-user'); await retry.refreshConfig(); assert.equal(retry.getFlag('equal'), true);
  await assert.rejects(retry.flushExposures()); assert.equal(retry.getExposureStatus().pending, 1);
  const originalId = (Array.isArray(requests.at(-1).body) ? requests.at(-1).body[0] : requests.at(-1).body.events?.[0] ?? requests.at(-1).body).id; mode = 'normal'; await retry.flushExposures();
  assert.equal(allEvents().find(event => event.user?.id === 'retry-user').id, originalId);
  const storageFailure = make('storage-failure-user'); await storageFailure.refreshConfig(); native.exec('ALTER TABLE watchfn_events RENAME TO unavailable_events');
  try { storageFailure.getFlag('equal'); await assert.rejects(storageFailure.flushExposures()); assert.equal(storageFailure.getExposureStatus().pending, 1); } finally { native.exec('ALTER TABLE unavailable_events RENAME TO watchfn_events'); }
  await assert.rejects(watch.flush(), /storage operations failed/);
  await storageFailure.flushExposures(); assert.equal(allEvents().filter(event => event.user?.id === 'storage-failure-user').length, 1);
  const slow = make('timeout-user', { endpoint: endpoint + '/slow/ingest', timeoutMs: 25 }); await slow.refreshConfig(); const started = Date.now(); slow.getFlag('equal'); await assert.rejects(slow.flushExposures()); assert.ok(Date.now() - started < 1000); assert.equal(slow.getExposureStatus().pending, 1);
  const unauthorized = make('unauthorized-user', { apiKey: 'wrong-key' }); await unauthorized.refreshConfig(); unauthorized.getFlag('equal'); await assert.rejects(unauthorized.flushExposures()); assert.equal(unauthorized.getExposureStatus().pending, 1); assert.ok(!allEvents().some(event => event.user?.id === 'unauthorized-user'));
  // Lost acknowledgement is at-least-once: identical event IDs can be persisted twice.
  mode = 'lost-response'; const ambiguous = make('ambiguous-user'); await ambiguous.refreshConfig(); ambiguous.getFlag('equal'); await assert.rejects(ambiguous.flushExposures()); await ambiguous.flushExposures();
  const duplicates = allEvents().filter(event => event.user?.id === 'ambiguous-user'); assert.equal(duplicates.length, 2); assert.equal(duplicates[0].id, duplicates[1].id);
  mode = 'hold'; const bounded = make('bounded-user', { maxQueueSize: 1 }); await bounded.refreshConfig(); bounded.getFlag('equal'); bounded.getFlag('dependent');
  assert.equal(bounded.getExposureStatus().dropped, 1); const holdDeadline = Date.now() + 2000; while (!release && Date.now() < holdDeadline) await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(release, 'held request must arrive before fixture deadline'); mode = 'normal'; release(); release = undefined;
  await assert.rejects(bounded.flushExposures(), /rejected before delivery/); await bounded.flushExposures(); assert.equal(allEvents().filter(event => event.user?.id === 'bounded-user').length, 1);
  await client.closeExposures(); assert.equal(client.getExposureStatus().closed, true); client.getFlag('equal'); assert.equal(client.getExposureStatus().dropped, 1); verify('node-user');
  // Actual Python SDK and httpx transport, using the same signed config and Watch endpoint.
  await writeFile(join(directory, 'accept.py'), `import asyncio,json,sys,time\nfrom userfn import UserFnClient,UserFnOptions,SignedConfigOptions,ExposureOptions\nasync def main():\n c=UserFnClient(UserFnOptions(api_key='${configKey}',endpoint=sys.argv[1],environment='production',config=SignedConfigOptions(tenant_id='tenant',trusted_keys={'key-1':sys.argv[2]},allow_insecure_http=True),exposures=ExposureOptions(endpoint=sys.argv[1]+'/ingest',api_key='${watchKey}',app='user-app',allow_insecure_http=True)))\n c.identify('python-user',{'privateTrait':'must-not-transmit'})\n assert await c.refresh_config()\n for key,value in [('equal',True),('dependent',True),('default-variant','control'),('default-value','plain-default'),('missing','fallback')]:\n  assert c.get_flag(key,'fallback')==value\n await asyncio.gather(c.flush_exposures(),c.flush_exposures())\n await c.close_exposures()\n assert c.get_exposure_status()['closed']\n for suffix,key in [('/slow/ingest','${watchKey}'),('/ingest','wrong-key')]:\n  bad=UserFnClient(UserFnOptions(api_key='unused',bootstrap_flags={'feature':True},exposures=ExposureOptions(endpoint=sys.argv[1]+suffix,api_key=key,app='user-app',allow_insecure_http=True,timeout_ms=25)))\n  assert bad.get_flag('feature') is True\n  started=time.monotonic()\n  try:\n   await bad.flush_exposures()\n   raise AssertionError('delivery must fail')\n  except RuntimeError: pass\n  assert time.monotonic()-started < 1\n  assert bad.get_exposure_status()['pending']==1\n  assert bad.get_exposure_status()['lastError']\n  try: await bad.close_exposures()\n  except RuntimeError: pass\n  assert bad.get_exposure_status()['closed']\n bounded=UserFnClient(UserFnOptions(api_key='unused',bootstrap_flags={'feature':True},exposures=ExposureOptions(endpoint=sys.argv[1]+'/ingest',api_key='${watchKey}',app='user-app',allow_insecure_http=True,max_queue_size=1)))\n bounded.identify('python-bounded')\n bounded.get_flag('feature'); bounded.get_flag('feature')\n assert bounded.get_exposure_status()['dropped']==1\n try:\n  await bounded.flush_exposures()\n  raise AssertionError('dropped event must be observable')\n except RuntimeError as error: assert 'rejected before delivery' in str(error)\n await bounded.flush_exposures(); await bounded.close_exposures()\n print(json.dumps(c.get_exposure_status()))\nasyncio.run(main())\n`);
  const python = await promisify(execFile)('python3', [join(directory, 'accept.py'), endpoint, trustedKey], { timeout: 20000, env: { ...process.env, PYTHONPATH: join(root, 'userfn/python/src') } }); assert.equal(JSON.parse(python.stdout.trim()).pending, 0); verify('python-user');
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'userfn/typescript/dist/index.js'), '--bundle', '--format=esm', '--platform=browser', '--outfile=' + join(directory, 'sdk.js')], { stdio: 'pipe' }); bundle = await readFile(join(directory, 'sdk.js'));
  const { chromium } = await import(process.env.USERFN_PLAYWRIGHT_MODULE ?? 'playwright'); browser = await chromium.launch({ headless: true, executablePath: process.env.USERFN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage(); await page.goto(endpoint);
  await page.evaluate(async ({ endpoint, trustedKey, configKey, watchKey }) => {
    const { UserFnClient } = await import('/sdk.js'); const client = new UserFnClient({ apiKey: configKey, endpoint, environment: 'production', config: { tenantId: 'tenant', trustedKeys: { 'key-1': trustedKey }, allowInsecureHttp: true }, exposures: { endpoint: endpoint + '/ingest', apiKey: watchKey, app: 'user-app', allowInsecureHttp: true } });
    client.identify('browser-user', { privateTrait: 'must-not-transmit' }); await client.refreshConfig(); for (const key of ['equal', 'dependent', 'default-variant', 'default-value', 'missing']) client.getFlag(key, 'fallback'); await client.flushExposures(); await client.closeExposures();
  }, { endpoint, trustedKey, configKey, watchKey }); verify('browser-user');
  assert.ok(requests.filter(request => request.authorization !== 'Bearer wrong-key').every(request => request.authorization === `Bearer ${watchKey}`));
  const before = allEvents(); await watch.stop(); await sql.destroy(); open(); assert.deepEqual(allEvents(), before); verify('node-user'); verify('python-user'); verify('browser-user');
  const query = await fetch(endpoint + '/query', { method: 'POST', headers: { authorization: `Bearer ${watchKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ where: { name: 'userfn.flag_exposure' }, limit: 100 }) }); assert.equal(query.status, 200); const queried = await query.json(); assert.equal(queried.results.length, before.length);
  console.log(JSON.stringify({ nodeBuiltSDK: true, pythonSDK: true, browser: await browser.version(), signedConfig: true, equalValueProvenance: true, prerequisiteRootOnly: true, failureRetention: true, actualStorageFailure: true, nodeAndPythonDeadline: true, actual401: true, boundedQueue: true, concurrentFlush: true, closeFencing: true, ambiguousRetryDuplicatesExplicit: true, sqliteReopen: true, persistedEvents: before.length }));
} finally {
  mode = 'normal'; release?.(); await browser?.close();
  for (const client of clients) { try { await client.closeExposures(); } catch {} }
  await watch?.stop().catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await sql?.destroy().catch(() => {}); await rm(directory, { recursive: true, force: true });
}
