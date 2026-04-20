import type { Route, RouteContext } from '@superfunctions/http';
import { ErrorCode } from 'recfn';
import type { RecFnStore } from '../store/types.js';
import { checkCalendarCount } from '../middleware/limits.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import type { CalendarTokenStore } from '../calendar/token-store.js';
import type { GoogleCalendarClient } from '../calendar/google.js';
import type { OutlookCalendarClient } from '../calendar/outlook.js';
import type { CalendarService } from '../calendar/service.js';
import { authenticate } from '../middleware/auth.js';
import { ok, err } from '../middleware/envelope.js';

export interface CalendarRouteDeps {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
  limits: import('../config.js').RecFnLimitsConfig;
  tokenStore: CalendarTokenStore;
  googleClient: GoogleCalendarClient;
  outlookClient: OutlookCalendarClient;
  calendarService: CalendarService;
}

const PROVIDERS = ['google', 'outlook'] as const;

export function createCalendarRoutes(deps: CalendarRouteDeps): Route[] {
  const { store, validateApiKey, limits, tokenStore, googleClient, outlookClient } = deps;

  return [
    {
      method: 'POST',
      path: '/api/v1/calendars',
      handler: async (request: Request, _ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const provider = body.provider as string | undefined;
        const accessToken = body.accessToken as string | undefined;
        const refreshToken = body.refreshToken as string | undefined;
        const autoSchedule = body.autoSchedule === true;

        if (!provider || !PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
          return err(ErrorCode.BAD_REQUEST, 'provider must be "google" or "outlook".');
        }
        if (!accessToken || typeof accessToken !== 'string') {
          return err(ErrorCode.BAD_REQUEST, 'accessToken is required.');
        }

        try {
          await checkCalendarCount(store, auth.namespace, limits);
        } catch (e) {
          return err(
            (e as import('recfn').RecFnError).code,
            (e as Error).message,
          );
        }

        const client = provider === 'google' ? googleClient : outlookClient;
        const valid = await client.validateToken(accessToken).catch(() => false);
        if (!valid) {
          return err(
            ErrorCode.CALENDAR_AUTH_FAILED,
            'Invalid or expired access token. Please re-authenticate.',
          );
        }

        const calendar = await store.createCalendar(
          { provider: provider as 'google' | 'outlook', autoSchedule },
          auth.namespace,
        );

        await tokenStore.set(calendar.id, {
          accessToken,
          refreshToken: typeof refreshToken === 'string' ? refreshToken : undefined,
        });

        return ok(calendar, 201);
      },
    },

    {
      method: 'GET',
      path: '/api/v1/calendars',
      handler: async (request: Request, _ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const calendars = await store.listCalendars(auth.namespace);
        return ok({ calendars });
      },
    },

    {
      method: 'DELETE',
      path: '/api/v1/calendars/:calendarId',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const calendarId = ctx.params.calendarId;

        const calendar = await store.getCalendar(calendarId, auth.namespace);
        if (!calendar) {
          return err(ErrorCode.CALENDAR_NOT_FOUND, 'Calendar not found.');
        }

        await tokenStore.delete(calendarId);
        await store.deleteCalendar(calendarId, auth.namespace);
        return ok({ calendarId, deleted: true });
      },
    },

    {
      method: 'GET',
      path: '/api/v1/calendars/:calendarId/events',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const calendarId = ctx.params.calendarId;

        const calendar = await store.getCalendar(calendarId, auth.namespace);
        if (!calendar) {
          return err(ErrorCode.CALENDAR_NOT_FOUND, 'Calendar not found.');
        }

        const tokens = await tokenStore.get(calendarId);
        if (!tokens) {
          return err(ErrorCode.CALENDAR_AUTH_FAILED, 'Calendar tokens not found.');
        }

        const url = new URL(request.url);
        const from = url.searchParams.get('from') ?? new Date().toISOString();
        const to = url.searchParams.get('to') ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        try {
          const events = await deps.calendarService.listEvents(calendarId, auth.namespace, {
            from,
            to,
          });
          return ok({ events });
        } catch (e) {
          return err(
            (e as import('recfn').RecFnError).code ?? ErrorCode.CALENDAR_AUTH_FAILED,
            e instanceof Error ? e.message : 'Failed to fetch calendar events.',
          );
        }
      },
    },
  ];
}
