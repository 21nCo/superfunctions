import {
  AesGcmTokenCipher,
  EncryptedTokenVault,
  MemoryTokenVault,
  type OAuthTokenPayload,
  type TokenKeyResolver,
  type TokenVault,
} from '@superfunctions/oauth-storage';

export type CalendarTokens = {
  accessToken: string;
  refreshToken?: string;
};

export type CalendarTokenStore = {
  set(calendarId: string, tokens: CalendarTokens): Promise<void>;
  get(calendarId: string): Promise<CalendarTokens | null>;
  delete(calendarId: string): Promise<void>;
};

const CALENDAR_PROVIDER_ID = 'calendar';
const CALENDAR_SCOPE_TENANT = '__recfn_calendar_tenant__';
const CALENDAR_SCOPE_USER = '__recfn_calendar_user__';
const DEFAULT_KEY_REF = 'recfn-calendar-key-v1';

let hasWarnedLegacyMemoryStore = false;

export function createOAuthBackedCalendarTokenStore(input?: {
  tokenVault?: TokenVault;
  encryptionKey?: string;
  keyRef?: string;
  now?: () => Date;
}): CalendarTokenStore {
  const now = input?.now ?? (() => new Date());
  const keyRef = input?.keyRef ?? DEFAULT_KEY_REF;
  const vault = new EncryptedTokenVault(
    input?.tokenVault ?? new MemoryTokenVault(),
    new AesGcmTokenCipher(createDefaultTokenKeyResolver(input?.encryptionKey)),
    () => now().toISOString()
  );

  return {
    async set(calendarId: string, tokens: CalendarTokens): Promise<void> {
      await vault.putTokenSet({
        tokenId: calendarId,
        tenantId: CALENDAR_SCOPE_TENANT,
        userId: CALENDAR_SCOPE_USER,
        providerId: CALENDAR_PROVIDER_ID,
        connectionId: calendarId,
        tokenSet: toOAuthTokenPayload(tokens),
        keyRef,
      });
    },

    async get(calendarId: string): Promise<CalendarTokens | null> {
      const stored = await vault.getTokenSetByConnection(calendarId);
      if (!stored) {
        return null;
      }

      return {
        accessToken: stored.tokenSet.accessToken,
        refreshToken: stored.tokenSet.refreshToken,
      };
    },

    async delete(calendarId: string): Promise<void> {
      await vault.deleteByConnection(calendarId);
    },
  };
}

/**
 * @deprecated Use createOAuthBackedCalendarTokenStore() from this module.
 * Planned removal: recfn-server@0.2.0
 */
export function createMemoryTokenStore(): CalendarTokenStore {
  if (!hasWarnedLegacyMemoryStore) {
    hasWarnedLegacyMemoryStore = true;
    process.emitWarning(
      '[DEPRECATED_PATH] createMemoryTokenStore() is deprecated; use createOAuthBackedCalendarTokenStore() from recfn/server/src/calendar/token-store.ts. Planned removal: recfn-server@0.2.0.',
      'DeprecationWarning'
    );
  }

  return createOAuthBackedCalendarTokenStore();
}

function toOAuthTokenPayload(tokens: CalendarTokens): OAuthTokenPayload {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
}

function createDefaultTokenKeyResolver(encryptionKey?: string): TokenKeyResolver {
  const material = Buffer.from(
    (encryptionKey ?? process.env.RECFN_CALENDAR_TOKEN_KEY ?? 'recfn-calendar-dev-key').padEnd(32, '0').slice(0, 32),
    'utf8'
  );

  return async () => material;
}
