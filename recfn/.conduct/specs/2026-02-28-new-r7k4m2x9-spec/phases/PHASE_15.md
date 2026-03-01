# Phase 15: Calendar integration

## Phase goal
Implement calendar integration for Google Calendar and Outlook, including auto-scheduling of bots for upcoming meetings.

## In scope
- Calendar CRUD routes: POST /calendars, GET /calendars, DELETE /calendars/:calendarId, GET /calendars/:calendarId/events.
- Google Calendar API integration (list events, detect meeting URLs).
- Microsoft Graph Calendar API integration (list events, detect meeting URLs).
- Auto-scheduling: create bots for upcoming events with meeting URLs.
- Token refresh for long-lived integrations.
- Token storage in secfn.

## Out of scope
- Desktop. New platforms. New ASR adapters.

## Deliverables
- `recfn/server/src/routes/calendars.ts` — calendar CRUD and events routes
- `recfn/server/src/calendar/google.ts` — Google Calendar API client
- `recfn/server/src/calendar/outlook.ts` — Outlook/Graph Calendar API client
- `recfn/server/src/calendar/scheduler.ts` — auto-scheduling logic (poll events, create bots)
- `recfn/server/src/calendar/token-refresh.ts` — OAuth token refresh logic
- `recfn/server/__tests__/api-calendars.test.ts`
- `recfn/server/__tests__/calendar-scheduler.test.ts`
- `recfn/server/__tests__/calendar-token-refresh.test.ts`

## Requirements covered
- CAL-001, CAL-002, CAL-003, CAL-004

## Implementation tasks
1. Implement calendar store: create, list, delete, get by calendarId. Store OAuth tokens in secfn.
2. Implement POST /calendars: validate provider, validate token by making test API call, store calendar entity.
3. Implement GET /calendars: list calendars for namespace.
4. Implement DELETE /calendars/:calendarId: remove calendar and stored tokens.
5. Implement Google Calendar API client: list events with time range, extract meeting URLs from event descriptions/conferenceData.
6. Implement Outlook Calendar API client: list events via Graph API, extract Teams meeting URLs.
7. Implement GET /calendars/:calendarId/events: fetch events from provider API, return with meetingUrl and botId (if auto-scheduled).
8. Implement scheduler: periodic poll (configurable interval, default 5min), find events starting within lead time (default 1min), create bots for events with meeting URLs, update CalendarEvent.botId.
9. Implement token refresh: on 401 from provider API, attempt refresh with stored refresh token. On failure, mark calendar as "expired".
10. Write tests: calendar CRUD, event listing with mock API, auto-scheduling, token refresh, token refresh failure.

## Verification steps
- `cd recfn/server && npx vitest run` — all calendar tests pass.
- Tests cover: TV-CAL-001, TV-CAL-002, TV-CAL-003, TV-CAL-004, TV-CAL-005.

## Stop condition
- Calendar CRUD works. Events listed from mock provider. Auto-scheduling creates bots. Token refresh works. All tests pass. Report: "Phase 15 complete; calendar integration ready for Phase 16."
