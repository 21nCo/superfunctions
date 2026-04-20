# Phase goal

Make transcript search and calendar scheduling production-safe.

## In scope / Out of scope

- In scope:
  - participant-aware search hits
  - deterministic search context windows
  - runtime scheduler/token refresh services
- Out of scope:
  - CLI and Python parity

## Deliverables

- `recfn/server/src/routes/search.ts`
- `recfn/server/src/search/indexer.ts`
- `recfn/server/src/calendar/scheduler.ts`
- `recfn/server/src/calendar/token-refresh.ts`
- `recfn/server/src/calendar/service.ts`
- `recfn/server/src/routes/calendars.ts`
- `recfn/server/src/index.ts`
- `recfn/server/__tests__/api-search.test.ts`
- `recfn/server/__tests__/calendar-scheduler.test.ts`
- `recfn/server/__tests__/calendar-token-refresh.test.ts`

## Requirements covered

- `SEARCH-001`
- `CAL-001`

## Implementation tasks

1. Extend search hits with participant info and stable context windows.
2. Ensure context lookup uses the persisted transcript ordering.
3. Introduce an explicit calendar runtime service that polls and schedules.
4. Wire token refresh into the runtime service and route flows.
5. Add tests for search shaping and runtime scheduling behavior.

## Verification steps

- `npm test --workspace recfn-server -- api-search calendar-scheduler calendar-token-refresh`

Expected outcome:

- Search results include participant data and stable context.
- Calendar scheduling and refresh logic run as real services.

## Stop condition

Report back with the runtime calendar service entry points and passing search/calendar tests.

