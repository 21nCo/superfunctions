import { expect, it } from 'vitest';
import { createCorrelationAccumulator, correlateRootCause, type CorrelationEventRecord } from '../src/correlation/root-cause.js';

it('retains first rule witnesses and preserves full-list correlation precedence', () => {
  const events: CorrelationEventRecord[] = [];
  const add = (category: CorrelationEventRecord['category'], payload: Record<string, unknown>) => events.push({ eventId: `evt_${events.length}`, category, payload, sinkPath: 'events.ndjson', lineNumber: events.length + 1 });
  add('console', { text: 'Cannot read properties of undefined (reading "user")' });
  add('page-error', { message: 'Cannot read properties of undefined (reading "plan")' });
  add('console', { text: 'Cannot read properties of undefined (reading "plan")' });
  add('network', { url: 'http://example.invalid/submit' });
  add('action', { query: 'Submit order' });
  for (let i = 0; i < 10000; i++) add('console', { text: 'Cannot read properties of undefined (reading "later")' });
  for (const length of [0, 1, 2, 3, 4, 5, events.length]) {
    const input = events.slice(0, length);
    const accumulator = createCorrelationAccumulator();
    input.forEach(event => accumulator.add(event));
    const retained = accumulator.events();
    const correlate = (rows: CorrelationEventRecord[]) => correlateRootCause({ actions: rows.filter(row => row.category === 'action'), consoleEvents: rows.filter(row => row.category === 'console'), pageErrors: rows.filter(row => row.category === 'page-error'), networkEvents: rows.filter(row => row.category === 'network'), checkpoints: [] });
    expect(retained.length).toBeLessThanOrEqual(6);
    expect(correlate(retained)).toEqual(correlate(input));
  }
});
