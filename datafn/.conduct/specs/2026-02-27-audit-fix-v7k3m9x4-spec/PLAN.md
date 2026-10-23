# PLAN: DataFn Audit Fix — Phased Execution

## Architecture Sketch

```
datafn/
├── core/src/
│   ├── types.ts          — Config type additions (limits, ws, logger)
│   ├── schema.ts         — Relation from/to validation (CLI-004)
│   ├── filters.ts        — Depth limit (CLI-009), $or handling (SRV-015)
│   └── validate.ts       — NEW: shared validation utilities (prototype check, type check)
│
├── server/src/
│   ├── server.ts         — Config defaults, graceful shutdown, logger injection
│   ├── ws.ts             — Auth, namespace scoping, heartbeat, limits
│   ├── validation/
│   │   ├── authz.ts      — Full field coverage, deny-by-default, relation authz
│   │   ├── mutation.ts   — Type validation, batch limits, prototype check, ID length
│   │   └── query.ts      — Having/groupBy validation, caps on all arrays
│   ├── routes/
│   │   ├── transact.ts   — Per-step authz
│   │   ├── sync.ts       — Batch limit check, byte limit
│   │   ├── rest.ts       — Path sanitization
│   │   └── seed.ts       — Namespace from auth
│   ├── execution/
│   │   ├── transact.ts   — No silent fallthrough, rolled-back annotation
│   │   ├── idempotency.ts — TTL + LRU eviction
│   │   ├── mutation/
│   │   │   ├── execute.ts — Error preservation, UUID IDs
│   │   │   └── relations.ts — Batch DB calls, atomic modifyRelation
│   │   ├── query/
│   │   │   ├── aggregate.ts — Group cap, schema cache
│   │   │   ├── filters.ts  — Targeted relation lookup
│   │   │   └── select.ts   — FK omit cache, one-many optimization
│   │   └── sync/
│   │       ├── push.ts     — Fail on change tracking error, batch serverSeq
│   │       ├── clone.ts    — Auto-pagination
│   │       ├── reconcile.ts — db.count()
│   │       └── change-tracking.ts — Backoff, batch insert
│   ├── http/middleware.ts — Buffer.byteLength, default 5MB
│   ├── middleware/rate-limit.ts — Atomic TTL, Retry-After, unref
│   └── logging.ts        — Extended redaction
│
├── client/src/
│   ├── debounce.ts       — Fix orphaned Promises
│   ├── sync/engine.ts    — Timer guard, clone error handling, pullNow await
│   ├── extension/transport.ts — Request timeout
│   ├── mutate.ts         — Single event emission
│   ├── query.ts          — Batch date codec
│   ├── crossTab.ts       — Message validation
│   ├── events/bus.ts     — Iteration safety
│   └── adapters/memoryStorage.ts — Dedup optimization, changelog cap
│
└── server/__tests__/
    ├── security.test.ts  — NEW: comprehensive security tests
    └── namespace-isolation.test.ts — Enhanced isolation tests
```

## Dependency Graph

```
Phase 00: Shared validation utilities (no deps)
Phase 01: Security CRITICAL server (depends on Phase 00)
Phase 02: Reliability CRITICAL server (no deps on Phase 01)
Phase 03: Scalability CRITICAL (no deps on Phase 01/02)
Phase 04: Client reliability CRITICAL (no server deps)
Phase 05: Security HIGH server (depends on Phase 01)
Phase 06: WebSocket hardening (depends on Phase 01)
Phase 07: Performance HIGH (depends on Phase 02/03)
Phase 08: Data integrity + reliability HIGH (depends on Phase 02)
Phase 09: Validation MEDIUM (depends on Phase 01)
Phase 10: Server + Execution MEDIUM (depends on Phase 02)
Phase 11: Client/Core MEDIUM (depends on Phase 04)
Phase 12: LOW issues + dead code cleanup (depends on Phase 10/11)
Phase 13: Structured logging (depends on Phase 10)
Phase 14: Test coverage gaps (depends on all prior phases)
```

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|---|---|---|---|
| 00 | Shared validation primitives | Prototype check, type validator, config types | Unit tests |
| 01 | Security CRITICAL server fixes | WS auth, authz coverage, type validation, batch limits, byte measurement, prototype block | Security test suite |
| 02 | Reliability CRITICAL server fixes | Transaction atomicity, change tracking consistency, rolled-back annotation | Transaction tests |
| 03 | Scalability CRITICAL fixes | Reconcile count, clone pagination, idempotency TTL | Sync tests |
| 04 | Client reliability CRITICAL | Debouncer fix, timer guard, clone error handling | Client unit tests |
| 05 | Security HIGH server fixes | Relation authz, REST sanitization, seed namespace, having/groupBy validation, LIKE/search caps | Security tests |
| 06 | WebSocket hardening | Heartbeat, connection limits, namespace broadcast, graceful shutdown | WS integration tests |
| 07 | Performance HIGH fixes | Batch serverSeq, static imports, relation batch calls, dedup optimization | Performance assertions |
| 08 | Data integrity + reliability HIGH | TOCTOU fixes, sequence failover, double event, date codec, pull loop guard | Integration tests |
| 09 | Validation MEDIUM caps | All validation limits, deny-by-default, error disclosure, payload default | Validation tests |
| 10 | Server + Execution MEDIUM | Deduplicate code, error handling, $or fix, batch inserts, parallel pull | Unit tests |
| 11 | Client/Core MEDIUM | Cross-tab validation, EventBus safety, offline fixes, changelog cap | Client tests |
| 12 | LOW issues + cleanup | Dead code removal, type fixes, documentation, minor optimizations | Code review |
| 13 | Structured logging | Logger interface, replace console.*, redaction extension | Logging tests |
| 14 | Test coverage gaps | Security suite, namespace isolation, concurrent tests, stress tests | All tests pass |

## Definition of Done (Global)

No phase is complete unless:
1. All listed verification steps pass
2. Existing test suite passes (`bun test` in all packages)
3. No new TypeScript errors (`bun run typecheck` or equivalent)
4. Changes are limited to files listed in the phase deliverables
5. A phase report is written documenting what was done and any deviations
