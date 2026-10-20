# Watch query streaming integration

2026-10-20. CatchFn incorporates WatchFn `99a23c8ea` through an ordinary merge,
including shared CI guard changes at `f0d620096`. No Catch delivery semantics or
synthetic/alert disposition changed in this integration.

Validation against the actual integrated Watch query implementation:

- Eight shared usage/planner checks pass.
- All 103 Catch SDK tests, TypeScript checks and CJS/ESM/declaration builds pass.
- `botfn-acceptance.mjs`: built SDK and real Chrome through Watch HTTP and native
  SQLite, close/reopen, actual BotFn GitHub HTTP client against a local provider
  fixture, lost intake replay deduplication, auth/route denial, verified widget
  links, payload expiration, retained outbox receipts and replay/status after
  expiration pass.
- `watchfn-acceptance.mjs`: real HTTP/native SQLite reopen, canonical metadata,
  authenticated queries, storage failures and retained retries pass.
- `browser-delivery-acceptance.mjs`: actual Chrome cross-origin delivery,
  same-event-ID 503 retry, offline/CORS recovery, auth/redaction, lost-response
  at-least-once arrivals and explicit new-report selection pass.

The runs use `CATCHFN_WATCH_CORE` pointing to the freshly built Watch core from
identical source in the sibling Watch checkout, which avoids rebuilding optional
Watch framework dependencies in the scoped Catch install. Existing scripts close
HTTP servers, browser sessions and database connections and remove their temporary
files. The worktree is clean after recording this evidence. No external issue,
message or deployment is created.

This confirms the existing Catch boundary against streaming query execution; it
does not establish hosted provider/database delivery, arbitrary-scale ordering,
snapshot isolation or completion of all original requirements. Watch's query
memory/order/collation limitations remain documented in
`watchfn/.conduct/query-streaming-readiness.md`. Catch intake remains at least once
outside its managed bug-report outbox deduplication contract, and the configured
Watch key continues to authorize queries as well as ingestion/status.

Reproduce after building Catch and the identical Watch source:

```sh
node --test scripts/check-shared-usage.test.mjs scripts/ci-stacked-pr.test.mjs
npm test --workspace=catchfn
npm run typecheck --workspace=catchfn
npm run build --workspace=catchfn
CATCHFN_WATCH_CORE=/absolute/path/to/watchfn/typescript/dist/index.mjs node catchfn/typescript/scripts/botfn-acceptance.mjs
CATCHFN_WATCH_CORE=/absolute/path/to/watchfn/typescript/dist/index.mjs node catchfn/typescript/scripts/watchfn-acceptance.mjs
CATCHFN_WATCH_CORE=/absolute/path/to/watchfn/typescript/dist/index.mjs node catchfn/typescript/scripts/browser-delivery-acceptance.mjs
```
