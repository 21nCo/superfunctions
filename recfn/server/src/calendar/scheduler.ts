import type { RecFnStore } from '../store/types.js';
import type { CalendarTokenStore } from './token-store.js';
import type { GoogleCalendarClient } from './google.js';
import type { OutlookCalendarClient } from './outlook.js';
import type { QueueAdapter } from '../integrations/flowfn.js';
import { QUEUE_NAMES } from '../integrations/flowfn.js';
import { validateMeetingUrl } from 'recfn';

export interface CalendarSchedulerDeps {
  store: RecFnStore;
  tokenStore: CalendarTokenStore;
  googleClient: GoogleCalendarClient;
  outlookClient: OutlookCalendarClient;
  queue?: QueueAdapter;
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
  const { store, tokenStore, googleClient, outlookClient, queue } = deps;
  const leadTimeMs = config.leadTimeMs ?? 60_000;
  const now = Date.now();
  const windowStart = new Date(now);
  const windowEnd = new Date(now + leadTimeMs + 60 * 60 * 1000);

  const calendars = await store.listCalendars(namespace);
  const autoCalendars = calendars.filter((c) => c.autoSchedule);
  let botsCreated = 0;

  for (const cal of autoCalendars) {
    const tokens = await tokenStore.get(cal.id);
    if (!tokens) continue;

    try {
      const from = windowStart.toISOString();
      const to = windowEnd.toISOString();

      let eventIdsWithUrls: EventWithUrl[] = [];

      if (cal.provider === 'google') {
        const events = await googleClient.listEvents(tokens.accessToken, { from, to });
        for (const e of events) {
          const url = extractGoogleMeetingUrl(e);
          if (url) {
            const start = e.start?.dateTime ?? e.start?.date ?? '';
            eventIdsWithUrls.push({ id: e.id, meetingUrl: url, startTime: start });
          }
        }
      } else if (cal.provider === 'outlook') {
        const events = await outlookClient.listEvents(tokens.accessToken, { from, to });
        for (const e of events) {
          const url = e.onlineMeeting?.joinUrl ?? extractUrlFromBody(e.body?.content);
          if (url) {
            const start = e.start?.dateTime ?? '';
            eventIdsWithUrls.push({ id: e.id, meetingUrl: url, startTime: start });
          }
        }
      }

      for (const { id: eventId, meetingUrl, startTime } of eventIdsWithUrls) {
        const startMs = new Date(startTime).getTime();
        if (startMs - now <= leadTimeMs && startMs > now - 60000) {
          const { platform } = validateMeetingUrl(meetingUrl);
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
          if (queue) {
            await queue.enqueue(QUEUE_NAMES.BOT_JOIN, {
              type: 'bot.join',
              data: { botId: bot.id, namespace },
              createdAt: new Date().toISOString(),
            });
          }
        }
      }
    } catch {
      // Token may be expired; caller can mark calendar
    }
  }

  return { botsCreated };
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
