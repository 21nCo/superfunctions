# TypeScript stored regex pattern alerts

SPEC section 7 exposes `watch.logs.createPattern({name, pattern: RegExp, threshold:{count,window}, alert:{enabled,severity,channels}})`. The prior implementation rejected every call with `Log pattern registration is unavailable`. This slice creates a durable alert definition and evaluates actual canonical stored log messages through the existing alert evaluator, transactional outbox and named transport configurations.

The serialized condition is distinct from metric conditions:

```json
{"type":"log-pattern","field":"message","pattern":{"engine":"ecmascript","source":"authentication failed","flags":"i"},"threshold":10,"window":"5m","operator":"gte"}
```

`engine` is mandatory; TypeScript rejects other engines instead of reinterpreting Python or other regex syntax. Native ECMAScript flags supported on Node 18 (`dgimsuy`) are accepted; invalid/duplicate flags, malformed source and source larger than 4096 UTF-8 bytes are rejected. Regex compilation is validated; arbitrary matching executes only in an owned worker. Stateful global/sticky cursors reset for every message. Python has a separate explicitly tagged native regex engine and no cross-language regex semantic equivalence is claimed.

Registration resolves requested channel names through trusted `alerts.namedChannels: Record<string,AlertChannel>`, then passes snapshots of the existing channels through `alerts.create` validation. Unknown names fail before creation; no transport or external provider is inferred. Example host configuration:

```typescript
alerts: {
  namedChannels: { operations: {type:'webhook',webhook: localOrConfiguredEndpoint} }
}
```

Definitions live in the existing alert JSON payload; there is no new table or metrics encoding. Roll out readers/writers supporting the new discriminant before using these definitions. Existing older evaluators do not support them. Registration requires a started Watch instance; evaluation uses existing admitted lifecycle work, so stop prevents new operations and waits for accepted evaluations. Call `alerts.evaluate` and `alerts.processNotifications` through the existing host scheduling path; registration does not create a hidden scheduler.

## Bounds and failure semantics

Discovery and regex evaluation share the same canonical log/type/time scan: at most 10000 scanned events, 64 KiB per event and 16 MiB total payload, with no silent partial-count result. Message matching is capped at 16 KiB per input and 16 MiB total text. Each worker has a 2000 ms startup/execution deadline and V8 resource limits; termination is awaited on success, timeout and error. Each loaded runtime module admits at most four regex workers and fails excess calls immediately without a queue. These are application bounds, not an OS-wide process-memory quota or a bound on stalled database I/O.

The condition threshold must be an integer from 1 through 10000. Pattern counting also honors the configured `alerts.maxObservations`, capped at 10000; exceeding that bound fails before an alert state or notification is created.

A complete zero-match scan is observed zero, not missing data. Timeouts, scan overflow and worker failures propagate before lifecycle mutation, never produce a false healthy zero. Definitions, window-specific observations and notification transitions reuse existing alert revision/concurrency checks. Different engine/source/flags/window keys have separate count observations. Regex source is never smuggled into a metric name.

## Validation

Source typing passed. First focused run passed both pattern/discovery files, including catastrophic backtracking termination and a responsive main event loop. SQLite tests initially hit the preexisting ABI115 binary under shell Node22/ABI127; no binary rebuild was performed. Final native checks use the existing Node20.20.0/ABI115 runtime. The corrected final full suite passed 368 tests across 34 files using one worker (10.90 seconds). Source TypeScript checking and the package build, including modern and TypeScript 5.0 declarations, passed. The suite covers actual SQLite reopen, the existing durable outbox and an owned HTTP webhook; exact window boundaries; zero observations; unknown aliases and engine/flag rejection; configured observation limits; worker capacity; catastrophic regex timeout and subsequent worker reuse. The existing five-tarball `watchfn/scripts/packed-core-acceptance.mjs` fixture passed with actual pattern registration, canonical log ingestion, threshold evaluation, outbox dispatch and notification-value assertions in both ESM and CommonJS on Node 18.18.0, 20.19.0 and 22.23.4. Strict declaration consumers passed with TypeScript 5.0.4, 5.3.3 and 5.4.5, alongside current-compiler external Zod schema/brand/registry composition. The production-only dependency audit reported zero findings. The disposable installed consumer was removed in the fixture's finally block.

Commands used from the checkout root, with Node 20.20.0 first on PATH for native compatibility:

```sh
# Run from watchfn/typescript:
node node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1
# Run from repository root:
./node_modules/.bin/tsc --noEmit -p watchfn/typescript/tsconfig.json
npm run build --workspace=@watchfn/core
NPM_CLI=/path/to/npm-11.21.0/bin/npm-cli.js node watchfn/scripts/packed-core-acceptance.mjs
```

Receipts: `/tmp/watch-ts-pattern-final-full.log`, `/tmp/watch-ts-pattern-final-types.log`, `/tmp/watch-ts-pattern-final-build.log` and `/tmp/watch-ts-pattern-packed.log`. No dependency, root manifest, lockfile or ignore-rule changes were needed for this TypeScript slice.

No live provider or production deployment is exercised. Local email overrides and loopback webhook sinks are owned fixtures. Broader WatchFn readiness requirements remain separate.

## Canonical envelope correction

An actual `watch.ingest` regression reproduced that reading only top-level `message` missed canonical `properties.message` logs. Counting now uses the same `logField` helper as discovery/query/indexing. An explicitly present top-level null still overrides nested properties and is not matched. The regression first failed on the unchanged counter, then the final focused set passed 41 tests across three files; source types and package build passed. The preceding 368-test full suite predates this one-line field-reader correction; it is not represented as a full-suite rerun after it. The final fresh five-tarball installed consumer passed again after rebuilding: Node 18/20/22 ESM+CJS runtime assertions, TypeScript 5.0.4/5.3.3/5.4.5 declarations, external Zod composition and production audit zero. Its finally block removed the disposable consumer. Final correction receipts are `/tmp/watch-ts-canonical-{baseline,focused,types,build,packed}.log`; the baseline is the expected failing reproduction.
