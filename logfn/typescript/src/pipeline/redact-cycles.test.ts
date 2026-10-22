import { expect, it } from 'vitest';
import { Logger } from '../core/logger.js';
import { redactSecFn } from './redact.js';
import type { LogEvent } from '../types.js';
it('redacts cyclic and prototype-key context without skipping the stage', () => {
  const context: any = JSON.parse('{"__proto__":{"value":"password=secret"}}');
  context.email = 'private@example.com';
  context.self = context;
  const events: LogEvent[] = [];
  const logger = new Logger({ name: 'test', pipeline: [redactSecFn()], sinks: [batch => { events.push(...batch); }] });
  logger.info('token=private', context);
  expect(events).toHaveLength(1);
  const wire = JSON.stringify(events[0]);
  expect(wire).not.toContain('private');
  expect(wire).not.toContain('secret');
  expect(wire).toContain('[circular]');
  expect(Object.hasOwn(events[0].ctx!, '__proto__')).toBe(true);
  expect(context.email).toBe('private@example.com');
});
