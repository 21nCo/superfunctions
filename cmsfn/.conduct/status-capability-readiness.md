# Startup and operation capability enforcement

STATUS-001 requires ContentFn capabilities at startup and relevant requests. Previously the capability client ran only through GET `/cmsfn/status`; unrelated operation handlers never checked it.

## Lifecycle and mapping

The existing synchronous Node server factory is preserved. Construction/import makes no request. Listening starts the initial `server.readiness` promise, which resolves to a success/failure envelope; hosts can await it before declaring readiness and close on failure. The listener remains available for diagnostics and local-only work. This is an initial snapshot, not a cached ongoing health result. Every relevant operation probes again after authorization, bounded input parsing and configured dataset validation. Failed probes prevent the downstream operation and return `CONTENTFN_UNAVAILABLE`; later requests can recover. Local role CRUD and release create/list/add do not depend on ContentFn availability.

| Scope | Required producer capabilities |
| --- | --- |
| Startup and GET status | schema, docs, assets; realtime only when preview enabled |
| Publish, unpublish, release publish | docs |
| Enabled preview token | docs, realtime |
| Audit events | audit |
| Webhook history | audit, webhooks |
| Import/export | schema, docs, assets |

All names have the actual producer `content.` prefix. No fictional import/export capability was added. Disabled preview returns its existing configuration error without an operation probe. Publish and preview now reuse the shared 64 KiB body parser and check configured dataset boundaries while inserting the gate. Callback authorization exceptions fail closed.

`contentfnStatusHeaders` supplies server-owned status credentials without copying request/browser headers. Credential resolution and HTTP/body reading are each bounded to two seconds. Non-success HTTP, malformed envelopes/time/capabilities, responses over 64 KiB and redirects fail closed. Close aborts active lifecycle/operation probes; GET status remains bounded by its own deadlines. User credential resolvers may continue their own side effects after timeout; CMS does not claim cancellation of arbitrary host code.

## Evidence

- Full server suite: 110 tests in 19 files passed. Existing operation fixtures now explicitly advertise their supported producer capabilities rather than relying on unchecked endpoints. Protected-status coverage waits for the independent startup probe, then proves the denied status request causes no additional producer call.
- New owned HTTP acceptance verifies no construction I/O, initial readiness, authenticated status headers, no additional probes after denied/unknown-dataset/disabled-feature requests, missing capabilities blocking downstream calls, local release creation during incompatibility, docs-only publishing without unrelated features, and outage refusal.
- Separate cases verify preview-enabled startup rejects absent realtime, normal startup accepts it when preview is disabled, malformed/oversized/redirected/stalled responses fail, and hanging credential resolution times out.
- Server strict typecheck passed. Turbo Studio/server closure build: 31 successful tasks, 29 cached; rebuilt server and Studio declarations/outputs.
- Full normally installed package acceptance passed with real ContentFn `fdd2678a244c208a713e3df729f5907fcca960d1`. Chromium 143.0.7499.4 exercised 142 actual API requests retaining all earlier App coverage. It awaited startup readiness, simulated incompatible/outage status at the owned host boundary, proved export was not forwarded, observed a failed startup envelope from a second server and recovered against the real producer. These status-failure modes are explicit local host simulations, not an external deployment outage.
- Strict installed JSX/CommonJS consumers typechecked the new readiness promise; ESM/CommonJS SSR exports passed. Normal npm 11 packed production install audited 174 packages with zero advisories; consumer tooling audited 185 with zero. These isolated audits do not describe the full monorepo.

Receipts: `/tmp/cms-status-{tests,types,build,packed}.log`, `/tmp/cms-status-production-audit-final.json`. The isolated install was removed after collecting receipts; owned browser/server fixtures close, and there are no remaining owned acceptance processes.

## Remaining scope

Required automatic scheduling and the specified P1 history pane remain open. Diff is optional. Preview/media are mounted but broader native acceptance, Safari, deployment identity/CORS and external service/database gates remain separate. The capability advertisement is not a substitute for complete endpoint behavior validation. No ContentFn/shared edits, deployment or push occurred.
