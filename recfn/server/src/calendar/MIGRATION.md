# Calendar Migration Notes

This module migrated calendar scheduling and OAuth token handling to the shared runtime/service path in `recfn-server@0.1.x`.

Removal target for legacy shims: **recfn-server@0.2.0**.

## Path and API mapping

- Old: `createMemoryTokenStore()`
- New: `createOAuthBackedCalendarTokenStore()`

- Old: `refreshTokenIfNeeded(calendarId, tokenStore, provider)`
- New: `refreshCalendarToken({ calendarId, tokenStore, tokenHttpClient, provider })`

- Old: direct helper-only polling via `pollAndSchedule(...)`
- New: `createCalendarService(...)` and `createCalendarRuntimeService(...)`

## Why this changed

- Calendar token storage now uses shared OAuth-backed storage primitives instead of local-only token handling.
- Refresh flow now uses `@superfunctions/oauth-flow` with `@superfunctions/oauth-http` compatible clients.
- Route handlers and runtime polling now share the same service entry point, so token refresh, namespace checks, and scheduling decisions are consistent.
- Scheduler observability is now explicit: namespace-scoped logs remain, and `recfn.calendar.schedule_decision` metrics are emitted for poll, create, skip, and failure outcomes.

## Backward compatibility

- Existing HTTP route paths remain stable.
- `pollAndSchedule(...)` remains available for direct callers, but new integrations should prefer `createCalendarService(...)`.
- Legacy APIs still compile and run for one minor release.
- Legacy APIs emit runtime `DeprecationWarning` messages with replacement guidance.

## Migration guidance

- If you previously refreshed tokens inside route code, move that logic behind `createCalendarService(...)` so refresh behavior is centralized.
- If you previously scheduled events with ad hoc polling loops, replace them with `createCalendarRuntimeService(...)` so duplicate-event suppression and scheduling telemetry stay intact.
- If you consume calendar scheduling outcomes operationally, switch alerts and dashboards to the structured `calendar.schedule.*` logs and `recfn.calendar.schedule_decision` metric family.
