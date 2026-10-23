# Phase 09 — CLI completeness (`--local`, config resolution, URL/credentials)

## Phase goal (1 sentence)

Make the CLI fully intent-complete: remote run creation + local execution mode, robust config/path resolution, configurable control-plane URL/credentials, and safe log output.

## In scope

- Implement `cifn run` remote mode with default config search order and explicit `--config`.
- Implement `cifn run --local` using the runner engine (matching runtime semantics).
- Implement `cifn status` list/detail.
- Implement `cifn logs` with safe output (no secret values).
- Add a documented configuration surface for:
  - control plane base URL
  - API key/Bearer token

## Out of scope

- Interactive TUI.
- Shell completion.

## Deliverables (explicit list of files/modules)

- Modify:
  - `cifn/typescript/cli/src/commands/run.ts`
  - `cifn/typescript/cli/src/commands/status.ts`
  - `cifn/typescript/cli/src/commands/logs.ts`
  - `cifn/typescript/cli/src/utils/config.ts`
  - `cifn/typescript/cli/src/utils/api.ts`
  - `cifn/typescript/cli/src/cli.test.ts`

## Requirements covered

- CLI-001
- CLI-002
- CLI-003
- CLI-004
- CLI-005

## Implementation tasks (ordered checklist)

- [ ] `cifn run`:
  - [ ] Implement default config path search order.
  - [ ] Implement `--config` override.
  - [ ] Implement remote mode: parse+validate locally (optional) then call `POST /api/v1/runs`.
- [ ] `cifn run --local`:
  - [ ] Execute using runner engine locally and print a run summary.
  - [ ] Ensure `if` semantics match remote runner behavior.
- [ ] `cifn status`:
  - [ ] Implement list and detail views.
- [ ] `cifn logs`:
  - [ ] Fetch logs and print; add defense-in-depth redaction if feasible.
- [ ] Config surface:
  - [ ] Support env vars and/or config file keys for base URL and token.
  - [ ] Fail fast with clear message if missing.
- [ ] Extend tests:
  - [ ] TV-CLI-001..006

## Verification steps (exact commands or manual steps) and expected outcomes

- Run:
  - `npm -w cifn/typescript/cli test`
- Expected:
  - All tests pass.
  - CLI supports remote and local modes as specified.

## Stop condition (what to report back before starting the next phase)

Report:

- The final CLI flags and environment variables supported.
- Evidence that CLI tests are green.

