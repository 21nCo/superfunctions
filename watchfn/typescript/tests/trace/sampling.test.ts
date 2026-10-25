import { expect, it } from 'vitest';
import { WatchFn } from '../../src/core/watch-fn';
it('honors disabled tracing and configured service name', async () => {
  const disabled = new WatchFn({ name: 'disabled', storage: 'memory', infra: { enabled: false }, trace: { enabled: false, sampleRate: 1 } } as any);
  const enabled = new WatchFn({ name: 'app', storage: 'memory', infra: { enabled: false }, trace: { enabled: true, sampleRate: 1, serviceName: 'trace-service' } } as any);
  disabled.start(); enabled.start();
  try {
    disabled.trace.startSpan('ignored').finish(); enabled.trace.startSpan('kept').finish();
    await disabled.flush(); await enabled.flush();
    expect(await disabled.trace.query({})).toEqual([]);
    expect(await enabled.trace.query({})).toMatchObject([{ service: 'trace-service' }]);
  } finally { await disabled.stop(); await enabled.stop(); }
});

import { readFileSync } from 'node:fs';
import { sampleTrace } from '../../src/trace/sampling';
import { Tracer } from '../../src/trace/tracer';
import { traceContextPropagator } from '../../src/trace/context-propagation';
const vectors = JSON.parse(readFileSync(new URL('../../../python/tests/fixtures/trace-sampling-golden.json', import.meta.url), 'utf8'));
it.each(vectors)('shares root decision for $id at $rate', ({ id, rate, sampled }) => { expect(sampleTrace(id, rate)).toBe(sampled); });
it('inherits parent sampling, honors incoming decisions and suppresses all recording when disabled', () => {
  const recorded: any[] = [];
  const tracer = new Tracer({ track: (_name: string, span: any) => recorded.push(span) } as any, 'service', { sampleRate: 0 });
  tracer.start('root', span => {
    expect(span.getContext().sampled).toBe(false);
    const child = tracer.startSpan('child'); expect(child.traceFlags).toBe(0); child.finish();
    expect(tracer.injectHeaders().traceparent.endsWith('-00')).toBe(true);
  });
  expect(recorded).toEqual([]);
  const parent = traceContextPropagator.create();
  tracer.startWithHeaders('inbound', traceContextPropagator.inject(parent), span => { expect(span.traceFlags).toBe(1); });
  expect(recorded).toHaveLength(1);
  const disabled = new Tracer({ track: () => { throw new Error('must not record'); } } as any, 'off', { enabled: false });
  disabled.startWithHeaders('off', traceContextPropagator.inject(parent), span => { expect(span.traceFlags).toBe(0); });
});
it('rejects invalid sampling configuration and malformed Unicode IDs', () => {
  for (const rate of [NaN, Infinity, -1, 1.1, true]) expect(() => sampleTrace('id', rate as number)).toThrow();
  expect(() => sampleTrace('\ud800', 1)).toThrow('Unicode');
  expect(() => new WatchFn({ name: 'invalid', trace: { enabled: true, sampleRate: -1 } } as any)).toThrow();
});
