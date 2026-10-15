# Remaining functions readiness assessment

Snapshot: 2026-10-15. Source checkout `/Volumes/Dev/n/superfunctions`, local `next` `523c66ae8cf981ff8331d56386cec1f81c704182`, `origin/dev` `5c0276d2e10d5d91472d9dde4347a651db048a62`, `sf-next/next` `b21477fc9a32ae425c38a2de810b5a8705fc711f`.

All 16 candidates below have zero differences between local next and sf-next/next and no matching changed files in `/tmp/sf-readiness-prs.json`. This uses the supplied PR snapshot, not a fresh GitHub query. Source inspection does not prove tests pass or production readiness. Test-file counts below are inventory counts, not successful executions. These functions remain in scope until implementation and acceptance gates are complete.

## Suggested dependency-aware order

| Order | Function | Concrete readiness work |
| --- | --- | --- |
| 1 | browsefn | TS/Python implementations and 22 test files; run existing seven-command `.conduct/release-gate.md` against dev dependencies, packaged consumers and actual HTTP/provider behavior. README labels Alpha. |
| 2 | chartfn | 13 test files, core and React/Svelte bindings. Verify actual vendor chart rendering, disposal, SSR imports and packed consumers. Core directly depends on React/ReactDOM and all three chart vendors; assess bundle/runtime boundaries. |
| 3 | drawfn | 16 test files and React/Svelte bindings. Canvas test setup mocks rendering contexts; actual browser interaction/export/lifecycle acceptance remains necessary. No Python implementation. |
| 4 | compfn | 13 test files; schema wrapping already present in `src/compfn.ts:19`. Validate persistent evidence storage and AuthFn/SecFn client contracts; README heading still uses obsolete `@superfunctions/compfn`. |
| 5 | contentfn | 17 test files, core/server/client/CLI/admin. Schema wrapping exists at `server/src/server.ts:125`. Verify current MdFn markdown/extensions/content adapters and dev DB/HTTP contracts before CMSFn. |
| 6 | cmsfn | 25 test files; requires ContentFn. Studio declares `mdfn`, absent by package name from dev. `server/src/index.ts:78-159` forwards raw `config.db` to roles/releases without schema wrapping; implement schema ownership and non-memory adapter acceptance. |
| 7 | testfn | No TS core test files; `typescript/package.json` permits success with `--passWithNoTests`. Add meaningful runner, timeout/error, storage, visual and analytics tests. `typescript/src/integrations/vitest-adapter.ts:90` launches file-derived arguments with `shell: true`; investigate/fix command injection boundary. Python has two behavior test files. Required by CiFn. |
| 8 | flowfn | `typescript/src/workflow/workflow.ts:319-325` makes approval/event wait steps sleep or immediately continue. Implement real suspension/resumption/event delivery. `python/flowfn/queue/queue.py:139` omits retry backoff. Verify durable recovery, retries and real backend behavior. |
| 9 | logfn | `typescript/src/http/watch.ts:115-118` acknowledges accepted events without storing them. Implement injected ingestion/persistence contract and failure acknowledgements; verify TS/Python transport parity. |
| 10 | watchfn | `typescript/src/query/query-engine.ts:34-40` ignores time ranges and aggregations. Browser synthetics, dynamic monitoring reconfiguration, email delivery and source maps contain unfinished implementations. Align local HTTP adapters with shared-package instructions. Example declares absent `@watchfn/sdk`. |
| 11 | catchfn | WatchFn delivery unfinished at `typescript/src/core/catch-fn.ts:204`. `server/typescript/src/service.ts:14` accepts raw Adapter without schema wrapping. Implement schema ownership and end-to-end ingestion/storage/delivery; verify current FileFn compatibility. |
| 12 | userfn | Public client ignores bootstrap flags at `typescript/src/index.ts:35-37`; identify/track/render leave delivery/rendering unfinished at lines 106/120/125. Feedback submission unfinished at `typescript/src/core/feedback.ts:7`; Python SurveyEngine absent at `python/src/userfn/client.py:15`. Requires full implementation. |
| 13 | cifn | Runner depends on uncovered `@testfn/core`. Email client logs that it would send and returns success at `typescript/control-plane/src/sendfn/sendfn-client.ts:64-67`. Integrate actual SendFn; verify queued execution, failure/retry, artifacts, secrets/redaction, deployment and Python client. |
| 14 | recfn | 282 non-conduct files, 64 test files, meeting/browser/ASR/native adapters. `server/src/store/db.ts` accepts raw Adapter without schema wrapping. Align package/version contracts and verify actual recording/transcription, reconnect, consent, retention and provider acceptance. Hosted POC instructions use incorrect workspace name `recfn-server`. |
| 15 | probefn | Nested pnpm/Turbo monorepo (`pnpm-workspace.yaml`, `turbo.json`, root scripts) must integrate into root npm workspaces. `packages/mcp-server/package.json` uses `file:../../../mcpfn/core`, resolving incorrectly under `probefn/mcpfn/core`. Private packages export source TS; define consumable artifact strategy and verify browser/MCP acceptance. CLI checkpoint explicitly says video capture unimplemented. |
| 16 | iconfn | Only tracked README and package manifest; no source, exports, tests or spec. Build/test only print no configuration. README recommends Iconify. Define and implement useful package contract; do not silently omit or count skeleton as complete. |

## Shared gates and limits

Every port needs root workspace and lockfile integration, compatibility with current dev shared APIs and versions, meaningful behavior checks, packaged consumers, actual runtime acceptance, Python where present, and a scoped PR. A green existing script does not establish completeness when it permits no tests or acknowledges unimplemented work.

Declared shared/internal dependency package names exist on dev except the listed TestFn, ContentFn, `mdfn`, and WatchFn example dependencies. This name-level check does not establish version or API compatibility. Raw database adapters must be wrapped internally with function-owned schemas under current AGENTS instructions. Keep existing source capabilities in scope; do not narrow success to easier tests or merely importing files.

This assessment is static, read-only source evidence. It neither ran function tests nor modified implementation. No function in this inventory is declared production-ready.
