# Phase goal

Implement generic subprocess execution and deterministic scaffolding helpers.

# In scope / Out of scope

- In scope:
  - `clifn/exec`
  - `clifn/scaffold`
  - timeouts
  - capture and streaming
  - dry-run file operations
  - overwrite policies
- Out of scope:
  - product-specific shell commands
  - template engines
  - browser launch orchestration

# Deliverables

- Create `clifn/core/src/exec.ts`
- Create `clifn/core/src/scaffold.ts`
- Modify `clifn/core/src/index.ts`
- Create `clifn/core/tests/exec.test.ts`
- Create `clifn/core/tests/scaffold.test.ts`

# Requirements covered

- `EXEC-001`
- `FS-001`
- `SEC-001`
- `OBS-001`

# Implementation tasks

- Implement subprocess execution with deterministic result objects.
- Support buffered capture plus optional stream hooks.
- Implement timeout handling and timeout reporting.
- Implement scaffold operations for mkdir and write-file.
- Enforce overwrite policy semantics.
- Reject path traversal outside the configured working directory.
- Add dry-run support and tests.

# Verification steps

- Run `npm run test -- --filter=clifn -- exec scaffold`
- Expected outcomes:
  - subprocess capture and timeout tests pass
  - scaffolding respects overwrite policies
  - path traversal is rejected

# Stop condition

Stop after generic exec and scaffold helpers are safe, deterministic, and test-covered.

