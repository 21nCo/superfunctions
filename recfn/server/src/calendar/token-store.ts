/**
 * OAuth token storage for calendar integrations.
 * Can be implemented with in-memory (tests) or secfn vault (production).
 */
export interface CalendarTokens {
  accessToken: string;
  refreshToken?: string;
}

export interface CalendarTokenStore {
  set(calendarId: string, tokens: CalendarTokens): Promise<void>;
  get(calendarId: string): Promise<CalendarTokens | null>;
  delete(calendarId: string): Promise<void>;
}

export function createMemoryTokenStore(): CalendarTokenStore {
  const store = new Map<string, CalendarTokens>();

  return {
    async set(calendarId: string, tokens: CalendarTokens): Promise<void> {
      store.set(calendarId, { ...tokens });
    },
    async get(calendarId: string): Promise<CalendarTokens | null> {
      const t = store.get(calendarId);
      return t ? { ...t } : null;
    },
    async delete(calendarId: string): Promise<void> {
      store.delete(calendarId);
    },
  };
}
