# PLAN: datafn Audit Gap Resolution

## Architecture Sketch

```
@datafn/client
├── events/
│   └── bus.ts           ← BUS-001: error isolation
├── signals/
│   └── querySignal.ts   ← SIG-001/002/003: dispose, fine-grained, optimistic
├── sync/
│   ├── engine.ts        ← WS-001, RET-001: reconnect, backoff
│   └── cloneUp.ts       ← (existing, no changes)
├── offline/
│   └── mutate.ts        ← OFF-001/002/003: batch fallback, atomic merge, deep merge
├── kv.ts                ← DEB-002, KV-001: debounce, seed
├── mutate.ts            ← DEB-001, MUT-001/002: debounce, silent, system
├── query.ts             ← QRY-001: AbortSignal
├── client.ts            ← CLN-001/002, CFG-001: destroy, clear, config
├── export.ts            ← EXP-001/002: export/import (NEW FILE)
├── plugins/
│   └── softDelete.ts    ← SD-001: soft-delete plugin (NEW FILE)
├── search/
│   └── clientSearch.ts  ← SRCH-001: client search (NEW FILE)
├── crossTab.ts          ← TAB-001: BroadcastChannel relay (NEW FILE)
└── storage.ts           ← OFF-002, HEAL-001: mergeRecord, healthCheck, close, clearAll

@datafn/client (storage adapters)
└── indexedDbStorage.ts  ← OFF-002, IDB-001: atomic merge, migration reliability

@datafn/server
├── routes/sync.ts       ← (test fixes only)
└── (various)            ← TEST-002: fix test failures
```

## Dependency Graph

```
Phase 00 (test fixes)
  ↓
Phase 01 (event bus) ← foundational
  ↓
Phase 02 (signal lifecycle) ← depends on event bus changes
  ↓
Phase 03 (client destroy) ← depends on signal dispose + event bus clear
  ↓
Phase 04 (debounced mutations) ← depends on destroy flush
  ↓
Phase 05 (KV enhancements) ← depends on debounce infra
  ↓
Phase 06 (silent/system mutations) ← mutation path changes
  ↓
Phase 07 (WS reconnection) ← sync engine
Phase 08 (push backoff)    ← sync engine (parallel with 07)
  ↓
Phase 09 (signal invalidation) ← depends on signal lifecycle
Phase 10 (optimistic updates)  ← depends on signal invalidation
  ↓
Phase 11 (offline improvements) ← storage adapter changes
Phase 12 (sync config + abort)  ← config + query changes
  ↓
Phase 13 (export/import)    ← depends on storage adapter
Phase 14 (soft-delete plugin) ← depends on mutation path
Phase 15 (self-healing)      ← depends on storage adapter
Phase 16 (bulk fallback)     ← depends on offline improvements
  ↓
Phase 17 (cross-tab)      ← depends on event bus + silent flag
Phase 18 (client search)  ← depends on plugin system
Phase 19 (audit + IDB)    ← independent polish
```

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|-------|------|---------------------|--------------|
| 00 | Fix test failures | Clean test baseline (0 failures) | `npm test` passes for client + server |
| 01 | Event bus error isolation | Fault-tolerant event delivery | Unit tests for throw-through behavior |
| 02 | Signal lifecycle management | Signal dispose, registry cleanup | Unit tests for dispose + disposeAll |
| 03 | Client destroy + clear | Full client lifecycle management | Unit tests for destroy/clear behavior |
| 04 | Debounced mutations | Per-key mutation coalescing | Unit tests for debounce, flush, coalesce |
| 05 | KV enhancements | Debounced KV + seed data | Unit tests for KV debounce + getOrSeed |
| 06 | Silent + system mutations | Event suppression + system flag | Unit tests for silent/system behavior |
| 07 | WebSocket reconnection | Auto-reconnect with backoff | Unit tests for reconnection state machine |
| 08 | Push retry backoff | Exponential backoff on push | Unit tests for delay timing |
| 09 | Fine-grained signal invalidation | Per-record/field invalidation | Unit tests for selective refresh |
| 10 | Optimistic signal updates | Instant UI updates on merge | Unit tests for cache patching |
| 11 | Offline improvements | Batch fallback, atomic merge, deep merge | Unit tests for all three |
| 12 | Sync config + AbortSignal | Configurable pull + cancellable queries | Unit tests for config + abort |
| 13 | Export/import | Data backup and restore | Unit tests for export/import roundtrip |
| 14 | Soft-delete plugin | Delete → merge conversion | Unit tests for plugin behavior |
| 15 | Self-healing persistence | Health check + recovery detection | Unit tests for health check |
| 16 | Bulk mutation fallback | Individual retry on batch failure | Unit tests for partial success |
| 17 | Cross-tab coordination | BroadcastChannel event relay | Unit tests for relay behavior |
| 18 | Client-side search | Offline search via MiniSearch | Unit tests for index + query |
| 19 | Audit trail + IDB migration | Enriched changelog + safe migration | Unit tests for both |

## Definition of Done (Global)

No phase is complete unless:
1. All verification steps for that phase pass
2. All pre-existing tests still pass (`npm test -w @datafn/client && npm test -w @datafn/server`)
3. No TypeScript compilation errors
4. New code has unit tests with ≥1 positive and ≥1 negative test per requirement
5. A phase report is written documenting what was done, test results, and any deviations

## Estimated Timeline

| Tier | Phases | Effort |
|------|--------|--------|
| Production-Critical (P0) | 00–08 | ~10-14 days |
| High Priority (P1) | 09–13 | ~8-12 days |
| Medium Priority (P2) | 14–19 | ~8-12 days |
| **Total** | 00–19 | **~26-38 days** |
