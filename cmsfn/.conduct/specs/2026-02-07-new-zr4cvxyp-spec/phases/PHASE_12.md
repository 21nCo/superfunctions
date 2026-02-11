# PHASE_12: Audit endpoints + Studio panes

## Phase goal

Implement audit endpoints for ContentFn events and webhook delivery status, and expose them in Studio panes without leaking raw document bodies.

## In scope

- Server endpoints:
  - `POST /cmsfn/audit/events`
  - `POST /cmsfn/audit/webhooks`
- Permission enforcement (`audit.read`)
- Deterministic ordering and pagination (opaque cursors)
- Studio panes:
  - Events viewer
  - Webhook deliveries viewer

## Out of scope

- Full diff viewer (optional; must be deterministic if implemented)

## Deliverables

- `cmsfn/server/src/http/audit.ts`
- `cmsfn/server/src/audit/events.ts`
- `cmsfn/server/src/audit/webhooks.ts`
- `cmsfn/studio/src/panes/audit/EventsPane.tsx`
- `cmsfn/studio/src/panes/audit/WebhooksPane.tsx`
- Tests implementing:
  - TV-AUDIT-EVENTS-001
  - TV-AUDIT-WEBHOOKS-001
  - TV-AUDIT-DENY-001
  - TV-DESK-PANES-001
  - TV-DESK-PANES-002

## Requirements covered

- AUDIT-001
- DESK-001

## Implementation tasks

1. Implement events endpoint:
   - fetch ContentFn events metadata
   - strip raw doc bodies
2. Implement webhooks endpoint:
   - fetch delivery attempt metadata
3. Implement deterministic ordering and pagination:
   - order by timestamp desc, id asc
4. Implement Studio panes and render lists deterministically.
5. Add tests for allow/deny and UI render ordering.

## Verification steps

- Run audit tests.
- Confirm no raw doc bodies are returned.

## Stop condition

- Audit endpoints and panes work deterministically and enforce permissions.

