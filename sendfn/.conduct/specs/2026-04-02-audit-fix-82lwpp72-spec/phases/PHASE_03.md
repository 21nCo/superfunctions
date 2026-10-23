# Phase goal

Extend the query and persistence layer so provider-message correlation, richer event filters, and adapter fidelity are available for higher-level flows.

## In scope / Out of scope

- In scope:
  - provider-message-id lookup
  - event query filter expansion
  - suppression normalization
  - memory/test-double fidelity
- Out of scope:
  - cryptographic webhook verification
  - admin HTTP envelope work

## Deliverables

- `sendfn/typescript/src/database/sendfn-db.ts`
- `sendfn/typescript/src/types.ts`
- `sendfn/typescript/src/events/tracker.ts`
- `sendfn/typescript/src/suppression/manager.ts`
- `sendfn/python/sendfn/database/helpers.py`
- `sendfn/python/sendfn/database/memory.py`
- `sendfn/python/sendfn/events/tracker.py`
- `sendfn/python/sendfn/suppression/manager.py`
- `sendfn/python/sendfn/models.py`
- `sendfn/typescript/tests/database_contract.test.ts` (new)
- `sendfn/python/tests/test_database_helpers.py` (new)
- `sendfn/python/tests/test_memory_adapter.py` (new)

## Requirements covered

- `DB-001`
- `SUP-001`
- `TEST-002`

## Implementation tasks

1. Add TypeScript and Python query helpers for `providerMessageId`.
2. Expand event query filters to include provider, user, and time window semantics.
3. Normalize suppression emails to lowercase trimmed keys in both SDKs.
4. Implement deterministic suppression bulk-add and export flows, including stable ordering and normalized deduplication.
5. Make the Python memory adapter reject duplicate IDs and emulate production-like lookup behavior.
6. Strengthen TypeScript test doubles so duplicate IDs and webhook lookups can fail realistically.
7. Add contract tests for the new query paths, normalization rules, and suppression bulk/export behavior.

## Verification steps

1. Run `npm test --workspace sendfn/typescript -- --run database_contract`.
   - Expected outcome: TS DB helper tests pass.
2. Run `python3 -m pytest sendfn/python/tests/test_database_helpers.py sendfn/python/tests/test_memory_adapter.py`.
   - Expected outcome: Python helper and memory adapter tests pass.
3. Manually exercise `TV-DB-001-P` and `TV-SUP-001-P`.
   - Expected outcome: exact vector expectations are met.

## Stop condition

Stop after provider-message lookups, event filters, suppression normalization, and realistic adapter/test-double behavior are available and verified.
