# Full Studio document history

Original DESK-001 is P1 SHOULD: history reads ContentFn revision history and
renders a deterministic list. TV-DESK-PANES-001 requires newest-first revisions
and a no-access state without revision content when history access is denied.
Diff is explicitly optional; this checkpoint does not add diff or restoration.

The complete App now mounts a History control for opened list and singleton
documents. It requests the real `/contentfn/docs/history` endpoint, preserves the
producer's deterministic order, renders revision/document/timestamp identity and
full immutable JSON snapshots, and pages older revisions without accumulating an
unbounded list. Closing/opening, scope changes and denied responses clear content;
stale responses cannot repopulate a different document or dataset. HTTP 401/403 is
handled before JSON parsing, including empty/HTML proxy responses. Other malformed
or oversized results show an explicit error, not empty success. Requests have a
10-second timeout and a 2-MiB streamed response limit before parsing. Oversized
pages retry the same cursor with smaller limits (20, 10, 5, 2, 1) within that
deadline; a single oversized snapshot fails explicitly without skipping it. Host
ContentFn `docs.history` authorization governs sensitive draft history.

Ordinary producer prerequisite merge: ContentFn
`3b87a303d8c37a22ba1b08bad6b9cbfb2c65a8bc` (sf-next PR 56), merged as
`606ac0795ee8c58eb190d82fbc39ea31b85be374`. It retains full snapshot/auth contracts,
adds dataset/document-bound keyset cursors, detached memory snapshots and bounded
materialization. Legacy cursors must restart. Existing revision tables still need
supporting index migration and supported-adapter query-plan validation; database
scan/sort cost remains a required performance readiness gate.

Validation with CMS Node 20.20.0:

- `npm test -w ./cmsfn/studio`: 94 tests passed across 19 files, including real
  pane pagination/snapshots, permission revocation, stale dataset response,
  malformed/oversized pages, repeated cursor, empty/HTML 401/403 and adaptive
  three-800-KB-snapshot pagination without skipped revisions.
- `npm run typecheck -w ./cmsfn/studio`: passed.
- `npx --yes turbo@2.6.1 run build --filter=@cmsfn/studio...
  --filter=@cmsfn/server...`: 31 tasks passed.

- `python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root
  /Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness`: fresh
  normal npm 11 production installation and zero audit vulnerabilities; full
  installed Chromium 143.0.7499.4 App passes 162 actual CMS/Content HTTP requests.
  More than 20 revisions paginate in producer order with full snapshots;
  revocation clears content and same-ID prod/staging navigation remains isolated.
  Prior lifecycle, scheduling/ACK recovery, audit, releases and ops checks remain.

Receipts: `/tmp/cms-history-{studio,types,build,packed}-final.log`. An initial
packed run reached a later fork-collision fixture assertion that still expected
the pre-history title after the history setup intentionally added 22 edits. The
assertion now checks the captured authoritative winning draft title, retaining the
unchanged full-document collision assertion; the complete rerun passed.

No provider send, deployment, external database acceptance or native Safari claim.
Remaining original operational acceptance and the producer index/query-plan gate
remain open; this checkpoint does not declare the whole CMS function complete.
