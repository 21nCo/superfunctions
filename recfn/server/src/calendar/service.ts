import type { OAuthTokenHttpClient } from '@superfunctions/oauth-http';
import {
  ErrorCode,
  createError,
  type Calendar,
  type CalendarEvent,
  type CalendarProvider,
} from '@recfn/core';
import type { Logger } from '../integrations/logfn.js';
import { createNoopLogger } from '../integrations/logfn.js';
import type { QueueAdapter } from '../integrations/flowfn.js';
import type { MetricsEmitter } from '../integrations/watchfn.js';
import type { RecFnStore } from '../store/types.js';
import type { GoogleCalendarClient, GoogleCalendarEvent } from './google.js';
import { googleEventsToCalendarEvents } from './google.js';
import type { OutlookCalendarClient, OutlookCalendarEvent } from './outlook.js';
import { outlookEventsToCalendarEvents } from './outlook.js';
import { pollAndSchedule, type SchedulerConfig } from './scheduler.js';
import type { CalendarTokenStore } from './token-store.js';
import { refreshCalendarToken } from './token-refresh.js';

export interface CalendarRefreshProviderConfig {
  id: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: string[];
}

export interface CalendarServiceDeps {
  store: RecFnStore;
  tokenStore: CalendarTokenStore;
  googleClient: GoogleCalendarClient;
  outlookClient: OutlookCalendarClient;
  queue?: QueueAdapter;
  logger?: Logger;
  metrics?: MetricsEmitter;
  tokenHttpClient?: OAuthTokenHttpClient;
  refreshProviders?: Partial<Record<CalendarProvider, CalendarRefreshProviderConfig>>;
  now?: () => Date;
}

export interface CalendarService {
  listEvents(
    calendarId: string,
    namespace: string,
    range: { from: string; to: string },
  ): Promise<CalendarEvent[]>;
  pollNamespace(namespace: string, config?: SchedulerConfig): Promise<{ botsCreated: number }>;
}

export interface CalendarRuntimeConfig extends SchedulerConfig {
  namespaces: string[] | (() => Promise<string[]> | string[]);
  pollIntervalMs?: number;
}

export interface CalendarRuntimeService {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  pollNow(): Promise<{ namespacesProcessed: number; botsCreated: number }>;
}

type ProviderEventSet =
  | { provider: 'google'; events: GoogleCalendarEvent[] }
  | { provider: 'outlook'; events: OutlookCalendarEvent[] };

export function createCalendarService(deps: CalendarServiceDeps): CalendarService {
  const logger = deps.logger ?? createNoopLogger();

  async function fetchEvents(calendar: Calendar, accessToken: string, range: {
    from: string;
    to: string;
  }): Promise<ProviderEventSet> {
    if (calendar.provider === 'google') {
      return {
        provider: 'google',
        events: await deps.googleClient.listEvents(accessToken, range),
      };
    }

    return {
      provider: 'outlook',
      events: await deps.outlookClient.listEvents(accessToken, range),
    };
  }

  async function fetchEventsWithRefresh(
    calendar: Calendar,
    namespace: string,
    range: { from: string; to: string },
  ): Promise<ProviderEventSet> {
    const tokens = await deps.tokenStore.get(calendar.id);
    if (!tokens) {
      throw createError(
        ErrorCode.CALENDAR_AUTH_FAILED,
        'Calendar tokens not found.',
      );
    }

    try {
      return await fetchEvents(calendar, tokens.accessToken, range);
    } catch (error) {
      const refreshProvider = deps.refreshProviders?.[calendar.provider];
      if (!tokens.refreshToken || !deps.tokenHttpClient || !refreshProvider) {
        logger.error('calendar.token_refresh.failed', {
          namespace,
          calendarId: calendar.id,
          provider: calendar.provider,
          error: error instanceof Error ? error.message : String(error),
          reason: 'refresh_not_configured',
        });
        throw createError(
          ErrorCode.CALENDAR_AUTH_FAILED,
          'Failed to fetch calendar events.',
        );
      }

      const refreshed = await refreshCalendarToken({
        calendarId: calendar.id,
        tokenStore: deps.tokenStore,
        tokenHttpClient: deps.tokenHttpClient,
        provider: refreshProvider,
      });

      if (!refreshed) {
        logger.error('calendar.token_refresh.failed', {
          namespace,
          calendarId: calendar.id,
          provider: calendar.provider,
          error: error instanceof Error ? error.message : String(error),
          reason: 'refresh_failed',
        });
        throw createError(
          ErrorCode.CALENDAR_AUTH_FAILED,
          'Failed to refresh calendar access token.',
        );
      }

      logger.info('calendar.token_refresh.success', {
        namespace,
        calendarId: calendar.id,
        provider: calendar.provider,
      });

      return fetchEvents(calendar, refreshed.accessToken, range);
    }
  }

  function sortCalendarEvents(events: CalendarEvent[]): CalendarEvent[] {
    return [...events].sort((a, b) => {
      const startCmp = a.startTime.localeCompare(b.startTime);
      if (startCmp !== 0) {
        return startCmp;
      }
      return a.id.localeCompare(b.id);
    });
  }

  const service: CalendarService = {
    async listEvents(
      calendarId: string,
      namespace: string,
      range: { from: string; to: string },
    ): Promise<CalendarEvent[]> {
      const calendar = await deps.store.getCalendar(calendarId, namespace);
      if (!calendar) {
        throw createError(ErrorCode.CALENDAR_NOT_FOUND, 'Calendar not found.');
      }

      const result = await fetchEventsWithRefresh(calendar, namespace, range);
      const eventIds = result.events.map((event) => event.id);
      const botIdMap = await deps.store.getEventBotIds(calendarId, eventIds, namespace);

      const events =
        result.provider === 'google'
          ? googleEventsToCalendarEvents(result.events, calendarId, botIdMap)
          : outlookEventsToCalendarEvents(result.events, calendarId, botIdMap);

      return sortCalendarEvents(events);
    },

    async pollNamespace(
      namespace: string,
      config: SchedulerConfig = {},
    ): Promise<{ botsCreated: number }> {
      return pollAndSchedule(
        {
          store: deps.store,
          tokenStore: deps.tokenStore,
          googleClient: deps.googleClient,
          outlookClient: deps.outlookClient,
          queue: deps.queue,
          logger,
          metrics: deps.metrics,
          now: deps.now,
          listCalendarEvents: async ({ calendar, namespace: targetNamespace, from, to }) => {
            const events = await service.listEvents(calendar.id, targetNamespace, { from, to });
            return events
              .filter((event) => typeof event.meetingUrl === 'string' && event.meetingUrl.length > 0)
              .map((event) => ({
                id: event.id,
                meetingUrl: event.meetingUrl!,
                startTime: event.startTime,
              }));
          },
        },
        namespace,
        config,
      );
    },
  };

  return service;
}

export function createCalendarRuntimeService(
  service: CalendarService,
  config: CalendarRuntimeConfig,
): CalendarRuntimeService {
  let interval: ReturnType<typeof setInterval> | null = null;

  async function resolveNamespaces(): Promise<string[]> {
    const source =
      typeof config.namespaces === 'function'
        ? await config.namespaces()
        : config.namespaces;
    return Array.from(new Set(source));
  }

  async function pollNow(): Promise<{ namespacesProcessed: number; botsCreated: number }> {
    const namespaces = await resolveNamespaces();
    let botsCreated = 0;

    for (const namespace of namespaces) {
      const result = await service.pollNamespace(namespace, {
        leadTimeMs: config.leadTimeMs,
        pollIntervalMs: config.pollIntervalMs,
      });
      botsCreated += result.botsCreated;
    }

    return {
      namespacesProcessed: namespaces.length,
      botsCreated,
    };
  }

  return {
    start(): void {
      if (interval) {
        return;
      }

      interval = setInterval(() => {
        void pollNow();
      }, config.pollIntervalMs ?? 5 * 60 * 1000);
    },

    stop(): void {
      if (!interval) {
        return;
      }

      clearInterval(interval);
      interval = null;
    },

    isRunning(): boolean {
      return interval !== null;
    },

    pollNow,
  };
}
