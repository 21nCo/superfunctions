import {
  createOAuthFlowService,
  type OAuthFlowProviderRuntimeConfig,
} from '@superfunctions/oauth-flow';
import type { OAuthTokenEndpointRequest, OAuthTokenHttpClient } from '@superfunctions/oauth-http';
import { MemoryOAuthStateStore, MemoryTokenVault, type TokenRecord } from '@superfunctions/oauth-storage';
import type { CalendarTokenStore } from './token-store.js';

export type TokenRefreshResult = {
  accessToken: string;
  refreshed: boolean;
};

export type TokenRefreshProvider = {
  refresh(refreshToken: string): Promise<{ accessToken: string }>;
};

let hasWarnedLegacyRefresh = false;

export async function refreshCalendarToken(input: {
  calendarId: string;
  tokenStore: CalendarTokenStore;
  tokenHttpClient: OAuthTokenHttpClient;
  provider: {
    id: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes?: string[];
  };
}): Promise<TokenRefreshResult | null> {
  const tokens = await input.tokenStore.get(input.calendarId);
  if (!tokens) {
    return null;
  }

  if (!tokens.refreshToken) {
    return { accessToken: tokens.accessToken, refreshed: false };
  }

  const nowIso = new Date().toISOString();
  const tokenVault = new MemoryTokenVault();
  const tokenRecord: TokenRecord = {
    tokenId: input.calendarId,
    tenantId: '__recfn_calendar_tenant__',
    userId: '__recfn_calendar_user__',
    providerId: input.provider.id,
    connectionId: input.calendarId,
    encryptedPayload: JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    }),
    keyRef: 'recfn-calendar-refresh',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await tokenVault.put(tokenRecord);

  const providerRuntimeConfig: Record<string, OAuthFlowProviderRuntimeConfig> = {
    [input.provider.id]: {
      clientId: input.provider.clientId,
      clientSecret: input.provider.clientSecret,
      allowlistedRedirectUris: [input.provider.redirectUri],
    },
  } as unknown as Record<string, OAuthFlowProviderRuntimeConfig>;

  const flow = createOAuthFlowService({
    providers: {
      [input.provider.id]: {
        id: input.provider.id,
        authorizationUrl: 'https://recfn.invalid/oauth/authorize',
        tokenUrl: input.provider.tokenUrl,
        defaultScopes: input.provider.scopes ?? [],
        supportsPkce: false,
        supportsRefreshToken: true,
        scopeSeparator: ' ',
        tokenAuthMethod: 'client_secret_post',
      },
    },
    providerRuntimeConfig,
    stateStore: new MemoryOAuthStateStore(),
    tokenVault,
    tokenHttpClient: input.tokenHttpClient,
  });

  try {
    const refreshed = await flow.refresh({
      connectionId: input.calendarId,
      providerId: input.provider.id,
      redirectUri: input.provider.redirectUri,
      scopes: input.provider.scopes,
    });

    await input.tokenStore.set(input.calendarId, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
    });

    return {
      accessToken: refreshed.accessToken,
      refreshed: true,
    };
  } catch {
    return null;
  }
}

/**
 * @deprecated Use refreshCalendarToken() from this module.
 * Planned removal: recfn-server@0.2.0
 */
export async function refreshTokenIfNeeded(
  calendarId: string,
  tokenStore: CalendarTokenStore,
  provider: TokenRefreshProvider,
): Promise<TokenRefreshResult | null> {
  if (!hasWarnedLegacyRefresh) {
    hasWarnedLegacyRefresh = true;
    process.emitWarning(
      '[DEPRECATED_PATH] refreshTokenIfNeeded() is deprecated; use refreshCalendarToken() from recfn/server/src/calendar/token-refresh.ts. Planned removal: recfn-server@0.2.0.',
      'DeprecationWarning'
    );
  }

  return refreshCalendarToken({
    calendarId,
    tokenStore,
    provider: {
      id: 'calendar-compat',
      tokenUrl: 'https://recfn.invalid/oauth/token',
      clientId: 'recfn-compat-client-id',
      clientSecret: 'recfn-compat-client-secret',
      redirectUri: 'https://recfn.invalid/oauth/callback',
    },
    tokenHttpClient: {
      exchangeToken: async (input: OAuthTokenEndpointRequest) => {
        if (input.grantType !== 'refresh_token' || !input.refreshToken) {
          throw new Error('Unsupported grant type for legacy calendar refresh provider');
        }

        const refreshed = await provider.refresh(input.refreshToken);
        return {
          accessToken: refreshed.accessToken,
        };
      },
      revokeToken: async () => {
        return;
      },
    },
  });
}
