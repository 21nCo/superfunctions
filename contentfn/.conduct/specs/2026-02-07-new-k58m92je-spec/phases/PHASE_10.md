# PHASE_10: Realtime feed (subscriptions + event streaming)

## Phase goal

Implement realtime event streaming for document and dataset events suitable for live preview and tooling.

## In scope

- Realtime transport selection and implementation (WebSocket preferred; SSE acceptable if documented).
- Subscription protocol:
  - subscribe to dataset events
  - subscribe to a specific document ID
- Event messages include: `eventId`, `type`, `dataset`, `timestamp`, and `document` identifiers where applicable.
- Authorization enforcement for realtime subscribe actions.

## Out of scope

- Collaborative presence semantics (may be added later only if explicitly required; otherwise undefined for now).

## Deliverables

- `contentfn/server/src/realtime/server.ts` (transport server)
- `contentfn/server/src/realtime/protocol.ts` (message shapes)
- `contentfn/server/src/realtime/subscribe.ts` (routing)
- Integration hooks from event log append to realtime broadcast
- Tests implementing:
  - TV-RT-SUBSCRIBE-001
  - TV-RT-SUBSCRIBE-002
  - TV-RT-EVENTS-001

## Requirements covered

- RT-001
- AUTH-001 (partial: realtime authorization)

## Implementation tasks

1. Define realtime message envelope and subscription commands (JSON):
   - `{ type:"subscribe", dataset, docId? }`
   - `{ type:"event", eventId, dataset, timestamp, eventType, document? }`
2. Implement server accepting connections and handling subscribe/unsubscribe.
3. Enforce authorization on subscribe:
   - when denied return an error message envelope OR close connection deterministically
4. Broadcast events to matching subscribers on publish/patch/unpublish.
5. Add integration test:
   - connect
   - subscribe to a document
   - mutate/publish
   - assert receipt of event messages with required fields

## Verification steps

- Run realtime tests and confirm deterministic denial behavior when unauthorized.
- Confirm event messages contain required fields and correct `dataset`.

## Stop condition

- Realtime feed passes referenced TVs and integrates with server mutation events.

