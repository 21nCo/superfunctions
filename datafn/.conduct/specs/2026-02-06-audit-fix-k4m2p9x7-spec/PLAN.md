## Architecture sketch

### Packages/modules

- **`@datafn/core`**
  - Schema types + validation + normalization
  - Canonical event and filter types
  - Determinism invariants (stable keys, stable ordering rules)
- **`@datafn/client`**
  - `createDatafnClient()` configuration resolution
  - Storage adapter abstraction + implementations (memory, indexeddb)
  - Local query engine + local mutation apply (offline)
  - Event bus + filtering + signal registry + invalidation engine
  - Sync engine (clone/pull/push) + hydration plan + reconcile
  - KV facade + codecs (dates, ids)
  - Extension transport integration (remote adapter injection, inbound events)
- **`@datafn/server`**
  - HTTP endpoints: `/datafn/*`
  - Schema-bounded validation (queries/mutations/transact/sync)
  - Execution: query/mutation/transact
  - Sync execution: clone/pull/push + join hydration + reconcile
  - Change tracking + idempotency
  - Authz enforcement + namespace isolation
- **`@datafn/svelte`**
  - `toSvelteStore(signal)` (existing)
  - Additional small helpers for Nucleus ergonomics (record-signal utilities) while preserving signals
- **Nucleus (consumer repo)**
  - Replace Flux usage with direct datafn table/signal/subscribe usage
  - Introduce Nucleus-local utility functions for common resource operations (archive/trash/lock) implemented as DFQL mutations
  - Remove reliance on `window` custom mutation events; use datafn events directly

## Dependency graph

1) `@datafn/core` type changes (event filter + mutation context + id generation contract)
2) `@datafn/client` config resolution (`sync.remoteAdapter`, local-only) + events + signals invalidation
3) KV support (core schema augmentation + client/server/storage)
4) Relation offline apply + join propagation (server push/pull/clone/apply)
5) Sync scalability (paginated clone + hydration plan)
6) Reconcile/repair
7) Local query performance/operators
8) Codecs (dates)
9) Client sync hooks + sync events
10) Server authz + namespace correctness
11) Extension inbound events contract
12) Nucleus refactor (remove Flux; consume datafn directly)

## Phases overview

Each phase delivers a verifiable vertical slice (API + behavior + vectors/tests) and is independently runnable locally.

| Phase | Goal | Capability delivered | Verification |
|------:|------|----------------------|-------------|
| 00 | Config + remote adapter + local-only + ID generation | CFG-001, CFG-002, API-001 | `npm test -w @datafn/client` |
| 01 | Context + events + filters + signal invalidation | API-002, EVT-001, EVT-002, SIG-001, SIG-002 | `npm test -w @datafn/client` |
| 02 | Built-in KV resource + API | KV-001, KV-002 | `npm test -w @datafn/client && npm test -w @datafn/server` |
| 03 | Offline apply for relation mutations | OFFM-001 | `npm test -w @datafn/client` |
| 04 | Server push supports relation ops + join change tracking | SYNC-005 | `npm test -w @datafn/server` |
| 05 | Clone/pull propagate joins + per-table pull | SYNC-003, SYNC-004, SYNC-006 | `npm test -w @datafn/server && npm test -w @datafn/client` |
| 06 | Paginated clone + hydration plan | SYNC-001, SYNC-002 | `npm test -w @datafn/server && npm test -w @datafn/client` |
| 07 | Reconcile endpoint + client reconcile | SYNC-007 | `npm test -w @datafn/server && npm test -w @datafn/client` |
| 08 | Local query perf + operators | OFFQ-001, OFFQ-002 | `npm test -w @datafn/client` |
| 09 | Date codec | CODEC-001 | `npm test -w @datafn/client` |
| 10 | Client sync hooks + sync events | HOOK-001, EVT-003 | `npm test -w @datafn/client` |
| 11 | Authz policy + namespace correctness | AUTH-001, AUTH-002 | `npm test -w @datafn/server` |
| 12 | Extension inbound events contract | EXT-001 | `npm test -w @datafn/client` |
| 13 | Nucleus direct refactor to datafn | Nucleus parity (no Flux) | `npm run build:nucleus` (in nucleus repo) |

## Definition of Done (global)

No phase is complete unless:

- Its listed verification steps pass locally.
- All referenced requirements for the phase are implemented.
- The relevant test vectors can be exercised via unit/integration tests or deterministic harnesses.
- `INTENT_AUDIT.md` shows **No missing intent items**.

