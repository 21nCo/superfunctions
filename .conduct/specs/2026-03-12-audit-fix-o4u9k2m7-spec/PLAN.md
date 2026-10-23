# Plan

## Architecture Sketch

### Shared package layer (`packages/*`)

1. OAuth stack:
- `@superfunctions/oauth-core` (existing)
- `@superfunctions/oauth-http` (existing)
- `@superfunctions/oauth-storage` (existing + db adapter bridge)
- `@superfunctions/oauth-providers` (existing)
- `@superfunctions/oauth-testing` (existing, deduped)
- `@superfunctions/oauth-flow` (new orchestration)

2. Reuse extraction stack:
- `@superfunctions/webhooks` (new)
- `@superfunctions/envelope` (new)
- `@superfunctions/errors` (new)
- `@superfunctions/queue` (new)
- `@superfunctions/metrics` (new)
- `@superfunctions/config` (new)
- `@superfunctions/auth` (extended bearer middleware)
- `@superfunctions/rate-limit` or `@superfunctions/middleware` extension (algorithm-complete)

3. Dedup support:
- `@superfunctions/storage` internal shared core for S3-compatible providers.
- SearchFn canonical adapter source strategy and compatibility exports.

### Consumer layer

- `authfn/ts-sdk`: social OAuth delegation to `@superfunctions/oauth-flow`.
- `plugfn/typescript`: connection manager and legacy auth wrapper delegation to shared OAuth flow.
- `recfn/server`: shared OAuth token handling + shared webhooks/envelope/queue/metrics/config/rate-limit.
- `cifn/typescript/control-plane`: shared webhooks/envelope/queue adoption.
- `cmsfn/core|server`: shared envelope/errors compatibility adoption.

### Docs layer

- New root workspace `docs/` (Fumadocs + `@superfunctions/docs-theme`).
- Coverage for all shared packages in `packages/*` and `packages/python-*`.
- External-consumer-first examples and migration guides.

## Dependency Graph

1. `oauth-flow` depends on:
- oauth-core
- oauth-http
- oauth-storage
- oauth-providers

2. Reuse packages dependency order:
- `errors` -> `envelope`
- `webhooks` independent
- `queue` independent
- `metrics` independent
- `config` independent
- `rate-limit` depends on db kv adapter types

3. Consumer migrations depend on shared package availability:
- authfn/plugfn/recfn OAuth migration depends on `oauth-flow` and oauth-storage db bridge.
- recfn/cifn envelope/webhook/queue migration depends on shared reuse packages.

4. Docs depends on package APIs stabilizing:
- root docs content phase starts after package API freeze for each module set.

## Phases Overview

| Phase | Goal | Delivered capability | Verification method |
|---|---|---|---|
| 00 | Baseline guardrails | Workspace wiring, duplication baseline, release-gate scaffolding | Workspace build + baseline duplication report |
| 01 | OAuth testing dedupe | `oauth-testing` re-export cleanup | Package tests/typecheck |
| 02 | OAuth flow package scaffold | New `oauth-flow` package with API contracts | Unit tests + typecheck |
| 03 | OAuth start/callback invariants | PKCE/state/replay-safe callback orchestration | Deterministic callback tests |
| 04 | OAuth refresh/disconnect invariants | Refresh merge + cleanup-on-revoke-fail semantics | Token lifecycle tests |
| 05 | OAuth storage persistence bridge | `@superfunctions/db` adapter path in oauth-storage | Adapter contract tests |
| 06 | PlugFn OAuth migration | Connection manager delegates to oauth-flow | PlugFn OAuth integration tests |
| 07 | AuthFn OAuth migration | social-oauth delegates to oauth-flow | AuthFn social OAuth tests |
| 08 | RecFn OAuth migration | calendar token refresh/store uses shared OAuth | RecFn calendar tests |
| 09 | Shared webhooks package + adoption | recfn/cifn webhook code migration | Webhook signing/delivery tests |
| 10 | Shared envelope/errors package + adoption | recfn/cifn/cmsfn compatibility migration | API envelope contract tests |
| 11 | Shared queue package + adoption | recfn/cifn queue dedupe | Queue behavior tests |
| 12 | Shared metrics/config/auth/rate-limit | extraction + recfn/plugfn adoption | Middleware and helper tests |
| 13 | PlugFn platform alignment | DB type contract + deterministic connection selection | Typecheck + deterministic selection tests |
| 14 | Storage adapter dedupe | common S3-compatible storage core | Storage adapter tests + duplication scan |
| 15 | SearchFn adapter canonicalization | single source strategy for adapters | SearchFn adapter tests + duplication scan |
| 16 | Python schema helper dedupe | authfn/secfn schema type helper extraction | Python tests/type checks |
| 17 | Root docs app scaffold | new docs workspace + nav skeleton + theme integration | Docs build |
| 18 | Root docs full content + migration guides + CI checks | complete shared package docs for external users | Docs coverage + snippet/link checks |

## Definition of Done (global)

No phase is complete unless its verification steps pass.

Additionally, the spec is complete only when:

1. All P0 requirements are verified by passing vectors.
2. No requirement in `REQUIREMENTS.md` lacks positive and negative vector coverage.
3. Release gate `gate:audit-fix-o4u9k2m7` passes across all targeted packages.
4. Root docs coverage report has zero undocumented shared packages.
5. Duplicate logic clusters identified in this audit are either removed or explicitly reduced to compatibility wrappers with no business logic.
