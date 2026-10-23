# Phase 06: Secrets and testfn/hostfn steps

## Phase goal
Inject job secrets from secfn at job start; implement testfn/run and hostfn/deploy steps in runner.

## In scope
- secfn client in control plane: resolve secret by key (e.g. HOSTFN_SSH_KEY); inject into job env when preparing job payload for runner; never store secret in store or log.
- Expression evaluation: resolve secrets.* and github.* (and hashFiles if needed) at job/step start; redact secrets from log output.
- testfn/run step: with config (e.g. vitest.config.ts), reporter; invoke testfn SDK in runner (same process or subprocess); pass/fail from test results; report step status.
- hostfn/deploy step: with environment, ci: true; set env HOSTFN_SSH_KEY etc. from secfn; run hostfn CLI: hostfn deploy <environment> --ci; capture exit code and output.

## Out of scope
- Docker runner; hostfn-runner type (Phase 09); full expression grammar (minimal: secrets.X, github.ref).

## Deliverables
- `cifn/typescript/control-plane/src/secrets/secfn-client.ts` (get secret by key).
- Job payload builder: merge job env and resolved secrets into env; send to runner.
- `cifn/typescript/runner/src/steps/testfn-run.ts` (call testfn SDK).
- `cifn/typescript/runner/src/steps/hostfn-deploy.ts` (spawn hostfn CLI with env).
- Log redaction: strip secret values from step output before sending to logfn.
- Tests: TV-SEC-003, TV-INT-004, TV-INT-006, TV-PIPE-009, TV-OBS-002.

## Requirements covered
- SEC-001, INT-003, INT-006, RUN-008, OBS-002.

## Implementation tasks
1. secfn client: getSecret(key) returning value; used by control plane when building job env; keys requested from pipeline (env secrets.HOSTFN_SSH_KEY → request HOSTFN_SSH_KEY).
2. When creating job payload for runner: resolve all secrets.* in job env and step with; put resolved values in env; do not include in stored run/job (store only key names or nothing).
3. Runner: receive env with secrets already injected; run steps with that env; before sending stdout/stderr to logfn, redact known secret keys (env keys that are marked secret or match pattern).
4. testfn/run step: require testfn SDK; load config from workspace; run tests (e.g. vitest run or testfn runner); map exit code to step success/failure; stream or buffer output to logfn.
5. hostfn/deploy step: read environment and options from with; spawn process hostfn deploy <environment> --ci with env (HOSTFN_SSH_KEY etc from job env); capture stdout/stderr and exit code; report step status.
6. Tests: job with env secrets.MY_SECRET; assert MY_SECRET in env at step run but not in log output; testfn step with dummy test file; hostfn step with mock (hostfn not required on host, or skip in CI).

## Verification steps
- Run with job env ${{ secrets.TEST_SECRET }}; TEST_SECRET = "redact-me"; assert log output does not contain "redact-me". TV-SEC-003, TV-PIPE-009, TV-OBS-002 pass.
- Run testfn/run step with minimal vitest project; assert step success when tests pass, failure when fail. TV-INT-004 pass.
- Run hostfn/deploy step with mock or real hostfn; assert CLI invoked with --ci and env. TV-INT-006 pass.
- Run tests: `npm test` for secrets and steps.

## Stop condition
- Secrets from secfn injected and redacted in logs; testfn and hostfn steps implemented and tested. Report: "Phase 06 complete; secrets, testfn, hostfn steps ready for Phase 07 (runner auth, API auth)."
