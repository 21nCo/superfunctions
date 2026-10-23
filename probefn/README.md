# probefn

Probefn is the Superfunctions browser evidence function for coding agents and humans who need to:

- drive local web apps through Playwright-backed automation
- inspect runtime evidence instead of guessing root causes
- review design quality and responsive behavior
- detect and explain visual regressions
- persist reusable local auth profiles

The implementation spec for this repository lives under `.conduct/specs/2026-04-15-new-384qfawh-spec/`.

## Local-First Guarantees

Core operation does not require a hosted Probefn service. Session orchestration, artifacts, design audits, baseline storage, report export, and auth profiles all live in the repository workspace.

## Super Console Administration

`@probefn/admin` mounts an explicitly configured repository and `ArtifactStore`
at one exact installation/workspace/project/environment scope. Its REST, MCP,
console, and TypeScript projections expose only the public local runtime APIs:

- read, initialize, and transition a known session
- capture event baselines and compute deltas
- capture a checkpoint through a configured, already-authorized live source
- export redacted JSON or Markdown reports
- project repository-relative run and checkpoint paths

The admin package intentionally does not advertise session enumeration, browser
startup/cancellation, visual-baseline approval, flows, auth-profile mutation, or
cloud control-plane operations because the current ProbeFn core has no matching
scoped administration API for those features. Evidence capture and report export
require confirmation and audit; bindings that overlap one artifact store are
rejected to prevent cross-environment access.

## Workspace commands

ProbeFn uses the root Superfunctions npm lock and Turbo graph. The `@probefn/workspace`
workspace owns integration tests and their cross-package development dependencies;
private runtime packages keep an acyclic production dependency graph. Run
`npx turbo run test typecheck --filter=@probefn/workspace` from the repository root, or
`npm test --workspace=@probefn/workspace -- packages/contracts/test` for a focused suite.
The MCP dependency must be built first (`npm run build --workspace=@mcpfn/core`)
when invoking tests directly instead of through Turbo. Install the matching
browser using `npm exec --workspace=@probefn/workspace -- playwright install chromium`.
Private runtime packages expose compiled ESM and declarations from `dist`. They
remain private; local distribution does not imply public npm publication or full
browser support. Build the closure before running commands directly.

## Quick Start

```bash
npm ci # from the Superfunctions repository root
npm run test:vectors --workspace=@probefn/workspace
npm run --silent probefn --workspace=@probefn/workspace -- session start --config test/fixtures/vite-healthy/probefn.config.ts --mode mixed --browser chromium --json
npm run --silent probefn --workspace=@probefn/workspace -- checkpoint create --session sess_healthy --name landing --json
npm run --silent probefn --workspace=@probefn/workspace -- audit design --session sess_healthy --checkpoint chk_landing --json
```

## Docs

- [Getting Started](docs/getting-started.md)
- [Agent Consumption](docs/agent-consumption.md)
- [Artifacts](docs/artifacts.md)
- [Baselines](docs/baselines.md)

## Key Commands

```bash
npm run --silent probefn --workspace=@probefn/workspace -- session start --config test/fixtures/vite-healthy/probefn.config.ts --mode mixed --browser chromium --json
npm run --silent probefn --workspace=@probefn/workspace -- page find --session sess_healthy --query "Save button" --json
npm run --silent probefn --workspace=@probefn/workspace -- checkpoint create --session sess_healthy --name landing --include-trace --include-styles --json
npm run --silent probefn --workspace=@probefn/workspace -- report export --session sess_healthy --format json
npm run --silent probefn --workspace=@probefn/workspace -- run flow --session sess_console_error --file test/fixtures/vite-console-error/flows/trigger-error.yaml --json
npm run --silent probefn --workspace=@probefn/workspace -- auth profile save --session sess_auth --profile customer-admin --json
npm run --silent probefn --workspace=@probefn/workspace -- mcp serve --stdio
```

## Paginated MCP event reads

`probefn_page_get_console`, `probefn_page_get_network`, and
`probefn_page_get_page_errors` accept `{sessionId, limit?, cursor?}`. The default
is 100 events; `limit` accepts 1–1000. Each successful data object contains
`events`, parallel `provenance` entries (`relativePath`, physical `lineNumber`),
and `nextCursor`. Preserve the session/tool and pass `nextCursor` as `cursor`
until it is null, including after short pages. A full final page can require an
extra empty terminal request. Event payloads retain their original JSON shape.

Serialized page data, including provenance, field names and cursor, is capped at
1 MiB; MCP's text and structured envelopes duplicate this bounded data and add
formatting overhead. A single event that cannot fit returns
`E_STORAGE_CAP_EXCEEDED` rather than truncation. Missing/corrupt rollover segments
fail explicitly. Count/byte boundaries never skip an unreturned event.

Cursors are authenticated, sink/repository-bound and process-local. A process
restart invalidates them; restart traversal without a cursor. Reads assume
append-only sink files, not a retained snapshot: later pages can include later
appends. Inode/size/mtime and the last emitted record's hash detect replacement,
shrinkage, same-size edits and changes at the resume record. They do not certify
all earlier bytes against edits combined with growth. Do not modify historical
segments during traversal. Extending a previously unterminated final record
invalidates its cursor. Earlier segment contents are not reparsed per page;
directory discovery still validates the complete numeric rollover sequence.

The legacy array collector and final report document retain output-sized memory;
this change bounds the three MCP event tools only. See
[validation and remaining gates](.conduct/mcp-event-pagination-readiness.md).

### Artifact-only report export

For large event histories, request an artifact-only response:

```bash
npm run --silent probefn --workspace=@probefn/workspace -- report export --session SESSION_ID --format json --artifact-only --json
```

The MCP `probefn_report_export` tool accepts `artifactOnly: true` with either
`json` or `markdown`. TypeScript callers can use
`SessionManager.exportReportArtifact({ sessionId, format })` or
`ReportService.exportReportArtifact({ session, format })`.

This mode writes the complete report and returns its path, trace reference and
inclusion metadata instead of embedding the event index in the response. JSON
values, event order and provenance, auth-profile exclusion, redaction and
correlation results are preserved; JSON whitespace/property order may differ.
Markdown output is unchanged. Output is prepared in a temporary file and renamed
only after successful completion. Failed reads or byte-cap failures preserve an
existing report and remove the temporary output.

Event history is processed incrementally with awaited writes and at most six
correlation witnesses. Memory still depends on individual record size,
run/checkpoint/regression metadata, checkpoint audit bundles, and segment enumeration. The existing
full-return APIs and default CLI/MCP behavior continue to retain output-sized
memory. Run artifacts now use durable per-run retained-volume accounting; see
[artifact quotas](docs/artifacts.md#durable-run-quotas). Report input still is not
an immutable snapshot across concurrent sink mutations.

Run `npm run test:report-streaming --workspace=@probefn/workspace` for the actual
160,000-event export acceptance under a 64 MiB V8 heap. It verifies every exported
event and removes its disposable input/output directory.


## Runtime compatibility

Probe requires **Node.js 22.13.0 or newer**. Its artifact quota coordinator uses
built-in `node:sqlite`; this replaces the previous 22.0 minimum without adding a
native package dependency. Use the same supported Node runtime on the PATH of
CLI/MCP subprocesses. Node 22 emits an experimental SQLite warning on stderr.

## Private installed distribution

Build the CLI and administration closure from the root monorepo on Node >=22.13:

```sh
npx turbo run build --filter=@probefn/cli --filter=@probefn/admin
node probefn/scripts/verify-distribution.mjs
```

The acceptance script packs the complete runtime workspace closure, installs its
13 tarballs in an isolated consumer with normal npm resolution, and exercises the
installed executable, MCP stdio, TypeScript declarations and scoped admin service.
Set `PROBEFN_NPM_CLI` to an npm CLI JavaScript entry point when selecting a
particular installed npm version. It removes its owned consumer after completion;
it neither publishes packages nor installs browser binaries. Production audit
results are checked separately and must report zero vulnerabilities.

An internal distributor must provide all ten `@probefn` runtime packages plus
`@probefn/admin`, `@superfunctions/admin`, and `@mcpfn/core` together. Each package's
`npm pack` contains compiled JavaScript and declarations, excluding source/tests.
Private ProbeFn runtime dependencies are pinned to their matching local versions;
installing only a CLI tarball cannot fetch unpublished private dependencies.
Consumers installing the tarball closure can run `./node_modules/.bin/probefn`
from their project directory; `probefn mcp serve --stdio` starts the same MCP tools.
Config and artifact paths default to that working directory, never the package
installation directory. Programmatic CLI/MCP callers may explicitly set `repoRoot`.

The installed fixture initializes a real scoped session and exports its persisted
report through CLI, MCP and admin. It does not launch a browser or certify every
operator workflow. Browser matrices, full original vector coverage and total
physical disk accounting (including SQLite/opaque scratch) remain separate gates.
