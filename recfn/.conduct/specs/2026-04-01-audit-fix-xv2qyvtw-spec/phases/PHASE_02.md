# Phase goal

Make transcript WebSockets namespace-safe and schema-consistent across the server and both SDKs.

## In scope / Out of scope

- In scope:
  - namespace binding during WS auth
  - canonical frame types
  - shared status payload shape
- Out of scope:
  - platform media capture
  - batch transcription changes

## Deliverables

- `recfn/server/src/ws/auth.ts`
- `recfn/server/src/ws/server.ts`
- `recfn/server/src/ws/frames.ts`
- `recfn/server/src/worker/lifecycle.ts`
- `recfn/client/src/ws.ts`
- `recfn/python/recfn/ws.py`
- `recfn/server/__tests__/ws-auth.test.ts`
- `recfn/server/__tests__/ws-transcript.test.ts`
- `recfn/client/__tests__/ws.test.ts`
- `recfn/python/tests/test_ws.py`

## Requirements covered

- `WS-001`
- `WS-002`

## Implementation tasks

1. Add a namespace lookup from `botId` before admitting WS subscriptions.
2. Make deferred auth and query-string auth share the same namespace check.
3. Define the canonical frame schema in a single shared source.
4. Update server emission and SDK parsing to use `botStatus`.
5. Add conformance tests across server, TypeScript SDK, and Python SDK.

## Verification steps

- `npm test --workspace recfn-server -- ws-auth ws-transcript`
- `npm test --workspace recfn-client -- ws`
- `PYTHONPATH=recfn/python python3 -m pytest recfn/python/tests/test_ws.py`

Expected outcome:

- Cross-namespace subscriptions fail.
- Canonical status frames pass in all SDK tests.

## Stop condition

Report back with the canonical WS frame schema and passing server plus SDK stream tests.

