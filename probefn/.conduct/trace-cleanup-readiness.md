# Trace admission and cleanup retries

Date: 2026-10-23. Baseline: 8dfe109957d3837d52ac1e9eb74b736fc2c6bc2a.

## Change

Trace admission now survives later scratch removal and chunk restart errors.
The live browser owner retains the admitted relative path, tracing state and
exact pending scratch directory independently. Repeated chunk flush returns the
previous admitted path before taking another chunk, including when the caller
chooses a different destination. Existing scratch must be removed before another
capture is attempted. Final stop keeps ownership while trace cleanup is pending
and persists the original receipt after retry.

Structured errors preserve the original storage/cap code and details. Late
failures with retained receipts or scratch are retryable; repeated cleanup and
restart failures remain structured. Both primary and cleanup causes are retained.
If import itself fails, the stopped chunk becomes inactive and no recovered trace
is claimed. No automatic recapture or crash scratch sweep is introduced.

## Reproduction

The two production source files were temporarily replaced with exact `git show`
bytes from baseline 8dfe109, with no other tests active, and restored in a
`finally` block before candidate validation. All three new admitted-receipt
regressions failed against that source: final cleanup lost ownership/receipt,
chunk cleanup retry could not return the original receipt, and failed chunk
restart left the next flush stopping an inactive chunk. The complete output is
`/tmp/probe-trace-cleanup-baseline.log`.

The first candidate full run included a new public test that created only lazy
session state, without starting a resident browser; its expected cleanup failure
therefore did not occur. The fixture now uses an explicit transport owner and
`openPage` against an owned loopback HTTP server. That failed run is retained in
`/tmp/probe-trace-cleanup-full.log` and is not passing evidence.

## Validation

Validation uses Node 22.22.0, Playwright 1.57.0 and local Chromium, with no external
site or provider traffic. Native cases cover final removal failure/retry, both
chunk failure stages with repeated failures and public error envelopes, combined
stop/removal failure without scratch ownership replacement, public session trace
persistence, and import cap failure without a false active chunk.

Commands:

- `npm exec -- vitest run --root probefn packages/browser-runner/test/scratch-cleanup.test.ts packages/browser-runner/test/artifact-quota.test.ts`
- `turbo run build typecheck test --filter=@probefn/workspace --filter=@probefn/admin`
- `npm run typecheck --workspace=@probefn/workspace`
- `PROBEFN_PLAYWRIGHT_VERSION=1.57.0 PROBEFN_NPM_CLI=<npm11 CLI> node probefn/scripts/verify-distribution.mjs --browser`

The full run at `/tmp/probe-trace-cleanup-full-final.log` passed 244 tests but
hit the unchanged design fixture's 10-second setup timeout (six tests skipped).
An unchanged rerun passed 245 tests and failed that same setup with a startup /
cleanup aggregate. An isolated unchanged run reproduced the aggregate. Read-only
SQLite inspection identified the precise contamination: `run_hmr` retained an
admitted event intent from the timed-out setup, but `removeSeed` had deleted its
referenced file without removing its coordinator state. Product recovery correctly
rejected that mismatch. The exact old server process was cwd/start-time verified,
stopped and read back absent. No coordinator intent or failure latch was reset.
Logs: `/tmp/probe-trace-cleanup-full-rerun.log`,
`/tmp/probe-trace-design-isolated.log`, and
`/tmp/probe-trace-design-stale-intent.log`.

The design fixture now owns a private temporary project with copied fixtures,
uses the same five seeded runs and unchanged 10-second setup bound, joins browser
and server cleanup in `finally`, and joins setup before deleting its root. Cleanup
failure retains the root. The isolated corrected fixture passed all six tests in
3.9 seconds (`/tmp/probe-trace-design-isolated-fixed.log`). The old synthetic
`probefn/.artifacts/.quota.sqlite` run_hmr intent remains untouched for diagnosis;
new fixture runs do not reuse that state.

Final source result: all **251 workspace tests across 47 files plus four admin
tests passed**, with all 17 uncached Turbo build/typecheck/test tasks green in
96.2 seconds. This includes the final import-cap regression and isolated design
fixture. Receipt: `/tmp/probe-trace-cleanup-full-isolated.log`.

Fresh package acceptance passed: 13 tarballs installed normally with npm 11,
strict TypeScript consumer, installed CLI/MCP/admin persisted reports, three
installed event-journal crash stages, real Chromium resident flows and trace
contents, streamed WebM, owner fences, and cap/rollover checks. Production audit:
zero vulnerabilities. The owned installed consumer was removed. Receipt:
`/tmp/probe-trace-cleanup-packed.log`. No runtime provider or deployment occurred.

Final fixture roots and owned server processes were read back absent. Logs remain
outside the repository; only scoped source/tests and these small receipts are
committed.

## Remaining boundaries

This is live-owner recovery only. Physical scratch caps, opaque browser profiles,
process-crash scratch reclamation and native platform containment remain open;
see [the next-step plan](physical-scratch-next-steps.md). Cleanup failures are
visible and retained rather than silently swallowed. Failed pre-admission captures
are not reconstructed. Previously committed durable event recovery is unchanged.
