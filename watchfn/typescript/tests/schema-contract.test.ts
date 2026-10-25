import { describe, expect, it } from 'vitest';
import { WatchFnConfigSchema } from '../src/core/types';
import { bugReportSchema } from '../src/core/bug-report';
import { validEmail } from '../src/alerts/channels/email-ses';

describe('public validation contracts', () => {
  it('keeps omitted collectors absent and applies explicit collector defaults', () => {
    expect(WatchFnConfigSchema.parse({ name: 'service' })).toEqual({ name: 'service', storage: 'memory' });
    expect(WatchFnConfigSchema.parse({ name: 'service', trace: {}, apm: {}, errors: {}, infra: {} })).toMatchObject({
      trace: { enabled: true, sampleRate: 0.1 },
      apm: { enabled: true, sampleRate: 1, slowRequestThreshold: 1000 },
      errors: { enabled: true, captureUnhandled: true, captureRejections: true },
      infra: { enabled: true, interval: 30000, system: true, process: true },
    });
    expect(WatchFnConfigSchema.parse({ name: 'service', apm: { autoInstrument: { http: false } } }).apm?.autoInstrument)
      .toEqual({ http: false, database: true, redis: true, external: true });
    for (const value of [Infinity, -Infinity]) {
      expect(WatchFnConfigSchema.safeParse({ name: 'service', infra: { interval: value } }).success).toBe(false);
      expect(WatchFnConfigSchema.safeParse({ name: 'service', apm: { slowRequestThreshold: value } }).success).toBe(false);
    }
    expect(WatchFnConfigSchema.parse({ name: 'service', trace: { enabled: false, sampleRate: 0 } }).trace)
      .toEqual({ enabled: false, sampleRate: 0 });
    for (const sampleRate of [NaN, Infinity, -Infinity, -0.1, 1.1]) {
      expect(WatchFnConfigSchema.safeParse({ name: 'service', trace: { sampleRate } }).success).toBe(false);
    }
  });

  it('accepts arbitrary string-keyed integration and bug-report metadata', () => {
    const integrations = { logfn: { enabled: true }, 'custom.integration': { nested: [1, false, null] } };
    expect(WatchFnConfigSchema.parse({ name: 'service', integrations }).integrations).toEqual(integrations);
    const report = {
      id: 'report-1', type: 'bug_report', timestamp: '2026-10-25T12:00:00+05:30',
      app: { name: 'service', custom: true }, sessionId: 'session-1',
      report: { title: 'Broken action', severity: 'high', custom: 1 },
      context: { 'literal.key': { nested: [null, 1] } }, attachments: [{ name: 'capture', bytes: 0 }],
      user: { custom: false }, integration: { provider: 'botfn' }, extra: { retained: true },
    };
    expect(bugReportSchema.parse(report)).toEqual(report);
    for (const timestamp of ['2026-10-25T12:00Z', '2026-10-25T12:00:00+0530', '2026-10-25T12:00+0530']) {
      expect(bugReportSchema.parse({ ...report, timestamp }).timestamp).toBe(timestamp);
    }
    for (const timestamp of ['2026-10-25T12:00:00+2560', '2026-02-30T12:00:00Z']) {
      expect(bugReportSchema.safeParse({ ...report, timestamp }).success).toBe(false);
    }
    expect(bugReportSchema.safeParse({ ...report, context: [] }).success).toBe(false);
    expect(bugReportSchema.safeParse({ ...report, timestamp: 'not-a-date' }).success).toBe(false);
  });

  it('accepts ordinary alert addresses and rejects header injection and malformed recipients', () => {
    for (const email of ['alerts@example.com', 'alerts+prod@sub.example.com', 'first.last@example.org']) expect(validEmail(email)).toBe(true);
    for (const email of [' alerts@example.com', 'alerts@example.com\r\nBcc:other@example.com', 'Name <alerts@example.com>', 'alerts', 'alerts@', '@example.com', null]) expect(validEmail(email)).toBe(false);
  });
});
