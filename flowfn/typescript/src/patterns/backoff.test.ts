import { describe, it, expect } from 'vitest';
import { calculateBackoff } from './backoff.js';
import { createFlow } from '../core/flow-fn.js';

describe('backoff strategies', () => {
  it('bounds exponential overflow and respects a zero maximum', () => {
    expect(calculateBackoff(2000, { type: 'exponential', delay: 1, maxDelay: 100 })).toBe(100);
    expect(calculateBackoff(2000, { type: 'exponential', delay: 0 })).toBe(0);
    expect(calculateBackoff(1, { type: 'fixed', delay: 10, maxDelay: 0 })).toBe(0);
  });
  it('rejects malformed options and invalid custom delays', () => {
    expect(() => calculateBackoff(1, { type: 'fixed', delay: -1 })).toThrow();
    expect(() => calculateBackoff(1, { type: 'custom', delay: 1 })).toThrow('strategy name');
    expect(() => calculateBackoff(1, { type: 'custom', delay: 1, strategy: 'rate' })).toThrow('Missing');
    expect(() => calculateBackoff(1, { type: 'custom', delay: 1, strategy: 'rate' }, () => NaN)).toThrow('finite');
  });
  it('resolves serialized names using the processing queue and isolates callback mutations', async () => {
    const flow = createFlow({ adapter: 'memory' });
    const seen: unknown[] = [];
    const queue = flow.queue('custom', { backoffStrategies: { service: (attempt, error, job) => {
      seen.push([attempt, error.message, job.data]);
      job.opts.attempts = 100;
      return 1;
    } } });
    try {
      const job = await queue.add('request', { id: 42 }, { attempts: 2, backoff: { type: 'custom', delay: 0, strategy: 'service' } });
      queue.process(async () => { throw new Error('busy'); });
      await queue.drain();
      expect(seen).toEqual([[1, 'busy', { id: 42 }]]);
      expect((await queue.getJob(job.id))?.state).toBe('failed');
      expect((await queue.getJob(job.id))?.attemptsMade).toBe(2);
    } finally { await flow.close(); }
  });
  it.each(['missing', 'invalid', 'throws'])('terminally persists %s strategy failures without stranding active jobs', async (mode) => {
    const flow = createFlow({ adapter: 'memory' });
    const queue = flow.queue('broken', { backoffStrategies: {
      invalid: () => -1,
      throws: () => { throw new Error('strategy unavailable'); },
    } });
    try {
      const job = await queue.add('request', {}, { attempts: 3, backoff: { type: 'custom', delay: 1, strategy: mode } });
      queue.process(async () => { throw new Error('original'); });
      await queue.drain();
      const persisted = await queue.getJob(job.id);
      expect(persisted?.state).toBe('failed');
      expect(persisted?.attemptsMade).toBe(1);
      expect(persisted?.failedReason).toContain('Backoff failed:');
      expect(persisted?.failedReason).toContain('original');
    } finally { await flow.close(); }
  });
});
