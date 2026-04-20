# Phase goal

Implement the generic diagnostics subsystem with stable sorting, default redaction, and text/JSON formatting.

# In scope / Out of scope

- In scope:
  - `clifn/diagnostics`
  - diagnostic type
  - sort and redact helpers
  - text and JSON formatters
- Out of scope:
  - extfn scan rules
  - docsfn-specific diagnostic semantics
  - product-owned strictness policies

# Deliverables

- Create `clifn/core/src/diagnostics.ts`
- Modify `clifn/core/src/index.ts`
- Create `clifn/core/tests/diagnostics.test.ts`

# Requirements covered

- `DIAG-001`
- `SEC-001`
- `OBS-001`

# Implementation tasks

- Define the generic diagnostic shape.
- Implement deterministic sort rules.
- Implement default sensitive-key redaction.
- Implement human-readable formatter and JSON formatter.
- Add tests for sorting, redaction, formatting, and stable snapshots.

# Verification steps

- Run `npm run test -- --filter=clifn -- diagnostics`
- Expected outcomes:
  - diagnostics sort deterministically
  - sensitive values are redacted
  - formatters produce stable output

# Stop condition

Stop after generic diagnostics are usable by multiple CLI products without product-specific assumptions.

