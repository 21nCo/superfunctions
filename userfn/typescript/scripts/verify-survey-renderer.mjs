/** Actual Chrome UI -> UserFn HTTP service -> owned SQLite, including lost receipts. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql as query } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { createUserFnService, getUserFnSchema } from '../../service/dist/index.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.USERFN_PLAYWRIGHT_MODULE ?? 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = await mkdtemp(join(tmpdir(), 'userfn-survey-renderer-'));
let browser, server, adapter, release;
const requests = [];
let dropNext = true, holdNext = false, denyAckNext = false;
try {
  const database = new Kysely({ dialect: new SqliteDialect({ database: new Database(join(directory, 'state.sqlite')) }) });
  adapter = kyselyAdapter({ db: database, dialect: 'sqlite', schema: Object.fromEntries(Object.keys(getUserFnSchema()).map(key => [key, key])) });
  for (const table of Object.values(getUserFnSchema())) {
    let migration = database.schema.createTable(table.modelName);
    for (const [name, field] of Object.entries(table.fields)) migration = migration.addColumn(name, field.type === 'number' ? 'integer' : 'text', column => name === 'id' ? column.primaryKey() : field.required ? column.notNull() : column);
    await migration.execute();
  }
  const questions = [{ id: 'score', type: 'csat', title: 'Score', required: true }, { id: 'choice', type: 'choice', title: 'Choice', required: true, choices: [{ label: 'Yes', value: true }, { label: 'No', value: false }] }, { id: 'text', type: 'text', title: 'Details' }];
  const branchQuestions = [
    { id: 'path', type: 'choice', title: 'Choose path', required: true, choices: [{ label: 'Details', value: true }, { label: 'Effort', value: false }] },
    { id: 'details', type: 'text', title: 'Branch details', required: true, when: { questionId: 'path', equals: true } },
    { id: 'effort', type: 'ces', title: 'Effort score', required: true, when: { questionId: 'path', equals: false } },
    { id: 'custom', type: 'scale', title: 'Custom score', min: -2, max: 2, required: true },
  ];
  const service = createUserFnService({ database: adapter, auth: { async authenticate(request) {
    const actorId = request.headers.get('authorization')?.replace('Bearer ', '');
    return actorId ? { id: actorId, type: 'session', subject: { actorType: 'user', actorId, tenantId: 'owned' }, scopes: ['userfn:surveys:write', 'userfn:feedback:write'] } : null;
  } }, surveys: { resolvePolicy: (_session, id) => ({ enabled: true, questions: id === 'branch' ? branchQuestions : questions, perUser: 1 }) } });
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [process.env.USERFN_SDK_ENTRY ?? join(root, 'userfn/typescript/dist/index.js'), '--bundle', '--format=esm', '--platform=browser', '--outfile=' + join(directory, 'sdk.js')], { stdio: 'pipe' });
  const bundle = await readFile(join(directory, 'sdk.js'));
  server = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/sdk.js') { outgoing.setHeader('content-type', 'text/javascript'); outgoing.end(bundle); return; }
    if (incoming.method === 'GET') { outgoing.setHeader('content-type', 'text/html'); outgoing.end('<!doctype html><title>Owned survey renderer acceptance</title><button id="outside">Open survey</button>'); return; }
    try {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks); const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      requests.push({ key: headers.get('idempotency-key'), body: body.toString() });
      const result = await service.router.handle(new Request('http://localhost' + incoming.url, { method: incoming.method, headers, body }));
      if (denyAckNext && result.ok) { denyAckNext = false; outgoing.writeHead(503); outgoing.end('{}'); return; }
      if (dropNext && result.ok) { dropNext = false; incoming.socket.destroy(); return; }
      if (holdNext && result.ok) { holdNext = false; await new Promise(resolve => { release = resolve; }); }
      outgoing.writeHead(result.status, Object.fromEntries(result.headers)); outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.USERFN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage(); page.setDefaultTimeout(5000);
  await page.addInitScript(() => { Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }); });
  await page.goto('http://127.0.0.1:' + server.address().port);
  const setup = (actor, journal = false, expired = false, target = page) => target.evaluate(async ({ actor, questions, journal, expired }) => {
    const { UserFnClient } = await import('/sdk.js');
    globalThis.client = new UserFnClient({ apiKey: actor, endpoint: location.origin, surveyTimeoutMs: 10000, surveyMaxAttempts: 3, ...(journal ? { surveyJournal: { storageKey: typeof journal === 'string' ? journal : 'owned-reload' } } : {}) });
    client.identify('alice'); client.setSurveys([{ id: 'survey', enabled: true, title: 'Survey', questions, triggers: [{ type: 'event' }], caps: { global: journal ? 1 : 2 }, ...(expired ? { schedule: { endAt: 1 } } : {}) }]);
    await client.trigger('event', 'show');
  }, { actor, questions, journal, expired });
  const fill = async (text, target = page) => {
    assert.equal(await target.getByRole('button', { name: '0', exact: true }).count(), 0, 'CSAT defaults start at1');
    assert.equal(await target.getByRole('button', { name: '6', exact: true }).count(), 0, 'CSAT defaults end at5');
    await target.getByRole('button', { name: '5', exact: true }).click();
    await target.getByRole('button', { name: 'Next', exact: true }).click();
    await target.getByRole('combobox').selectOption('1');
    await target.getByRole('button', { name: 'Next', exact: true }).click();
    await target.getByRole('textbox').fill(text);
  };
  await page.locator('#outside').focus();
  await setup('browser');
  assert.equal(await page.getByRole('dialog').getAttribute('aria-modal'),'true');
  assert.equal(await page.getByRole('button',{name:'Close survey'}).evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.getByRole('button',{name:'Next',exact:true}).evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button',{name:'Close survey'}).evaluate(node=>node===document.activeElement),true);
  await page.locator('#outside').evaluate(node=>node.focus());
  assert.equal(await page.getByRole('button',{name:'Close survey'}).evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(),0);
  assert.equal(await page.locator('#outside').evaluate(node=>node===document.activeElement),true);
  await page.evaluate(()=>client.trigger('event','show'));
  await fill('original answers');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('not confirmed'));
  assert.equal(requests.length, 1, 'No automatic renderer retries');
  assert.equal((await query`SELECT count(*) AS count FROM userfn_survey_responses`.execute(database)).rows[0].count, 1);
  await page.getByRole('button', { name: 'Close survey' }).click(); await page.evaluate(() => client.trigger('event', 'show'));
  assert.ok((await page.locator('.userfn-modal').textContent()).includes('original answers'));
  await page.getByRole('button', { name: 'Retry submission', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent === 'Response saved.');
  assert.deepEqual(requests[0], requests[1], 'Lost receipt retry has identical key and body');
  assert.equal(JSON.parse(requests[0].body).answers[1].value, false, 'Choice retains boolean type');
  assert.equal((await query`SELECT count(*) AS count FROM userfn_survey_responses`.execute(database)).rows[0].count, 1);
  await page.getByRole('button', { name: 'Close survey' }).click();
  await setup('late'); await fill('late receipt'); holdNext = true;
  await page.evaluate(() => { const button = document.querySelector('.userfn-cta'); button.click(); button.click(); });
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent === 'Submitting your response…');
  const deadline = Date.now() + 5000; while (!release && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(release); assert.equal(requests.length, 3, 'Double click launches one request');
  await page.evaluate(() => { client.identify('bob'); client.setConsent({ messaging: false }); });
  assert.equal(await page.locator('.userfn-overlay').count(), 0);
  release(); release = undefined;
  await page.waitForFunction(() => [...client.surveyAttempts.values()].every(attempt => !attempt.pending));
  assert.equal(await page.locator('.userfn-overlay').count(), 0, 'Late response does not resurrect revoked UI');
  await page.evaluate(() => { client.setConsent({ messaging: true }); client.identify('alice'); return client.trigger('event', 'show'); });
  await page.getByRole('button', { name: 'Retry submission', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent === 'Response saved.');
  assert.equal(requests.length, 3, 'Known late receipt reconciles without another request');
  await page.reload(); await setup('browser'); await fill('later new attempt');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('not confirmed'));
  assert.equal((await query`SELECT count(*) AS count FROM userfn_survey_responses`.execute(database)).rows[0].count, 2, 'Service still enforces caps after client reload');
  await page.getByRole('button', { name: 'Close survey' }).click();
  const beforeLocal = requests.length;
  await page.evaluate(async () => {
    const { UserFnClient } = await import('/sdk.js');
    client = new UserFnClient({ apiKey: 'local-only' }); client.identify('local');
    client.setSurveys([{ id: 'empty', enabled: true, questions: [], triggers: [{ type: 'event' }] }]);
    await client.trigger('event', 'show');
  });
  assert.equal(await page.getByRole('button', { name: 'Submit', exact: true }).count(), 1, 'Empty surveys still require an explicit submit');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent === 'Response recorded locally.');
  assert.equal(requests.length, beforeLocal, 'Local mode does not claim or attempt server storage');
  await page.keyboard.press('Escape');
  await page.locator('#outside').focus();
  await page.evaluate(async()=>{
    client.setCampaigns([{id:'accessible',kind:'modal',enabled:true,content:{title:'Announcement',body:'Content',ctaText:'Done'},triggers:[{type:'event'}]}]);
    await client.trigger('event','modal');
  });
  assert.equal(await page.getByRole('dialog',{name:'Announcement'}).getAttribute('aria-modal'),'true');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.getByRole('button',{name:'Done',exact:true}).evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#outside').evaluate(node=>node===document.activeElement),true);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(async()=>{
    client.setCampaigns([{id:'toast',kind:'inbox-item',enabled:true,content:{body:'Toast'},triggers:[{type:'event'}]}]);
    await client.trigger('event','toast');
  });
  assert.equal(await page.locator('.userfn-toast').evaluate(node=>getComputedStyle(node).animationName),'none');
  await page.evaluate(()=>client.setConsent({messaging:false}));
  await page.locator('#outside').focus();
  assert.equal(await page.locator('#outside').evaluate(node=>node===document.activeElement),true,'dismissed dialog listeners must be removed');
  const campaignKeys = [];
  await page.route('**/messages/campaign/reserve', async route => {
    campaignKeys.push(route.request().headers()['idempotency-key']);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ campaignId: 'campaign', allowed: false, shown: false }) });
  });
  await page.evaluate(async () => {
    if (crypto.randomUUID !== undefined || typeof crypto.getRandomValues !== 'function') throw new Error('Capability fixture invalid');
    const { UserFnClient } = await import('/sdk.js');
    const messaging = new UserFnClient({ apiKey: 'browser', endpoint: location.origin, messaging: { storageKey: 'owned-compatibility', allowInsecureHttp: true } });
    messaging.identify('alice');
    messaging.setCampaigns([{ id: 'campaign', kind: 'modal', enabled: true, content: { body: 'once' }, triggers: [{ type: 'event' }], caps: { session: 1 } }]);
    await messaging.trigger('event', 'show');
  });
  assert.equal(campaignKeys.length, 1);
  assert.match(campaignKeys[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await page.evaluate(async()=>{
    const {UserFnClient}=await import('/sdk.js');
    client=new UserFnClient({apiKey:'feedback-browser',endpoint:location.origin,feedbackMaxAttempts:1});
    client.identify('feedback-owner');
    document.querySelector('#outside').focus(); client.openFeedbackWidget();
  });
  assert.equal(await page.getByRole('dialog',{name:'Send feedback'}).getAttribute('aria-modal'),'true');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.getByRole('button',{name:'Send Feedback',exact:true}).evaluate(node=>node===document.activeElement),true);
  await page.getByRole('textbox',{name:'Feedback title'}).fill('Original feedback');
  await page.getByRole('textbox',{name:'Feedback details'}).fill('Original details');
  const beforeFeedback=requests.length; denyAckNext=true;
  await page.getByRole('button',{name:'Send Feedback',exact:true}).click();
  await page.getByRole('button',{name:'Retry feedback',exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Feedback title'}).isDisabled(),true);
  assert.equal((await query`SELECT count(*) AS count FROM userfn_feedback`.execute(database)).rows[0].count,1);
  await page.getByRole('button',{name:'Retry feedback',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent==='Feedback sent.');
  assert.deepEqual(requests[beforeFeedback],requests[beforeFeedback+1]);
  assert.equal((await query`SELECT count(*) AS count FROM userfn_feedback`.execute(database)).rows[0].count,1);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#outside').evaluate(node=>node===document.activeElement),true);
  await page.evaluate(()=>client.openFeedbackWidget());
  await page.getByRole('textbox',{name:'Feedback title'}).fill('Late feedback');
  await page.getByRole('textbox',{name:'Feedback details'}).fill('Close while pending');
  holdNext=true; release=undefined;
  await page.getByRole('button',{name:'Send Feedback',exact:true}).click();
  for(let count=0;count<100&&!release;count++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(typeof release,'function');
  await page.evaluate(()=>client.identify('new-owner'));
  assert.equal(await page.getByRole('dialog').count(),0);
  release(); release=undefined;
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole('dialog').count(),0);
  await page.locator('#outside').focus();
  assert.equal(await page.locator('#outside').evaluate(node=>node===document.activeElement),true);
  for (const details of [true, false]) {
    await page.evaluate(async ({ branchQuestions, details }) => {
      const { UserFnClient } = await import('/sdk.js');
      client = new UserFnClient({ apiKey: 'branch-' + details, endpoint: location.origin });
      client.identify('branch'); client.setSurveys([{ id: 'branch', enabled: true, questions: branchQuestions, triggers: [{ type: 'event' }] }]);
      await client.trigger('event', 'show');
    }, { branchQuestions, details });
    await page.getByRole('combobox').selectOption(details ? '0' : '1');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    if (details) {
      await page.getByRole('textbox', { name: 'Branch details' }).fill('conditional answer');
    } else {
      assert.equal(await page.getByRole('textbox', { name: 'Branch details' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: '0', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: '8', exact: true }).count(), 0);
      await page.getByRole('button', { name: '7', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: '-2', exact: true }).click();
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent === 'Response saved.');
    const answers = JSON.parse(requests.at(-1).body).answers;
    assert.deepEqual(answers.map(answer => answer.questionId), ['path', details ? 'details' : 'effort', 'custom']);
    await page.keyboard.press('Escape');
  }
  const forged = await page.request.post('http://127.0.0.1:' + server.address().port + '/surveys/branch/responses', {
    headers: { authorization: 'Bearer forged-branch', 'idempotency-key': 'forged' },
    data: { answers: [{ questionId: 'path', value: false }, { questionId: 'details', value: 'hidden injected' }, { questionId: 'effort', value: 7 }, { questionId: 'custom', value: 0 }] },
  });
  assert.equal(forged.status(), 400, 'Service rejects answers to hidden questions');
  for (const answers of [
    [{ questionId: 'path', value: false }, { questionId: 'custom', value: 0 }],
    [{ questionId: 'path', value: false }, { questionId: 'effort', value: 8 }, { questionId: 'custom', value: 0 }],
    [{ questionId: 'path', value: true }, { questionId: 'details', value: 'ok' }, { questionId: 'custom', value: -3 }],
  ]) {
    const invalid = await page.request.post('http://127.0.0.1:' + server.address().port + '/surveys/branch/responses', {
      headers: { authorization: 'Bearer invalid-branch', 'idempotency-key': 'invalid' }, data: { answers },
    });
    assert.equal(invalid.status(), 400, 'Service enforces active required questions and scale bounds');
  }

  assert.equal((await query`SELECT count(*) AS count FROM userfn_survey_responses`.execute(database)).rows[0].count, 4);
  await page.reload();
  await setup('journal', true);
  await fill('survive reload');
  denyAckNext = true;
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('not confirmed'));
  const originalJournalRequest = requests.at(-1);
  await page.reload();
  await setup('journal', true, true);
  assert.ok((await page.locator('.userfn-modal').textContent()).includes('survive reload'));
  await page.getByRole('button', { name: 'Retry submission', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent === 'Response saved.');
  assert.deepEqual(requests.at(-1), originalJournalRequest, 'Reload recovery preserves key and body even after local schedule expiry');
  assert.equal((await query`SELECT count(*) AS count FROM userfn_survey_responses`.execute(database)).rows[0].count, 5);
  await page.reload(); await setup('journal', true);
  assert.equal(await page.getByRole('dialog').count(), 0, 'Accepted local count survives reload');
  const scopeError = await page.evaluate(async () => {
    const { UserFnClient } = await import('/sdk.js');
    const changed = new UserFnClient({ apiKey: 'other-journal', endpoint: location.origin, surveyJournal: { storageKey: 'owned-reload' } });
    changed.identify('alice');
    try { await changed.trigger('event', 'show'); return false; } catch { return true; }
  });
  assert.equal(scopeError, true, 'Credential scope changes cannot replay persisted answers');
  const peer = await page.context().newPage();
  try {
    await page.reload(); await peer.goto(page.url());
    await setup('cross-tabs', 'owned-cross-tabs');
    await setup('cross-tabs', 'owned-cross-tabs', false, peer);
    await fill('one response across tabs'); await fill('different stale answers', peer);
    const beforeTabs = requests.length;
    holdNext = true;
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    const deadline = Date.now() + 5000;
    while (!release && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(release);
    await peer.getByRole('button', { name: 'Submit', exact: true }).click();
    assert.equal(requests.length, beforeTabs + 1);
    release(); release = undefined;
    await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent === 'Response saved.');
    await peer.waitForFunction(() => document.querySelector('[role=status]')?.textContent === 'This survey is no longer active.');
    assert.equal(requests.length, beforeTabs + 1, 'Web Locks prevent a stale peer form sending a second key');
    assert.equal((await query`SELECT count(*) AS count FROM userfn_survey_responses`.execute(database)).rows[0].count, 6);
  } finally { release?.(); release = undefined; await peer.close(); }
  console.log(JSON.stringify({ passed: true, browser: await browser.version(), lostAckSameKey: true, withoutRandomUUID: true, persistedResponses: 6, crossTabJournal: true, conditionalBranches: true, cesAndCustomScale: true, epochFences: true, typedChoicesAndCsat: true, explicitLocalMode: true, keyboardDialogs: true, feedbackSameKeyRetry: true, reducedMotion: true, reloadJournal: true }));
} finally {
  release?.(); await browser?.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await adapter?.close(); await rm(directory, { recursive: true, force: true });
}
