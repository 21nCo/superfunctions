# Full local MCP release gate

Validated on October 28, 2026, against candidate `85c625c5d` plus the gate changes committed with this receipt. This extends the core/admin and minimum-runtime evidence in `dev-runtime-integration-20261028.md`.

## Gate improvements

- Unit-test commands use one worker; package steps remain sequential. Playwright already uses one worker.
- The gate now builds, typechecks and tests shared admin, and runs the actual core/admin tarball runtime acceptance and production audit. These were previously separate checks and could be omitted by future release runs.
- The fresh multi-package consumer install prefers online metadata. The initial full run passed its earlier acceptance steps but failed installation with `ETARGET` for `@aws-sdk/credential-provider-env@^3.972.77`. An online registry lookup returned version 3.972.77 and confirmed the parent dependency. After refreshing metadata and changing this preference, the complete gate passed. The observation is consistent with stale cached metadata; no dependency requirement was relaxed.

## Validation

Clean scoped installation included root tooling and all gate workspaces (1004 packages). Used Node 22.13.0 and the lockfile's Playwright 1.59.1 Chromium 147 binaries; no user browser profile was loaded.

`node scripts/gate-mcpfn-release.mjs` completed with `ok: true`: **93 of 93 steps passed**. Coverage includes:

- Shared prerequisites and OAuth/core/admin/client/auth/testing/inspector/DataFn server/DataFn adapter/CLI build, typecheck and test steps.
- Built schema entries with runtime code generation disabled, mixed-entry redaction and native browser PKCE.
- Calculator manifest validation/diff/scenarios and production-client roundtrip; external authenticated fixture; official active conformance; actual local Workers startup.
- Release-tag mapping validation (no tags created), ESM/CommonJS exports and testing subpaths, package file/executable inventory.
- Fresh tarball installation, ESM/CommonJS consumers, external harness exports, stdio and HTTP roundtrips, DataFn writer ownership and documentation inventory.
- The newly included core/admin packed acceptance reported zero production advisories for that isolated graph.

The release temporary directory was removed and absence read back. No deployment, package publication, base merge or cloud-account resource was created. Only the intended gate edit and this receipt were added; the pre-existing untracked `runtime-dependency-acceptance.md` was preserved.

Local receipts: `/tmp/mcp-release-root-ci-20261028.log`, `/tmp/mcp-release-browser-install-20261028.log`, initial failure `/tmp/mcp-full-release-20261028.log`, and successful full result `/tmp/mcp-full-release-online-20261028.log`. The final JSON records each step's command and exit status.

## Qualification limits

Several packages retain exact published core 0.0.5, OAuth 0.1.1 and older DataFn dependencies. Installing the current top-level tarballs does not replace those nested versions. This proves the tested mixed graph works; it does not prove every consumer runs the new core, or that the whole mixed graph is security-clean. The zero-advisory result applies to the isolated core/admin graph only. The separate minimum-runtime matrix covers core/admin, not all ecosystem packages. Hosted CI and post-publication registry acceptance remain open. This gate's success does not establish universal production readiness across all functions.
