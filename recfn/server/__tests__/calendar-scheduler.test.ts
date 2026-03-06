import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createMemoryStore,
  createMemoryTokenStore,
  createGoogleCalendarClient,
  createOutlookCalendarClient,
  MemoryQueueAdapter,
  pollAndSchedule,
} from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';
describe('Calendar scheduler', () => {
  let store: RecFnStore;
  let tokenStore: ReturnType<typeof createMemoryTokenStore>;

  beforeEach(() => {
    store = createMemoryStore();
    tokenStore = createMemoryTokenStore();
  });

  it('creates bot for upcoming event with meeting URL (TV-CAL-004)', async () => {
    const queue = new MemoryQueueAdapter();
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

    const result = await pollAndSchedule(
      {
        store,
        tokenStore,
        googleClient,
        outlookClient: createOutlookCalendarClient(),
        queue,
      },
      'ns_test',
      { leadTimeMs: 60_000 },
    );

    expect(result.botsCreated).toBe(1);
    const bots = await store.listBots('ns_test', {});
    expect(bots.items).toHaveLength(1);
    expect(bots.items[0]?.meetingUrl).toBe('https://zoom.us/j/12345');
    expect(queue.size('recfn.bot.join')).toBe(1);
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

    const result = await pollAndSchedule(
      {
        store,
        tokenStore,
        googleClient,
        outlookClient: createOutlookCalendarClient(),
      },
      'ns_test',
      { leadTimeMs: 60_000 },
    );

    expect(result.botsCreated).toBe(0);
  });
});
