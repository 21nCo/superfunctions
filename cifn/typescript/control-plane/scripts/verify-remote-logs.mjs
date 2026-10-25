/** Real built runner, LogFn, control-plane HTTP and SQLite crash/reopen acceptance. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { RemoteRunner } from '../../runner/dist/index.mjs';
const require = createRequire(import.meta.url);
const { DatabaseStore, CIFN_STATE_TABLE, resolvePipelineDoc } = require('../dist/index.js');
const SQLite = require('better-sqlite3');
const { Kysely, SqliteDialect } = require('kysely');
const { kyselyAdapter } = await import('@superfunctions/db/adapters');
const directory = await mkdtemp(join(tmpdir(), 'cifn-log-acceptance-'));
const key = randomBytes(32).toString('base64');
const secret = 'configured-log-secret-ascii';
const token = 'local-registration';
const stateDirectory = join(directory, 'runner');
const witness = join(directory, 'witness');
const crashGate = join(directory, 'crash-release');
const crashDone = join(directory, 'crash-done');
const crashPid = join(directory, 'crash-pid');
let crashShellStarted = false;
let control, proxy, port = 0, output = '';
const children = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stop(child, signal = 'SIGTERM') {
  if (!child) return;
  if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill(signal);
  await child.exited;
}
async function waitCrashShellExit() {
  let pid;
  try { pid = Number(await readFile(crashPid, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  for (let i = 0; i < 800; i++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(20);
  }
  throw new Error('Owned crash fixture shell process did not exit; directory retained');
}
async function start() {
  const processChild = spawn(process.execPath, [fileURLToPath(new URL('../dist/server.js', import.meta.url))], {
    env: { ...process.env, PORT: String(port), CIFN_STORE_ADAPTER: 'sqlite', CIFN_SQLITE_PATH: join(directory, 'state.sqlite'), CIFN_STORE_ENCRYPTION_KEY: key,
      CIFN_RUNNER_REGISTRATION_TOKEN: token, CIFN_API_KEYS: secret, CIFN_WEBHOOK_SECRET: 'owned-signing', CIFN_PIPELINE_RESOLVER: 'git', CIFN_ALLOW_LOCAL_REPOSITORIES: 'true', CIFN_QUEUE_ADAPTER: 'memory', CIFN_ARTIFACTS_ADAPTER: 'memory', CIFN_SECRETS_ADAPTER: 'memory', CIFN_LOGS_ADAPTER: 'memory' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const child = { process: processChild, exited: once(processChild, 'exit') }; children.push(child);
  let ready;
  processChild.stdout.on('data', chunk => { output += chunk; const match = /listening on port (\d+)/.exec(String(chunk)); if (match) ready = Number(match[1]); });
  processChild.stderr.on('data', chunk => { output += chunk; });
  for (let i = 0; !ready && i < 200; i++) { if (processChild.exitCode !== null) throw new Error('Control startup failed: ' + output); await delay(50); }
  assert.ok(ready, 'control ready'); port = ready; return child;
}
async function data(path, body, credential = secret) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  assert.ok(res.ok, `${path}: ${res.status}`); const value = await res.json(); assert.equal(value.ok, true); return value.data;
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  const source = join(directory, 'checkout-source'), repository = join(directory, 'checkout-bare');
  await mkdir(source);
  const gitEnv = { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => execFileSync('git', args, { cwd: source, env: gitEnv, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const webhookDoc = JSON.stringify({ on: { push: { branches: ['main'] }, pull_request: { branches: ['main'] } }, jobs: { build: { 'runs-on': 'default', steps: [{ uses: 'checkout' }, { run: 'test "$(cat checkout-receipt)" = "owned exact commit"' }] } } });
  git('init', '-b', 'main'); await writeFile(join(source, 'checkout-receipt'), 'owned exact commit'); await writeFile(join(source, 'cifn.yml'), webhookDoc); git('add', '.'); git('commit', '-m', 'owned fixture');
  const checkoutSha = git('rev-parse', 'HEAD'); git('clone', '--bare', '--', source, repository);
  assert.deepEqual(await resolvePipelineDoc({ repo: repository, ref: checkoutSha }, { allowLocalRepositories: true }), { doc: webhookDoc, resolvedConfigPath: 'cifn.yml' });
  control = await start();
  const registered = await data('/api/v1/runners/register', { token });
  // Move the branch after recording the webhook SHA: both config and checkout must stay pinned.
  await writeFile(join(source, 'checkout-receipt'), 'wrong newer branch');
  await writeFile(join(source, 'cifn.yml'), 'invalid later config'); git('add', '.'); git('commit', '-m', 'later branch'); git('push', repository, 'main');
  const signedRepository = { id: 1, full_name: 'owned/repository', clone_url: repository };
  const signedPR = { action: 'synchronize', repository: signedRepository, pull_request: {
    head: { repo: signedRepository, ref: 'main', sha: checkoutSha }, base: { repo: signedRepository, ref: 'main' },
  } };
  const sendWebhook = async (payload, event = 'pull_request') => {
    const body = JSON.stringify(payload);
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/github`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event,
      'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'owned-signing').update(body).digest('hex') }, body, signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  };
  const skipped = await sendWebhook({ ...signedPR, pull_request: { ...signedPR.pull_request, base: { ...signedPR.pull_request.base, ref: 'other' } } });
  assert.equal(skipped.status, 200); assert.equal(skipped.body.data.skipped, true);
  const denied = await sendWebhook({ ...signedPR, pull_request: { ...signedPR.pull_request, head: { ...signedPR.pull_request.head, repo: { ...signedRepository, id: 2 } } } });
  assert.equal(denied.status, 403);
  const accepted = await sendWebhook(signedPR); assert.equal(accepted.status, 201);
  const webhookRunId = accepted.body.data.runId;
  await new RemoteRunner({ baseUrl: `http://127.0.0.1:${port}`, runnerId: registered.runnerId, runnerSecret: registered.runnerSecret, stateDirectory: join(directory, 'webhook-runner'), allowLocalRepositories: true }).tick();
  assert.equal((await data(`/api/v1/runs/${webhookRunId}`)).status, 'success');
  await stop(control); control = await start();
  const persistedWebhook = await data(`/api/v1/runs/${webhookRunId}`);
  assert.equal(persistedWebhook.status, 'success'); assert.equal(persistedWebhook.pipelineRef.ref, checkoutSha);

  let dropped = false, logsOffline = false, stepsOffline = false, firstBody, replayBody;
  const requests = [];
  proxy = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks); const text = body.toString();
      if (stepsOffline && req.url.endsWith('/step')) { res.writeHead(503); res.end('{}'); return; }
      if (req.url.endsWith('/logs')) {
        assert.ok(!text.includes(secret), 'Configured secret must not reach log transport'); requests.push(JSON.parse(text).packet);
        if (logsOffline) { res.writeHead(503); res.end('{}'); return; }
        if (!firstBody) firstBody = text; else if (JSON.parse(text).packet.sequence === 0) replayBody = text;
      }
      const upstream = await fetch(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: { Authorization: req.headers.authorization ?? '', 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
      const response = await upstream.text();
      if (!dropped && req.url.endsWith('/logs') && upstream.ok) { dropped = true; await stop(control, 'SIGKILL'); res.destroy(); return; }
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' }); res.end(response);
    } catch { res.writeHead(503); res.end('{}'); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const options = { baseUrl: `http://127.0.0.1:${proxy.address().port}`, runnerId: registered.runnerId, runnerSecret: registered.runnerSecret, stateDirectory, allowLocalRepositories: true };
  const js = `if(require('fs').readFileSync('checkout-receipt','utf8')!=='owned exact commit')throw Error('wrong checkout');require('fs').appendFileSync(${JSON.stringify(witness)},'once\\n');process.stdout.write('stdout '+process.env.TOKEN+'\\n');process.stderr.write('stderr '+process.env.TOKEN+'\\n');`;
  const input = { trigger: { type: 'workflow_dispatch' }, pipelineSpec: { on: { workflow_dispatch: {} }, env: { TOKEN: '${{ secrets.CIFN_API_KEYS }}' }, jobs: { build: { 'runs-on': 'default', steps: [{ uses: 'checkout', with: { repository, ref: checkoutSha } }, { run: `${quote(process.execPath)} -e ${quote(js)}` }] } } } };
  const run = await data('/api/v1/runs', input);
  const runId = run.runId ?? run.id; assert.ok(runId);
  await assert.rejects(new RemoteRunner(options).tick());
  assert.equal(dropped, true);
  control = await start();
  const before = await data(`/api/v1/runs/${runId}/jobs/build/logs`);
  assert.equal(before.transfer.status, 'pending'); assert.ok(before.lines.length > 0);
  const runner = new RemoteRunner(options); await runner.tick(); await runner.tick();
  assert.equal(replayBody, firstBody, 'Exact stable replay after lost ACK');
  const logs = await data(`/api/v1/runs/${runId}/jobs/build/logs`);
  assert.equal(logs.transfer.status, 'complete');
  const lines = logs.lines.map(line => line.line);
  assert.equal(lines.filter(line => line === 'stdout ***').length, 1);
  assert.equal(lines.filter(line => line === 'stderr ***').length, 1);
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.equal(await readFile(witness, 'utf8'), 'once\n');
  await stop(control); control = await start();
  assert.deepEqual(await data(`/api/v1/runs/${runId}/jobs/build/logs`), logs);
  logsOffline = true;
  const outageRun = await data('/api/v1/runs', input);
  const outageId = outageRun.runId ?? outageRun.id;
  await new RemoteRunner(options).tick();
  assert.equal((await data(`/api/v1/runs/${outageId}`)).status, 'success');
  assert.equal((await data(`/api/v1/runs/${outageId}/jobs/build/logs`)).transfer.status, 'pending');
  logsOffline = false;
  await new RemoteRunner(options).tick();
  assert.equal((await data(`/api/v1/runs/${outageId}/jobs/build/logs`)).transfer.status, 'complete');
  assert.equal(await readFile(witness, 'utf8'), 'once\nonce\n');
  // A shell waits on an owned gate: observing output must precede job completion.
  const liveGate = join(directory, 'live-gate');
  const liveJs = `const fs=require('fs');process.stdout.write('live stdout '+process.env.TOKEN.slice(0,8));setTimeout(()=>{process.stdout.write(process.env.TOKEN.slice(8)+'\\n');process.stderr.write('live stderr '+process.env.TOKEN+'\\n');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(liveGate)})){clearInterval(timer);process.exit(0);}},20);setTimeout(()=>process.exit(9),15000);},350);`;
  const liveInput = structuredClone(input);
  liveInput.pipelineSpec.jobs.build.steps = [{ run: `${quote(process.execPath)} -e ${quote(liveJs)}` }];
  const liveRun = await data('/api/v1/runs', liveInput);
  const liveId = liveRun.runId ?? liveRun.id;
  const liveExecution = new RemoteRunner(options).tick();
  // Observe rejection promptly but still await execution in finally.
  void liveExecution.catch(() => {});
  try {
    let streamed;
    for (let i = 0; i < 150; i++) {
      streamed = await data(`/api/v1/runs/${liveId}/jobs/build/logs`);
      if (['live stdout ***', 'live stderr ***'].every(expected => streamed.lines.some(line => line.line === expected))) break;
      await delay(50);
    }
    assert.ok(streamed.lines.some(line => line.line === 'live stdout ***'), 'stdout available before shell exits');
    assert.ok(streamed.lines.some(line => line.line === 'live stderr ***'), 'stderr available before shell exits');
    assert.equal(streamed.transfer.status, 'pending');
    assert.equal((await data(`/api/v1/runs/${liveId}`)).status, 'running');
    assert.ok(!JSON.stringify(streamed).includes(secret));
  } finally { await writeFile(liveGate, 'release'); await liveExecution; }
  const liveLogs = await data(`/api/v1/runs/${liveId}/jobs/build/logs`);
  assert.equal(liveLogs.transfer.status, 'complete');
  assert.equal(liveLogs.lines.filter(line => line.line === 'live stdout ***').length, 1);
  assert.equal(liveLogs.lines.filter(line => line.line === 'live stderr ***').length, 1);
  assert.ok(!JSON.stringify(requests).includes('live stdout '+secret.slice(0,8)), 'partial secret prefix withheld across captures');
  // Kill a real runner after its line checkpoint but before any log acknowledgement.
  logsOffline = true; stepsOffline = true;
  const crashWitness = join(directory, 'crash-executions');
  const crashJs = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(crashPid)},String(process.pid));fs.appendFileSync(${JSON.stringify(crashWitness)},'once\\n');process.on('exit',code=>fs.writeFileSync(${JSON.stringify(crashDone)},JSON.stringify({code,pid:process.pid,at:Date.now()})));process.stdout.write('started stdout '+process.env.TOKEN+'\\n');process.stderr.write('started stderr '+process.env.TOKEN+'\\n');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(crashGate)})){clearInterval(timer);process.exit(0)}},20);setTimeout(()=>process.exit(9),15000);`;
  const crashInput = structuredClone(input);
  crashInput.pipelineSpec.jobs.build.steps = [{ run: `${quote(process.execPath)} -e ${quote(crashJs)}` }];
  const crashRun = await data('/api/v1/runs', crashInput); const crashId = crashRun.runId ?? crashRun.id;
  const childCode = `import {RemoteRunner} from ${JSON.stringify(new URL('../../runner/dist/index.mjs', import.meta.url).href)}; await new RemoteRunner(${JSON.stringify(options)}).tick();`;
  const childProcess = spawn(process.execPath, ['--input-type=module', '-e', childCode], { stdio: ['ignore', 'pipe', 'pipe'] });
  const crashChild = { process: childProcess, exited: once(childProcess, 'exit') }; children.push(crashChild);
  childProcess.stdout.on('data', chunk => { output += chunk; }); childProcess.stderr.on('data', chunk => { output += chunk; });
  let startedFile, startedSpool;
  for (let i = 0; i < 150; i++) {
    for (const name of await readdir(join(stateDirectory, 'logs'))) {
      if (!name.endsWith('.json')) continue;
      const value = JSON.parse(await readFile(join(stateDirectory, 'logs', name), 'utf8'));
      if (value.identity.runId !== crashId) continue;
      crashShellStarted = true;
      if (['started stdout ***', 'started stderr ***'].every(line => value.packets.some(packet => packet.events.some(event => event.msg === line)))) {
        startedFile = join(stateDirectory, 'logs', name); startedSpool = value;
      }
    }
    if (startedFile) break;
    await delay(50);
  }
  assert.ok(startedFile, 'started runner persisted both redacted lines before being killed');
  assert.equal(startedSpool.acknowledged, 0);
  await stop(crashChild, 'SIGKILL');
  await writeFile(crashGate, 'release');
  for (let i = 0; i < 150; i++) { try { await stat(crashDone); break; } catch { await delay(20); } }
  assert.ok(await stat(crashDone), 'owned orphan shell exited through its release gate');
  await waitCrashShellExit();
  const spoolBefore = await readFile(startedFile);
  const stepFile = join(stateDirectory, 'steps', startedFile.split('/').at(-1));
  const stepBefore = await readFile(stepFile);
  assert.equal((await data(`/api/v1/runs/${crashId}`)).jobs[0].steps[0].status, 'pending');
  assert.equal((await data(`/api/v1/runs/${crashId}/jobs/build/logs`)).lines.length, 0);
  await stop(control); control = await start(); logsOffline = false; stepsOffline = false;
  await new RemoteRunner(options).tick(); await new RemoteRunner(options).tick();
  const recovered = await data(`/api/v1/runs/${crashId}/jobs/build/logs`);
  assert.equal(recovered.transfer.status, 'pending');
  for (const line of ['started stdout ***', 'started stderr ***']) assert.equal(recovered.lines.filter(entry => entry.line === line).length, 1);
  assert.equal((await data(`/api/v1/runs/${crashId}`)).status, 'running');
  assert.equal((await data(`/api/v1/runs/${crashId}`)).jobs[0].steps[0].status, 'running');
  assert.deepEqual(await readFile(stepFile), stepBefore, 'recovery never rewrites step journal or infers terminal status');
  assert.equal(await readFile(crashWitness, 'utf8'), 'once\n');
  assert.deepEqual(await readFile(startedFile), spoolBefore, 'recovery never writes stale spool ACKs or status');
  const journalEntries = await Promise.all((await readdir(stateDirectory)).filter(name => name.endsWith('.json')).map(name => readFile(join(stateDirectory, name), 'utf8').then(JSON.parse)));
  const retained = journalEntries.find(entry => entry.runId === crashId);
  assert.equal(retained.phase, 'started'); assert.equal(retained.result, undefined); assert.equal(retained.logOutcome, undefined);
  await stop(control); control = undefined;
  const exitBytes = await readFile(crashDone);
  const observedExit = JSON.parse(exitBytes.toString());
  assert.equal(observedExit.code, 0); assert.equal(observedExit.pid, Number(await readFile(crashPid, 'utf8')));
  // This owned fixture has independently observed exit; production callers must supply their own evidence.
  const native = new SQLite(join(directory, 'state.sqlite')); native.pragma('journal_mode = WAL'); native.pragma('synchronous = FULL');
  const sql = new Kysely({ dialect: new SqliteDialect({ database: native }) });
  let decision;
  try {
    const store = await DatabaseStore.open({ database: kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { [CIFN_STATE_TABLE]: CIFN_STATE_TABLE } }), encryptionKey: Buffer.from(key, 'base64') });
    const snapshot = await store.inspectExecution(crashId, retained.dispatchId);
    assert.equal(snapshot.runStatus, 'running'); assert.equal(snapshot.executionId, retained.executionId);
    decision = { decisionId: 'owned-exit-decision', expectedFingerprint: snapshot.fingerprint, executionId: snapshot.executionId, actorId: 'owned-fixture-operator', ownerStopped: true,
      evidence: { kind: 'observed-owner-exit', referenceId: 'owned-shell-exit', digest: createHash('sha256').update(exitBytes).digest('hex'), observedAt: observedExit.at },
      action: 'complete', result: { status: 'success', steps: [{ stepKey: 'step-0', status: 'success' }] } };
    const receipt = await store.adjudicateExecution(crashId, retained.dispatchId, decision);
    assert.deepEqual(await store.adjudicateExecution(crashId, retained.dispatchId, decision), receipt);
    assert.equal((await store.getRun(crashId)).status, 'success');
  } finally { await sql.destroy(); }
  control = await start();
  assert.equal((await data(`/api/v1/runs/${crashId}`)).status, 'success');
  await new RemoteRunner(options).tick(); await new RemoteRunner(options).tick();
  assert.equal(await readFile(crashWitness, 'utf8'), 'once\n', 'operator adjudication never reexecutes a shell');
  assert.deepEqual(await readFile(stepFile), stepBefore, 'operator decision does not rewrite runner evidence');
  await stop(control); control = undefined;
  async function inspect(path) {
    for (const name of await readdir(path)) {
      const file = join(path, name); if ((await stat(file)).isDirectory()) await inspect(file);
      else assert.ok(!(await readFile(file)).includes(Buffer.from(secret)), `No configured secret persisted: ${name}`);
    }
  }
  await inspect(directory); assert.ok(!output.includes(secret));
  console.log(JSON.stringify({ passed: true, localBareRepositoryCheckout: true, actualPinnedPipelineResolution: true, signedPullRequestPinnedCheckout: true, checkoutReplayWithoutReexecution: true, killedRunnerLogRecovery: true, killedRunnerStepRecovery: true, startedExecutionInitiallyUncertain: true, explicitOwnedExitAdjudication: true, noExecutionReplay: true, readonlyReplay: true, liveBeforeCompletion: true, streamedSecretBoundary: true, transportRequests: requests.length, retrievedLines: logs.lines.length, transfer: logs.transfer.status, executionCount: 2, logOnlyOutageRecovered: true, sqliteReopen: true, configuredSecretAbsent: true }));
} finally {
  const failures = [];
  try { await writeFile(crashGate, 'release'); } catch (error) { failures.push(error); }
  for (const child of children) { try { await stop(child); } catch (error) { failures.push(error); } }
  try { if (crashShellStarted) await waitCrashShellExit(); } catch (error) { failures.push(error); }
  try { if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); } } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Owned fixture cleanup incomplete; directory retained');
  await rm(directory, { recursive: true, force: true });
}
