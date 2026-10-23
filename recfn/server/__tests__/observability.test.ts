import { describe, it, expect } from 'vitest';
import {
  createMetricsEmitter,
  recordJoinLatency,
  MemoryLogger,
  METRICS,
  emitBotsActive,
  emitRecordingsCount,
  emitAsrLatency,
  emitJoinLatency,
  emitWebhookDelivery,
  emitCalendarScheduleDecision,
} from '../src/index.js';
import { sanitizeLogData } from '../src/integrations/logfn.js';

describe('Observability (TV-OBS-001, TV-OBS-002, TV-OBS-003)', () => {
  it('createMetricsEmitter no-op when no trackFn', () => {
    const metrics = createMetricsEmitter();
    expect(() => metrics.track('test.event', { foo: 1 })).not.toThrow();
  });

  it('createMetricsEmitter emits when trackFn provided', () => {
    const events: Array<{ event: string; props?: Record<string, unknown> }> = [];
    const metrics = createMetricsEmitter((e, p) => events.push({ event: e, props: p }));

    metrics.track('recfn.bots.active', { count: 2 });
    metrics.track('recfn.asr.latency_ms', { latencyMs: 150 });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ event: 'recfn.bots.active', props: { count: 2 } });
    expect(events[1]).toEqual({ event: 'recfn.asr.latency_ms', props: { latencyMs: 150 } });
  });

  it('recordJoinLatency logs and warns when exceeds 10s target', () => {
    const logger = new MemoryLogger();
    const metrics = createMetricsEmitter();

    recordJoinLatency({
      botId: 'bot_1',
      latencyMs: 500,
      logger,
      metrics,
    });

    const infoEntries = logger.findByEvent('bot.join_latency');
    expect(infoEntries).toHaveLength(1);
    expect(infoEntries[0].data).toMatchObject({ botId: 'bot_1', latencyMs: 500 });

    logger.clear();
    recordJoinLatency({
      botId: 'bot_2',
      latencyMs: 15_000,
      logger,
    });

    const warnEntries = logger.findByEvent('bot.join_latency.exceeded_target');
    expect(warnEntries).toHaveLength(1);
    expect(warnEntries[0].data).toMatchObject({
      botId: 'bot_2',
      latencyMs: 15_000,
      targetMs: 10_000,
    });
  });

  it('recordJoinLatency emits metric when metrics provided', () => {
    const events: Array<{ event: string; props?: Record<string, unknown> }> = [];
    const metrics = createMetricsEmitter((e, p) => events.push({ event: e, props: p }));
    const logger = new MemoryLogger();

    recordJoinLatency({
      botId: 'bot_1',
      latencyMs: 3000,
      namespace: 'ns_test',
      logger,
      metrics,
    });

    expect(events).toContainEqual({
      event: 'recfn.bot.join_latency_ms',
      props: expect.objectContaining({ latencyMs: 3000, botId: 'bot_1', namespace: 'ns_test' }),
    });
  });

  it('emit helpers use correct metric names', () => {
    const events: Array<{ event: string }> = [];
    const metrics = createMetricsEmitter((e) => events.push({ event: e }));

    emitBotsActive(metrics, 5, 'ns1');
    emitRecordingsCount(metrics, 10);
    emitAsrLatency(metrics, 200, { recordingId: 'rec_1', asrProvider: 'whisper' });
    emitJoinLatency(metrics, 1500, { botId: 'bot_1' });
    emitWebhookDelivery(metrics, { eventType: 'bot.joined', ok: true });
    emitWebhookDelivery(metrics, { eventType: 'recording.ready', ok: false });

    expect(events[0].event).toBe(METRICS.BOTS_ACTIVE);
    expect(events[1].event).toBe(METRICS.RECORDINGS_COUNT);
    expect(events[2].event).toBe(METRICS.ASR_LATENCY_MS);
    expect(events[3].event).toBe(METRICS.JOIN_LATENCY_MS);
    expect(events[4].event).toBe(METRICS.WEBHOOK_DELIVERY);
    expect(events[5].event).toBe(METRICS.WEBHOOK_DELIVERY_FAILED);
  });

  it('redacts secrets and transcript-like payloads before they are logged', () => {
    const sanitized = sanitizeLogData({
      accessToken: 'secret-token',
      nested: {
        refreshToken: 'refresh-token',
        segmentText: 'hello world',
      },
      chatMessages: [
        {
          text: 'sensitive transcript body',
        },
      ],
      count: 2,
    });

    expect(sanitized).toEqual({
      accessToken: '[REDACTED]',
      nested: {
        refreshToken: '[REDACTED]',
        segmentText: '[REDACTED]',
      },
      chatMessages: '[REDACTED]',
      count: 2,
    });
  });

  it('emits calendar scheduler metrics with the canonical event name', () => {
    const events: Array<{ event: string; props?: Record<string, unknown> }> = [];
    const metrics = createMetricsEmitter((e, p) => events.push({ event: e, props: p }));

    emitCalendarScheduleDecision(metrics, {
      decision: 'created',
      namespace: 'ns_test',
      calendarId: 'cal_123',
      provider: 'google',
      eventId: 'evt_123',
      botId: 'bot_123',
      platform: 'meet',
    });

    expect(events).toEqual([
      {
        event: METRICS.CALENDAR_SCHEDULE_DECISION,
        props: {
          decision: 'created',
          namespace: 'ns_test',
          calendarId: 'cal_123',
          provider: 'google',
          eventId: 'evt_123',
          botId: 'bot_123',
          platform: 'meet',
        },
      },
    ]);
  });
});
