# PHASE_04: Publish / unpublish + event emission baseline

## Phase goal

Implement draft publishing and unpublishing with atomic semantics and baseline event emission to the internal event log.

## In scope

- HTTP endpoints:
  - `POST /contentfn/docs/publish`
  - `POST /contentfn/docs/unpublish`
- Draft → published mapping (remove `drafts.` prefix)
- `_publishedAt` handling
- Internal event log append for:
  - `doc.published`
  - `doc.unpublished`

## Out of scope

- Webhook delivery (PHASE_09)
- Realtime transport (PHASE_10)

## Deliverables

- `contentfn/server/src/http/endpoints/publish.ts`
- `contentfn/server/src/storage/publish.ts` (atomic copy semantics using adapter transaction when available)
- `contentfn/server/src/storage/events.ts` (append-only event log)
- Tests implementing:
  - TV-DOC-PUBLISH-001
  - TV-DOC-PUBLISH-002
  - TV-DOC-UNPUBLISH-001

## Requirements covered

- DOC-003 (partial: publish/unpublish semantics; events stored)
- API-002 (envelope correctness)

## Implementation tasks

1. Publish:
   - require draft `drafts.{id}` exists
   - copy draft content to published `{id}` atomically (prefer adapter transaction)
   - set `_publishedAt`
   - update `_rev` and `_updatedAt` deterministically
   - append `doc.published` event to event log with `changedPaths` best-effort (may be empty set initially but deterministic)
2. Unpublish:
   - remove published `{id}` representation if exists
   - keep draft intact
   - append `doc.unpublished` event
3. Ensure correct errors:
   - publish with missing draft → `DOCUMENT_NOT_FOUND` (or deterministic validation error)
4. Add tests for publish/unpublish invariants and perspective reads.

## Verification steps

- Run publish/unpublish tests and confirm atomic behavior (no intermediate visibility states).
- Confirm event log contains correct event entries after operations.

## Stop condition

- Publish/unpublish endpoints pass referenced TVs and event log has correct baseline entries.

