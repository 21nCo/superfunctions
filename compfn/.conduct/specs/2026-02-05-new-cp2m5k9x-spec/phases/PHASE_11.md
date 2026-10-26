# PHASE_11: Optional CLI

## Phase goal

Implement CLI commands: compfn init, compfn run-checks [--check-id id], compfn export --framework-id <id> [--output path], compfn attest --control-id <id> --actor-id <id> [--outcome pass|fail]. init creates or migrates DB schema. run-checks runs all checks or one. export writes auditor pack JSON to path. attest creates one manual attestation evidence.

## In scope

- compfn init – load config, run schema create/migrate, exit 0
- compfn run-checks – call checks.list(), for each (or --check-id one) call checks.run(id); output summary (count run, pass/fail)
- compfn export --framework-id <id> --output <path> – call export.auditorPack({ frameworkId }); write result to path; exit 0
- compfn attest --control-id <id> --actor-id <id> --outcome pass|fail – call evidence.create({ controlId, type: "manual_attestation", actorId, outcome }); exit 0
- CLI can use CompFnAPI directly (same process) or HTTP client (if server URL in config)

## Out of scope

- Interactive prompts (optional); dashboard

## Deliverables

- `cli/src/commands/init.ts`, `run-checks.ts`, `export.ts`, `attest.ts` (or single entry with subcommands)
- Main entry: compfn <command> [options]; parse with commander or similar
- Tests: TV-CLI-001 (init, run-checks), TV-CLI-002 (export, attest)

## Requirements covered

- CLI-001

## Implementation tasks

1. Create CLI package or folder; entry point compfn or compfn-cli. Subcommands: init, run-checks, export, attest.
2. init: read config (e.g. compfn.config.json or env); create CompFnAPI with database adapter; run schema migration or create (same as Phase 00); exit 0. On error exit 1 and print error.message.
3. run-checks: create API; list checks; if --check-id use that id only else all; for each call checks.run(id); print summary (e.g. “Ran 3 checks: 2 pass, 1 fail”); exit 0.
4. export: create API; call export.auditorPack({ frameworkId: opts.frameworkId }); write JSON to opts.output or stdout; exit 0.
5. attest: create API; call evidence.create({ controlId: opts.controlId, type: "manual_attestation", actorId: opts.actorId, outcome: opts.outcome || "pass" }); print evidenceId; exit 0.
6. Write tests: TV-CLI-001 (init succeeds; run-checks runs); TV-CLI-002 (export writes file; attest creates evidence).
7. Document in README: “CLI” section with command synopsis and examples.

## Verification steps

- Run compfn init (with test config); exit 0.
- Run compfn run-checks; exit 0; output includes run count.
- Run compfn export --framework-id <id> --output /tmp/out.json; file exists and is valid JSON.
- Run compfn attest --control-id <c> --actor-id u1 --outcome pass; evidence list shows new evidence.

## Stop condition

- CLI init, run-checks, export, attest implemented; TV-CLI-001, TV-CLI-002 pass; docs updated.
