# Required feedback filters checkpoint — 2026-10-20

The original specification requires tag/product-area/status board filters (spec.md sections Feedback Board and data model). This checkpoint adds original required tag/product-area filtering and submission attributes. Ranked sorting and moderation history remain deferred extensions.

## Storage and compatibility

Three additive, internally wrapped shared DB tables hold normalized attributes, tag edges and a durable migration marker/cursor. Original feedback payloads, IDs and fingerprints are immutable. New feedback plus both normalized projections commit in one transaction; unsupported transaction adapters reject new submissions. Tag labels/product areas use case-sensitive NFC+trim; tag duplicates collapse only in projections, preserving original request identity.

Exported `backfillFeedbackFilters(adapter, {batchSize})` processes1–500 rows per transaction. It persists progress and marks readiness only after the complete scan. Hosts must apply the exported additive schema and run one offline worker with all old/new writers stopped. Interrupted batches roll back and resume; completed reruns return done without changes. Service filter reads fail503 if readiness is absent/incomplete. Old receipt replay remains valid. New submissions observe a committed building marker and fail until migration completes.

Filters query tenant-scoped normalized indexes, bound matching candidates, then apply feedback status/cursor pagination. `maxFilterCandidates` is configurable1–500, default500, keeping portable IN lists bounded. Overflow returns503 before pagination. Combined tag/area filters bound the tag candidate set first, so a broad tag may fail even where the intersection would be small. This is not a500-row tenant ceiling; the native test proves a rare tag works with501 tenant records.

## Validation

- TypeScript SDK typecheck/build and29 tests pass.
- Python3.9 SDK suite29 tests passes; Python3.10 exercises actual HTTP submission and combined filters.
- Service TypeScript build and10 contract tests pass.
- Three native tests pass: original submission persistence, board/vote HTTP concurrency, and the new old-schema migration test. The latter creates only prior tables and501 legacy rows; verifies missing-schema and schema-only503; interrupts a partially written batch and checks rollback; resumes all rows; checks duplicate normalized tag collapse, readiness and overflow; proves failed normalized writes roll back feedback; reopens SQLite and verifies original payload/fingerprint/receipt remain unchanged. Adapters declaring no transaction support fail closed.
- Actual AuthFn issuance/revocation acceptance continues to pass with the expanded schema.
- Both real SDK transports test tag+product-area+status selection; TypeScript also checks NFC-equivalent tag input.

## Limits

This is bounded portable filtering, not arbitrary-scale query support. Larger matching sets and combined filters with a broad tag need indexed join/aggregate support rather than truncated scans. Product-area/tag editing after submission, duplicate merge, ranking, moderation history, browser board UI, external sources, full config service and hosted/provider matrices remain open. Migration is offline and single-worker; do not resume old writers or import legacy rows after the ready marker. DDL execution remains the host's shared schema migration responsibility; the exported helper performs transactional data backfill, not adapter-specific table creation.

No shared edits, hosted changes or push were performed.
