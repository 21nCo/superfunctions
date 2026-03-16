# Calendar OAuth Migration Notes

This module migrated calendar OAuth token handling to shared OAuth packages in recfn-server 0.1.x.

Removal target for legacy shims: **recfn-server@0.2.0**.

## Path and API mapping

- Old: `createMemoryTokenStore()`
- New: `createOAuthBackedCalendarTokenStore()`

- Old: `refreshTokenIfNeeded(calendarId, tokenStore, provider)`
- New: `refreshCalendarToken({ calendarId, tokenStore, tokenHttpClient, provider })`

## Why this changed

- Calendar token storage now uses `@superfunctions/oauth-storage` primitives.
- Refresh flow now uses `@superfunctions/oauth-flow` with `@superfunctions/oauth-http` compatible clients.
- This removes duplicated local OAuth lifecycle logic and aligns with shared package behavior.

## Backward compatibility

- Legacy APIs still compile and run for one minor release.
- Legacy APIs emit runtime `DeprecationWarning` messages with replacement guidance.
