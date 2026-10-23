import type { Calendar } from '@recfn/core';
import type { RecFnStore } from '../store/types.js';
import type { CalendarTokenStore } from './token-store.js';
import type { GoogleCalendarClient } from './google.js';
import type { OutlookCalendarClient } from './outlook.js';
import type { QueueAdapter } from '../integrations/flowfn.js';
import type { Logger } from '../integrations/logfn.js';
import { QUEUE_NAMES } from '../integrations/flowfn.js';
import { createNoopLogger } from '../integrations/logfn.js';
import { validateMeetingUrl } from '@recfn/core';
import type { MetricsEmitter } from '../integrations/watchfn.js';
import { emitCalendarScheduleDecision } from '../observability/metrics.js';

export interface CalendarSchedulerDeps {
  store: RecFnStore;
  tokenStore: CalendarTokenStore;
  googleClient: GoogleCalendarClient;
  outlookClient: OutlookCalendarClient;
  queue?: QueueAdapter;
  logger?: Logger;
  metrics?: MetricsEmitter;
  now?: () => Date;
  listCalendarEvents?: (input: {
    calendar: Calendar;
    namespace: string;
    from: string;
    to: string;
  }) => Promise<EventWithUrl[]>;
}

export interface SchedulerConfig {
  pollIntervalMs?: number;
  leadTimeMs?: number;
}

export interface EventWithUrl {
  id: string;
  meetingUrl: string;
  startTime: string;
}

/**
 * Poll calendars for upcoming events and create bots for those with meeting URLs.
 * Default: poll every 5min, create bot 1min before event start.
 */
export async function pollAndSchedule(
  deps: CalendarSchedulerDeps,
  namespace: string,
  config: SchedulerConfig = {},
): Promise<{ botsCreated: number }> {
  const {
    store,
    tokenStore,
    googleClient,
    outlookClient,
    queue,
    logger = createNoopLogger(),
    metrics,
    now: nowProvider = () => new Date(),
    listCalendarEvents,
  } = deps;
  const leadTimeMs = config.leadTimeMs ?? 60_000;
  const now = nowProvider().getTime();
  const windowStart = new Date(now);
  const windowEnd = new Date(now + leadTimeMs + 60 * 60 * 1000);

  const calendars = await store.listCalendars(namespace);
  const autoCalendars = calendars.filter((c) => c.autoSchedule);
  let botsCreated = 0;

  for (const cal of autoCalendars) {
    logger.info('calendar.schedule.poll', {
      namespace,
      calendarId: cal.id,
      provider: cal.provider,
      from: windowStart.toISOString(),
      to: windowEnd.toISOString(),
    });
    if (metrics) {
      emitCalendarScheduleDecision(metrics, {
        decision: 'poll',
        namespace,
        calendarId: cal.id,
        provider: cal.provider,
      });
    }

    try {
      const from = windowStart.toISOString();
      const to = windowEnd.toISOString();

      const eventIdsWithUrls = listCalendarEvents
        ? await listCalendarEvents({
            calendar: cal,
            namespace,
            from,
            to,
          })
        : await listEventsWithUrls({
            calendar: cal,
            tokenStore,
            googleClient,
            outlookClient,
            from,
            to,
          });

      for (const { id: eventId, meetingUrl, startTime } of eventIdsWithUrls) {
        const existing = await store.getEventBotIds(cal.id, [eventId], namespace);
        const existingBotId = existing.get(eventId);
        if (existingBotId) {
          logger.info('calendar.schedule.skip_existing', {
            namespace,
            calendarId: cal.id,
            provider: cal.provider,
            eventId,
            botId: existingBotId,
          });
          if (metrics) {
            emitCalendarScheduleDecision(metrics, {
              decision: 'skip_existing',
              namespace,
              calendarId: cal.id,
              provider: cal.provider,
              eventId,
              botId: existingBotId,
            });
          }
          continue;
        }

        const startMs = new Date(startTime).getTime();
        if (!(startMs - now <= leadTimeMs && startMs > now - 60000)) {
          logger.info('calendar.schedule.skip_outside_window', {
            namespace,
            calendarId: cal.id,
            provider: cal.provider,
            eventId,
            startTime,
          });
          if (metrics) {
            emitCalendarScheduleDecision(metrics, {
              decision: 'skip_outside_window',
              namespace,
              calendarId: cal.id,
              provider: cal.provider,
              eventId,
            });
          }
          continue;
        }

        let platform: ReturnType<typeof validateMeetingUrl>['platform'];
        try {
          ({ platform } = validateMeetingUrl(meetingUrl));
        } catch (error) {
          logger.warn('calendar.schedule.skip_invalid_url', {
            namespace,
            calendarId: cal.id,
            provider: cal.provider,
            eventId,
            error: error instanceof Error ? error.message : String(error),
          });
          if (metrics) {
            emitCalendarScheduleDecision(metrics, {
              decision: 'skip_invalid_url',
              namespace,
              calendarId: cal.id,
              provider: cal.provider,
              eventId,
            });
          }
          continue;
        }

        const bot = await store.createBot({
          meetingUrl,
          platform,
          config: {
            displayName: 'RecFn Bot',
            joinTimeout: 30000,
            autoLeaveOnEmpty: true,
            autoLeaveEmptyTimeout: 30000,
            consentMessage: 'This meeting is being recorded',
            enableRealTimeTranscript: false,
            asrProvider: 'whisper',
            recordingFormat: 'mp4',
            language: 'en-US',
          },
          namespace,
        });
        await store.setEventBotId(cal.id, eventId, bot.id, namespace);
        botsCreated++;
        logger.info('calendar.schedule.created', {
          namespace,
          calendarId: cal.id,
          provider: cal.provider,
          eventId,
          botId: bot.id,
          platform,
        });
        if (metrics) {
          emitCalendarScheduleDecision(metrics, {
            decision: 'created',
            namespace,
            calendarId: cal.id,
            provider: cal.provider,
            eventId,
            botId: bot.id,
            platform,
          });
        }
        if (queue) {
          await queue.enqueue(QUEUE_NAMES.BOT_JOIN, {
            type: 'bot.join',
            data: { botId: bot.id, namespace },
            createdAt: new Date().toISOString(),
          });
        }
      }
    } catch (error) {
      logger.error('calendar.schedule.failed', {
        namespace,
        calendarId: cal.id,
        provider: cal.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      if (metrics) {
        emitCalendarScheduleDecision(metrics, {
          decision: 'failed',
          namespace,
          calendarId: cal.id,
          provider: cal.provider,
        });
      }
    }
  }

  return { botsCreated };
}

async function listEventsWithUrls(input: {
  calendar: Calendar;
  tokenStore: CalendarTokenStore;
  googleClient: GoogleCalendarClient;
  outlookClient: OutlookCalendarClient;
  from: string;
  to: string;
}): Promise<EventWithUrl[]> {
  const { calendar, tokenStore, googleClient, outlookClient, from, to } = input;
  const tokens = await tokenStore.get(calendar.id);
  if (!tokens) {
    return [];
  }

  let eventIdsWithUrls: EventWithUrl[] = [];

  if (calendar.provider === 'google') {
    const events = await googleClient.listEvents(tokens.accessToken, { from, to });
    for (const event of events) {
      const url = extractGoogleMeetingUrl(event);
      if (url) {
        const start = event.start?.dateTime ?? event.start?.date ?? '';
        eventIdsWithUrls.push({ id: event.id, meetingUrl: url, startTime: start });
      }
    }
  } else if (calendar.provider === 'outlook') {
    const events = await outlookClient.listEvents(tokens.accessToken, { from, to });
    for (const event of events) {
      const url = event.onlineMeeting?.joinUrl ?? extractUrlFromBody(event.body?.content);
      if (url) {
        const start = event.start?.dateTime ?? '';
        eventIdsWithUrls.push({ id: event.id, meetingUrl: url, startTime: start });
      }
    }
  }

  return eventIdsWithUrls;
}

function extractGoogleMeetingUrl(e: {
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ uri?: string }> };
  description?: string;
}): string | undefined {
  if (e.hangoutLink) return e.hangoutLink;
  for (const ep of e.conferenceData?.entryPoints ?? []) {
    if (ep.uri) return ep.uri;
  }
  if (e.description) {
    const m = e.description.match(/https?:\/\/(?:zoom\.us|meet\.google|teams\.microsoft)[^\s)]+/i);
    if (m) return m[0];
  }
  return undefined;
}

function extractUrlFromBody(content?: string): string | undefined {
  if (!content) return undefined;
  const m = content.match(/https?:\/\/(?:teams\.microsoft|zoom\.us|meet\.google)[^\s"<>)]+/i);
  return m?.[0];
}
