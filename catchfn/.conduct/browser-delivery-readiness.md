# Browser report delivery recovery

2026-10-20 UTC. A failed widget submission previously left its canonical report queued in WatchFn, but submitting again prepared another report ID. Delivery failures now expose `CatchFnDeliveryError` with `reportId` and an awaitable `retry()` that reuses the prepared payload. Endpoint retries flush accepted events; a queue-capacity rejection retries enqueueing the same envelope. Injected clients receive the same prepared ID and payload on retry. Successful retry results are retained and concurrent calls share one attempt. Preparation failures remain ordinary errors and do not acquire delivery retry semantics.

The widget locks report fields after delivery failure, displays an unconfirmed-delivery state, and offers Retry same report. Starting a new report is a separate explicit action with a warning that the queued original may still be delivered. Success is shown only after transport acknowledgement. Prepared attachments and beforeSend hooks are not rerun for delivery retries.

## Validation

- All 86 TypeScript SDK tests pass, including actual loopback HTTP repeated failure/recovery, concurrent retry calls, queue-capacity rejection, unchanged report IDs/payloads, and injected-client integration results.
- Typecheck and ESM/CommonJS/declaration builds pass.
- `scripts/browser-delivery-acceptance.mjs` passes in actual installed Chrome against two local origins, WatchFn's real ingestion/query router, and shared Kysely/native SQLite storage. It covers repeated503 failure, locked fields, unchanged canonical payload, bearer authentication, final-hook redaction, browser offline recovery, denied CORS then recovery, accepted persistence followed by response timeout, and explicit creation of a new report while an original is queued.
- The response-timeout case verifies two persisted arrivals with the same report ID after retry. It does not treat matching IDs as datastore deduplication.
- Existing `scripts/watchfn-acceptance.mjs` passes built-package HTTP/SQLite reopen, authentication, retries, canonical query and storage-failure checks. Existing `scripts/browser-acceptance.mjs` passes Chrome and WebKit widget, masking, annotation, consent and focus checks with an injected client.

Reproduce after building CatchFn, WatchFn/shared DB and installing native SQLite plus Chrome:

```sh
CATCHFN_WATCH_CORE=/absolute/path/to/watchfn/typescript/dist/index.mjs node catchfn/typescript/scripts/browser-delivery-acceptance.mjs
```

The local run used the built WatchFn core from the sibling `watchfn-sf-next-readiness` checkout. The script otherwise defaults to this checkout's WatchFn build. Temporary files, native database connections, browser and servers are cleaned up.

## Remaining boundaries

The CORS policy belongs to the hosting server; the acceptance installs an explicit origin allowlist around the real WatchFn router. It does not establish hosted deployment, unload guarantees, persistent offline storage, or network delivery in all browser engines. The queue is in memory, and retries remain at least once. No Python behavior changed.

BotFn issue creation/linking remains open. It needs an authenticated server-side integration at canonical WatchFn bug-report ingestion, durable delivery/duplicate handling and persisted issue-link results. Adding delivery only to the separate flat-report service would not connect the browser's canonical path and is not evidence for this requirement. Retention/index tuning, deduplication, attachment provisioning, Python parity, performance and broader accessibility gates remain open.
