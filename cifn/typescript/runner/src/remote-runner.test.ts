import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync } from 'node:fs';
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
