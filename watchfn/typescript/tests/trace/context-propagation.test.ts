import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TraceContextPropagator } from '../../src/trace/context-propagation';
const cases = JSON.parse(readFileSync(new URL('../../../python/tests/fixtures/trace-context-golden.json', import.meta.url), 'utf8'));
const propagator = new TraceContextPropagator();
describe('shared trace context wire vectors', () => {
  it.each(cases)('$name', ({ headers, valid, state }) => {
    const context = propagator.extract(headers);
    expect(context !== null).toBe(valid);
    if (context) {
      expect(context.traceState).toBe(state);
      expect(context.traceFlags).toBe(1);
      const output = propagator.inject(context, { TraceParent: 'stale', TraceState: 'stale', other: 'retained' });
      expect(output.other).toBe('retained'); expect(output.TraceParent).toBeUndefined(); expect(output.TraceState).toBeUndefined();
      expect(propagator.extract(output)).toEqual(context);
    }
  });
  it('rejects invalid injection atomically and creates independent children', () => {
    const parent = propagator.create(), child = propagator.createChild(parent);
    expect(child.traceId).toBe(parent.traceId); expect(child.parentSpanId).toBe(parent.spanId); expect(child.spanId).not.toBe(parent.spanId);
    const headers = { TraceParent: 'keep' };
    for (const context of [{ ...parent, traceId: parent.traceId + '\n' }, { ...parent, traceFlags: NaN }, { ...parent, traceState: 'vendor=value\r\ninjected=yes' }]) expect(() => propagator.inject(context, headers)).toThrow('Invalid trace');
    expect(headers).toEqual({ TraceParent: 'keep' });
  });
});

import { Tracer } from '../../src/trace/tracer';
import { createServer } from 'node:http';
it('propagates real HTTP parentage, flags and state across concurrent async calls', async () => {
  const events: any[] = [];
  const host = { track: (_name: string, span: any) => events.push(span) };
  const client = new Tracer(host as any, 'client'), serverTracer = new Tracer(host as any, 'server');
  const server = createServer((request, response) => {
    void serverTracer.startWithHeaders('remote', request.headers, async span => {
      await Promise.resolve();
      const child = serverTracer.startSpan('remote-child'); child.finish();
      response.end(JSON.stringify({ id: span.id, traceId: span.traceId, parentId: span.parentId, flags: span.traceFlags, headers: serverTracer.injectHeaders() }));
    }).catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    await Promise.all([0, 1].map(async flag => {
      const parent = propagator.create(); parent.traceFlags = flag; parent.traceState = `vendor=value${flag}`;
      await client.startWithHeaders('outgoing', propagator.inject(parent), async span => {
        await Promise.resolve();
        const response = await fetch(`http://127.0.0.1:${address.port}`, { headers: client.injectHeaders() });
        const body = await response.json() as any;
        expect(body.parentId).toBe(span.id); expect(body.traceId).toBe(parent.traceId); expect(body.flags).toBe(flag);
        expect(body.headers.tracestate).toBe(parent.traceState);
        expect(events.find(event => event.name === 'remote-child' && event.traceId === parent.traceId)?.parentId).toBe(body.id);
      });
    }));
    expect(() => client.injectHeaders()).toThrow('No active');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('does not reuse completed ambient parents or attach explicit new traces to them', async () => {
  const tracer = new Tracer({ track: () => {} } as any);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let late!: Promise<any>, root!: any;
  tracer.start('root', span => {
    root = span;
    const separate = tracer.startSpan('separate', { traceId: 'separate' });
    expect(separate.parentId).toBeUndefined(); separate.finish();
    late = gate.then(() => { const child = tracer.startSpan('late'); child.finish(); return child; });
  });
  release(); const child = await late;
  expect(child.traceId).not.toBe(root.traceId); expect(child.parentId).toBeUndefined();
});

it('retains manual transaction context outside its original ambient scope', () => {
  const tracer = new Tracer({ track: () => {} } as any);
  const incoming = propagator.create(); incoming.traceFlags = 0; incoming.traceState = 'vendor=manual';
  const transaction = tracer.startWithHeaders('inbound', propagator.inject(incoming), () => tracer.startTransaction('manual'));
  tracer.start('unrelated', () => {
    const child = transaction.startSpan('child');
    expect(child.parentId).toBe(transaction.id); expect(child.traceId).toBe(incoming.traceId);
    expect(tracer.injectHeaders({}, child).tracestate).toBe('vendor=manual');
    expect(tracer.injectHeaders({}, child).traceparent.endsWith('-00')).toBe(true);
    child.finish();
  });
  transaction.finish();
});

it('stops reading repeated fields immediately at their bounds', () => {
  const parent = propagator.inject(propagator.create()).traceparent;
  const parents = [parent, parent];
  Object.defineProperty(parents, 2, { get() { throw new Error('read past duplicate parent'); } });
  expect(propagator.extract({ traceparent: parents })).toBeNull();
  const states = ['x'.repeat(513)];
  Object.defineProperty(states, 1, { get() { throw new Error('read past state bound'); } });
  expect(propagator.extract({ traceparent: parent, tracestate: states })?.traceState).toBeUndefined();
});
