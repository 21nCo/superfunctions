import type { Calendar, CalendarEvent } from 'recfn';
import type { RecFnHttpClient } from '../client.js';
import type { ApiResult } from '../client.js';

export interface CreateCalendarInput {
  provider: 'google' | 'outlook';
  accessToken: string;
  refreshToken?: string;
  autoSchedule?: boolean;
}

export function createCalendarsResource(client: RecFnHttpClient) {
  return {
    async create(input: CreateCalendarInput): Promise<ApiResult<Calendar>> {
      return client.request('POST', '/api/v1/calendars', {
        body: {
          provider: input.provider,
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          autoSchedule: input.autoSchedule,
        },
      });
    },

    async list(): Promise<ApiResult<{ calendars: Calendar[] }>> {
      return client.request('GET', '/api/v1/calendars');
    },

    async delete(calendarId: string): Promise<ApiResult<{ calendarId: string; deleted: boolean }>> {
      return client.request('DELETE', `/api/v1/calendars/${calendarId}`);
    },

    async getEvents(
      calendarId: string,
      opts?: { from?: string; to?: string },
    ): Promise<ApiResult<{ events: CalendarEvent[] }>> {
      const params = new URLSearchParams();
      if (opts?.from) params.set('from', opts.from);
      if (opts?.to) params.set('to', opts.to);
      const qs = params.toString();
      const path = qs
        ? `/api/v1/calendars/${calendarId}/events?${qs}`
        : `/api/v1/calendars/${calendarId}/events`;
      return client.request('GET', path);
    },
  };
}
