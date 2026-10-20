import { spawn } from 'node:child_process';
import { executeOwnedShell } from './executor/owned-shell.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaimJournal } from './claim-journal.js';
import { RemoteRunner, executeRemoteShellJob } from './remote-runner.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const value = mkdtempSync(join(tmpdir(), 'cifn-journal-')); directories.push(value); return value; }
describe('durable runner journal', () => {
  it('preserves initial execution ownership, private modes and exclusive started markers across reopen', () => {
    const path = directory(); let journal = new ClaimJournal(path);
    const entry = { version: 1 as const, phase: 'prepared' as const, runnerId: 'runner', runId: 'run', dispatchId: 'dispatch', claimToken: 'claim', executionId: 'owner' };
    expect(journal.save(entry, true)).toEqual(entry);
    expect(journal.save({ ...entry, executionId: 'competitor' }, true)).toEqual(entry);
    expect(journal.markStarted(entry)).toBe(true);
    expect(journal.markStarted(entry)).toBe(false);
    journal = new ClaimJournal(path);
    expect(journal.hasStarted(entry.dispatchId)).toBe(true);
    expect(journal.get(entry.dispatchId)?.phase).toBe('started');
    expect(statSync(path).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(path)) expect(statSync(join(path, name)).mode & 0o777).toBe(0o600);
    const result = { status: 'success' as const, steps: [{ stepKey: 'step-0', status: 'success' as const }] };
    journal.save({ ...entry, phase: 'completed', result });
    expect(new ClaimJournal(path).list()).toEqual([{ ...entry, phase: 'completed', result }]);
    expect(readdirSync(path).some(name => name.endsWith('.tmp'))).toBe(false);
    expect(readFileSync(join(path, readdirSync(path).find(name => name.endsWith('.json'))!), 'utf8')).not.toContain('env');
  });
});

it('executes actual shell work with prepared environment but without inherited runner credentials', async () => {
  const previous = process.env.CIFN_RUNNER_SECRET; process.env.CIFN_RUNNER_SECRET = 'must-not-inherit';
  try {
    const result = await executeRemoteShellJob({ runId: 'run', jobKey: 'build', env: { TOKEN: 'prepared' }, jobSpec: {
      'runs-on': 'default', steps: [{ run: 'test "$TOKEN" = prepared && test -z "$CIFN_RUNNER_SECRET"' }],
    } });
    expect(result).toEqual({ status: 'success', steps: [{ stepKey: 'step-0', status: 'success' }] });
    expect(await executeRemoteShellJob({ runId: 'run', jobKey: 'build', jobSpec: { 'runs-on': 'default', steps: [{ run: 'exit 7' }] } })).toEqual({ status: 'failure', steps: [{ stepKey: 'step-0', status: 'failure' }] });
  } finally { if (previous === undefined) delete process.env.CIFN_RUNNER_SECRET; else process.env.CIFN_RUNNER_SECRET = previous; }
});

it('fails unsupported provider steps explicitly without fabricated success', async () => {
  expect(await executeRemoteShellJob({ runId: 'run', jobKey: 'build', jobSpec: { 'runs-on': 'default', steps: [{ uses: 'artifact/upload' }] } })).toEqual({ status: 'failure', steps: [{ stepKey: 'step-0', status: 'failure' }] });
});

it('retains permanently rejected results for reconciliation without blocking later polling', async () => {
  const path = directory();
  const journal = new ClaimJournal(path);
  journal.save({ version: 1, phase: 'completed', runnerId: 'runner', runId: 'run', dispatchId: 'dispatch', claimToken: 'claim', executionId: 'owner', result: { status: 'success', steps: [{ stepKey: 'step-0', status: 'success' }] } });
  const requests: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input); requests.push(url);
    if (url.endsWith('/complete')) return new Response('{}', { status: 409 });
    return new Response(JSON.stringify({ ok: true, data: url.endsWith('/resume') ? { claims: [] } : { job: null } }), { status: 200 });
  };
  const runner = new RemoteRunner({ baseUrl: 'http://localhost', runnerId: 'runner', runnerSecret: 'secret', stateDirectory: path, fetch: fetcher });
  await runner.tick(); await runner.tick();
  expect(journal.get('dispatch')?.phase).toBe('reconciliation');
  expect(requests.filter(url => url.endsWith('/complete'))).toHaveLength(1);
  expect(requests.filter(url => url.endsWith('/heartbeat'))).toHaveLength(2);
});


it('cancels an owned SIGTERM-resistant descendant without later steps or killing an unrelated process', async () => {
  const path = directory(); const witness = join(path, 'witness'); const ready = join(path, 'ready');
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const controller = new AbortController();
  const quote = (value: string) => "'" + value.split("'").join("'\\''") + "'";
  const script = `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');process.on('SIGTERM',()=>{});require('fs').closeSync(1);require('fs').closeSync(2);setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(witness)},'late'),4000);setInterval(()=>{},1000);`;
  try {
    const execution = executeRemoteShellJob({ runId: 'run', jobKey: 'job', jobSpec: { 'runs-on': 'default', steps: [
      { run: `${quote(process.execPath)} -e ${quote(script)} & wait` }, { run: `echo later > ${quote(witness)}` },
    ] } }, controller.signal);
    for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(existsSync(ready)).toBe(true); controller.abort();
    const result = await execution;
    expect(result.steps.map(step => step.status)).toEqual(['failure', 'skipped']);
    expect(existsSync(witness)).toBe(false);
    expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
  } finally { sentinel.kill('SIGKILL'); }
}, 15_000);

it('does not spawn a shell if cancellation was already observed', async () => {
  const path = directory(); const witness = join(path, 'witness');
  const controller = new AbortController(); controller.abort();
  expect((await executeOwnedShell(`touch "${witness}"`, path, process.env, controller.signal)).exitCode).toBe(1);
  expect(existsSync(witness)).toBe(false);
});


it.each(['before-ack', 'ack-race', 'before-start'])('records cancellation without spawning in the %s race', async mode => {
  const path = directory(); const witness = join(path, 'witness');
  let statusCalls = 0; let offered = false; let stopped = 0; let acknowledged = 0;
  const payload = { runId: 'run', jobKey: 'job', dispatchId: 'dispatch', claimToken: 'token', jobSpec: { 'runs-on': 'default', steps: [{ run: `touch "${witness}"` }] } };
  const fetcher: typeof fetch = async input => {
    const url = String(input); let data: unknown;
    if (url.endsWith('/resume')) data = { claims: [] };
    else if (url.endsWith('/heartbeat')) { data = { job: offered ? null : payload }; offered = true; }
    else if (url.endsWith('/status')) { statusCalls++; data = { cancelRequested: mode === 'before-ack' || statusCalls > 1 }; }
    else if (url.endsWith('/ack')) { acknowledged++; if (mode === 'ack-race') return new Response('{}', { status: 409 }); data = { acknowledged: true }; }
    else if (url.endsWith('/stopped')) { stopped++; data = { stopped: true }; }
    else throw Error('Unexpected completion');
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  };
  await new RemoteRunner({ baseUrl: 'http://localhost', runnerId: 'runner', runnerSecret: 'secret', stateDirectory: path, fetch: fetcher }).tick();
  expect(existsSync(witness)).toBe(false);
  expect(new ClaimJournal(path).hasStarted('dispatch')).toBe(true);
  expect(new ClaimJournal(path).get('dispatch')?.phase).toBe('finished');
  expect(stopped).toBe(1); expect(acknowledged).toBe(mode === 'before-ack' ? 0 : 1);
});

it('retries a lost cancellation receipt after journal reopen without executing again', async () => {
  const path = directory(); const journal = new ClaimJournal(path);
  const entry = { version: 1 as const, phase: 'cancelled' as const, runnerId: 'runner', runId: 'run', dispatchId: 'dispatch', claimToken: 'claim', executionId: 'owner' };
  journal.save(entry);
  let attempts = 0;
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url.endsWith('/stopped') && attempts++ === 0) throw Error('Lost response');
    return new Response(JSON.stringify({ ok: true, data: url.endsWith('/resume') ? { claims: [] } : { job: null } }));
  };
  const options = { baseUrl: 'http://localhost', runnerId: 'runner', runnerSecret: 'secret', stateDirectory: path, fetch: fetcher };
  await expect(new RemoteRunner(options).tick()).rejects.toThrow('Lost response');
  expect(journal.get('dispatch')?.phase).toBe('cancelled');
  await new RemoteRunner(options).tick();
  expect(journal.get('dispatch')?.phase).toBe('finished'); expect(attempts).toBe(2);
});


it('does not interpret an in-flight observation failure as cancellation', async () => {
  const path = directory(); let offered = false; let statuses = 0; let completions = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); let data: unknown = {};
    if (url.endsWith('/resume')) data = { claims: [] };
    else if (url.endsWith('/heartbeat')) {
      data = { job: offered ? null : { runId: 'run', jobKey: 'job', dispatchId: 'dispatch', claimToken: 'token', jobSpec: { 'runs-on': 'default', steps: [{ run: 'sleep 0.1; true' }] } } }; offered = true;
    } else if (url.endsWith('/status')) { if (++statuses > 2) throw Error('Temporary transport loss'); data = { cancelRequested: false }; }
    else if (url.endsWith('/complete')) {
      completions++; expect(JSON.parse(String(init?.body)).result.status).toBe('success');
    } else if (url.endsWith('/stopped')) throw Error('Must not acknowledge cancellation');
    return new Response(JSON.stringify({ ok: true, data }));
  };
  await new RemoteRunner({ baseUrl: 'http://localhost', runnerId: 'runner', runnerSecret: 'secret', stateDirectory: path, fetch: fetcher }).tick();
  expect(completions).toBe(1); expect(new ClaimJournal(path).get('dispatch')?.phase).toBe('finished');
});


it('does not acknowledge stopped if another process wins execution ownership during a pre-start cancellation check', async () => {
  const path = directory(); const journal = new ClaimJournal(path); let offered = false; let stopped = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); let data: unknown = {};
    if (url.endsWith('/resume')) data = { claims: [] };
    else if (url.endsWith('/heartbeat')) {
      data = { job: offered ? null : { runId: 'run', jobKey: 'job', dispatchId: 'dispatch', claimToken: 'token', jobSpec: { 'runs-on': 'default', steps: [{ run: 'true' }] } } }; offered = true;
    } else if (url.endsWith('/status')) {
      const entry = JSON.parse(String(init?.body));
      expect(journal.markStarted(entry)).toBe(true);
      data = { cancelRequested: true };
    } else if (url.endsWith('/stopped')) { stopped++; }
    return new Response(JSON.stringify({ ok: true, data }));
  };
  await new RemoteRunner({ baseUrl: 'http://localhost', runnerId: 'runner', runnerSecret: 'secret', stateDirectory: path, fetch: fetcher }).tick();
  expect(stopped).toBe(0); expect(journal.get('dispatch')?.phase).toBe('started');
});
