# logfn v0 — Ideation and Role in Superfunctions

Source inputs:
- /Users/ar/dev/agent/intent/logfn-init.md → "Logging - application logging, server logging - Abstraction, link to watchFn"
- Existing patterns across SearchFn, CacheFn, FlowFn, WatchFn

## Problem
Every package needs consistent, low-overhead, structured logging across browser and server. Today logs are ad‑hoc, hard to correlate, and not consistently scrubbed for secrets/PII. We also need a single path to ship logs into WatchFn for aggregation, correlation with traces/metrics, alerting, and long-term analytics.

## Role of LogFn
LogFn is the ecosystem’s structured logging layer:
- API and conventions for app/server logs (JSON-first, type-safe).
- Pluggable pipelines (redaction, enrichment, sampling, routing).
- Transports to local sinks (console, file) and remote sinks (WatchFn HTTP ingest).
- Context propagation (traceId/spanId/requestId, user/tenant) to correlate with WatchFn traces and metrics.
- Browser + Node + Python parity, with zero heavy deps by default.

## Design Principles
- Minimal, fast, zero-alloc hot paths where possible (compile fields, avoid string concat).
- JSON events with stable schema and versioning.
- No vendor lock-in: transports are optional; WatchFn is the first-party default but not required.
- Secure by default: secret/PII redaction before any sink.
- Cross-language parity (TS and Python) with shared event schema.

## Event Schema (v0)
```json
{
  "ts": "2026-01-13T18:00:00.000Z",
  "level": "debug|info|warn|error|fatal|trace",
  "msg": "human message",
  "name": "component/module",
  "ctx": { "key": "value" },
  "tags": ["http", "cache"],
  "traceId": "w3c-trace-id",
  "spanId": "w3c-span-id",
  "requestId": "generated-or-propagated",
  "userId": "optional",
  "tenantId": "optional",
  "version": "0"
}
```

## Core API (TypeScript)
```ts
import { createLogger } from 'logfn';

const logger = createLogger({
  name: 'app',
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  pipeline: [
    redactSecFn({ patterns: ['api_key', 'token', 'password'] }),
    enrichContext({ app: 'my-app', env: process.env.NODE_ENV }),
    withRequestIds(), // W3C traceparent ↔ requestId
    sample({ error: 1.0, info: 0.1, debug: 0.01 })
  ],
  sinks: [
    sinkConsole({ color: process.env.NODE_ENV !== 'production' }),
    sinkHttp({ url: '/watch/logs', batch: 50, flushIntervalMs: 1000 })
  ]
});

logger.info('server started', { port: 3000 });
logger.error('db failure', { err: serialize(err) });
```

### Framework middleware (via @superfunctions/http-*)
- Express/Fastify/Hono/Next/SvelteKit adapters exposing `requestLogger()` that:
  - attaches correlation IDs to `req/res` and logger child
  - logs request/response with latency, status, route, userId (from AuthFn)

```ts
import { requestLogger } from 'logfn/http/express';
app.use(requestLogger({ header: 'traceparent' }));
```

## Core API (Python)
```python
from logfn import create_logger

logger = create_logger(
    name='service',
    level='INFO',
    pipeline=[redact_secfn(patterns=['api_key', 'token']), with_request_ids(), sample(error=1.0, info=0.1)],
    sinks=[sink_console(), sink_http(url='/watch/logs', batch=50, flush_interval_ms=1000)]
)

logger.info('worker online', extra={'queue': 'emails'})
```

## Transports (v0)
- sinkConsole: dev-friendly pretty printer, JSON option.
- sinkHttp: POST batched events to WatchFn ingest (uses @superfunctions/http* for server routes). Offline buffer for browser; retries with backoff.
- sinkFile (Node): append + rotate by size/time (optional in v0, or v0.1).

## Pipeline Stages (v0)
- redactSecFn: integrate SecFn patterns to scrub secrets and PII (tokens, emails, IPs if configured).
- enrichContext: merge static/runtime fields (service, version via env, host). Attach AuthFn context when present.
- withRequestIds: propagate W3C tracecontext; generate `requestId` if missing; interop with WatchFn tracer.
- sample: level-aware sampling to control cost.

## Integrations Across Superfunctions
- WatchFn: primary ingest transport; shared `traceId`/`spanId`; WatchFn UI correlates logs ↔ traces ↔ metrics.
- SecFn: supplies redaction rules; future: policy-based allow/deny of fields.
- AuthFn: user/session/tenant context enrichment; opt-in PII masking.
- CacheFn: emit cache hit/miss/evict events; ready-made helper `wrapCacheLogger(cache)`.
- SearchFn: query/index timings and errors; helper `logSearchDurations(engine)`.
- FlowFn: job lifecycle logs with `jobId`, retries, backoff; worker attach.
- PlugFn: OAuth/webhook delivery logs; signed delivery IDs; retry outcomes.
- SendFn/BotFn: route error/fatal alerts to email/slack; minimal policy: “on >=error, fanout to SendFn channel.”
- HostFn: environment detection, default sink selection (console in dev, http/file in prod).

## Browser vs Server Notes
- Browser: console + HTTP with offline queue (IndexedDB or memory); capture `window.error` and `unhandledrejection` as error events (optional module).
- Server: high-throughput path, backpressure on HTTP transport; graceful shutdown flush.

## HTTP Ingest for WatchFn
- POST /watch/logs (adapter provided in logfn/http/*) with payload: `{ events: Event[] }`.
- Auth via AuthFn (service tokens) or shared secret header.
- Backed by WatchFn’s event store; retention/TTL managed by WatchFn.

## Testing and DevX
- Vitest/pytest with snapshot tests of event shapes.
- Fixtures to assert redaction rules.
- Benchmarks: events/sec per sink; payload size, flush latency.

## Security & Privacy Defaults
- Redact known secret patterns by default (keys, passwords, auth headers).
- Configurable allowlist for `ctx` keys.
- No PII fields unless explicitly added by caller or enrichment policy.

## Package Structure (planned)
```
logfn/
├── typescript/
│   ├── src/
│   │   ├── core/          # logger core, pipeline
│   │   ├── sinks/         # console, http, file
│   │   ├── http/          # express/fastify/hono/next/sveltekit middleware
│   │   └── utils/
│   ├── package.json       # name: logfn
│   └── vitest.config.ts
├── python/
│   ├── logfn/
│   └── tests/
└── v0.intent.md (this file)
```

## v0 Scope (MVP)
- TypeScript core + console and HTTP sinks.
- Express/Fastify/Hono middleware.
- Redaction + enrichment + sampling pipelines.
- Basic WatchFn ingest route adapter (server) and client (browser/server).
- Bench + smoke tests.

## v0.1–v0.2 Roadmap
- File sink with rotation; structured pretty printing.
- Next.js/SvelteKit middleware.
- Python SDK parity (core + console/http sinks).
- Automatic correlation with WatchFn tracer (span start/end breadcrumbs).
- Drop-in adapters for CacheFn, FlowFn, SearchFn.

## Open Questions
- Should sampling also consider dynamic backpressure from WatchFn (server hints)?
- Shared schema versioning with WatchFn events (logs vs traces vs metrics) — single envelope?
- Default PII mask policy out of the box or opt-in only?

---

This ideation aligns LogFn as the structured logging layer for superfunctions, with first-class integration into WatchFn and consistent patterns across TypeScript and Python.
