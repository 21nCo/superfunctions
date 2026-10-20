# Feedback board checkpoint — 2026-10-20

## Delivered original scope

The specification's feedback-board listing, voting and status update now have dedicated service routes and both SDK methods. Existing submission receipts and injected service compatibility remain intact.

- Tenant-scoped `GET /feedback`: ID keyset pagination (default20/max100), status filter, safe board projection without identity/traits. Unknown/repeated query fields and invalid cursors/limits/statuses fail400. Status values follow the original enum.
- `POST /feedback/:id/vote`: explicit vote scope; authenticated actor type/ID owns one row per tenant/item. Direction ±1 replaces through shared atomic upsert with explicit conflict target; zero deletes. Idempotent repeats/removals do not multiply votes. No client identity fallback or anonymous voting. API-key actor means one vote per key; per-human voting requires a verified user principal.
- `PATCH /feedback/:id/status`: explicit moderate scope, canonical validation, scoped update and awaited receipt. Read/write/vote/moderate permissions remain independent.
- New internally wrapped `userfn_feedback_votes` schema. Host migrations must create its primary/unique ID constraint and index before upgrading. Old feedback-row vote values are not used for totals.
- Score and viewer direction derive from one bounded projected query of authoritative rows. This avoids denormalized updates and avoids positive/negative counts from different snapshots. `maxVotesPerFeedback` defaults10000, configurable1–100000; overflow503 never includes a truncated score. Scalable aggregate pushdown remains open.
- SDK board/vote/status methods reuse real HTTP transports and bounded retries, validate acknowledgments, and retain stable desired directions/statuses on retries. Board response cap16MiB; mutation receipt cap64KiB.

## Checks

- SDK TypeScript typecheck and ESM/CJS/declaration build pass; 29 SDK tests pass, including malformed board/vote/status results and stable direction retry.
- Python3.9 suite: 29 tests pass, including real local HTTP malformed-result failures and vote retry. Python3.10 executes board acceptance against the actual service.
- Service strict TypeScript build and ten contract tests pass. Overflow test proves a second vote can commit while the bounded result projection returns503, that no partial score is returned, and that removal restores readable totals. Invalid direction/authority/status, bound configuration, and equal-ID user/API-key principal isolation tests pass.
- Two native tests pass via `npm run test:native --workspace=@userfn/service`. Existing TS/Python submission/SQLite reopen acceptance remains intact. New board acceptance uses actual loopback HTTP and file-backed SQLite: five items across three nonoverlapping cursor pages, tenant isolation, twenty concurrent actors, duplicate same-actor votes, twenty concurrent direction flips, repeated removals, independent scope denial, both SDK status/filter flows, reopened database preserving20votes+status, and missing vote table503.
- Actual AuthFn issuance/revocation acceptance still passes with the expanded UserFn schema (`npm run test:authfn --workspace=@userfn/service`).

## Remaining gates

Tag/product-area filtering requires a portable indexed representation; shared cross-adapter JSON-array containment was not assumed. Vote-ranked sorting, anonymous voting, duplicate merge, moderation audit/history, board widget/browser flows, external sources, dedicated config delivery, offline queues, roadmap/changelog and deployment remain open. No arbitrary-scale performance claim: a board page can require one bounded vote query per item; aggregate pushdown/index benchmarking is still required. Other database adapters' concurrency and hosted durability have not been verified.

Pagination is a live keyset view, not a retained snapshot; inserts before an existing cursor and concurrent filter/status changes can alter subsequent pages. Votes/status updates use last committed mutation semantics; the service does not impose client-issued sequence ordering. A response can be lost after a successful mutation; idempotent reconciliation must use the same actor/item/direction or status. Python's socket-timeout/cancellation limitations documented in the earlier checkpoint still apply.

No shared package edits, hosted changes or push were performed.

## Follow-up: normalized required filters

The [feedback filter checkpoint](feedback-filter-readiness.md) implements tag/product-area/status filtering and an explicit resumable migration gate, superseding the earlier missing-filter finding. Candidate scaling and metadata editing remain open; ranking/history extensions stay deferred.
