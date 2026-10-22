import { expect, it, vi } from 'vitest';
import { createLogsAdapter, LogFnLogsAdapter } from './logfn.js';
it('rejects the unsupported standalone LogFn HTTP configuration without contacting fictional routes', () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  try {
    expect(() => createLogsAdapter({ type: 'real', logfnBaseUrl: 'http://127.0.0.1:1' })).toThrow('durable CiFn remote log delivery');
    expect(() => new LogFnLogsAdapter({ baseUrl: 'http://127.0.0.1:1' })).toThrow('unsupported');
    expect(fetcher).not.toHaveBeenCalled();
  } finally { fetcher.mockRestore(); }
});
