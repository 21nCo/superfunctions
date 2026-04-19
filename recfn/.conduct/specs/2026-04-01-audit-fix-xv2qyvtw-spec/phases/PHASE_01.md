# Phase goal

Persist aggregate bot-related data and expose it through the corrected API contract.

## In scope / Out of scope

- In scope:
  - aggregate bot response
  - chat persistence
  - meeting metadata persistence
  - correct botId ownership on related records
- Out of scope:
  - WebSocket security
  - media capture fixes

## Deliverables

- `recfn/server/src/routes/bots.ts`
- `recfn/server/src/routes/chat.ts`
- `recfn/server/src/routes/metadata.ts`
- `recfn/server/src/worker/bot-worker.ts`
- `recfn/server/src/store/db.ts`
- `recfn/server/__tests__/api-bots.test.ts`
- `recfn/server/__tests__/api-chat.test.ts`
- `recfn/server/__tests__/api-metadata.test.ts`

## Requirements covered

- `API-001`
- `DATA-001`
- `BOT-002`

## Implementation tasks

1. Extend the durable store with write paths for chat messages and metadata snapshots.
2. Wire platform chat events into persistence.
3. Persist metadata updates during join, recording, leaving, and done states.
4. Make `GET /api/v1/bots/:botId` return the aggregate bot view.
5. Ensure participant, chat, metadata, and recording rows preserve the correct `botId` and namespace.
6. Add API tests for aggregate reads and dedicated child endpoints.

## Verification steps

- `npm exec --workspace recfn-server tsc --noEmit`
- `npm test --workspace recfn-server -- api-bots api-chat api-metadata`

Expected outcome:

- Aggregate and dedicated endpoints return persisted data.
- No placeholder metadata responses remain for existing bots.

## Stop condition

Report back with the aggregate response schema and passing API tests for bots, chat, and metadata.

