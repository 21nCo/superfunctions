import { describe, expect, it } from 'vitest';
import { captureLifecycle, emptyLifecycle, LIFECYCLE_MAX_EVENTS } from './lifecycle.js';
import { createRunRecord } from '../store/records.js';
import { deliverLifecycleEvent } from './dispatcher.js';
const run = () => createRunRecord({ trigger: { type: 'workflow_dispatch' }, pipelineSpec: { name: 'test', on: { workflow_dispatch: {} }, jobs: { privatekey: { 'runs-on': 'default', steps: [{ run: 'never executed' }] } } } });
describe('bounded lifecycle events', () => {
  it('excludes pipeline content and masks secret-valued job keys', () => {
    const before = run(); const after = structuredClone(before); after.jobs[0].status = 'running';
    const ledger = emptyLifecycle(); captureLifecycle('fixture', ledger, before, after, ['privatekey']);
    expect(ledger.records[0].event.jobKey).toBe('***');
    expect(JSON.stringify(ledger)).not.toContain('never executed');
  });
  it('orders terminal children before their terminal parents', () => {
    const before = run(); const after = structuredClone(before); after.status = 'success'; after.jobs[0].status = 'success'; after.jobs[0].steps[0].status = 'success';
    const ledger = emptyLifecycle(); captureLifecycle('fixture', ledger, before, after, []);
    expect(ledger.records.map(record => record.event.type)).toEqual(['step.completed', 'job.completed', 'run.status_changed']);
  });
  it('rejects event admission at capacity while allowing receipt-only mutations', () => {
    const before = run(); const ledger = emptyLifecycle(); captureLifecycle('fixture', ledger, undefined, before, []);
    ledger.records = Array.from({ length: LIFECYCLE_MAX_EVENTS }, () => structuredClone(ledger.records[0]));
    expect(() => captureLifecycle('fixture', ledger, before, before, [])).not.toThrow();
    const after = structuredClone(before); after.status = 'running';
    expect(() => captureLifecycle('fixture', ledger, before, after, [])).toThrow('retention capacity');
  });
  it('observes sync and async sink failure, flush failure, and actual async completion', async () => {
    const ledger = emptyLifecycle(); captureLifecycle('fixture', ledger, undefined, run(), []);
    const event = ledger.records[0].event;
    await expect(deliverLifecycleEvent(event, () => { throw Error('private'); })).rejects.toThrow('reconciliation');
    await expect(deliverLifecycleEvent(event, async () => { throw Error('private'); })).rejects.toThrow('reconciliation');
    const sink = Object.assign(() => {}, { flush: async () => { throw Error('private'); } });
    await expect(deliverLifecycleEvent(event, sink)).rejects.toThrow('reconciliation');
    let oversizedSends = 0;
    await expect(deliverLifecycleEvent({ ...event, jobKey: 'x'.repeat(100_000) }, () => { oversizedSends++; })).rejects.toThrow('reconciliation');
    expect(oversizedSends).toBe(0);
    let release!: () => void; let completed = false;
    const pending = deliverLifecycleEvent(event, () => new Promise<void>(resolve => { release = resolve; })).then(() => { completed = true; });
    await Promise.resolve(); expect(completed).toBe(false); release(); await pending; expect(completed).toBe(true);
  });
});
