/** Isolated browser board -> actual UserFn HTTP -> native SQLite. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { createUserFnService, getUserFnSchema, backfillFeedbackFilters } from '../../service/dist/index.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.USERFN_PLAYWRIGHT_MODULE ?? 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = await mkdtemp(join(tmpdir(), 'userfn-feedback-board-'));
let browser, server, adapter, release;
let uncertainVote = false, holdList = false, held = false;
const calls = [];
try {
  const sql = new Kysely({ dialect: new SqliteDialect({ database: new Database(join(directory, 'state.sqlite')) }) });
  adapter = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(Object.keys(getUserFnSchema()).map(key => [key, key])) });
  for (const table of Object.values(getUserFnSchema())) {
    let migration = sql.schema.createTable(table.modelName);
    for (const [name, field] of Object.entries(table.fields)) migration = migration.addColumn(name, field.type === 'number' ? 'integer' : 'text', column => name === 'id' ? column.primaryKey() : field.required ? column.notNull() : column);
    await migration.execute();
  }
  await backfillFeedbackFilters(adapter);
  const service = createUserFnService({ database: adapter, auth: { async authenticate(request) {
    const actor = request.headers.get('authorization')?.replace('Bearer ', '');
    if (!actor) return null;
    return { id: actor, type: 'api-key', subject: { actorType: 'api-key', actorId: actor, tenantId: actor === 'foreign' ? 'other' : 'owned' }, scopes: actor === 'readonly' ? ['userfn:feedback:read'] : ['userfn:feedback:read', 'userfn:feedback:write', 'userfn:feedback:vote'] };
  } } });
  for (let index = 0; index < 3; index++) {
    const response = await service.router.handle(new Request('http://local/feedback', { method: 'POST', headers: { authorization: 'Bearer owner', 'content-type': 'application/json', 'idempotency-key': 'seed-' + index }, body: JSON.stringify({ feedback: { title: index === 0 ? '<img src=x onerror=alert(1)>' : 'Item ' + index, body: 'Details ' + index, category: 'feature', tags: [index === 0 ? 'target' : 'other'], productArea: 'Editor' }, context: { source: 'in_app', user: null } }) }));
    assert.equal(response.status, 201);
  }
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [process.env.USERFN_SDK_ENTRY ?? join(root, 'userfn/typescript/dist/index.js'), '--bundle', '--format=esm', '--platform=browser', '--outfile=' + join(directory, 'sdk.js')], { stdio: 'pipe' });
  const bundle = await readFile(join(directory, 'sdk.js'));
  server = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/sdk.js') { outgoing.setHeader('content-type', 'text/javascript'); outgoing.end(bundle); return; }
    if (!incoming.url.startsWith('/feedback')) { outgoing.setHeader('content-type', 'text/html'); outgoing.end('<!doctype html><title>Board acceptance</title><main id="host"><p id="keep">Host content</p></main>'); return; }
    try {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      calls.push(incoming.method + ' ' + incoming.url);
      const result = await service.router.handle(new Request('http://localhost' + incoming.url, { method: incoming.method, headers, ...(incoming.method === 'GET' ? {} : { body: Buffer.concat(chunks) }) }));
      if (holdList && incoming.method === 'GET') { holdList = false; held = true; await new Promise(resolve => { release = resolve; }); }
      if (uncertainVote && incoming.url.endsWith('/vote') && result.ok) { uncertainVote = false; outgoing.writeHead(503); outgoing.end('{}'); return; }
      outgoing.writeHead(result.status, Object.fromEntries(result.headers)); outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage(); page.setDefaultTimeout(5000); await page.goto('http://127.0.0.1:' + server.address().port);
  const mount = actor => page.evaluate(async actor => {
    globalThis.board?.dispose();
    const { UserFnClient } = await import('/sdk.js');
    globalThis.client = new UserFnClient({ apiKey: actor, endpoint: location.origin, feedbackMaxAttempts: 1 });
    globalThis.board = client.mountFeedbackBoard(document.querySelector('#host'), { limit: 1 });
  }, actor);
  await mount('owner'); await page.getByText('1 feedback items shown.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load more', exact: true }).click(); await page.getByText('2 feedback items shown.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load more', exact: true }).click(); await page.getByText('3 feedback items shown.', { exact: true }).waitFor();
  assert.equal(await page.locator('li').count(), 3); assert.equal(await page.locator('img').count(), 0);
  await page.getByLabel('Tag', { exact: true }).fill('target'); await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.getByText('1 feedback items shown.', { exact: true }).waitFor();
  assert.equal(await page.locator('li h3').textContent(), '<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: 'Upvote:' }).click(); await page.getByText('Vote saved.', { exact: true }).waitFor();
  assert.ok((await page.locator('li').textContent()).includes('1 votes'));
  assert.equal(await page.getByRole('button', { name: 'Upvote:' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', { name: 'Upvote:' }).evaluate(button => document.activeElement === button), true);
  uncertainVote = true;
  await page.getByRole('button', { name: 'Downvote:' }).click(); await page.getByText('Vote not confirmed.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Upvote:' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await page.getByText('1 feedback items shown.', { exact: true }).waitFor();
  assert.ok((await page.locator('li').textContent()).includes('-1 votes'));
  await page.getByRole('button', { name: 'Remove vote:' }).click(); await page.getByText('Vote saved.', { exact: true }).waitFor();
  assert.ok((await page.locator('li').textContent()).includes('0 votes'));
  holdList = true; held = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const deadline = Date.now() + 5000; while (!held && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(held, true);
  await page.getByLabel('Tag', { exact: true }).fill('absent'); await page.getByRole('button', { name: 'Apply filters' }).click(); await page.getByText('No feedback matches these filters.').waitFor();
  release(); release = undefined; await page.waitForTimeout(100); assert.equal(await page.locator('li').count(), 0);
  await mount('readonly'); await page.getByText('1 feedback items shown.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Upvote:' }).click(); await page.getByText('Vote not confirmed.', { exact: false }).waitFor();
  await mount('foreign'); await page.getByText('No feedback matches these filters.').waitFor();
  await mount('owner'); await page.getByText('1 feedback items shown.', { exact: true }).waitFor();
  holdList = true; held = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const identityDeadline = Date.now() + 5000; while (!held && Date.now() < identityDeadline) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(held, true);
  await page.evaluate(() => client.identify('new-local-identity'));
  release(); release = undefined; await page.waitForTimeout(100);
  assert.equal(await page.locator('.userfn-feedback-board').count(), 0); assert.equal(await page.locator('#keep').textContent(), 'Host content');
  assert.equal(await adapter.count({ model: 'userfn_feedback_votes' }), 0);
  console.log(JSON.stringify({ passed: true, browser: await browser.version(), requests: calls.length, pagination: true, filters: true, escapedContent: true, acknowledgedVotes: true, lostAckReconciled: true, staleFilterFence: true, permissionAndTenantIsolation: true, identityDispose: true }));
} finally {
  release?.(); await browser?.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await adapter?.close(); await rm(directory, { recursive: true, force: true });
}
