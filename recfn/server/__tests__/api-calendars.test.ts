import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createRecFnServer,
  createMemoryStore,
  MemoryStorageAdapter,
  createMemoryTokenStore,
  createGoogleCalendarClient,
  createOutlookCalendarClient,
} from '../src/index.js';
import type { RecFnServer } from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';
import type { GoogleCalendarClient } from '../src/calendar/google.js';
import type { OutlookCalendarClient } from '../src/calendar/outlook.js';

const API_KEYS: Record<string, { namespace: string; apiKey: string }> = {
  'sk-valid-key': { namespace: 'ns_test', apiKey: 'sk-valid-key' },
};

function createTestServerWithCalendars(
  googleMock?: Partial<GoogleCalendarClient>,
  outlookMock?: Partial<OutlookCalendarClient>,
) {
  const store = createMemoryStore();
  const storage = new MemoryStorageAdapter();
  const tokenStore = createMemoryTokenStore();
  const googleClient = {
    ...createGoogleCalendarClient(),
    ...googleMock,
  };
  const outlookClient = {
    ...createOutlookCalendarClient(),
    ...outlookMock,
  };

  const server = createRecFnServer({
    store,
    storage,
    tokenStore,
    googleCalendarClient: googleClient,
    outlookCalendarClient: outlookClient,
    validateApiKey: (key: string) => API_KEYS[key] ?? null,
  });

  return { server, store, tokenStore };
}

function req(method: string, path: string, opts?: { body?: unknown; apiKey?: string }): Request {
  const headers: Record<string, string> = {
    Authorization: opts?.apiKey !== undefined && opts.apiKey !== '' ? `Bearer ${opts.apiKey}` : 'Bearer sk-valid-key',
  };
  if (opts?.body) headers['Content-Type'] = 'application/json';
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

describe('Calendar API routes', () => {
  let server: RecFnServer;
  let store: RecFnStore;

  beforeEach(() => {
    ({ server, store } = createTestServerWithCalendars({
      validateToken: vi.fn().mockResolvedValue(true),
      listEvents: vi.fn().mockResolvedValue([]),
    }, {
      validateToken: vi.fn().mockResolvedValue(true),
      listEvents: vi.fn().mockResolvedValue([]),
    }));
  });

  describe('POST /api/v1/calendars', () => {
    it('creates calendar with valid token (TV-CAL-001)', async () => {
      const res = await server.router.handle(
        req('POST', '/api/v1/calendars', {
          body: {
            provider: 'google',
            accessToken: 'ya29.valid-token',
            refreshToken: '1//valid-refresh',
            autoSchedule: true,
          },
        }),
      );

      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.ok).toBe(true);
      const data = body.data as { id: string; provider: string; autoSchedule: boolean; createdAt: string };
      expect(data.id).toMatch(/^cal_/);
      expect(data.provider).toBe('google');
      expect(data.autoSchedule).toBe(true);
      expect(data.createdAt).toBeDefined();
    });

    it('returns 401 CALENDAR_AUTH_FAILED for invalid token (TV-CAL-002)', async () => {
      ({ server } = createTestServerWithCalendars({
        validateToken: vi.fn().mockResolvedValue(false),
      }));

      const res = await server.router.handle(
        req('POST', '/api/v1/calendars', {
          body: {
            provider: 'google',
            accessToken: 'invalid-token',
            autoSchedule: false,
          },
        }),
      );

      expect(res.status).toBe(401);
      const body = await json(res);
      expect((body.error as { code: string }).code).toBe('CALENDAR_AUTH_FAILED');
    });
  });

  describe('GET /api/v1/calendars', () => {
    it('lists calendars', async () => {
      const res = await server.router.handle(req('GET', '/api/v1/calendars'));
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.ok).toBe(true);
      expect((body.data as { calendars: unknown[] }).calendars).toEqual([]);
    });
  });

  describe('DELETE /api/v1/calendars/:calendarId', () => {
    it('deletes calendar', async () => {
      const createRes = await server.router.handle(
        req('POST', '/api/v1/calendars', {
          body: { provider: 'google', accessToken: 'valid', autoSchedule: false },
        }),
      );
      const createData = (await json(createRes)).data as { id: string };
      const calId = createData.id;

      const res = await server.router.handle(req('DELETE', `/api/v1/calendars/${calId}`));
      expect(res.status).toBe(200);
      const body = await json(res);
      expect((body.data as { deleted: boolean }).deleted).toBe(true);
    });
  });

  describe('GET /api/v1/calendars/:calendarId/events', () => {
    it('returns events with meetingUrl (TV-CAL-003)', async () => {
      const listEventsMock = vi.fn().mockResolvedValue([
        {
          id: 'evt_001',
          summary: 'Team Standup',
          start: { dateTime: '2026-03-01T09:00:00Z' },
          end: { dateTime: '2026-03-01T09:30:00Z' },
          hangoutLink: 'https://zoom.us/j/999',
        },
      ]);

      ({ server } = createTestServerWithCalendars({
        validateToken: vi.fn().mockResolvedValue(true),
        listEvents: listEventsMock,
      }));

      const createRes = await server.router.handle(
        req('POST', '/api/v1/calendars', {
          body: { provider: 'google', accessToken: 'valid', autoSchedule: false },
        }),
      );
      const createData = (await json(createRes)).data as { id: string };
      const calId = createData.id;

      const res = await server.router.handle(
        req('GET', `/api/v1/calendars/${calId}/events?from=2026-03-01T00:00:00Z&to=2026-03-02T00:00:00Z`),
      );

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.ok).toBe(true);
      const events = (body.data as { events: unknown[] }).events;
      expect(events).toHaveLength(1);
      expect((events[0] as { id: string }).id).toBe('evt_001');
      expect((events[0] as { title: string }).title).toBe('Team Standup');
      expect((events[0] as { meetingUrl?: string }).meetingUrl).toBe('https://zoom.us/j/999');
    });
  });
});
