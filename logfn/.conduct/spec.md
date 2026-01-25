# LogFn v0 Specification

Status: Draft  
Version: v0 target (Q1 2026)  
Source: `/logfn/.conduct/ideation.md` (v0 intent)  
Scope: TypeScript-first MVP with forward-compatible Python parity

## Goals
- Provide a structured logging layer for browser and server with consistent schema, correlation IDs, and secure-by-default handling.
- Enable pluggable pipelines (redaction, enrichment, sampling) and transports (console, HTTP to WatchFn) without heavy dependencies.
- Interoperate with WatchFn traces/metrics via shared IDs and ingest adapters; align with SecFn for redaction policies and AuthFn for user/tenant enrichment.

## Non-Goals (v0)
- File sink with rotation (planned v0.1).
- Framework-specific adapters beyond Express/Fastify/Hono (Next/SvelteKit planned v0.1).
- Full Python parity (planned v0.2).
- UI/analysis features (owned by WatchFn).

## Deliverables
- TypeScript package `logfn` under `logfn/typescript/` with:
  - Core logger, pipeline engine, log levels, event schema validation, child loggers.
  - Built-in stages: `redactSecFn`, `enrichContext`, `withRequestIds`, `sample`.
  - Sinks: `sinkConsole`, `sinkHttp` (browser + Node).
  - HTTP middleware adapters for Express, Fastify, Hono in `src/http/`, implemented atop `@superfunctions/http` abstractions (shared router/types).
  - WatchFn ingest adapter route (`POST /watch/logs`) built with `@superfunctions/http`.
  - DevX: typings, inline JSDoc, README usage, Vitest tests, basic benchmarks.
- Artifact: this spec; keep aligned with ideation and update upon changes.
- Python package (planned v0.2) `logfn` under `logfn/python/logfn/` mirroring TS concepts (core logger, console/http sinks, minimal middleware for FastAPI/Flask using `superfunctions-http`).

## Event Schema (v0)
- Shape (JSON object):
  - `ts` (string, RFC3339 with ms, required; default `new Date().toISOString()`).
  - `level` (enum: `trace|debug|info|warn|error|fatal`, required; default from logger config).
  - `msg` (string, required, human-readable).
  - `name` (string, required; logger/component name).
  - `ctx` (object, optional; shallow serializable values only).
  - `tags` (string[], optional; <= 20 entries, trimmed lower_snake or kebab recommended).
  - `traceId`, `spanId`, `requestId` (string, optional; W3C TraceContext formats where applicable).
  - `userId`, `tenantId` (string, optional; redaction/masking applied per policy).
  - `version` (string, required; default `"0"`).
- Validation:
  - Reject non-serializable values (functions/symbols/BigInt); replace with `"[unserializable]"`.
  - Drop fields set to `undefined`; nulls preserved.
  - Enforce max payload size per event: 64KB after serialization (truncate `ctx` entries with notice).
- Forward compatibility:
  - Additional fields allowed; sinks must ignore unknown keys.

## Logger API (TypeScript)
- Factory: `createLogger(options: LoggerOptions): Logger`.
  - `LoggerOptions`:
    - `name: string` (required).
    - `level: LogLevel` (default `info` in production, `debug` otherwise).
    - `pipeline?: PipelineStage[]` (ordered; default empty).
    - `sinks: Sink[]` (at least one required; default `sinkConsole()` in dev, `sinkConsole + sinkHttp` in prod when url provided).
    - `now?: () => Date` (for testing).
  - Methods: `trace/debug/info/warn/error/fatal(msg: string, ctx?: Record<string, unknown>, tags?: string[])`.
  - `child(overrides: Partial<LoggerOptions> & { ctx?: Record<string, unknown>; tags?: string[] })` merges name/tag/context.
  - `flush(): Promise<void>` ensures all sinks drain (used on shutdown/unload).
- Concurrency/perf:
  - Hot path is sync until sinks; pipeline stages are sync by default.
  - Sinks may be async but must buffer to avoid blocking caller.
  - Budget: < 1µs added per stage and < 20µs total per log on Node target (informational benchmark).
- Error handling:
  - Pipeline stage errors are caught; stage is skipped and error is emitted to internal debug channel (not user-facing).
  - Sink errors are reported via optional `onError` hook and do not throw to caller.

## Pipeline Stage Contract
- Signature: `(event: LogEvent) => LogEvent | null`.
- If returns `null`, event is dropped (sampling).
- Must be pure and synchronous for v0; side effects limited to event mutation.
- Built-ins:
  - `redactSecFn({ patterns, allowlist? })`:
    - Uses SecFn-supplied regex/patterns; defaults include common secrets (api_key, token, password, auth headers, emails if configured).
    - Applies to `msg` and string-like values in `ctx`/IDs; replaces with `"[redacted]"`.
  - `enrichContext(staticFields, dynamic?: () => Record<string, unknown>)` merges service/env/host/version; later fields override earlier.
  - `withRequestIds({ header?: string = 'traceparent', generate?: () => { traceId, spanId, requestId } })`:
    - Parses W3C TraceContext when present; generates missing IDs; attaches to event.
  - `sample(rates: Partial<Record<LogLevel, number>>)`:
    - Rates 0–1; default { error:1, warn:1, info:0.1, debug:0.01, trace:0.0 }.

## Sink Contract
- Signature: `(batch: LogEvent[]) => Promise<void> | void` with `flush(): Promise<void>` optional.
- `sinkConsole(options?: { color?: boolean; json?: boolean; levelColors?: Record<LogLevel, string> })`:
  - Pretty in dev (color, aligned), JSON in production when `json=true`.
  - No buffering; synchronous write to stdout/stderr based on level (error/fatal to stderr).
- `sinkHttp(options: { url: string; batch?: number=50; flushIntervalMs?: number=1000; timeoutMs?: number=3000; headers?: Record<string,string>; auth?: { token?: string; secretHeader?: string }; retry?: { attempts?: number=5; backoffMs?: number=200..5000 jitter }; offlineBuffer?: 'memory' | 'indexeddb'; maxQueue?: number=5000 })`:
  - Batches events; flushes on interval, batch size, or `flush()`.
  - Browser: uses fetch, background flush on visibilitychange/unload; optional IndexedDB queue for offline.
  - Server: uses fetch/undici; backpressure via retry queue; drops oldest when `maxQueue` exceeded with metric.
  - Accepts WatchFn-specific headers when provided.

## Middleware Adapters (TS)
- Location: `src/http/{express,fastify,hono}`.
- `requestLogger(options?: { header?: string; redactHeaders?: string[]; sample?: number | Record<LogLevel, number>; logger?: Logger; includeBody?: boolean=false; captureUser?: (req) => { userId?, tenantId? } })`.
- Behavior:
  - Attaches correlation IDs (traceId/spanId/requestId) to request/response and logger child on `req.log`.
  - Emits start/stop events with route, method, status, latency, content-length, user/tenant if provided.
  - Redacts configured headers; caps body size if captured (<=8KB).
  - Uses existing logger if provided; otherwise creates child from root.

## WatchFn Ingest
- Server adapter (using `@superfunctions/http` router/types) exposes `watchLogsHandler(options: { auth?: { header: string; value: string } | { verifyToken: (req) => boolean }; maxBatch?: number=500 })`.
- Route: `POST /watch/logs` accepting `{ events: LogEvent[] }`.
- Validates schema version and size limits; responds 202 on accept; 4xx on invalid; 429 on rate-limit hint.
- Ties into WatchFn store with retention configured there; includes trace/span IDs for correlation.

## Browser vs Server Behavior
- Browser:
  - Default sinks: console + http when url provided; offline queue (memory by default, IndexedDB optional).
  - Capture `window.error` and `unhandledrejection` via optional helper (`captureBrowserErrors(logger)`).
  - Flush on `visibilitychange` (hidden) and `beforeunload`.
- Server:
  - Graceful shutdown hook helper `registerProcessHandlers(logger)` to flush on SIGTERM/SIGINT.
  - High-throughput path avoids async/await in hot log methods; batching isolated to sinks.

## Testing & Quality
- Vitest suites:
  - Schema enforcement and redaction snapshots.
  - Pipeline ordering and drop semantics.
  - Sampling determinism given seeded RNG.
  - HTTP sink batching/backoff with fake timers and mocked fetch.
  - Middleware: request/response logging with correlation IDs.
  - Browser helpers under jsdom with fake IndexedDB (where feasible).
- Benchmarks (lightweight):
  - Events/sec for console and http sink (mocked fetch) with pipeline depth 0/2/4.
  - Payload size vs fields to ensure 64KB guard works.
- Type checks: `tsc --noEmit`.

## Security & Privacy
- Default redaction enabled; allowlist for safe keys.
- No secrets in logs by default; userId/tenantId masked unless opt-in.
- Transport auth: HTTP sink supports token/secret header; server ingest validates.
- PII policy hooks to be aligned with SecFn; document defaults.

## Configuration & DX
- Provide `LoggerOptions` and helper presets: `devLogger()`, `serverLogger({ name, url })`.
- Ship `.d.ts` with JSDoc; README with minimal and advanced examples.
- Ensure tree-shakeable; avoid heavy deps (no winston/pino).
- Publish npm package `logfn`; entrypoints `.` (core) and `http/*` (adapters).

## Rollout Plan
- v0 MVP (this spec).
- v0.1: file sink + pretty printer, Next/SvelteKit adapters.
- v0.2: Python parity (core + console/http sinks + minimal middleware for FastAPI/Flask).
- Track changes in this spec; keep ideation file intact as historical context.

## Acceptance Criteria (v0)
- Can log structured events with schema defaults and custom fields; events reach console and HTTP sinks with batching.
- Built-in pipeline stages function as described; sampling drops events per config; redaction scrubs secrets in msg/ctx.
- Request middleware emits correlated request/response logs with IDs in Express/Fastify/Hono.
- HTTP sink retries with backoff and respects queue limits; flush works on demand and shutdown/unload.
- Tests cover schema, pipeline, sinks, middleware, and redaction; `tsc --noEmit` passes.
- Documentation: README and examples updated to match APIs above.
