import { expect, it, vi } from 'vitest';
import { registerProcessHandlers } from './process-handlers.js';
import type { Logger } from '../core/logger.js';
it.each(['SIGTERM', 'SIGINT'] as const)('drains before exit on %s and adds no undelivered success event', async signal => {
  let release!: () => void;
  const info = vi.fn();
  const flush = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const before = process.listenerCount(signal);
  const cleanup = registerProcessHandlers({ info, flush } as unknown as Logger);
  try {
    const handler = process.listeners(signal).at(-1) as () => Promise<void>;
    const pending = handler();
    await handler();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    release();
    await pending;
    expect(exit).toHaveBeenCalledWith(0);
    expect(info).toHaveBeenCalledTimes(1);
  } finally { cleanup(); exit.mockRestore(); }
  expect(process.listenerCount(signal)).toBe(before);
});
it('exits unsuccessfully when delivery fails', async () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const cleanup = registerProcessHandlers({ info: vi.fn(), flush: async () => { throw Error('offline'); } } as unknown as Logger);
  try {
    await (process.listeners('SIGTERM').at(-1) as () => Promise<void>)();
    expect(exit).toHaveBeenCalledWith(1);
  } finally { cleanup(); exit.mockRestore(); stderr.mockRestore(); }
});
