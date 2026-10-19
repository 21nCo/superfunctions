# WatchFn readiness checkpoint — 2026-10-20

This checkpoint implements bounded HTTP ingestion. It does not establish full readiness against `watchfn/SPEC.md`.

## HTTP ingestion contract

Start the WatchFn instance before handling requests through `watch.httpRouter`. `POST /ingest` accepts one event, an event array, or `{ "events": [...] }`. Events must be JSON objects with a nonempty string `name`. Batches contain 1–500 events; each serialized event is limited to 64 KiB UTF-8 and the entire request body to 8 MiB, including streamed bodies without Content-Length. Every event is validated before the first storage write. Unknown event fields, timestamps, correlation identifiers, and nested metadata are preserved verbatim rather than rewritten as tracking properties.

The endpoint returns `202 { "accepted": N }` only after all configured storage `add` operations resolve. Invalid JSON/events/batches return 400, excessive bodies/events return 413, and unavailable, stopped, or failing storage returns a generic 503 without leaking storage errors. The direct `watch.ingest(events)` method awaits storage but trusts already validated application input; HTTP validation belongs to the endpoint.

When `auth.apiKey` is supplied (unless `auth.enabled` is explicitly false), ingestion requires either `Authorization: Bearer <key>` or `x-api-key`. Authentication runs before body parsing. `auth.enabled: true` without a key fails closed. With no authentication configuration, ingestion remains unauthenticated for compatibility.

## Validation

- Existing clean scoped npm installation and package-lock generation completed successfully; HTTP and DB dependency versions now resolve to this shared prerequisite branch, and Vitest uses 3.2.4.
- Shared observability and HTTP builds pass. Express, Fastify, Next, and SvelteKit adapter builds pass.
- WatchFn full suite: 45 tests passed before the additional partial-persistence regression test. An earlier run failed the unchanged metric aggregator p95 test because its `Date.now()`-relative ten-second sample spans two minute buckets while the assertion assumes one bucket. This remains a timing-sensitive baseline test.
- Final focused ingestion suite: 17 tests passed, including partial-persistence failure. Standalone WatchFn `tsc --noEmit` passed; `git diff --check` passed.
- WatchFn ESM and declarations built successfully. The complete dual-format build fails because the existing bundled SvelteKit adapter introduces top-level await into CJS output. Packed-package/CJS acceptance is not established.
- Shared Hono adapter build fails with three TS2305 errors: its nested older HTTP dependency lacks observation header exports. This dependency-closure issue remains unresolved.

## Remaining limitations

Persistence is sequential, not atomic: a failure after earlier writes can leave a partial batch. Retrying may duplicate those events; there is no idempotency or deduplication contract. Memory storage acknowledgement is ephemeral and subject to its existing 1,000-event retention. DatabaseStorage still uses the legacy `insertEvent/queryEvents` interface; shared DB schema wrapping, real database durability, and transaction support are pending. A request already in flight can finish after stop; stop does not drain pending writes.

Allowed-origin enforcement, CORS, ingestion rate limits, key rotation/scopes, and authentication for health/query are not implemented by this checkpoint. No body-read/storage deadline is introduced. Event-specific schema/version/timestamp validation remains the responsibility of producers. The synchronous `track`/collector route still uses unawaited storage callbacks and is not covered by the HTTP acknowledgement guarantee.

Browser retries/offline delivery, Python parity, substantive query/log/trace/business APIs, full LogFn/CatchFn integration, real deployment, and the original performance targets remain pending. No remote PR, push, deployment, or release was performed for this checkpoint.

## Express completion and deterministic aggregation checks

- Express middleware no longer replaces `res.json` or counts a JSON write and its subsequent `finish` as separate requests. It records one completion, records premature `close` with `aborted: true`, and removes its lifecycle listeners.
- Three focused lifecycle tests pass; standalone TypeScript check passes. Full core suite: 50 tests pass.
- The first full run exposed two existing wall-clock-dependent aggregation tests: samples crossed a minute boundary while assertions inspected only the first bucket. Their single-bucket inputs now use fixed timestamps, and a new explicit boundary test verifies both bucket averages without weakening the expected values.
- Correction to the earlier build diagnosis: bundled shared observability top-level await is pulled through the Hono dependency closure. The source SvelteKit adapter does not introduce that await. Synchronous CommonJS import remains unverified until shared runtime initialization and packed dependency closure are fixed.

## Packed module formats and declaration checkpoint

- Merged shared prerequisites through `9b841ff4a`: lazy Node context initialization removes import-time await; all HTTP adapter peers now accept HTTP 0.3.1.
- WatchFn bundles actual shared HTTP/observability implementations into both output formats. An explicit package `files` list includes all `dist` artifacts; inherited repository ignore rules previously omitted CommonJS JS/declarations from tarballs.
- Conditional exports select `.d.mts` declarations for ESM and `.d.ts` for CommonJS. Next request tracking uses the structural request surface it actually reads, so the core declaration entry does not import Next's framework-wide ambient types. Real NextRequest objects satisfy that surface.
- Fresh npm11 consumer, without force/legacy-peer flags: ESM import and synchronous `require('@watchfn/core')` pass on Node18.18.0, Node20.19.0, Node22.23.3. Each performs authenticated ingestion, metadata readback and a time-range query over a preserved LogFn `ts` envelope.
- Strict ESM consumer declarations pass Node16 and NodeNext module resolution. Separate CommonJS TypeScript declaration consumption and the original TypeScript5.0 floor remain unproven. Runtime consumers use current automatically resolved framework peers; this does not establish every framework's Node18 runtime support.
- Full core suite59 passes; standalone source types and CJS/ESM/declaration builds pass.
- Production audit fails with four low-severity entries: `cookie`, `@sveltejs/kit`, `@superfunctions/http-sveltekit`, and `@watchfn/core`, stemming from SvelteKit's transitive cookie dependency. npm reports no automatic fix. The acceptance script intentionally fails this gate and prints its findings. Framework dependencies currently install eagerly; opt-in integration packaging and SvelteKit-specific remediation remain required.
- Initial failed attempts are retained as defects found: incompatible adapter peer pins, omitted CommonJS tarball files, wrong ESM declaration mapping, Next declaration subpath/ambient failures, and the audit above. No WatchFn PR/push or production-readiness claim is made.
