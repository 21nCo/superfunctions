# Feedback metadata moderation checkpoint

Original `.conduct/spec.md` Feedback Board core CRUD requires tagging and product-area assignment. This change implements those operations in the dedicated shared HTTP/DB service and both SDKs. It does not add a moderation-history or ranking contract absent from this slice.

## Behavior and storage

- PATCH `/feedback/:id/metadata` accepts nonempty `{tags?, productArea?}` under the existing moderator scope. Tags replace the set, empty array clears it; explicit null clears area. Omitted fields remain untouched. Bounds and normalization match submission/filter behavior. Unknown authority fields reject before writes; tenant scoping returns404 across tenants.
- Existing normalized tables remain authoritative for current metadata; no schema changes. Completed migration marker is mandatory for changes. Transactions replace tag edges and update area atomically, with an update of the attributes row before mutation to serialize same-item SQL writes. Adapters without transaction capability fail closed.
- Board items and item detail's new `metadata` show current normalized metadata. Original payload/fingerprint are immutable; same-key submission replay cannot undo moderation. Legacy rows without projections remain readable from original payload before backfill; missing projections after ready fail closed.
- SDK methods `setFeedbackMetadata(id, patch)` / `set_feedback_metadata(id, patch)` use actual HTTP, await commit receipts and verify that requested fields are acknowledged. Existing bounded retries preserve the patch. Custom service implementations must explicitly supply the new optional method.

## Validation

- Service TypeScript build and10 service contract tests pass.
- Four native SQLite/HTTP tests pass, including new metadata acceptance: real TS/Python mutation/filter reads; normalization/deduplication; full replacement/clearing; concurrent disjoint fields and competing complete tag sets; repeated patch uniqueness; failure after tag deletion/insertion and transaction abort after callback; tenant/scope/body rejection; readiness gate; unsupported transactions; immutable payload/fingerprint and original POST replay; close/reopen after assignment and clearing.
- Existing real AuthFn issuance/revocation acceptance passes (one test).
- TypeScript SDK30 tests, typecheck and ESM/CJS/declaration build pass. Metadata tests reject malformed/mismatching successful receipts and invalid patches; retries preserve target/body.
- Python3.9 SDK30 tests pass; native acceptance invokes Python3.10 against the actual service and SQLite.
- Commands: `npm run build --workspace=@userfn/service`; `npm test --workspace=@userfn/service`; `npm run test:native --workspace=@userfn/service`; `npm run test:authfn --workspace=@userfn/service`; `npm test --workspace=./userfn/typescript`; `npm run typecheck --workspace=./userfn/typescript`; `npm run build --workspace=./userfn/typescript`; from `userfn/python`, `uv run --isolated --no-project --python 3.9 --with pytest python -m pytest tests -q`.

## Remaining gates

SQLite proves this adapter's transaction/concurrency behavior, not other providers' isolation or row locking. Changes have no optimistic version precondition; automatic retry may supersede a concurrent moderator's intervening change. Live board pagination remains non-snapshot. Current metadata reads add bounded projection queries per item. Offline migration remains single-worker with old writers stopped; never delete the ready marker and replay original-payload backfill after moderation.

Duplicate merge, scalable vote aggregation beyond the existing fail-closed projection limit, moderation history, ranking, board browser UI, external feedback sources, broader configuration/engagement service and hosted/provider matrices remain open. This checkpoint does not make UserFn fully ready.
