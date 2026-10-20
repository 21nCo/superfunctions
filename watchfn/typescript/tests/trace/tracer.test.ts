import { describe, expect, it, vi } from 'vitest';
import { Tracer } from '../../src/trace/tracer';
import { Span } from '../../src/trace/span';
import { WatchFn } from '../../src/core/watch-fn';

function fixture() {
  const track = vi.fn();
  return { track, tracer: new Tracer({ track } as unknown as WatchFn) };
}

describe('manual and callback tracing', () => {
  it('records manual finish once, including epoch zero', () => {
    const { tracer, track } = fixture();
    const span = tracer.startSpan('manual', { startTime: 0 });
    expect(track).not.toHaveBeenCalled();
    expect(span.finish(0)).toBe(span);
    span.finish(10);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0]).toEqual(['trace.span', expect.objectContaining({startTime:0,endTime:0,duration:0})]);
    expect(span.id).toMatch(/^[a-f0-9]{16}$/);
    expect(span.traceId).toMatch(/^[a-f0-9]{32}$/);
  });

  it('records transaction children with stable explicit ancestry and no leaked context', () => {
    const { tracer, track } = fixture();
    const transaction = tracer.startTransaction('order');
    const child = transaction.startSpan('payment', {traceId:'override',parentId:'override'});
    expect(child.parentId).toBe(transaction.id);
    expect(child.traceId).toBe(transaction.traceId);
    expect(tracer.currentSpan()).toBeUndefined();
    child.finish(); transaction.finish(); transaction.finish();
    expect(track).toHaveBeenCalledTimes(2);
    expect(() => transaction.startSpan('late')).toThrow('finished');
  });

  it('records sync callbacks and manual early finish once', () => {
    const { tracer, track } = fixture();
    expect(tracer.start('sync', span => { span.finish(); return 42; })).toBe(42);
    expect(track).toHaveBeenCalledTimes(1);
    expect(tracer.currentSpan()).toBeUndefined();
  });

  it('preserves async context and isolates concurrent traces', async () => {
    const { tracer, track } = fixture();
    await Promise.all(['a','b'].map(name => tracer.start(name, async parent => {
      await Promise.resolve();
      expect(tracer.currentSpan()).toBe(parent);
      tracer.startSpan(`${name}-child`).finish();
    })));
    const events = track.mock.calls.map(call => call[1]);
    expect(events).toHaveLength(4);
    for (const name of ['a','b']) {
      const parent = events.find(event => event.name === name);
      const child = events.find(event => event.name === `${name}-child`);
      expect(child.parentId).toBe(parent.id);
      expect(child.traceId).toBe(parent.traceId);
    }
    expect(events.find(event => event.name === 'a').traceId).not.toBe(events.find(event => event.name === 'b').traceId);
  });

  it('awaits thenables and captures rejection without duplicate records', async () => {
    const { tracer, track } = fixture();
    const error = new Error('failed');
    const thenable = { then(_resolve: unknown, reject: (error: Error) => void) { reject(error); } };
    await expect(tracer.start('failure', () => thenable)).rejects.toBe(error);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0][1].tags.error).toBe(true);
    expect(track.mock.calls[0][1].logs[0].fields.error).toBe(error);
    expect(() => tracer.start('sync failure', () => { throw error; })).toThrow(error);
    expect(track).toHaveBeenCalledTimes(2);
  });

  it('persists public transaction and manual span events through WatchFn', async () => {
    const watch = new WatchFn({name:'tracing',storage:'memory',infra:{enabled:false}});
    watch.start();
    try {
      const transaction = watch.startTransaction('checkout');
      transaction.startSpan('payment').finish();
      transaction.finish(); transaction.finish();
      watch.trace.startSpan('manual').finish();
      const events = await watch.query({metric:'trace.span'});
      expect(events.map((event: any) => event.properties.name)).toEqual(['payment','checkout','manual']);
      expect(events[0].properties.parentId).toBe(events[1].properties.id);
      expect(events[0].properties.traceId).toBe(events[1].properties.traceId);
    } finally { watch.stop(); }
  });

  it('keeps standalone spans usable without a recorder', () => {
    const span = new Span({name:'standalone',startTime:0});
    expect(span.finish(10).toJSON().duration).toBe(10);
  });
});
