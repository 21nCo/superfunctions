import type { CalendarTokenStore } from './token-store.js';

export interface TokenRefreshResult {
  accessToken: string;
  refreshed: boolean;
}

export interface TokenRefreshProvider {
  refresh(refreshToken: string): Promise<{ accessToken: string }>;
}

export async function refreshTokenIfNeeded(
  calendarId: string,
  tokenStore: CalendarTokenStore,
  provider: TokenRefreshProvider,
): Promise<TokenRefreshResult | null> {
  const tokens = await tokenStore.get(calendarId);
  if (!tokens) return null;
  if (!tokens.refreshToken) return { accessToken: tokens.accessToken, refreshed: false };

  try {
    const { accessToken } = await provider.refresh(tokens.refreshToken);
    await tokenStore.set(calendarId, {
      accessToken,
      refreshToken: tokens.refreshToken,
    });
    return { accessToken, refreshed: true };
  } catch {
    return null;
  }
}
