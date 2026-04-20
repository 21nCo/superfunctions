# Phase goal

Implement the artifact store, append-only manifests and sinks, and the sensitive-data redaction pipeline.

# In scope / Out of scope

- In scope: run directory planning, manifest writers, event sink writers, rollover behavior, redaction policy application.
- Out of scope: browser launch, dev-server process control, design analysis.

# Deliverables

- `packages/storage/package.json`
- `packages/storage/src/index.ts`
- `packages/storage/src/artifact-store.ts`
- `packages/storage/src/manifest-writer.ts`
- `packages/storage/src/event-sink.ts`
- `packages/storage/src/redaction.ts`
- `packages/storage/src/caps.ts`
- `packages/storage/test/artifact-store.test.ts`
- `packages/storage/test/redaction.test.ts`
- `packages/storage/test/caps.test.ts`

# Requirements covered

- `STORAGE-001`
- `STORAGE-002`
- `SECURITY-001`

# Implementation tasks

1. Implement run-scoped path planners for manifests, checkpoints, event sinks, diffs, traces, and reports.
2. Implement append-only NDJSON event sinks and manifest commit helpers.
3. Implement artifact and event cap enforcement with explicit rollover or structured failure behavior.
4. Implement the redaction pipeline for headers, cookies, secrets, and env-like tokens.
5. Add unit tests for repository-relative path enforcement, rollover, cap errors, and redaction-failure behavior.

# Verification steps

1. Run `pnpm --filter @probefn/storage test`.
   Expected outcome: storage, redaction, and cap tests pass.
2. Run `pnpm --filter @probefn/storage typecheck`.
   Expected outcome: no type errors.
3. Inspect generated fixture snapshots under test output.
   Expected outcome: all persisted paths are repository-relative and no secret literals remain.

# Stop condition

Report one passing example of a run directory layout, one passing redaction test, and one passing cap-enforcement test before starting Phase 02.
