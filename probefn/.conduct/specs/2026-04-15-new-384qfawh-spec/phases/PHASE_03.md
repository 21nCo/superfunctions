# Phase goal

Implement the Playwright browser runner and raw runtime evidence capture.

# In scope / Out of scope

- In scope: browser launch, context lifecycle, page creation, console/page/network event capture, trace wiring.
- Out of scope: semantic navigation, design analyzers, baseline comparison.

# Deliverables

- `packages/browser-runner/package.json`
- `packages/browser-runner/src/index.ts`
- `packages/browser-runner/src/browser-runner.ts`
- `packages/browser-runner/src/event-capture.ts`
- `packages/browser-runner/src/trace.ts`
- `packages/browser-runner/test/browser-runner.test.ts`
- `packages/core/src/session-state.ts`
- `packages/core/src/session-manager.ts`

# Requirements covered

- `BROWSER-001`
- `EVENT-001`
- `OBS-001`

# Implementation tasks

1. Launch Playwright Chromium sessions through the browser-runner package.
2. Wire console, page-error, request-failure, and response-failure capture into storage sinks.
3. Add trace recording hooks and trace-path persistence.
4. Finalize session state transitions for browser startup and shutdown.
5. Add integration tests using the healthy and console-error fixtures.

# Verification steps

1. Run `pnpm --filter @probefn/browser-runner test`.
   Expected outcome: browser launch and event-capture tests pass.
2. Run `pnpm --filter @probefn/browser-runner typecheck`.
   Expected outcome: no type errors.
3. Run `pnpm probefn report export --session sess_trace --format json`.
   Expected outcome: exported JSON references a local trace path when tracing is enabled.

# Stop condition

Report the exact event types captured, one sample persisted event envelope, and the trace-path format before starting Phase 04.
