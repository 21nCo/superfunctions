# Live flow continuity and trace evidence

## Original contract and scope

The original `2026-04-15-new-384qfawh-spec/REQUIREMENTS.md` requires Chromium (BROWSER-001); Firefox/WebKit are SHOULD coverage and may arrive later without changing the public surface. SESSION-001 permits a new session per CLI invocation. NAV-001/NAV-002 require real deterministic/semantic actions. OBS-001 requires Playwright traces and report references; video is optional. SNAP-001 permits optional artifacts to be absent when not requested. TV-OBS-001 requires a real run-relative trace reference or an explicit missing-trace warning.

This checkpoint implements one live browser/context/page across the steps of `run.flow` / `probefn_run_flow`. Input values, JavaScript variables, and DOM mutations survive between actions and the checkpoint without localStorage or a reload. It does not implement resident browser continuity across separate page MCP calls or separate CLI processes. Standalone page operations still do not record their own traces, so the broader OBS-001 requirement remains open.

## Behavior

- An asynchronous flow scope reuses only its own browser; overlapping flows or playback calls for the same session within one runtime are rejected. Cross-process playback locking is not implemented by this checkpoint. Independent sessions do not share pages.
- Flow cleanup stops tracing, imports a unique run-relative ZIP through ArtifactStore's persisted cap, and closes the owned browser. Prior flow traces are retained, never overwritten. The session/report references the latest finalized flow trace; older checkpoint references retain their original trace.
- Requested checkpoint traces are attached with SHA-256 after the flow trace has finalized, before flow success is returned. Trace finalization or manifest admission failures fail the flow. Intermediate checkpoint artifacts may remain for diagnosis after failure; they do not imply successful completion. A standalone checkpoint requesting an unavailable trace now fails explicitly instead of silently omitting it.
- Reports in a flow are final run summaries: export occurs after the browser trace and requested checkpoint links have finalized, in requested format order. They are not intermediate-step snapshots.
- The additional per-checkpoint `artifactCapBytes` allowance counts newly written checkpoint artifacts and manifest bytes; it does not count a preexisting referenced trace again. `run.flow` currently has no per-step override field. All imported trace bytes and final manifest writes still consume the persisted per-run cap. SQLite accounting and opaque Playwright scratch limitations remain as documented separately; this is not an OS filesystem quota.
- MCP request cancellation is forwarded from McpFn's request signal. The installed SDK aborts in-flight requests on connection close. `session.stop` aborts and joins its owned flow before completing the session; browser cleanup failures propagate rather than being treated as successful cleanup. No global transport-close cancellation is applied to other TCP clients.

## Evidence

The initial native regression failed both assertions: a fill followed by click and checkpoint lost the transient value, and the report's trace path was null. The fixture now uses an input plus a JavaScript counter with no storage persistence.

Final validation on Node 22.22.0 and npm 11.21.0:

- `turbo run build typecheck test --filter=@probefn/workspace --filter=@probefn/admin`: all 17 tasks passed; 197 integration tests across 38 files plus 4 admin tests. Log: `/tmp/probe-flow-final-full.log`.
- Six focused real-browser regressions passed: transient DOM state and independently unzipped action records; checkpoint SHA-256 and retention across two flows; explicit missing-trace rejection; request cancellation; session-stop cancellation; overlapping playback rejection in both acquisition orders; actual oversized trace rejected by a 65,536-byte persisted run cap without a report or successful trace reference. Log: `/tmp/probe-flow-final-focused2.log`.
- `PROBEFN_PLAYWRIGHT_VERSION=1.57.0 PROBEFN_NPM_CLI=/Users/serro/.npm/_npx/04c1df8cf750d1fc/node_modules/npm/bin/npm-cli.js node probefn/scripts/verify-distribution.mjs --browser`: fresh normal npm consumer of 13 private tarballs passed real installed MCP **and separate CLI** live flows. Chromium 143.0.7499.4, cached revision 1200. The MCP trace was 163,863 bytes; independent `unzip` reads contained the fill value and click selector, and the checkpoint hash matched. The later CLI trace used a distinct path and retained the earlier bytes unchanged. The consumer had 27 artifacts and 3 screenshots. Existing cap-1 rejection, configured 2MiB cap, seven-event rollover proof, declarations/admin imports, and production audit (0 findings) also passed. Log: `/tmp/probe-flow-final-installed.log`.
- Owned app PID 11526 was verified absent, its loopback listener closed, and the entire installed consumer removed. Source fixtures remove their temporary roots and close HTTP/browser resources in finally blocks. No dependency or lockfile changes, Python package additions, or gitignore changes.

## Remaining requirements

Resident cross-call MCP continuity, complete standalone-operation trace coverage, broader engine SHOULD coverage, and the original overall production readiness gates remain open. Optional video retains its existing separately validated behavior. No browser downloads, host settings changes, external services, deployment, or registry publication are part of this checkpoint.
