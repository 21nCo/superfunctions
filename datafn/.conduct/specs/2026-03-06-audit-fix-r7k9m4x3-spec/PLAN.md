# PLAN: Python Package Parity with TypeScript (Non-Capabilities)

## Architecture Sketch

```
datafn/python/datafn/
├── __init__.py              # Entry point (unchanged)
├── constants.py             # System fields constants (minor update)
├── db.py                    # Adapter protocol (unchanged)
├── envelope.py              # Error types + envelope (enhanced)
├── filters.py               # Filter evaluation (MAJOR enhancement)
├── guards.py                # Guard evaluation (transaction wrapping)
├── validation.py            # SchemaIndex + validation (MAJOR enhancement)
├── relations.py             # Relation ops (refactored to use join utilities)
├── transaction.py           # Transaction wrapper (unchanged)
├── change_tracking.py       # Change tracking (unchanged)
├── idempotency.py           # Idempotency store (unchanged)
├── server.py                # Server creation (enhanced: validation, logger, plugins, limits)
│
├── utils/                   # NEW: Core utility module
│   ├── __init__.py
│   ├── sort.py              # NEW: Sort parsing + execution
│   ├── select.py            # NEW: Select token parsing + application
│   ├── date.py              # NEW: Date coercion utilities
│   ├── aggregate.py         # NEW: Aggregation operations
│   ├── normalize.py         # NEW: DFQL normalization
│   ├── joins.py             # NEW: Join table utilities
│   ├── ns.py                # NEW: Namespace helper
│   └── validate_fields.py   # NEW: Field type validation + proto pollution
│
├── hooks.py                 # NEW: Plugin hook runner
├── logger.py                # NEW: Logger interface + noop logger
│
└── handlers/
    ├── query.py             # Query handler (MAJOR rewrite)
    ├── mutation.py          # Mutation handler (MAJOR enhancement)
    ├── transact.py          # Transaction handler (fixes)
    └── sync.py              # Sync handler (enhancements)
```

## Dependency Graph

```
Phase 0: Core Utilities (no deps)
    ├── filters.py enhancement
    ├── utils/sort.py
    ├── utils/select.py
    ├── utils/date.py
    ├── utils/aggregate.py
    ├── utils/normalize.py
    ├── utils/joins.py
    ├── utils/ns.py
    └── utils/validate_fields.py

Phase 1: Validation & Schema (depends on Phase 0)
    ├── validation.py enhancement (uses validate_fields, joins)
    ├── envelope.py enhancement (error classification)
    └── server.py schema validation (uses validation.py)

Phase 2: Logger & Hooks Infrastructure (no deps on Phase 0/1)
    ├── logger.py
    └── hooks.py

Phase 3: Query Handler (depends on Phase 0, 1)
    └── handlers/query.py rewrite (uses sort, select, aggregate, filters, validation)

Phase 4: Mutation Handler (depends on Phase 0, 1)
    └── handlers/mutation.py enhancement (uses validation, date, validate_fields)

Phase 5: Transaction Handler (depends on Phase 4)
    └── handlers/transact.py fixes (uses mutation handler)

Phase 6: Sync Handler (depends on Phase 0, 1, 4)
    └── handlers/sync.py enhancement (uses date, joins, validation)

Phase 7: Server Integration & Tests (depends on all above)
    ├── server.py integration (wires logger, hooks, limits, validation)
    └── Comprehensive test suite
```

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|---|---|---|---|
| PHASE_00 | Core utility parity | All utility functions matching TS core | Unit tests for each utility |
| PHASE_01 | Validation & schema enhancement | Schema validation, FK injection, field type validation, read-only tracking, proto pollution | Unit tests for validation |
| PHASE_02 | Logger & hooks infrastructure | Logger interface, noop logger, plugin hook runner | Unit tests for hooks |
| PHASE_03 | Query handler parity | Cursor pagination, offset, limit, count, aggregation, select/omit, default sort | Query integration tests |
| PHASE_04 | Mutation handler parity | Merge decision, replace logic, batch insert, error classification, change tracking, field validation | Mutation integration tests |
| PHASE_05 | Transaction handler fixes | Atomic wrapping, rollback annotation | Transaction tests |
| PHASE_06 | Sync handler parity | Date coercion, cursor validation, pull limits, join sync, namespace consistency | Sync integration tests |
| PHASE_07 | Server integration & comprehensive tests | Schema validation on init, config validation, payload limits, field-level auth, full test suite | End-to-end test suite |

## Definition of Done (Global)

No phase is complete unless:
1. All verification steps pass.
2. All existing tests continue to pass (`pytest tests/`).
3. No regressions introduced in existing functionality.
4. Code follows existing Python conventions in the codebase (async/await, typing, etc.).
