import { describe, expect, it, vi } from 'vitest';
import {
  createCalendarService,
  createGoogleCalendarClient,
  createMemoryStore,
  createMemoryTokenStore,
  createOutlookCalendarClient,
  createRecFnServer,
  MemoryLogger,
  MemoryStorageAdapter,
} from '../src/index.js';
import { refreshCalendarToken, refreshTokenIfNeeded } from '../src/calendar/token-refresh.js';

describe('Calendar token refresh', () => {
  it('returns existing token when refresh not needed', async () => {
    const tokenStore = createMemoryTokenStore();
    await tokenStore.set('cal_1', { accessToken: 'valid-token' });

    const result = await refreshTokenIfNeeded(
      'cal_1',
      tokenStore,
      { refresh: vi.fn() },
    );

    expect(result).toEqual({ accessToken: 'valid-token', refreshed: false });
  });

  it('refreshes token and stores new access token', async () => {
    const tokenStore = createMemoryTokenStore();
    await tokenStore.set('cal_1', {
      accessToken: 'expired',
      refreshToken: 'refresh-123',
    });

    const refreshMock = vi.fn().mockResolvedValue({ accessToken: 'new-token' });

    const result = await refreshTokenIfNeeded('cal_1', tokenStore, {
      refresh: refreshMock,
    });

    expect(result).toEqual({ accessToken: 'new-token', refreshed: true });
    expect(refreshMock).toHaveBeenCalledWith('refresh-123');

    const stored = await tokenStore.get('cal_1');
    expect(stored?.accessToken).toBe('new-token');
    expect(stored?.refreshToken).toBe('refresh-123');
  });

  it('refreshes token via shared oauth-flow path', async () => {
    const tokenStore = createMemoryTokenStore();
    await tokenStore.set('cal_1', {
      accessToken: 'expired',
      refreshToken: 'refresh-123',
    });

    const tokenHttpClient = {
      exchangeToken: vi.fn().mockResolvedValue({
        accessToken: 'new-token',
      }),
      revokeToken: vi.fn().mockResolvedValue(undefined),
    };

    const result = await refreshCalendarToken({
      calendarId: 'cal_1',
      tokenStore,
      tokenHttpClient,
      provider: {
        id: 'google',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
        redirectUri: 'https://app.example.com/oauth/callback',
      },
    });

    expect(result).toEqual({ accessToken: 'new-token', refreshed: true });
    expect(tokenHttpClient.exchangeToken).toHaveBeenCalledTimes(1);
  });

  it('refreshes expired calendar credentials automatically in route flows (TV-CAL-001)', async () => {
    const store = createMemoryStore();
    const storage = new MemoryStorageAdapter();
    const tokenStore = createMemoryTokenStore();
    const logger = new MemoryLogger();
    const calendar = await store.createCalendar(
      { provider: 'google', autoSchedule: true },
      'ns_test',
    );

    await tokenStore.set(calendar.id, {
      accessToken: 'expired-token',
      refreshToken: 'refresh-123',
    });

    const googleClient = {
      ...createGoogleCalendarClient(),
      validateToken: vi.fn().mockResolvedValue(true),
      listEvents: vi.fn().mockImplementation(async (accessToken: string) => {
        if (accessToken === 'expired-token') {
          throw new Error('token expired');
        }

        return [
          {
            id: 'evt_001',
            summary: 'Team Standup',
            start: { dateTime: '2026-03-01T09:00:00Z' },
            end: { dateTime: '2026-03-01T09:30:00Z' },
            hangoutLink: 'https://zoom.us/j/999',
          },
        ];
      }),
    };

    const server = createRecFnServer({
      store,
      storage,
      tokenStore,
      logger,
      googleCalendarClient: googleClient,
      outlookCalendarClient: createOutlookCalendarClient(),
      calendarTokenHttpClient: {
        exchangeToken: vi.fn().mockResolvedValue({ accessToken: 'new-token' }),
        revokeToken: vi.fn().mockResolvedValue(undefined),
      },
      calendarRefreshProviders: {
        google: {
          id: 'google',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          clientId: 'google-client-id',
          clientSecret: 'google-client-secret',
          redirectUri: 'https://app.example.com/oauth/callback',
        },
      },
      validateApiKey: (key: string) =>
        key === 'sk-valid-key'
          ? { namespace: 'ns_test', apiKey: 'sk-valid-key' }
          : null,
    });

    const res = await server.router.handle(
      new Request(
        `http://localhost/api/v1/calendars/${calendar.id}/events?from=2026-03-01T00:00:00Z&to=2026-03-02T00:00:00Z`,
        {
          method: 'GET',
          headers: { Authorization: 'Bearer sk-valid-key' },
        },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { events: Array<{ id: string; meetingUrl?: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.events).toEqual([
      expect.objectContaining({
        id: 'evt_001',
        meetingUrl: 'https://zoom.us/j/999',
      }),
    ]);

    const stored = await tokenStore.get(calendar.id);
    expect(stored?.accessToken).toBe('new-token');
    expect(logger.findByEvent('calendar.token_refresh.success')).toHaveLength(1);
  });

  it('logs refresh failures and skips scheduling with stale credentials', async () => {
    const store = createMemoryStore();
    const tokenStore = createMemoryTokenStore();
    const logger = new MemoryLogger();
    const now = Date.now();
    const calendar = await store.createCalendar(
      { provider: 'google', autoSchedule: true },
      'ns_test',
    );

    await tokenStore.set(calendar.id, {
      accessToken: 'expired-token',
      refreshToken: 'bad-refresh',
    });

    const service = createCalendarService({
      store,
      tokenStore,
      logger,
      now: () => new Date(now),
      googleClient: {
        ...createGoogleCalendarClient(),
        listEvents: vi.fn().mockRejectedValue(new Error('token expired')),
      },
      outlookClient: createOutlookCalendarClient(),
      tokenHttpClient: {
        exchangeToken: vi.fn().mockRejectedValue(new Error('invalid refresh token')),
        revokeToken: vi.fn().mockResolvedValue(undefined),
      },
      refreshProviders: {
        google: {
          id: 'google',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          clientId: 'google-client-id',
          clientSecret: 'google-client-secret',
          redirectUri: 'https://app.example.com/oauth/callback',
        },
      },
    });

    const result = await service.pollNamespace('ns_test', {
      leadTimeMs: 60_000,
    });

    expect(result.botsCreated).toBe(0);
    expect((await store.listBots('ns_test', {})).items).toHaveLength(0);
    const refreshFailures = logger.findByEvent('calendar.token_refresh.failed');
    expect(refreshFailures).toHaveLength(1);
    expect(refreshFailures[0]?.data).toMatchObject({
      namespace: 'ns_test',
      calendarId: calendar.id,
      provider: 'google',
      reason: 'refresh_failed',
    });
  });

  it('returns null when refresh fails (TV-CAL-005)', async () => {
    const tokenStore = createMemoryTokenStore();
    await tokenStore.set('cal_1', {
      accessToken: 'expired',
      refreshToken: 'invalid-refresh',
    });

    const refreshMock = vi.fn().mockRejectedValue(new Error('Invalid refresh token'));

    const result = await refreshTokenIfNeeded('cal_1', tokenStore, {
      refresh: refreshMock,
    });

    expect(result).toBeNull();
  });
});
