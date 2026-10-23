# Phase 01: Server foundation — DB schema, store, API skeleton

## Phase goal
Deliver the recfn server with API routes for bot CRUD (without actual bot joining), authentication middleware, namespace isolation, and envelope responses.

## In scope
- Server package setup with @superfunctions/http and @superfunctions/db.
- DB schema for bots, recordings, transcripts, participants, chat messages, meeting metadata.
- In-memory store for development/testing.
- API routes: POST /bots, GET /bots, GET /bots/:botId, POST /bots/:botId/leave, DELETE /bots/:botId.
- API routes: GET /bots/:botId/recordings, GET /recordings/:recordingId, GET /bots/:botId/participants, GET /bots/:botId/chat, GET /bots/:botId/metadata.
- Auth middleware (API key → namespace).
- Envelope response helper.
- Error handling middleware.

## Out of scope
- Bot worker, flowfn, platform adapters, ASR, recording storage, WebSocket, webhooks, calendar.

## Deliverables
- `recfn/server/package.json`
- `recfn/server/tsconfig.json`
- `recfn/server/vitest.config.ts`
- `recfn/server/src/index.ts` — server entry + createRecFnServer factory
- `recfn/server/src/store/types.ts` — store interface
- `recfn/server/src/store/memory.ts` — in-memory store implementation
- `recfn/server/src/middleware/auth.ts` — API key auth middleware
- `recfn/server/src/middleware/envelope.ts` — response envelope helper
- `recfn/server/src/routes/bots.ts` — bot CRUD routes
- `recfn/server/src/routes/recordings.ts` — recording routes (stubs)
- `recfn/server/src/routes/transcripts.ts` — transcript routes (stubs)
- `recfn/server/src/routes/participants.ts` — participant routes
- `recfn/server/src/routes/chat.ts` — chat routes
- `recfn/server/src/routes/metadata.ts` — metadata routes
- `recfn/server/__tests__/api-bots.test.ts`
- `recfn/server/__tests__/api-auth.test.ts`
- `recfn/server/__tests__/api-namespace.test.ts`

## Requirements covered
- BOT-001, BOT-003, BOT-005, BOT-006, BOT-007, API-001, API-002, API-003, API-004, API-005, API-006, SEC-001, SEC-002

## Implementation tasks
1. Create `recfn/server/` with package.json (deps: @superfunctions/http, @superfunctions/db, recfn-core).
2. Define store interface: createBot, getBot, listBots, updateBot, deleteBot, and similar for recordings/transcripts/participants/chat/metadata.
3. Implement in-memory store.
4. Implement auth middleware: extract Bearer token, validate via secfn (or mock for dev), derive namespace.
5. Implement envelope response helper: `ok(data)` → `{ ok: true, data }`, `err(code, message)` → `{ ok: false, error: { code, message } }`.
6. Implement POST /bots route: validate body, validate URL (core validator), create bot with status "creating", return 201.
7. Implement GET /bots route: list with pagination (limit, cursor, status filter, platform filter).
8. Implement GET /bots/:botId: return bot or 404.
9. Implement POST /bots/:botId/leave: validate status, transition to "leaving", or 409/404.
10. Implement DELETE /bots/:botId: validate terminal state, delete cascade, or 409/404.
11. Implement stub routes for recordings, transcripts, participants, chat, metadata (return data from store).
12. Write tests: bot CRUD, auth (missing key, invalid key), namespace isolation, pagination, error envelopes.

## Verification steps
- `cd recfn/server && npm install && npm run build` — builds without errors.
- `cd recfn/server && npx vitest run` — all tests pass.
- Tests cover: TV-BOT-001, TV-BOT-002, TV-BOT-004, TV-BOT-005, TV-BOT-007, TV-BOT-008, TV-BOT-009, TV-API-001–005.

## Stop condition
- Server starts, API routes return correct envelopes, auth works, namespace isolation enforced. All tests pass. Report: "Phase 01 complete; server API skeleton ready for Phase 02."
