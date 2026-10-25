import { describe, expect, it } from 'vitest';
import { Logger } from './logger.js';
import type { LogEvent, Sink } from '../types.js';

describe('attached sinks', () => {
  it('shares attachments with existing and later children and detaches idempotently', async () => {
    const events: LogEvent[] = [];
    const parent = new Logger({ name: 'parent', sinks: [() => {}] });
    const before = parent.child({ name: 'before' });
    const detach = parent.addSink(batch => { events.push(...batch); });
    const after = parent.child({ name: 'after' });
    before.info('one'); after.info('two'); parent.info('three');
    await parent.flush();
    expect(events.map(event => event.name)).toEqual(['before', 'after', 'parent']);
    detach(); detach(); before.info('ignored'); after.info('ignored');
    expect(events).toHaveLength(3);
  });
  it('joins admitted asynchronous delivery after detach and exposes failure', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const parent = new Logger({ name: 'parent', sinks: [() => {}], onError: () => {} });
    const detach = parent.addSink(async () => { await gate; throw new Error('storage unavailable'); });
    parent.child({}).info('pending'); detach();
    let finished = false;
    const flushing = parent.flush().finally(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    release(); await expect(flushing).rejects.toThrow('storage unavailable');
    await parent.flush();
  });
  it('delivers redacted isolated copies and flushes attached buffered sinks', async () => {
    const events: LogEvent[] = [];
    let flushes = 0;
    const parent = new Logger({ name: 'parent', sinks: [() => {}] });
    parent.addSink(batch => { batch[0].msg = 'mutated'; });
    const sink: Sink = batch => { events.push(...batch); };
    sink.flush = async () => { flushes++; };
    parent.addSink(sink);
    parent.info('safe', { password: 'private-password' });
    await parent.flush();
    expect(events[0].msg).toBe('safe');
    expect(JSON.stringify(events)).not.toContain('private-password');
    expect(flushes).toBe(1);
  });
  it('surfaces synchronous attached sink failures without interrupting other sinks', async () => {
    let healthy = 0;
    const parent = new Logger({ name: 'parent', sinks: [() => {}], onError: () => {} });
    parent.addSink(() => { throw new Error('sync failure'); });
    parent.addSink(() => { healthy++; });
    expect(() => parent.info('accepted')).not.toThrow();
    expect(healthy).toBe(1);
    await expect(parent.flush()).rejects.toThrow('sync failure');
    await parent.flush();
  });
  it('reference-counts duplicate attachments without duplicate delivery', async () => {
    let count = 0;
    const parent = new Logger({ name: 'parent', sinks: [() => {}] });
    const sink: Sink = () => { count++; };
    const first = parent.addSink(sink); const second = parent.child({}).addSink(sink);
    parent.info('once'); expect(count).toBe(1);
    first(); parent.info('still attached'); expect(count).toBe(2);
    second(); parent.info('detached'); expect(count).toBe(2);
  });
});
