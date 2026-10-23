# Resident MCP browser sessions

The original Session/browser contract binds a long-lived orchestration context to browser state. This checkpoint keeps one live browser/context/page per MCP transport-owned session across separate page, action, checkpoint and flow calls. CLI processes remain ephemeral; one CLI flow retains transient state within that invocation.

Guarded CLI/MCP mutation paths acquire canonical run/session SQLite ownership before mutation. Different transports and processes cannot mutate an owned session. Each connection closes only its own sessions. Requests propagate cancellation into playback; transport closure signals all owned operations before joining cleanup. Default cleanup response bound is 30 seconds, configurable through the runtime constructor (1–300000 ms). Exceeding it returns `cleanupPending`; the cleanup task and authority remain retained until completion. A held-close regression verifies another writer stays fenced during this interval.

Standalone operations flush genuine Playwright trace chunks without closing the page. Reports expose the ordered `tracePaths` plus latest `tracePath`. Requested checkpoint trace references are finalized before success; flow references retain their full-flow trace. Trace imports consume the existing persisted artifact allowance and fail explicitly on overflow. Resident video is explicitly unsupported because its current finalizer closes the page; ephemeral CLI video behavior is preserved.

## Evidence

Native source regressions exercise separate protocol calls retaining transient DOM input/counter state, a second process/runtime denied mutation, two connections sharing a server without sharing browser lifetime, request cancellation during a real held HTTP response, and browser close held beyond a configured 100 ms cleanup bound. The focused four resident tests passed before final packaging validation (`/tmp/probe-resident-cancel-bound.log`). The previous full resident checkpoint passed 205 integration tests across 40 files plus four admin tests (`/tmp/probe-resident-full1.log`). Final validation results are recorded below after completion.

## Boundaries

This is CLI/MCP runtime ownership, not comprehensive SDK writer fencing. Raw `ArtifactStore` calls and lower-level callers bypassing guarded operation APIs do not automatically acquire session authority. They must coordinate with owners; direct writes to an actively owned run are unsupported. Fencing those lower-level writers remains required follow-up. Read-only observation does not gain mutation rights.

Native lock metadata uses the separately documented bounded registry/slot policy. Default 256 ownership slots are a finite lifetime allocation, configurable up to 65536; exhaustion fails rather than silently dropping ownership. Offline maintenance requires all writers stopped; active registered lock databases must never be unlinked. Arbitrary external replacement of the authority directory is outside this cooperative locking guarantee. Per-run artifact caps do not bound total filesystem allocation, SQLite journals or opaque browser scratch.

Chromium acceptance does not establish Firefox/WebKit coverage. No deployment, external provider acceptance, registry release or broader readiness completion is implied.

### Validation attempts and isolation

The initial final suite under concurrent host activity failed (68 failed, 127 passed, 11 skipped; two unhandled assertion errors; 739 seconds, `/tmp/probe-resident-full3.log`). An installed pre-browser CLI report subprocess also exceeded its unchanged timeout (`/tmp/probe-resident-installed2.log`). These are retained failure evidence, not production passes. The quiet suite then completed in 55 seconds with 201 passes and five early fixture-server exits. Ten orphaned fixture children from the initial timed-out run occupied test ports. Their exact Probe working directories, fixture arguments and start times were checked before terminating PIDs 19113, 19777, 23963, 24078, 24239, 24598, 24864, 25150, 25645 and 25804; readback showed all gone. Unrelated host processes were preserved. Existing suite cleanup under severe deadline failure needs separate hardening; passing normal runs does not establish cleanup under arbitrary host starvation.

After owned-child cleanup, the unchanged-deadline full command passed all 206 integration tests in 40 files and four admin tests; all 17 Turbo build/typecheck/test tasks succeeded (55.902 seconds, `/tmp/probe-resident-clean.log`). Command from the worktree root:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH /Volumes/Dev/n/superfunctions/node_modules/.bin/turbo run build typecheck test --filter=@probefn/workspace --filter=@probefn/admin
```

A subsequent lifecycle correction stores the closed flag on each transport context instead of retaining every closed connection in a runtime-global set. In-flight closures still observe closure before/after ownership acquisition; settled connections become collectible. A regression cycles 1000 closed transports, checks no settled cleanup entries remain, and resumes a delayed operation after closure to verify it cannot acquire ownership. Final targeted results follow below.

Final transport correction: 15 Turbo build/typecheck tasks passed (`/tmp/probe-resident-final-types.log`); all five resident regressions passed in 3.88 seconds (`/tmp/probe-resident-final-focused.log`), including the 1000-context retention test. The full suite above predates only this transport-context correction; it was not rerun after the focused correction. The older completed-checkpoint overflow fixture PID 23512 was separately confirmed by exact command, worktree cwd and start time, terminated after confirming no acceptance still used it, and read back absent.

### Fresh installed consumer

The normal private 13-tarball installation passed with Node 22.22.0, npm 11.21.0, Playwright 1.57.0 and cached Chromium 143.0.7499.4 (revision 1200). Command:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH \
PROBEFN_PLAYWRIGHT_VERSION=1.57.0 \
PROBEFN_NPM_CLI=/Users/serro/.npm/_npx/04c1df8cf750d1fc/node_modules/npm/bin/npm-cli.js \
node probefn/scripts/verify-distribution.mjs --browser
```

`/tmp/probe-resident-installed-final.log` records actual npm-bin execution, MCP stdio, scoped admin imports/persistence, consumer declaration checking and production audit with zero vulnerabilities. Separate installed MCP calls preserved transient `MCP Ada:1`; an independent CLI report mutation was rejected while MCP owned the session. A separate CLI session completed its own transient flow. Independent ZIP inspection and SHA-256 verified the 159152-byte full-flow trace. Before stop the fixture observed 42 artifact files and three valid PNGs. Both CLI/MCP cap-1 checkpoints failed before manifest commit; the persisted 2 MiB run allowance and three-record event segments preserved all seven events across two rollovers. Raw storage cap checks ran only after session owners stopped.

The owned app PID 65555 exited, loopback port 61913 rejected connections, both sessions stopped, MCP client/transport closed, and the temporary installed consumer was removed. No browser download, registry publication or external service was used. Artifact count is explicitly before stop/final trace and the later cap-proof writes, not a final physical-storage total.
