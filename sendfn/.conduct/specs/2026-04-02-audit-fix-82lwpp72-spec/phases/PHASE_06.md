# Phase goal

Harden the release gate with realistic test doubles, exhaustive regression coverage, and repo-root verification commands.

## In scope / Out of scope

- In scope:
  - stronger TypeScript mock adapter/test support
  - Python memory adapter fidelity
  - full regression suite for packaging, email, webhook, push, and routes
  - repo-root release-gate commands
- Out of scope:
  - README prose polishing
  - new provider features

## Deliverables

- `sendfn/typescript/tests/mock-adapter.ts` (new)
- `sendfn/typescript/tests/admin_api.test.ts` (new)
- `sendfn/typescript/tests/release_gate.test.ts` (new)
- `sendfn/python/tests/conftest.py` (new)
- `sendfn/python/tests/test_release_gate.py` (new)
- `sendfn/python/tests/test_http_routes.py`
- `sendfn/python/sendfn/database/memory.py`
- `sendfn/typescript/package.json`
- `sendfn/python/pyproject.toml`

## Requirements covered

- `TEST-001`
- `TEST-002`
- `OBS-001`

## Implementation tasks

1. Replace weak TypeScript inline mocks with reusable, fidelity-preserving test helpers.
2. Expand regression coverage to include canonical envelopes, import safety, webhook mutation protection, and provider-message correlation.
3. Ensure release-gate commands are executable from repo root with documented dependency installation.
4. Add test cases that fail on duplicate ID overwrites and missing provider-message lookup support.
5. Add structured-log redaction assertions.

## Verification steps

1. Run `npm run build --workspace sendfn/typescript`.
   - Expected outcome: build passes.
2. Run `npm run lint --workspace sendfn/typescript`.
   - Expected outcome: lint/typecheck passes.
3. Run `npm test --workspace sendfn/typescript -- --run`.
   - Expected outcome: full TS test suite passes.
4. Run `python3 -m pytest sendfn/python/tests`.
   - Expected outcome: full Python test suite passes.
5. Exercise `TV-TEST-001-P`, `TV-TEST-001-N`, `TV-TEST-002-P`, and `TV-TEST-002-N`.
   - Expected outcome: release gate passes only when fidelity and tooling expectations are satisfied.

## Stop condition

Stop after the clean-checkout release gate is trustworthy and the regression suite covers the audit-fix failure classes end to end.
