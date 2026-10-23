# Phase 08: Webhook events via plugfn

## Phase goal
Implement webhook CRUD and event delivery for all bot lifecycle events via plugfn, with HMAC signing and retry.

## In scope
- Webhook CRUD routes: POST /webhooks, GET /webhooks, DELETE /webhooks/:webhookId.
- Webhook event delivery for: bot.joining, bot.joined, bot.left, bot.error, recording.ready, transcript.ready, participant.joined, participant.left.
- HMAC-SHA256 signing (X-RecFn-Signature header).
- At-least-once delivery with retry via plugfn.
- Unique eventId per delivery for consumer deduplication.

## Out of scope
- Calendar webhooks. New platforms. Desktop.

## Deliverables
- `recfn/server/src/routes/webhooks.ts` — webhook CRUD routes
- `recfn/server/src/webhooks/deliver.ts` — event delivery logic
- `recfn/server/src/webhooks/sign.ts` — HMAC signing
- `recfn/server/src/webhooks/events.ts` — event type definitions and payload builders
- `recfn/server/src/integrations/plugfn.ts` — plugfn client wrapper
- `recfn/server/__tests__/api-webhooks.test.ts`
- `recfn/server/__tests__/webhook-delivery.test.ts`
- `recfn/server/__tests__/webhook-signing.test.ts`

## Requirements covered
- WH-001, WH-002, WH-003, WH-004, INT-004

## Implementation tasks
1. Implement webhook store: create, list, delete, query by namespace and event type.
2. Implement POST /webhooks route: validate body (url, events array, optional secret), create webhook, return 201.
3. Implement GET /webhooks: list webhooks for namespace.
4. Implement DELETE /webhooks/:webhookId: delete webhook.
5. Implement HMAC signing: hmac-sha256(secret, JSON.stringify(payload)), set X-RecFn-Signature header.
6. Implement event delivery: on lifecycle event, query matching webhooks, build payload (event, eventId, timestamp, data), sign if secret, deliver via plugfn.
7. Hook into bot worker: fire bot.joining/joined/left/error at each transition.
8. Hook into recording pipeline: fire recording.ready after upload.
9. Hook into transcription pipeline: fire transcript.ready after processing.
10. Hook into participant tracking: fire participant.joined/left.
11. Implement retry via plugfn retry policy (at-least-once).
12. Write tests: webhook CRUD, event delivery with signing, retry on failure, eventId uniqueness.

## Verification steps
- `cd recfn/server && npx vitest run` — all webhook tests pass.
- Tests cover: TV-WH-001, TV-WH-002, TV-WH-003, TV-WH-004, TV-WH-005, TV-INT-003.

## Stop condition
- Webhook CRUD works. Events delivered at each lifecycle point. HMAC signing correct. Retry works. All tests pass. Report: "Phase 08 complete; webhooks ready for Phase 09."
