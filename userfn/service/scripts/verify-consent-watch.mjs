/** Real local Watch HTTP + SQLite, Python subprocess and Chrome consent boundaries. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { UserFnClient } from '../../typescript/dist/index.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { WatchFn, getWatchFnSchema } = await import(pathToFileURL(process.env.USERFN_WATCH_CORE ?? join(root, 'watchfn/typescript/dist/index.mjs')));
const { chromium } = await import(process.env.USERFN_PLAYWRIGHT_MODULE ?? 'playwright');
const directory = await mkdtemp(join(tmpdir(), 'userfn-consent-'));
const native = new Database(join(directory, 'events.sqlite'));
const schemas = getWatchFnSchema();
for (const [name, schema] of Object.entries(schemas)) native.exec(`CREATE TABLE "${name}" (${Object.entries(schema.fields).map(([field, type]) => `"${field}" ${type.type === 'number' ? 'REAL' : 'TEXT'}${field === 'id' ? ' PRIMARY KEY' : ''}`).join(',')})`);
const sql = new Kysely({ dialect: new SqliteDialect({ database: native }) });
const watch = new WatchFn({ name: 'consent-fixture', storage: 'database', database: kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { watchfn_events: 'watchfn_events' } }), infra: { enabled: false }, auth: { apiKey: 'watch-key' } }); watch.start();
let browser, bundle, release; const seen = []; let heldFinished;
const server = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.url === '/' || incoming.url === '/sdk.js') { outgoing.setHeader('content-type', incoming.url === '/sdk.js' ? 'text/javascript' : 'text/html'); outgoing.end(incoming.url === '/' ? '<!doctype html><title>Consent acceptance</title>' : bundle); return; }
    if (incoming.url.startsWith('/seen/')) { outgoing.end(JSON.stringify(seen.some(event => event.properties.flagKey === decodeURIComponent(incoming.url.slice(6))))); return; }
    if (incoming.method !== 'POST') { outgoing.writeHead(404); outgoing.end(); return; }
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk); const body = Buffer.concat(chunks); seen.push(...JSON.parse(body));
    if (incoming.url === '/hold/ingest') await new Promise(resolve => { release = resolve; });
    if (incoming.url === '/slow/ingest') await new Promise(resolve => setTimeout(resolve, 150));
    if (incoming.url === '/fail/ingest') { outgoing.writeHead(503); outgoing.end('{}'); return; }
    const response = await watch.httpRouter.handle(new Request('http://localhost/ingest', { method: 'POST', headers: incoming.headers, body }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    if (incoming.url === '/hold/ingest') heldFinished?.();
  } catch (error) { if (!outgoing.destroyed) { outgoing.writeHead(500); outgoing.end('fixture failure'); } console.error(error); }
});
const events = () => native.prepare('SELECT payload FROM watchfn_events').all().map(row => JSON.parse(row.payload));
const within = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture operation timed out')), 3000); })]); } finally { clearTimeout(timer); } };
const waitFor = async predicate => { const deadline = Date.now() + 3000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture deadline exceeded'); await new Promise(resolve => setTimeout(resolve, 2)); } };
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const endpoint = `http://127.0.0.1:${server.address().port}`;
  const options = { apiKey: 'unused', bootstrapFlags: { feature: true }, exposures: { endpoint: endpoint + '/ingest', apiKey: 'watch-key', app: 'consent', allowInsecureHttp: true, timeoutMs: 1000 } };
  const denied = new UserFnClient({ ...options, consent: { analytics: false, messaging: false } }); assert.equal(denied.getFlag('feature'), true); await denied.flushExposures(); assert.equal(seen.length, 0);
  const client = new UserFnClient({ ...options, exposures: { ...options.exposures, endpoint: endpoint + '/hold/ingest' } }); client.getFlag('node-handed-off'); const old = client.flushExposures(); const oldOutcome = old.then(() => 'success', error => error.message);
  await waitFor(() => release); client.getFlag('node-unsent'); client.setConsent({ analytics: false }); assert.equal(client.getExposureStatus().discarded, 2); assert.match(await within(oldOutcome), /discarded/);
  const held = new Promise(resolve => { heldFinished = resolve; }); release(); await within(held);
  // A request already handed to the server may persist despite abort; it is not retracted.
  assert.ok(events().some(event => event.properties.flagKey === 'node-handed-off'));
  client.setConsent({ analytics: true }); await client.flushExposures(); assert.ok(!seen.some(event => event.properties.flagKey === 'node-unsent'));
  const failure = new UserFnClient({ ...options, exposures: { ...options.exposures, endpoint: endpoint + '/fail/ingest' } }); failure.getFlag('node-failed'); await assert.rejects(failure.flushExposures()); failure.setConsent({ analytics: false }); failure.setConsent({ analytics: true }); await failure.flushExposures(); assert.equal(seen.filter(event => event.properties.flagKey === 'node-failed').length, 1);
  const fresh = new UserFnClient(options); fresh.getFlag('node-new'); await fresh.closeExposures();
  const python = `import asyncio,json,sys,httpx\nfrom userfn import UserFnClient,UserFnOptions,ConsentOptions,ExposureOptions\nendpoint=sys.argv[1]\ndef make(path='/ingest',**kw):return UserFnClient(UserFnOptions('unused',bootstrap_flags={'feature':True},exposures=ExposureOptions(endpoint+path,'watch-key','consent',allow_insecure_http=True),**kw))\nasync def main():\n c=make(consent=ConsentOptions(analytics=False,messaging=False));assert c.get_flag('feature') is True;await c.flush_exposures();c.set_consent(analytics=True);c.get_flag('python-unsent');c.set_consent(analytics=False);assert c.get_exposure_status()['discarded']==1;c.set_consent(analytics=True);await c.flush_exposures();c.get_flag('python-new');await c.close_exposures()\n c=make('/slow/ingest');c.get_flag('python-handed-off');old=asyncio.create_task(c.flush_exposures())\n async with httpx.AsyncClient() as http:\n  for _ in range(150):\n   if (await http.get(endpoint+'/seen/python-handed-off')).json():break\n   await asyncio.sleep(.01)\n  else:raise AssertionError('Request not observed')\n c.get_flag('python-pending');c.set_consent(analytics=False)\n try:await old;raise AssertionError('Discard did not reject')\n except RuntimeError as e:assert 'discarded' in str(e)\n assert c.get_exposure_status()['discarded']==2;c.set_consent(analytics=True);c.get_flag('python-after-regrant');await c.flush_exposures();assert c.get_exposure_status()['pending']==0;await c.close_exposures()\nasyncio.run(main())\n`;
  await writeFile(join(directory, 'consent.py'), python); await promisify(execFile)(process.env.USERFN_PYTHON ?? 'python3', [join(directory, 'consent.py'), endpoint], { env: { ...process.env, PYTHONPATH: join(root, 'userfn/python/src') }, timeout: 15000 });
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'userfn/typescript/dist/index.js'), '--bundle', '--format=esm', '--platform=browser', '--outfile=' + join(directory, 'sdk.js')], { stdio: 'pipe' }); bundle = await readFile(join(directory, 'sdk.js'));
  browser = await chromium.launch({ headless: true, executablePath: process.env.USERFN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }); const page = await browser.newPage(); await page.goto(endpoint);
  const result = await page.evaluate(async options => {
    const { UserFnClient } = await import('/sdk.js'); globalThis.dnt = '0'; Object.defineProperty(navigator, 'doNotTrack', { configurable: true, get: () => globalThis.dnt });
    const c = new UserFnClient({ ...options, consent: { analytics: false, messaging: false } }); const other = new UserFnClient({ apiKey: 'unused' }); c.identify('owner'); other.identify('other');
    const campaign = { id: 'campaign', enabled: true, kind: 'modal', content: { title: 'owned-campaign', body: 'body', ctaText: 'go', ctaUrl: '#should-not-navigate' }, triggers: [{ type: 'event', pattern: 'show' }], priority: 1 };
    c.setCampaigns([campaign]); c.trigger('event', 'show'); if (document.querySelector('.userfn-modal')) throw new Error('Denied messaging rendered');
    c.setConsent({ messaging: true }); c.trigger('event', 'show'); const oldButton = document.querySelector('.userfn-cta'); if (!oldButton) throw new Error('Allowed campaign missing');
    other.setCampaigns([{ ...campaign, content: { ...campaign.content, title: 'other-client' } }]); other.trigger('event', 'show'); c.openFeedbackWidget();
    c.setConsent({ messaging: false }); if (document.body.textContent.includes('owned-campaign')) throw new Error('Owned message retained'); if (!document.body.textContent.includes('other-client') || !document.body.textContent.includes('Send Feedback')) throw new Error('Unrelated UI removed');
    c.setConsent({ messaging: true }); oldButton.click(); if (location.hash) throw new Error('Detached callback executed');
    c.setCampaigns([]); c.setSurveys([{ id: 'survey', enabled: true, kind: 'custom', questions: [{ id: 'q', title: 'owned-survey', type: 'text' }, { id: 'next', title: 'must-not-render', type: 'text' }], triggers: [{ type: 'event', pattern: 'survey' }] }]); c.trigger('event', 'survey'); const survey = [...document.querySelectorAll('.userfn-modal')].find(element => element.textContent.includes('owned-survey')); if (!survey) throw new Error('Allowed survey missing'); const next = survey.querySelector('.userfn-cta');
    c.setConsent({ messaging: false }); c.setConsent({ messaging: true }); next.click(); if (document.body.textContent.includes('must-not-render')) throw new Error('Revoked survey advanced');
    c.setConsent({ analytics: true }); c.getFlag('browser-unsent'); globalThis.dnt = '1'; await c.flushExposures(); if (c.getExposureStatus().discarded !== 1) throw new Error('DNT queue not discarded');
    c.setConsent({ analytics: true, messaging: true }); if (c.getConsent().analytics || c.getConsent().messaging || !c.getConsent().doNotTrack) throw new Error('DNT did not veto grants'); if (c.getFlag('feature') !== true) throw new Error('Flag evaluation changed'); c.trigger('event', 'survey'); if (document.body.textContent.includes('owned-survey')) throw new Error('DNT messaging rendered');
    globalThis.dnt = '0'; c.setConsent({ analytics: false }); c.reset(); if (c.getConsent().analytics) throw new Error('Reset granted consent'); c.setConsent({ analytics: true }); c.getFlag('browser-new'); await c.closeExposures();
    return { ownedTeardown: true, detachedCallbacks: true, surveys: true, explicitFeedbackRetained: true, liveDnt: true, independentConsent: true };
  }, options);
  const keys = events().map(event => event.properties.flagKey);
  for (const absent of ['node-unsent', 'node-failed', 'python-unsent', 'python-pending', 'browser-unsent']) assert.ok(!keys.includes(absent), absent);
  for (const present of ['node-new', 'python-new', 'python-after-regrant', 'browser-new']) assert.ok(keys.includes(present), present);
  assert.ok(!seen.some(event => ['node-unsent', 'python-unsent', 'python-pending', 'browser-unsent'].includes(event.properties.flagKey)));
  await Promise.all([denied.closeExposures(), client.closeExposures(), failure.closeExposures()]);
  console.log(JSON.stringify({ actualWatchHttpSqlite: true, pythonHttp: true, ownedRequestCancellation: true, acknowledgedRetractionNotClaimed: true, browser: await browser.version(), ...result }));
} finally {
  release?.(); await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await watch.stop(); await sql.destroy(); await rm(directory, { recursive: true, force: true });
}
