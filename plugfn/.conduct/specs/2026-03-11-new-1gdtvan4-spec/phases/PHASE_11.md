# Phase goal

Implement Finatron financial email parsing pipeline with deterministic-first extraction and confidence governance.

## In scope / Out of scope

- **In scope**:
  - Deterministic parser rules for core financial message classes.
  - Model fallback orchestration.
  - Confidence, provenance, and review-state persistence.
- **Out of scope**:
  - Non-financial message intelligence features.

## Deliverables

- `plugfn/typescript/src/finatron/parsers/deterministic.ts`
- `plugfn/typescript/src/finatron/parsers/model-fallback.ts`
- `plugfn/typescript/src/finatron/parsers/pipeline.ts`
- `plugfn/typescript/src/finatron/types.ts`
- `plugfn/typescript/src/finatron/storage.ts`
- `plugfn/typescript/tests/finatron/parser-pipeline.test.ts`
- `plugfn/typescript/tests/finatron/parser-vectors.test.ts`

## Requirements covered

- MAIL-008
- ARCH-004

## Implementation tasks

1. Define normalized financial extraction schema with provenance fields.
2. Implement deterministic parsers for statements, transaction alerts, invoices, receipts.
3. Add model fallback with explicit trigger conditions.
4. Persist confidence/provenance and low-confidence review state.
5. Add golden vector tests for positive and negative parser outputs.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run tests/finatron/parser-pipeline.test.ts tests/finatron/parser-vectors.test.ts`
2. Run sample parse job replay against fixture emails and confirm deterministic outputs.
Expected outcome: deterministic-first behavior is proven and malformed/no-provenance outputs are rejected.

## Stop condition

Financial parsing pipeline produces auditable, confidence-scored outputs and passes all parser vectors.
