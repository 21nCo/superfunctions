# Phase goal

Implement the generic output service and preserve `clifn/ui` through a compatibility wrapper.

# In scope / Out of scope

- In scope:
  - `clifn/output`
  - text/json output
  - quiet/verbose behavior
  - table rendering
  - spinner behavior
  - `clifn/ui` compatibility wrapping
- Out of scope:
  - runner integration
  - config loading
  - diagnostics sorting/redaction

# Deliverables

- Create `clifn/core/src/output.ts`
- Modify `clifn/core/src/ui.ts`
- Modify `clifn/core/src/index.ts`
- Create `clifn/core/tests/output.test.ts`
- Modify `clifn/core/tests/ui.test.ts`

# Requirements covered

- `COMP-001`
- `OUT-001`
- `OBS-001`

# Implementation tasks

- Implement `createOutput()` with deterministic text and JSON modes.
- Support injected stdout and stderr writers.
- Implement quiet and verbose behavior.
- Implement deterministic table rendering based on declared columns.
- Reuse or adapt the existing spinner behavior behind the new output service.
- Reimplement `clifn/ui` as a compatibility layer over the new output service.
- Add unit tests covering text output, JSON output, tables, spinners, and `ui` compatibility.

# Verification steps

- Run `npm run test -- --filter=clifn -- output ui`
- Expected outcomes:
  - text output tests pass
  - JSON mode emits exactly one newline-terminated document
  - table output is deterministic
  - existing `ui` tests still pass

# Stop condition

Stop after the new output service works and `clifn/ui` remains source-compatible.

