# Phase goal

Implement runtime correlation and evidence-backed report generation.

# In scope / Out of scope

- In scope: hypothesis generation, unresolved-state handling, JSON export, Markdown export, artifact citation.
- Out of scope: MCP transport and auth-profile persistence.

# Deliverables

- `packages/analyzers/src/correlation/root-cause.ts`
- `packages/session-reporter/package.json`
- `packages/session-reporter/src/index.ts`
- `packages/session-reporter/src/report-json.ts`
- `packages/session-reporter/src/report-markdown.ts`
- `packages/session-reporter/test/reporter.test.ts`
- `packages/core/src/report-service.ts`

# Requirements covered

- `DEBUG-001`
- `REPORT-001`
- `OBS-001`

# Implementation tasks

1. Correlate recent actions, console events, page errors, request failures, and checkpoints into evidence-backed hypotheses.
2. Implement unresolved reporting when evidence is insufficient.
3. Implement JSON and Markdown report exporters.
4. Ensure reports link traces, checkpoints, and diff artifacts by repository-relative path.
5. Add tests for evidence-backed hypotheses and unresolved cases.

# Verification steps

1. Run `pnpm --filter @probefn/session-reporter test`.
   Expected outcome: JSON and Markdown report tests pass.
2. Run `pnpm probefn report export --session sess_console_error --format json`.
   Expected outcome: hypotheses include event IDs and confidence scores.
3. Run `pnpm probefn report export --session sess_unknown_failure --format json`.
   Expected outcome: unresolved reason is reported instead of a fabricated hypothesis.

# Stop condition

Report one hypothesis example, one unresolved example, and the exact report paths before starting Phase 09.
