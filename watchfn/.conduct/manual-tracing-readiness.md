# Manual tracing checkpoint

Manual spans now record a `trace.span` event when finished. Completion is idempotent, including timestamp zero. Callback spans share the same completion path; synchronous callbacks, promises, thenables and failures preserve their result/error without duplicate recordings. Trace identifiers use random 16-byte trace IDs and 8-byte span IDs.

Transactions provide explicitly parented child spans, retain one trace ID, and reject creation of children after the transaction finishes. Starting a manual transaction does not overwrite ambient asynchronous context. Callers must finish each child explicitly; finishing the transaction does not silently end children still performing work.

Seven focused tests cover manual/epoch-zero completion, transaction ancestry, callback early finish, concurrent async context isolation, thenable rejection, standalone spans and the public WatchFn transaction capture path. The combined suite passes 100 core tests and 12 browser tests; source typecheck and all core module/declaration builds pass. The existing LogFn-to-WatchFn acceptance also passes its eight real HTTP requests. The public WatchFn transaction helper delegates to this implementation.

This checkpoint uses the existing synchronous `watch.track` capture route. It does not establish awaited database persistence, shutdown draining, remote W3C propagation validation, sampling, export protocols, trace querying, or full distributed tracing readiness. Finishing after WatchFn stops follows the existing capture behavior and drops the event. These gates remain open.

Fresh core tarballs also pass authenticated HTTP query, count aggregation, transaction child capture and duplicate-finish checks in ESM and synchronous CommonJS on Node18.18.0,20.19.0,22.23.3. Strict declarations including TypeScript5.0.4 and the core production audit pass (zero vulnerabilities). Optional-framework audits are separate.
