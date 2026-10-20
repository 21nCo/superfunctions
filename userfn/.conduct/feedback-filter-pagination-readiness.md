# Resumable filter scanning — 2026-10-20

This checkpoint removes the previous500-total-matching-candidate ceiling. `maxFilterCandidates` retains its public configuration name/range1–500/default500, but now bounds work per request. The existing offline schema/backfill readiness contract is unchanged.

The scanner reads tenant-scoped normalized tag candidates ordered by feedbackId, or product-area candidates ordered by ID, after the supplied cursor. Each query has at most100 candidate rows. Area intersections and status checks use bounded IN queries for that chunk. If the response fills partway through a chunk, the cursor stops at the last returned match. Otherwise the entire chunk is consumed and the progress cursor advances to its final candidate. Budget exhaustion returns a partial or empty page with a non-null cursor. Only driver exhaustion yields null; a full final page can require one extra empty terminal request.

Clients must keep filters fixed and follow nextCursor until null, including after empty/short pages. Both existing SDK response contracts support this without a transport/API change. Documentation now demonstrates the complete loop. This is live keyset traversal, not snapshot isolation or an export snapshot; concurrent changes retain the previously documented limitations.

## Validation

- Service build/typecheck, ten contract tests, three native suites and actual AuthFn integration pass.
- Expanded native board acceptance creates502 same-tag records through the real TS HTTP client and traverses every ID exactly once with limit17, forcing midchunk boundaries inside100-candidate queries.
- Area-only traversal and combined sparse area/status selection match the exact expected ID sets.
- Instrumented queries prove a250-candidate request scans100+100+50 rows; a no-match intersection over502 candidates yields two empty progress pages and one terminal empty page.
- After SQLite close/reopen, a seven-candidate budget produces short/empty progress pages. Both TS and actual Python HTTP clients follow cursors to completion, with monotonically advancing cursors and no missing/duplicate IDs. Python independently derives all502 expected feedback IDs and verifies the sparse intersection.
- Existing old-schema migration, submission idempotency, vote concurrency and persistence acceptance continue to pass. The old candidate-overflow assertion now expects resumable success.

The vote-score projection limit is independent and remains an explicit503 overflow gate. Ranked sorting, metadata editing, snapshot pagination, aggregate scaling, browser UI and hosted adapter acceptance remain open. No shared edits or push were performed.
