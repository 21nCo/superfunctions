import { describe, expect, it } from 'vitest';
import { sanitizeValue, validateAndSerialize } from './validation.js';
import type { LogEvent } from './types.js';
const base: LogEvent = { ts: '2026-10-18T00:00:00.000Z', level: 'info', msg: 'test', name: 'test', version: '0' };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe('safe event serialization', () => {
  it('replaces cycles while retaining repeated non-cyclic references', () => {
    const shared = { value: 1 };
    const cycle: any = { shared, other: shared };
    cycle.self = cycle;
    cycle.array = [cycle];
    expect(sanitizeValue(cycle)).toEqual({ shared, other: shared, self: '[circular]', array: ['[circular]'] });
  });
  it('contains deep nesting, throwing getters, invalid dates and prototype keys', () => {
    let nested: any = {};
    for (let i = 0; i < 10000; i++) nested = { nested };
    const context = JSON.parse('{"__proto__":{"safe":true}}');
    Object.defineProperty(context, 'bad', { enumerable: true, get() { throw Error('private'); } });
    const result: any = sanitizeValue({ context, nested, date: new Date(NaN) });
    expect(result.context.bad).toBe('[unserializable]');
    expect(Object.hasOwn(result.context, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result.context)).toBe(Object.prototype);
    expect(result.date).toBe('[unserializable]');
    expect(JSON.stringify(result)).toContain('[depth_limit]');
  });
  it('enforces UTF-8 size and keeps whole context entries', () => {
    const event = { ...base, ctx: { enormous: '🙂'.repeat(20000), useful: 'keep me' } };
    const result = validateAndSerialize(event);
    expect(result.truncated).toBe(true);
    expect(bytes(result.event)).toBeLessThanOrEqual(65536);
    expect(result.event.ctx).toMatchObject({ _truncated: true, useful: 'keep me' });
    expect(result.event.ctx).not.toHaveProperty('enormous');
    expect(event.ctx.enormous).toHaveLength(40000);
  });
  it('bounds oversized messages and metadata even without context', () => {
    const result = validateAndSerialize({ ...base, msg: '🙂'.repeat(40000), name: '界'.repeat(30000), tags: ['x'.repeat(100000)] });
    expect(result.truncated).toBe(true);
    expect(bytes(result.event)).toBeLessThanOrEqual(65536);
    expect(result.event.msg.length).toBeGreaterThan(0);
    expect(result.event.name.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.event)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });
  it('sanitizes additional fields before serialization', () => {
    const result = validateAndSerialize({ ...base, extra: { unsupported: 1n } } as LogEvent);
    expect(JSON.stringify(result.event)).toContain('[unserializable]');
  });
});
