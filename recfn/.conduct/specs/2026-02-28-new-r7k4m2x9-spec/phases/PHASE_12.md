# Phase 12: TypeScript client SDK

## Phase goal
Implement the TypeScript client SDK that wraps all REST API and WebSocket endpoints with typed methods.

## In scope
- RecFn client class with constructor (baseUrl, apiKey).
- Namespaced methods: bots, recordings, transcripts, participants, chat, analytics, calendars, webhooks.
- WebSocket streaming helper: transcripts.stream(botId).
- Typed return values matching API envelope.
- Error handling: return envelope, don't throw for expected errors.

## Out of scope
- Python SDK. CLI.

## Deliverables
- `recfn/client/package.json`
- `recfn/client/tsconfig.json`
- `recfn/client/src/index.ts` — RecFn class, barrel export
- `recfn/client/src/client.ts` — HTTP client (fetch wrapper with auth header)
- `recfn/client/src/resources/bots.ts` — bots resource methods
- `recfn/client/src/resources/recordings.ts` — recordings resource methods
- `recfn/client/src/resources/transcripts.ts` — transcripts resource methods
- `recfn/client/src/resources/participants.ts` — participants resource methods
- `recfn/client/src/resources/chat.ts` — chat resource methods
- `recfn/client/src/resources/analytics.ts` — analytics resource methods
- `recfn/client/src/resources/calendars.ts` — calendars resource methods
- `recfn/client/src/resources/webhooks.ts` — webhooks resource methods
- `recfn/client/src/ws.ts` — WebSocket stream helper
- `recfn/client/__tests__/client.test.ts`
- `recfn/client/__tests__/ws.test.ts`

## Requirements covered
- SDK-001, SDK-003

## Implementation tasks
1. Create `recfn/client/` with package.json (deps: recfn-core).
2. Implement HTTP client: fetch wrapper that adds Authorization header, parses JSON response into typed envelope.
3. Implement bots resource: create, get, list, leave, delete methods.
4. Implement recordings resource: list, get, downloadUrl, download methods.
5. Implement transcripts resource: get (with format), transcribe, search methods.
6. Implement participants, chat, analytics, calendars, webhooks resources.
7. Implement WebSocket stream helper: connect to WS /ws/transcripts/:botId, emit typed events (segment, participant_joined, etc.), handle ping/pong, auto-reconnect on disconnect.
8. Implement error handling: all methods return `{ ok, data } | { ok, error }`, no exceptions for API errors.
9. Write tests: mock HTTP responses, verify typed returns, test error handling, test WS connection.

## Verification steps
- `cd recfn/client && npm install && npm run build` — builds.
- `cd recfn/client && npx vitest run` — all tests pass.
- Tests cover: TV-SDK-001, TV-SDK-003.

## Stop condition
- Client SDK wraps all API endpoints with typed methods. WebSocket helper works. Error handling returns envelopes. All tests pass. Report: "Phase 12 complete; TypeScript SDK ready for Phase 13."
