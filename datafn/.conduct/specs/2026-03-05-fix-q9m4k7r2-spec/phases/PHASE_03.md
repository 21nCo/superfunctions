# PHASE_03

## Phase goal

Stabilize release confidence with end-to-end verification on the todo example behavior that originally regressed.

## In scope / Out of scope

- **In scope**:
  - End-to-end behavior checks for todo merge and theme KV set.
  - Final verification checklist and release notes summary.
- **Out of scope**:
  - New feature work.

## Deliverables

- `datafn/examples/todo-app` test/run notes in phase report (no required source changes)
- Optional targeted regression test additions under `datafn/examples/todo-app/*` if harness exists

## Requirements covered

- KV-001
- OBS-001
- TST-001

## Implementation tasks

- [ ] Run todo example flow: create todo, toggle completed, set theme light/dark.
- [ ] Verify DB state for namespace includes KV row and expected todo updates.
- [ ] Verify push responses align with persistence (`applied` list correctness).
- [ ] Capture command transcript summary in phase report.

## Verification steps

1. `npm run dev` (server + example client as project documents)
   - Expected: no INTERNAL/false-success on KV theme set.
2. DB query checks for namespace-scoped KV row and todo state.
   - Expected: row exists and values match latest mutation.
3. `npx vitest run datafn/server/__tests__/mutation-optimization.test.ts datafn/server/__tests__/merge-sql-regression.test.ts`
   - Expected: all pass.

## Stop condition

Report successful end-to-end reproduction of original failing scenario with persisted KV rows and no todo merge regression.
