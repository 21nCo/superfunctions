# BotFn Change Specification (Draft)

Last updated: 2026-01-14  
Status: Draft (not started)  
Owner: Platform (Superfunctions)

## Goal
Improve BotFn into a more robust, multi-platform bot framework with better persistence, observability, and provider ergonomics, while adding Slack support alongside existing Discord + GitHub/Linear integrations.

## Scope (this change)
- Add Slack support:
  - New `slack-core` package (signature verification, request adapters, response helpers).
  - New `bot-slack` implementation following the platform-agnostic core pattern.
  - Shared command schema/registry usable by Discord and Slack.
- Persistence modernization:
  - Switch persistence service from D1-only to pluggable DB using `@superfunctions/db` with Postgres as primary target.
  - Migrations and multi-tenant readiness (tenant/guild/workspace scoping).
- Observability and reliability:
  - Integrate `watchfn` for metrics/traces and `logfn` for structured logs.
  - Standardized retry/backoff and rate limiting around provider calls; basic circuit breaker.
  - Health endpoints and alerting hooks (emit to watchfn).
- Provider abstraction:
  - Unify GitHub/Linear/Discord/Slack access via a connection/provider registry (wrapping plugfn patterns) to reduce per-service boilerplate.
- Deployment portability:
  - Add Node/Express entrypoints for bots/persistence (alongside Workers) and minimal Docker/Compose spec.
- SDK-first alignment (like other functions):
  - Reshape botfn as a core SDK with adapters built on `@superfunctions/http` (Hono/Express/Fastify/Next/Workers).
  - Platform plugins (discord-core, slack-core, etc.) plug into a common handler registry; minimal per-platform glue.
  - Thin scaffolding/entrypoints for each runtime instead of bespoke platform code.
- Multi-language SDKs:
  - TypeScript: primary SDK + adapters (Hono/Express/Fastify/Next/Workers) with provider plugins.
  - Python: optional parallel SDK exposing the same handler/registry concepts, with ASGI/FastAPI/Flask adapters and provider signature helpers. Keep it thin if persistence/control-plane is HTTP-based.
- Testing/docs:
  - Contract/integration tests (MSW) for providers; e2e for Discord/Slack command flows.
  - Update docs with quickstart, env var matrix, and architecture diagram.

## Non-Goals (now)
- Teams/Telegram support (can follow Slack).
- Full-blown queue service; use lightweight retries/backoff unless needed.

## Work Items (high level)
1) Slack core + bot:
   - Create `packages/slack-core` (verify signatures, map events/interactions, helpers).
   - Add `bot-slack` with `core.ts` + platform entry (Workers + Node handler).
   - Shared command registry consumed by Discord and Slack.
2) Persistence upgrade:
   - Replace D1 bindings with `@superfunctions/db` Postgres adapter.
   - Add migrations, tenant/guild/workspace scoping, and indices for lookups by external IDs.
3) Observability/reliability:
   - Add `watchfn` instrumentation (latency, error rates) and `logfn` sinks.
   - Retry/backoff wrappers for provider APIs; simple circuit-breaker and rate-limit guards.
   - Health endpoints for bot and persistence; emit health status to watchfn.
4) Provider abstraction:
   - Connection/provider registry that wraps GitHub/Linear/Discord/Slack, leaning on plugfn patterns.
   - Centralized auth/token handling; shared error taxonomy.
5) Deployment:
   - Node/Express entrypoints; Dockerfile + docker-compose for bot + persistence.
   - Keep Cloudflare Worker targets.
6) Tests/docs:
   - MSW-backed integration tests for providers; e2e flows for Discord/Slack commands.
   - Update README/AGENTS with quickstart, env var table, arch diagram.

## Risks / Considerations
- Rate limits on Slack/GitHub/Linear; ensure backoff and jitter.
- Signature verification correctness across platforms.
- DB migration path from D1 → Postgres; data export guidance.
- Multi-tenant isolation (per guild/workspace/tenant) for persistence.
