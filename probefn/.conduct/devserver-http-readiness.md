# Spawned server HTTP readiness — 2026-10-23

The installed browser fixture exposed a false-success path: a syntax-error source
line containing a matching readiness URL could mark a failed child ready. A live
child printing the same banner without serving HTTP also returned success. Two
native process regressions failed against the previous implementation
(`/tmp/probe-readiness-baseline.log`).

Spawned sessions now require both the configured banner and a successful HTTP
response while the owned process is still alive. Probing shares the original
startup deadline, retries unavailable responses, cancels response bodies, and is
aborted/joined on timeout, process exit or explicit session stop. Early process
exit before HTTP success retains `E_DEVSERVER_EXIT_EARLY`; an unavailable endpoint
retains the startup timeout. No readiness deadline or shutdown grace was widened.
The current browser/dev-server contract contains no explicit non-HTTP readiness
mode. Attach mode's existing HTTP availability behavior is unchanged.

The existing lifecycle success fixtures now serve real loopback HTTP instead of
printing a banner for port1. Their process-group, descendant, SIGTERM escalation,
permission error and cleanup assertions remain intact. Additional regressions
exercise delayed503-to200 readiness and cancellation of a hung HTTP request.

Validation: all25 native lifecycle cases passed; full normal Turbo
build/typecheck/test completed17 tasks with181 integration tests in35 files plus
four admin tests. Strict types passed. Logs: `/tmp/probe-readiness-focused.log`
(the earlier23-case focused run) and `/tmp/probe-readiness-full.log` (final25-case
coverage and complete suite). The installed13-tarball browser acceptance is rerun
against this built implementation; its result is recorded below.

This fixes the reproduced startup acceptance error. It does not guarantee future
server health after readiness or prove that a reachable endpoint belongs to the
spawned child when a configuration points to an unrelated service. Physical disk
quota, broader browser matrices, trace/video and original remaining gates are
unchanged. No Python code, deployment, publication or dependency changes.

Final installed rerun passed with Playwright1.57.0 / Chromium143.0.7499.4:
13 local tarballs, actual npm bin/MCP, spawned HTTP app, storage-state action,
five checkpoint artifact kinds, CLI/MCP reports, strict consumer declarations and
production audit0. Twelve artifacts/one PNG were checked; owned PID78820 was absent
and the loopback port refused requests after stop. The script removed its temporary
installation. Log: `/tmp/probe-readiness-installed.log`.
