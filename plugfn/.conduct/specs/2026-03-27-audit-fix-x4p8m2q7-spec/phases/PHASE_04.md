# Phase goal

Make workflow lifecycle handling and CLI diagnostics production-real instead of log-only or placeholder behavior.

# In scope / Out of scope

- In scope: workflow trigger unregister behavior, durable delay/idempotency semantics, CLI provider diagnostics
- Out of scope: Python implementation

# Deliverables

- `plugfn/typescript/src/core/workflow-engine.ts`
- `plugfn/typescript/src/storage/workflow-storage.ts`
- `plugfn/typescript/tests/workflow-lifecycle.test.ts`
- `plugfn/typescript/tests/workflow-durability.test.ts`
- `plugfn/cli/src/commands/test.ts`
- `plugfn/cli/tests/test-command.test.ts`
- `plugfn/docs/operations/release-gates.md`

# Requirements covered

- `WORKFLOW-001`
- `CLI-001`

# Implementation tasks

1. Replace the log-only `unregisterTrigger()` behavior with real trigger detachment.
2. Persist enough workflow execution state to survive restart and multi-instance resume.
3. Return deterministic failure codes when unregister or durability guarantees cannot be met.
4. Upgrade `plugfn test` to run real configured provider diagnostics and emit deterministic JSON + exit codes.
5. Add workflow lifecycle tests and CLI command tests covering both positive and negative paths.

# Verification steps

- Run `npm test --workspace plugfn -- --run plugfn/typescript/tests/workflow-lifecycle.test.ts plugfn/typescript/tests/workflow-durability.test.ts`
- Run `npm test --workspace @plugfn/cli -- --run`
- Run `rg -n "unregisterTrigger\\(|setTimeout\\(" plugfn/typescript/src/core/workflow-engine.ts`
- Expected outcome: workflow tests and CLI tests pass, unregister behavior is no longer a no-op, and delay handling is either durable or explicitly rejected with deterministic failure.

# Stop condition

Report the trigger backends covered, the durability model chosen, and the final CLI exit-code contract.
