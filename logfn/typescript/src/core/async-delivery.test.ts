import { describe, expect, it, vi } from 'vitest';
import { Logger } from './logger.js';
import type { Sink } from '../types.js';
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
describe('logger delivery ownership', () => {
  it('joins child calls before flushing sinks', async () => {
    const release = gate();
    const received: string[] = [];
    const sink: Sink = async events => { await release.promise; received.push(events[0].name); };
    sink.flush = async () => { expect(received).toEqual(['child']); };
    const parent = new Logger({ name: 'parent', sinks: [sink] });
    parent.child({ name: 'child' }).info('accepted');
    let finished = false;
    const pending = parent.flush().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    release.resolve();
    await pending;
  });
  it('reports completed background rejection after all hooks finish', async () => {
    const debug = vi.spyOn(console, 'error').mockImplementation(() => {});
    const flushed: string[] = [];
    const broken: Sink = async () => { throw Error('delivery failed'); };
    broken.flush = async () => { flushed.push('broken'); };
    const healthy: Sink = () => {};
    healthy.flush = async () => { await Promise.resolve(); flushed.push('healthy'); };
    try {
      const logger = new Logger({ name: 'test', sinks: [broken, healthy] });
      logger.info('message');
      await Promise.resolve();
      await expect(logger.flush()).rejects.toThrow('delivery failed');
      expect(flushed).toEqual(['broken', 'healthy']);
      await expect(logger.flush()).resolves.toBeUndefined();
    } finally { debug.mockRestore(); }
  });
  it('waits for healthy hooks even when another hook throws synchronously', async () => {
    const release = gate();
    const bad: Sink = () => {};
    bad.flush = () => { throw Error('flush failed'); };
    const healthy: Sink = () => {};
    healthy.flush = () => release.promise;
    const logger = new Logger({ name: 'test', sinks: [bad, healthy] });
    let settled = false;
    const pending = logger.flush().finally(() => { settled = true; });
    const assertion = expect(pending).rejects.toThrow('flush failed');
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await assertion;
  });
});
