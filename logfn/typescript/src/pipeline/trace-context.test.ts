import { expect, it } from 'vitest';
import { parseW3CTraceContext, withRequestIds } from './request-ids.js';
const trace = '0af7651916cd43dd8448eb211c80319c';
const span = 'b7ad6b7169203331';
it.each([
  `00-${'0'.repeat(32)}-${span}-01`, `00-${trace}-${'0'.repeat(16)}-01`,
  `00-${'z'.repeat(32)}-${span}-01`, `00-${trace.toUpperCase()}-${span}-01`,
  `00-${trace}-${span}-zz`, `00-${trace}-${span}-0`,
  `ff-${trace}-${span}-01`, `00-${trace}-${span}-01-extension`,
  `01-${trace}-${span}-01invalid`, `00-${trace}-${span}-01\n`,
])('rejects invalid trace context %s', header => {
  expect(parseW3CTraceContext(header)).toBeNull();
});
it.each([`00-${trace}-${span}-01`, `01-${trace}-${span}-01`, `01-${trace}-${span}-01-extension`])('accepts valid known and additive future formats %s', header => {
  expect(parseW3CTraceContext(header)).toEqual({ traceId: trace, spanId: span });
});
it('fills missing IDs without replacing an existing trace', () => {
  const stage = withRequestIds({ generate: () => ({ traceId: 'new', spanId: 'span', requestId: 'request' }) });
  expect(stage({ ts: '2026-10-18T00:00:00Z', name: 'test', level: 'info', msg: 'test', version: '0', traceId: 'existing' })).toMatchObject({ traceId: 'existing', spanId: 'span', requestId: 'request' });
});
