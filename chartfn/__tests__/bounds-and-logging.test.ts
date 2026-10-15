import { expect, it, vi } from 'vitest';
import { validateChartSpec } from '../src/validate.js';
import { logger } from '../src/logger.js';
it('rejects oversized values before inspecting or copying their entries', () => {
  const values = new Array(10_001);
  Object.defineProperty(values, 0, { get() { throw Error('must not inspect values'); } });
  const result = validateChartSpec({ type: 'bar', data: { series: [{ values }] } });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain('max points');
});
it('defaults browser logging to warnings without a process environment', () => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const previous = globalThis.process;
  try {
    Object.defineProperty(globalThis, 'process', { configurable: true, writable: true, value: undefined });
    logger.debug('quiet default');
  } finally {
    Object.defineProperty(globalThis, 'process', { configurable: true, writable: true, value: previous });
  }
  expect(debug).not.toHaveBeenCalled();
  debug.mockRestore();
});
