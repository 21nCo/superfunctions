# Installed local browser acceptance — 2026-10-23

The private distribution fixture now supports `--browser`. It packs the actual
13-package CLI/admin closure, installs outside the checkout, starts the installed
npm bin as an MCP stdio server, and asks its public session tool to spawn an owned
loopback HTTP app from the consumer directory. Public page-open/action/checkpoint
and report tools execute the browser workflow. A separate installed CLI command
exports the stopped session's report.

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH \
PROBEFN_PLAYWRIGHT_VERSION=1.57.0 \
PROBEFN_NPM_CLI=/Users/serro/.npm/_npx/04c1df8cf750d1fc/node_modules/npm/bin/npm-cli.js \
node probefn/scripts/verify-distribution.mjs --browser
```

Passed on Node22.22.0/npm11.21.0, Playwright1.57.0 and cached Chromium
143.0.7499.4 (revision1200). The launcher uses Playwright's cached headless engine;
no browser settings, downloads or external application requests are involved.
The fresh default resolution requested uncached Chromium1248 and failed before
launch; the explicit fixture version is within the runtime's declared ^1.55 range.
This is evidence for the stated version, not the uncached latest engine.

The action saves a value in localStorage. The checkpoint verifies the resulting
paragraph text after storage-state restoration, PNG signature, and actual DOM,
accessibility, layout and style files. This follows the current public playback
contract: each operation owns a fresh browser and carries storage state, not
arbitrary in-memory page state. Twelve artifacts, including one screenshot, were
persisted under the consumer's `.artifacts` directory. Both MCP and installed CLI
report exports succeeded. The server PID was absent and its loopback port closed
after explicit session stop. MCP transport and the temporary installation were
closed/removed in finally blocks. Production dependency audit remained zero.
Log: `/tmp/probe-installed-browser-final.log`.

The initial malformed app fixture exposed a separate runtime gap: a syntax-error
source line containing the configured readiness pattern can be accepted before
HTTP availability is verified. That failure remains a follow-up, not passing
server-readiness evidence. The successful fixture proves the actual page content
and action result, independently of the readiness message.

This covers compiled installed browser runtime imports and local persisted assets.
It does not establish Firefox/WebKit, trace/video capture, every original workflow,
external deployments, or total physical disk quota (SQLite and opaque scratch
remain outside the logical artifact accounting claim). No Python implementation
is added. Registry publication and base-branch merging are not part of this run.
