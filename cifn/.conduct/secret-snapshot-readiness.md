# Acceptance-time secrets for remote shell expressions

2026-10-20. This checkpoint addresses the shell expression portion of original
PIPE-005 and the prepared-secret requirement. It does not complete remote
provider execution, log persistence, or full CiFn readiness.

Before this change, `prepareRun` discovered a step's `${{ secrets.TOKEN }}` but
resolved only environment values. The remote runner supplied no secret resolver,
so a valid shell step using that expression failed even with a configured secret
provider. A built-package local-shell reproduction returned `failure` for
`test '${{ secrets.TOKEN }}' = snapshot-test`.

## Behavior and security boundary

Preparation copies the input before its first asynchronous lookup, resolves each
referenced secret once, and captures the values before accepting the run. Each
job receives the names referenced by its own configuration and inherited pipeline
environment, not another job's step secrets. Environment interpolation and later
shell interpolation use that same snapshot. Missing providers/values and provider
lookup failures reject preparation with a fixed diagnostic; an explicitly stored
empty string remains valid. Provider exception text is not propagated.

The snapshot is an additive field in the existing encrypted prepared payload.
It follows authenticated runner claim/resume delivery, never the public run
projection. Provider rotation after acceptance does not alter pending work.
The remote runner uses the existing redaction path for both the expanded command
and captured output. Completion requests and local journal records still contain
identities/statuses only, never payloads or expanded commands. This does not
prevent a pipeline author from deliberately writing or transmitting a secret:
shell steps execute trusted pipeline code and are not a sandbox.

Interpolation now assembles substitutions using positions in the original
source. `$&`, dollar-backtick, dollar-apostrophe, `$$`, and expression-looking
bytes in a resolved value remain literal bytes; inserted expressions are never
re-evaluated, including repeated references. This applies to asynchronous secret
and GitHub interpolation and synchronous GitHub interpolation. Shell interpolation
remains source substitution, not automatic shell escaping. Use environment
variables for arbitrary shell data rather than interpolating it into a command.

## Compatibility and remaining requirements

No database schema migration or new encryption key is required. Deploy the
updated control plane and runner together before depending on remote step secret
expressions. Historical prepared jobs without a named snapshot are not silently
re-resolved; their unresolved step secrets fail closed. Existing environment-only
jobs remain usable. Missing secrets formerly treated as empty in environment
resolution now reject acceptance; explicitly configure an empty value if that is
intended. The snapshot in application memory remains sensitive and should not be
logged by embedding callers.

The remote checkpoint still supports shell steps only. Provider `uses` steps,
secret-dependent condition evaluation, remote log streaming/persistence,
execution lease recovery/reconciliation, provider/container integration and
hosted deployment remain separate original gates. This change neither adds
shell escaping nor promises transformed/encoded secret redaction. Python clients
consume public run/status APIs and receive no snapshot field; no Python SDK change
is needed for this internal runner protocol addition.

## Validation

Native SQLite tests prove a single provider lookup per name, job-scoped payloads,
input-copy isolation, secret rotation and close/reopen preservation, encrypted
SQLite bytes, sanitized authenticated public run responses, and actual local HTTP
claim-resume authentication. Shell tests execute a prepared expression, inspect
redacted command/output, and run a complete RemoteRunner tick while scanning its
journal and completion requests for secret values and expanded scripts. Missing,
failed, and explicitly empty provider values are covered. Interpolation cases
exercise literal metacharacters, repeated references, and expression-like values.

Validation uses local Node 20.20.0, native SQLite and owned local subprocesses.
The existing remote execution acceptance additionally exercises process restart,
completion replay, shell/DAG witnesses and cancellation. It does not establish
hosted provider acceptance or installed-package portability.

Commands:

```sh
npm test -w @cifn/control-plane
npm test -w @cifn/runner
npm run lint -w @cifn/control-plane
npm run lint -w @cifn/runner
npx tsc -p cifn/typescript/control-plane/tsconfig.durable.json
npx tsc -p cifn/typescript/runner/tsconfig.remote.json
npm run build -w @cifn/control-plane
npm run build -w @cifn/runner
node cifn/typescript/control-plane/scripts/verify-remote-execution.mjs
```

Final local results: 186 control-plane tests (including 24 native SQLite cases),
85 runner tests, both package typechecks, strict durable/remote typechecks, and
CJS/ESM/declaration builds passed. The built remote execution acceptance passed.
Repeating the original built-package reproduction after provider rotation now
returns `success` using the accepted value. Logs:
`/tmp/cifn-secret-control-tests.log`, `/tmp/cifn-secret-runner-tests.log`,
`/tmp/cifn-secret-final-types.log`, `/tmp/cifn-secret-build-control.log`, and
`/tmp/cifn-secret-remote-acceptance.log`. SQLite, journal and process fixtures are
removed by their cleanup paths; no persistent provider resources were created.
