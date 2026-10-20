# Secret-scan completion evidence

2026-10-20 UTC. A scan summary with status failed and zero findings previously created pass evidence and could mark its control compliant. The regression reproduces this through the real CompFn check/evidence/readiness APIs using the shared memory adapter.

A supplied scan status must now identify successful completion before the findings count can certify pass/fail. Failed, running, cancelled, pending and unknown statuses produce unknown evidence. Counts must be nonnegative safe integers. Omitting status preserves the existing synchronous-summary client contract. Raw summary metadata remains attached to evidence for inspection.

Tests cover persisted evidence/readiness for five incomplete/error statuses, completed zero/positive counts, legacy omitted status and malformed counts. No adapter endpoint or live provider is exercised by these injected-client tests. Existing production requirements, real-provider acceptance and deployment gates remain open.

Validation: 123 core tests across 15 files, core/CLI typechecks and both builds pass on this branch. The five new persisted-evidence cases failed against the previous implementation and pass after the change. No shared packages, generated artifacts or ignore rules changed.
