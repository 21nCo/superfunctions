import { describe, it, expect, vi } from 'vitest';
import { createMemoryTokenStore } from '../src/index.js';
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
