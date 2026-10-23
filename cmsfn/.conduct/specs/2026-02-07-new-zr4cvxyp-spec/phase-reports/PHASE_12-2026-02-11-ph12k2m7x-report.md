# PHASE_12 Completion Report: Audit endpoints + Studio panes

**Spec**: 2026-02-07-new-zr4cvxyp-spec  
**Phase**: PHASE_12  
**Date**: 2026-02-11  

## Summary

Implemented audit endpoints for ContentFn events and webhook delivery status. CmsFn calls ContentFn at POST /contentfn/audit/events and /contentfn/audit/webhooks (contract defined; ContentFn implementation can be added separately). Responses are UI-safe: event metadata without raw document bodies; delivery status with webhookId, status, attempt, timestamps. Permission: audit.read. Deterministic ordering and pagination (opaque cursor). Studio EventsPane and WebhooksPane list data and show deterministic "no access" when hasAuditRead is false.

## Requirements

- **AUDIT-001**: Audit surface for ContentFn events and webhook delivery status; no raw document bodies; unauthorized access denied.
- **DESK-001**: Audit/webhook viewer panes (EventsPane, WebhooksPane).

## Deliverables

### CmsFn Server

- **server/src/audit/events.ts** — contentfnAuditEvents(config, { dataset, limit?, cursor? }): POST to ContentFn /contentfn/audit/events; map response to UI-safe CmsfnAuditEvent (document only _id, _type, _rev); return { events, nextCursor }.
- **server/src/audit/webhooks.ts** — contentfnAuditWebhooks(config, { dataset, limit?, cursor? }): POST to ContentFn /contentfn/audit/webhooks; return { deliveries, nextCursor }.
- **server/src/http/audit.ts** — handleAuditEvents, handleAuditWebhooks; body validation; allowedDatasets; requireAuditRead (audit.read); call contentfn audit; pass through errors.
- **server/src/index.ts** — POST /cmsfn/audit/events, POST /cmsfn/audit/webhooks.

### CmsFn Studio

- **studio/src/panes/audit/EventsPane.tsx** — List events (type, timestamp, document._id); Load more (cursor); hasAuditRead=false → data-audit-denied, "No access".
- **studio/src/panes/audit/WebhooksPane.tsx** — List deliveries (status, attempt, updatedAt); Load more; hasAuditRead=false → no access.

### Tests

- **server/src/__tests__/audit.test.ts** — TV-AUDIT-EVENTS-001 (events list without raw body), TV-AUDIT-WEBHOOKS-001 (deliveries with webhookId, status, attempt, timestamps), TV-AUDIT-DENY-001 (no audit.read → PERMISSION_DENIED).
- **studio/src/__tests__/auditPanes.test.tsx** — TV-DESK-PANES-002 (WebhooksPane renders deliveries), TV-DESK-PANES-002 negative (EventsPane/WebhooksPane hasAuditRead=false → no access).

## Test status

- TV-AUDIT-EVENTS-001: PASS  
- TV-AUDIT-WEBHOOKS-001: PASS  
- TV-AUDIT-DENY-001: PASS  
- TV-DESK-PANES-002: PASS (pane + no-access variant)

## Verification

- cmsfn/server: npm run build && npm run test — 28 tests (all pass).
- cmsfn/studio: npm run build && npm run test — 34 tests (all pass).

## Notes

- ContentFn is expected to expose POST /contentfn/audit/events and /contentfn/audit/webhooks with body { dataset, limit?, cursor? } and response { events/deliveries, nextCursor }. Until then, CmsFn returns ContentFn errors (e.g. 404) to the client.
- TV-DESK-PANES-001 (history pane / revisions) is a separate pane (ContentFn docs.history); not implemented in this phase.

## Ready for next phase?

Yes — audit endpoints and Events/Webhooks panes work deterministically with permission enforcement.
