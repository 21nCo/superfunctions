# PHASE_09: Webhooks (register/list/delete + delivery engine)

## Phase goal

Implement webhook registration and reliable delivery with signatures and deterministic retry behavior.

## In scope

- HTTP endpoints:
  - `POST /contentfn/webhooks/register`
  - `POST /contentfn/webhooks/list`
  - `POST /contentfn/webhooks/delete`
- Delivery engine:
  - enqueue events on doc/asset changes
  - deliver HTTP POST to webhook URL with canonical payload
  - HMAC signature header when secret configured
  - retry with exponential backoff up to a configured max
- Observability for failures (logged + queryable for admins)

## Out of scope

- Admin UI for webhooks (belongs to `cmsfn`)

## Deliverables

- `contentfn/server/src/http/endpoints/webhooks.ts`
- `contentfn/server/src/webhooks/deliver.ts` (delivery runner)
- `contentfn/server/src/webhooks/sign.ts` (HMAC signature)
- `contentfn/server/src/storage/webhooks.ts` (registrations)
- `contentfn/server/src/storage/webhookQueue.ts` (queue persistence)
- Tests implementing:
  - TV-WH-REGISTER-001
  - TV-WH-REGISTER-002
  - TV-WH-DELIVERY-001

## Requirements covered

- WH-001
- OBS-001 (partial: failure logs)

## Implementation tasks

1. Implement webhook register/list/delete with URL validation.
2. Implement event enqueueing:
   - on `doc.published` (PHASE_04) and other events
   - write to webhook queue with attempt=0 and nextRunAt=now
3. Implement delivery runner:
   - fetch due queue rows
   - send POST with canonical payload
   - on success mark delivered
   - on failure increment attempt and schedule nextRunAt with deterministic exponential backoff
4. Implement HMAC signature:
   - `X-ContentFn-Signature: v1=<hex>`
5. Add an integration test with a local webhook receiver fixture verifying payload schema and signature header.

## Verification steps

- Run webhook tests; confirm register validation and delivery behavior.
- Simulate transient failure and confirm retry scheduling is deterministic.

## Stop condition

- Webhooks pass referenced TVs and delivery failures are observable.

