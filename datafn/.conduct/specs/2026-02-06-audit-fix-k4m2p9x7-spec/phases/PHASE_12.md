## Phase goal

Ensure extension environments can inject a remote adapter and receive remote-originated events so `client.subscribe()` works across extension contexts without Flux mediators.

## In scope

- Define and implement a remote event propagation contract compatible with `sync.remoteAdapter`.
- Feed inbound remote events into the local event bus so signals/subscriptions behave the same as in-page usage.
- Ensure subscribe/unsubscribe lifecycle is leak-free and deterministic.
- Tests for extension RPC subscribe/unsubscribe behavior.

## Out of scope

- UI-specific extension wiring in Nucleus (Phase 13 consumer changes).

## Deliverables

- Modify:
  - `datafn/client/src/transport/extension.ts` (or existing extension transport)
  - `datafn/client/src/events/bus.ts` (if inbound injection point needed)
  - `datafn/client/src/client.ts` (wire adapter + inbound events)
- Add/modify tests:
  - `datafn/client/__tests__/extension-rpc.test.ts`
  - `datafn/client/__tests__/subscribe.test.ts`

## Requirements covered

- EXT-001

## Implementation tasks

- [ ] Define an optional capability on remote adapter for events:
  - Either:
    - extend adapter with `subscribeRemote(filter): { subscriptionId }` / `unsubscribeRemote(subscriptionId)`
    - and `onEvent(handler)` to deliver inbound events
  - Or provide a separate `remoteEvents` adapter injected alongside `remoteAdapter` (choose one; MUST be deterministic and documented).
- [ ] Wire inbound remote events:
  - decode remote event payload to canonical `DatafnEvent`
  - emit into local event bus (no double-emission for locally-originated events)
- [ ] Subscription lifecycle:
  - when first local subscriber with a filter is registered, open remote subscription
  - when the last subscriber for that remote subscription is removed, unsubscribe remotely
  - ensure deterministic mapping from filter → remote subscription key to enable dedupe
- [ ] Tests:
  - TV-EXT-001/TV-EXT-001N

## Verification steps

```bash
npm test -w @datafn/client
```

## Stop condition

Before starting Phase 13, report:

- The final remote event capability design (extended remoteAdapter vs separate adapter).
- Any browser API fallbacks required (BroadcastChannel availability, etc).

