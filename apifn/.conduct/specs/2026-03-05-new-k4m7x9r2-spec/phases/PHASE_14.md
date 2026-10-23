# Phase 14: CLI Diff Command

## Phase Goal
Implement `apifn diff` command for CI/CD breaking change detection.

## In Scope
- `apifn diff <before> <after>` command
- File path and URL inputs
- Human-readable colored table output
- JSON output (`--format json`)
- Exit code 0 (no breaking) / 1 (breaking) / 2 (error)
- `--fail-on-breaking` flag (default: true)

## Out of Scope
- GitHub Actions workflow (later phase)
- PR comment integration

## Deliverables
- `apifn/cli/src/commands/diff.ts`

## Requirements Covered
- CLI-005, CI-002, CI-003

## Implementation Tasks
1. [ ] Implement `apifn diff` command: load both specs (file or URL), run diffOpenAPI(), display results
2. [ ] Implement human-readable output: table with type, path, description, breaking badge
3. [ ] Implement JSON output: serialize DiffResult matching SPEC Section 6.5
4. [ ] Implement exit code logic per CI-002
5. [ ] Implement `--fail-on-breaking` flag
6. [ ] Handle URL inputs (fetch spec from HTTP)
7. [ ] Integration test: diff two fixture specs

## Verification Steps
1. `apifn diff before.yml after.yml` → human-readable table
2. `apifn diff before.yml after-breaking.yml` → exit 1
3. `apifn diff before.yml after-nonbreaking.yml` → exit 0
4. `apifn diff before.yml after.yml --format json` → valid JSON on stdout
5. TV-CLI-005, TV-CI-002

## Stop Condition
Diff command works with correct exit codes. Report sample output.
