# Phase goal

Reduce duplication, finish shared-package adoption, and make the duplication gate pass.

## In scope / Out of scope

- **In scope**:
  - duplicate logic extraction
  - shared-package reuse verification
  - provider-normalization deduplication
  - duplication gate automation
- **Out of scope**:
  - new public features outside this spec

## Deliverables

- `browsefn/typescript/src/core/rate-limiter.ts`
- `browsefn/typescript/src/core/provider-registry.ts`
- `browsefn/python/browsefn/core/provider_registry.py`
- `browsefn/typescript/src/router/http-router.ts`
- `browsefn/python/browsefn/http/router.py`
- `browsefn/scripts/check-duplication.mjs`
- `browsefn/python/tests/test_contract_parity.py`

## Requirements covered

- SHARED-001
- RATE-001
- HTTP-001
- QA-001

## Implementation tasks

1. Remove duplicate TypeScript rate-limit algorithm logic in favor of the shared package wrapper.
2. Ensure provider alias normalization exists once per language and is consumed everywhere else.
3. Add a BrowseFn duplication-check script that wraps the documented `jscpd` command.
4. Add contract-parity tests that fail if canonical provider IDs diverge between languages.

## Verification steps

1. Run `npx jscpd browsefn/typescript/src browsefn/python/browsefn --min-lines 5 --min-tokens 50 --reporters console`.
Expected: reported duplication is `<= 5.0%`.
2. Run `node browsefn/scripts/check-duplication.mjs`.
Expected: script exits `0`.

## Stop condition

Report the final duplication percentage and the single source of truth for provider alias normalization in each language.
