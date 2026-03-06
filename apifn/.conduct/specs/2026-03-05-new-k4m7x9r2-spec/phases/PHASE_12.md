# Phase 12: CLI Test Command

## Phase Goal
Implement `apifn test` command with multiple reporters and CI-friendly exit codes.

## In Scope
- `apifn test [collection-dir]` command
- `--env` flag for environment selection
- `--bail` flag for fail-fast
- `--parallel` and `--concurrency` flags
- `--reporter console|json|silent` flag
- `--timeout` flag
- Console reporter (colored output with pass/fail)
- JSON reporter (machine-readable output)
- Exit codes per CLI-011

## Out of Scope
- watchfn integration during tests
- testfn adapter

## Deliverables
- `apifn/cli/src/commands/test.ts`
- `apifn/collections/src/runner/reporters/console.ts`
- `apifn/collections/src/runner/reporters/json.ts`
- `apifn/collections/src/runner/reporters/silent.ts`

## Requirements Covered
- CLI-004, CLI-011, RUN-009

## Implementation Tasks
1. [ ] Implement `apifn test` command: load collection, resolve environment, run, report
2. [ ] Implement console reporter: print colored pass/fail per request, summary at end
3. [ ] Implement JSON reporter: serialize RunReport to stdout
4. [ ] Implement silent reporter: no output (for programmatic use)
5. [ ] Implement exit code logic: 0=pass, 1=failure, 2=error
6. [ ] Wire `--bail`, `--parallel`, `--concurrency`, `--timeout` flags to RunOptions
7. [ ] Integration test: run apifn test against a fixture collection

## Verification Steps
1. `apifn test ./fixtures/passing-collection --env development` → exit 0, summary shows all passed
2. `apifn test ./fixtures/failing-collection --env development` → exit 1, failure details shown
3. `apifn test ./fixtures/passing-collection --reporter json` → valid JSON on stdout
4. TV-CLI-004, TV-CLI-011

## Stop Condition
CLI test command works with all reporters and exit codes. Report sample output.
