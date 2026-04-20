import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCalendarRuntimeService,
  createCalendarService,
  createGoogleCalendarClient,
  createMetricsEmitter,
  createMemoryStore,
  createMemoryTokenStore,
  createOutlookCalendarClient,
  METRICS,
  MemoryLogger,
  MemoryQueueAdapter,
} from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';

describe('Calendar scheduler', () => {
  let store: RecFnStore;
  let tokenStore: ReturnType<typeof createMemoryTokenStore>;
  let logger: MemoryLogger;

  beforeEach(() => {
    store = createMemoryStore();
    tokenStore = createMemoryTokenStore();
    logger = new MemoryLogger();
  });

  it('runs as a runtime service, creates bots in-namespace, and deduplicates repeated polls (TV-CAL-001)', async () => {
    const queue = new MemoryQueueAdapter();
    const metricEvents: Array<{ event: string; props?: Record<string, unknown> }> = [];
    const metrics = createMetricsEmitter((event, props) => {
      metricEvents.push({ event, props });
    });
    const now = Date.now();
    const eventStart = new Date(now + 30_000).toISOString();
    const eventEnd = new Date(now + 90_000).toISOString();

    const cal = await store.createCalendar(
      { provider: 'google', autoSchedule: true },
      'ns_test',
    );
    await tokenStore.set(cal.id, { accessToken: 'valid' });

    const googleClient = {
      ...createGoogleCalendarClient(),
      listEvents: vi.fn().mockResolvedValue([
        {
          id: 'evt_upcoming',
          summary: 'Meeting',
          start: { dateTime: eventStart },
          end: { dateTime: eventEnd },
          hangoutLink: 'https://zoom.us/j/12345',
        },
      ]),
    };

    const service = createCalendarService({
      store,
      tokenStore,
      googleClient,
      outlookClient: createOutlookCalendarClient(),
      queue,
      logger,
      metrics,
      now: () => new Date(now),
    });
    const runtime = createCalendarRuntimeService(service, {
      namespaces: ['ns_test'],
      pollIntervalMs: 1000,
      leadTimeMs: 60_000,
    });

    expect(runtime.isRunning()).toBe(false);
    runtime.start();
    expect(runtime.isRunning()).toBe(true);
    runtime.stop();
    expect(runtime.isRunning()).toBe(false);

    const firstPoll = await runtime.pollNow();
    expect(firstPoll).toEqual({ namespacesProcessed: 1, botsCreated: 1 });

    const secondPoll = await runtime.pollNow();
    expect(secondPoll).toEqual({ namespacesProcessed: 1, botsCreated: 0 });

    const bots = await store.listBots('ns_test', {});
    expect(bots.items).toHaveLength(1);
    expect(bots.items[0]?.meetingUrl).toBe('https://zoom.us/j/12345');
    expect(queue.size('recfn.bot.join')).toBe(1);

    const createdLog = logger.findByEvent('calendar.schedule.created');
    expect(createdLog).toHaveLength(1);
    expect(createdLog[0]?.data).toMatchObject({
      namespace: 'ns_test',
      calendarId: cal.id,
      eventId: 'evt_upcoming',
      platform: 'zoom',
    });

    const duplicateLog = logger.findByEvent('calendar.schedule.skip_existing');
    expect(duplicateLog).toHaveLength(1);
    expect(duplicateLog[0]?.data).toMatchObject({
      namespace: 'ns_test',
      calendarId: cal.id,
      eventId: 'evt_upcoming',
    });
    expect(metricEvents).toEqual(
      expect.arrayContaining([
        {
          event: METRICS.CALENDAR_SCHEDULE_DECISION,
          props: expect.objectContaining({
            decision: 'poll',
            namespace: 'ns_test',
            calendarId: cal.id,
            provider: 'google',
          }),
        },
        {
          event: METRICS.CALENDAR_SCHEDULE_DECISION,
          props: expect.objectContaining({
            decision: 'created',
            namespace: 'ns_test',
            calendarId: cal.id,
            eventId: 'evt_upcoming',
            platform: 'zoom',
          }),
        },
        {
          event: METRICS.CALENDAR_SCHEDULE_DECISION,
          props: expect.objectContaining({
            decision: 'skip_existing',
            namespace: 'ns_test',
            calendarId: cal.id,
            eventId: 'evt_upcoming',
          }),
        },
      ]),
    );
  });

  it('does not create bot for event without meeting URL', async () => {
    const now = Date.now();
    const eventStart = new Date(now + 30_000).toISOString();

    const cal = await store.createCalendar(
      { provider: 'google', autoSchedule: true },
      'ns_test',
    );
    await tokenStore.set(cal.id, { accessToken: 'valid' });

    const googleClient = {
      ...createGoogleCalendarClient(),
      listEvents: vi.fn().mockResolvedValue([
        {
          id: 'evt_no_url',
          summary: 'In-person meeting',
          start: { dateTime: eventStart },
          end: { dateTime: eventStart },
        },
      ]),
    };

    const service = createCalendarService({
      store,
      tokenStore,
      googleClient,
      outlookClient: createOutlookCalendarClient(),
      logger,
      now: () => new Date(now),
    });

    const result = await service.pollNamespace('ns_test', { leadTimeMs: 60_000 });

    expect(result.botsCreated).toBe(0);
    expect(logger.findByEvent('calendar.schedule.created')).toHaveLength(0);
  });
});
