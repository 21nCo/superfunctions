import { expect, it, vi } from 'vitest';
import { Logger } from './logger.js';
it('reports pipeline and synchronous sink failures through inherited hook', () => {
  const onError = vi.fn();
  const stage = () => { throw new Error('stage failure'); };
  const sink = () => { throw new Error('sink failure'); };
  const logger = new Logger({ name: 'parent', pipeline: [stage], sinks: [sink], onError });
  expect(() => logger.child({ name: 'child' }).info('message')).not.toThrow();
  expect(onError.mock.calls.map(([, context]) => context)).toEqual([{ stage: 'stage' }, { sink: 'sink' }]);
});
it('reports async sink failure and preserves explicit flush rejection', async () => {
  const error = new Error('delivery failure');
  const onError = vi.fn();
  const sink = async () => { throw error; };
  const logger = new Logger({ name: 'test', sinks: [sink], onError });
  logger.info('message');
  await expect(logger.flush()).rejects.toBe(error);
  expect(onError).toHaveBeenCalledWith(error, { sink: 'sink' });
});
it('contains throwing and reentrant callbacks', () => {
  let calls = 0;
  const logger = new Logger({ name: 'test', sinks: [() => { throw Error('sink'); }], onError: () => {
    calls++;
    logger.info('recursive error report');
    throw Error('hook');
  } });
  expect(() => logger.info('message')).not.toThrow();
  expect(calls).toBe(1);
});
it('reports flush failure while still rejecting the explicit flush', async () => {
  const error = new Error('flush failure');
  const sink = Object.assign(() => {}, { flush: async () => { throw error; } });
  const onError = vi.fn();
  const logger = new Logger({ name: 'test', sinks: [sink], onError });
  await expect(logger.flush()).rejects.toBe(error);
  expect(onError).toHaveBeenCalledWith(error, { sink: 'unknown' });
});
