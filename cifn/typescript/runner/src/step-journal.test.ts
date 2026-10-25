import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StepJournal, replayStepSnapshot, StepStatusReportingError } from './step-journal.js';
import { executeRemoteShellJob } from './remote-runner.js';
import { MAX_STEP_JOURNAL_BYTES, type StepEvent } from '@cifn/control-plane';
const paths: string[] = [];
const identity = { runId: 'run', runnerId: 'runner', dispatchId: 'dispatch', claimToken: 'claim-private', executionId: 'execution' };
const location = () => { const path = mkdtempSync(join(tmpdir(), 'cifn-step-events-')); paths.push(path); return path; };
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
it('persists before transport and read-only replay cannot overwrite concurrent owner events', async () => {
  const path = location(), journal = new StepJournal(path, identity);
  journal.append('step-0', 'running');
  const file = join(path, 'steps', readdirSync(join(path, 'steps'))[0]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  await expect(journal.deliver(async () => { throw new Error('lost ack'); })).rejects.toThrow('lost ack');
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const replay = replayStepSnapshot(path, identity, async () => { entered(); await gate; return { nextSequence: 2 }; });
  await ready;
  journal.append('step-0', 'success');
  const before = readFileSync(file); release(); await replay;
  expect(readFileSync(file).equals(before)).toBe(true);
  const events: StepEvent[] = [];
  await replayStepSnapshot(path, identity, async event => { events.push(event); return { nextSequence: event.sequence + 1 }; });
  expect(events.map(event => event.status)).toEqual(['running', 'success']);
});
it.each(['identity', 'sequence', 'digest', 'malformed', 'oversize'])('rejects %s before using transport credentials', async mode => {
  const path = location(), journal = new StepJournal(path, identity); journal.append('step-0', 'running');
  const file = join(path, 'steps', readdirSync(join(path, 'steps'))[0]);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (mode === 'identity') value.identity.claimToken = 'bad-secret';
  if (mode === 'sequence') value.events[0].sequence++;
  if (mode === 'digest') value.events[0].digest = 'bad';
  writeFileSync(file, mode === 'malformed' ? '{private' : mode === 'oversize' ? 'x'.repeat(MAX_STEP_JOURNAL_BYTES + 1) : JSON.stringify(value));
  const send = vi.fn(); await expect(replayStepSnapshot(path, identity, send)).rejects.toThrow('Step status could not be durably reported'); expect(send).not.toHaveBeenCalled();
});
it('bounds records and refuses invalid acknowledgements', async () => {
  const journal = new StepJournal(location(), identity);
  for (let index = 0; index < 100; index++) { journal.append(`step-${index}`, 'running'); journal.append(`step-${index}`, 'success'); }
  expect(() => journal.append('step-99', 'success')).toThrow(StepStatusReportingError);
  await expect(journal.deliver(async () => ({ nextSequence: 0 }))).rejects.toThrow(StepStatusReportingError);
});
it('halts before launching a shell when durable admission fails', async () => {
  const path = location(), journal = new StepJournal(path, identity);
  chmodSync(join(path, 'steps'), 0o500);
  try {
    await expect(executeRemoteShellJob({ runId: 'run', jobKey: 'job', jobSpec: { 'runs-on': 'default', steps: [{ run: `touch '${join(path, 'must-not-exist')}'` }] } }, undefined, undefined, undefined, undefined,
      async (key, status) => journal.append(key, status))).rejects.toThrow(StepStatusReportingError);
    expect(readdirSync(path)).toEqual(['steps']);
  } finally { chmodSync(join(path, 'steps'), 0o700); }
});
it('awaits observers and reports condition failure, skipped and ordinary terminal transitions', async () => {
  const states: string[] = [];
  const result = await executeRemoteShellJob({ runId: 'run', jobKey: 'job', jobSpec: { 'runs-on': 'default', steps: [
    { run: 'exit 0' }, { run: 'exit 8', if: 'failure()' }, { run: 'exit 0', if: 'invalid(' }, { run: 'exit 0' }, { run: 'exit 0', if: 'always()' },
  ] } }, undefined, undefined, undefined, undefined, async (key, status) => { await Promise.resolve(); states.push(key + ':' + status); });
  expect(result.status).toBe('failure');
  expect(states).toEqual(['step-0:running', 'step-0:success', 'step-1:skipped', 'step-2:failure', 'step-3:skipped', 'step-4:running', 'step-4:success']);
});
it('does not turn a rejected skipped-step observation into a fabricated failure event', async () => {
  const states: string[] = [];
  await expect(executeRemoteShellJob({ runId: 'run', jobKey: 'job', jobSpec: { 'runs-on': 'default', steps: [{ run: 'exit 99', if: 'failure()' }] } }, undefined, undefined, undefined, undefined,
    async (_key, status) => { states.push(status); throw new Error('observer persistence failed'); })).rejects.toThrow(StepStatusReportingError);
  expect(states).toEqual(['skipped']);
});
