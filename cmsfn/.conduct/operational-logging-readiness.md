# Metadata-only operational logging

The original OBS-001 requirement and phase 13 call for login/logout, role changes,
release publication attempts/results and preview mint metadata without document bodies,
asset bytes or credentials. At checkpoint `26acc27e895a31768414f180ee6abc8e741388f7`,
the logging helper had only unit-test callers. A new actual HTTP fixture successfully
changed a role and minted a preview token but observed zero operational records
(`/tmp/cms-observability-baseline.log`).

The HTTP server now emits correlated attempt/result records for role upsert/delete,
preview minting and manual publication. The host-driven due executor emits corresponding
scheduled records, including the verified execution subject. Results distinguish denied
or failed calls, successful publication, partial publication and pending/uncertain
execution. Validated handlers supply target metadata; a bounded trusted-host resolver
supplies the request subject. Unverified body/header identities are never copied.

Authentication remains deployment-defined. `reportSessionEvent` records a host-completed
login/logout outcome; it does not implement or claim authentication. Hosts requiring
complete actor records must provide their existing verified session resolver. Missing,
failed or timed-out enrichment leaves the subject absent and does not affect permission
checks. It receives an abort signal and is bounded to 250 ms.

The existing CMS sink interface remains compatible with a LogFn host adapter. A strict
allowlist replaces the old shallow sensitive-key blacklist. Metadata strings are bounded
to 512 UTF-8 bytes, exclude control characters and are omitted if invalid. Only safe
counts and canonical error codes are emitted. Documents, role definitions, asset bytes,
tokens, request headers, raw provider errors and per-document failure messages are never
projected into records.

Sink throws or rejected promises increment process-local `loggingStatus().failures`
without changing a committed operation's response. At most 128 asynchronous sink calls
remain in flight; additional records increment failures without queuing. The default
sink writes structured JSON to stdout. This is bounded best-effort logging, not a durable
outbox or exactly-once delivery. Host sink shutdown/flush, synchronous blocking and
non-cooperative callbacks remain host responsibilities. Durable ContentFn audit and
release execution journals remain separate authoritative records.

## Validation

Node 20.20.0:

- `npx vitest run src/__tests__/operational-logging.test.ts`: six actual HTTP/metadata
  tests passed, covering role/preview success, denial, storage exceptions, host session
  reports, verified identity timeout/failure, sink throws/rejections after committed
  writes, bounded stalled sinks, allowlist privacy and manual success/lost-ACK uncertainty.
- `npx vitest run src/__tests__/scheduled-releases.test.ts`: 15 native SQLite tests
  passed, including two new scheduled logging cases. They verify partial outcomes,
  trusted denied subjects and successful committed publication despite sink failure.
- `npx turbo run typecheck test build --filter=@cmsfn/server --filter=@cmsfn/studio`:
  35 successful tasks, 138 server tests and 138 Studio tests, types and ESM/CJS builds.
  These are the complete selected server/Studio suites; core-package tests were not
  rerun because core source did not change. This is not a claim about all CMS packages.
- `python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root
  /Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness`: fresh normal
  npm11 install of 32 packed packages, strict TypeScript, ESM/CJS and Chromium
  143.0.7499.4 full App acceptance passed with 255 actual HTTP requests. The matching
  clean ContentFn producer was `d25a8aa0892a22339517711e8c70369356242fea`.
  Installed assertions cover role/preview records, manual partial publication, scheduled
  lost acknowledgement/recovery, host session metadata and absence of fixture secrets.
- Production-only audit and the separate tooling installation reported zero vulnerabilities.

The first packed invocation omitted the existing producer-root argument and stopped
before browser launch because the CMS checkout did not contain ContentFn server dist.
Its receipt is retained separately; this was a fixture prerequisite failure, not a
production source failure. The corrected invocation used the matching built producer.

Receipts: `/tmp/cms-observability-{baseline,focused,http,scheduled,types,validation,packed,packed-final}.log`
and `/tmp/cms-observability-production-audit-{initial,final}.json`.
Both owned consumers `/tmp/cms-studio-packed-k72qsgwu` and
`/tmp/cms-studio-packed-dgg6c_1t` were removed and read back absent. All owned browser,
server and validation processes terminated. `git diff --check` passed.

Native Safari retains its earlier blocked receipt with settings restored OFF; no new
Safari attempt was made. Live deployment identity, CORS, providers and external storage
acceptance remain open. This checkpoint closes the selected operational instrumentation
gap, not whole-function readiness. No deployment, release or push was performed.

## Public JavaScript session-report validation

A follow-up regression against `56fe9bbe67fc9084dd3dfba5e23c9b727d759298` reproduced
that an unknown action or truthy string `succeeded` could be admitted as a session event.
The public hook now validates its runtime boundary before creating an operation:
exact login/logout action, a plain object with an own boolean `succeeded`, and an
optional nonempty subject string of at most 512 UTF-8 bytes without control characters.
Unknown keys (including token/password), symbols, inherited inputs and accessor
properties are rejected without invoking accessors or echoing values. Every invalid
input throws the same generic `TypeError` and admits no event.

The focused regression checks 15 malformed JavaScript inputs through `Reflect.apply`,
then verifies legitimate false and true outcomes. Nine selected logging/HTTP tests and
server typecheck passed. Existing compiler settings were preserved. Server ESM/CJS and
declaration builds passed. The fresh 32-package fixture's `--operational-only` mode
verified both actual installed module formats, eight malformed JavaScript calls with
zero admission, valid outcomes, strict TypeScript consumers and SSR. Production-only
and tooling-install audits again reported zero vulnerabilities. This follow-up did not
repeat the browser/full-suite matrix; the preceding checkpoint's full App evidence is
retained separately.

Commands:

```sh
# From cmsfn/server
npx vitest run src/__tests__/operational-logging.test.ts src/__tests__/logging.test.ts
npm run typecheck
# From the repository
npm run build --workspace=@cmsfn/server
python3 cmsfn/.conduct/studio-packed-acceptance.py --operational-only --producer-root /Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness
```

Receipts: `/tmp/cms-session-report-{baseline,focused,types,build,packed}.log` and
`/tmp/cms-session-report-production-audit.json`. The owned consumer
`/tmp/cms-studio-packed-o22gi0t8` was removed and verified absent; no owned processes
remain. The matching ContentFn producer, Safari state and remaining deployment gates
are unchanged.
