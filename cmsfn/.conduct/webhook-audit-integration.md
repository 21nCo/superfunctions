# Dataset-wide webhook audit integration

Producer prerequisite: ContentFn `92e2c826054aa1061f62ea84fa6988b7f096e7b4`.

CMS `/cmsfn/audit/webhooks` now consumes the real ContentFn schema 4
`/contentfn/audit/webhooks` result `{ records, nextOffset }`. It requests one
bounded dataset page and projects delivery metadata; it does not aggregate an
arbitrary first100 results from per-hook APIs. Both local `audit.read` permission
and configured dataset scope must pass before the trusted `contentfnAuditHeaders`
resolver is invoked. Browser credentials are never forwarded implicitly.

Opaque CMS cursors bind dataset, descending order, offset and webhook-vs-event
kind. Existing event cursors remain accepted for event queries. Wrong-kind,
wrong-dataset, malformed and oversized cursors fail before upstream I/O. Limits
are 1–1000. Record shape/dataset, page length and next-offset progression are
validated; malformed responses, non-success transports and producer readiness
errors never become empty successful pages. The existing 1MiB response bound,
10-second timeout and redirect denial apply. Error projection preserves only
safe code/status plus the enumerated `WEBHOOK_AUDIT_NOT_READY` reason.

`CmsfnWebhookDeliveryStatus.url` and `updatedAt` can now be null for legacy
history; status includes `processing`, and responses include `timestampKnown`.
Studio renders “Timestamp unknown” rather than guessing from a retry deadline.
Destination projection strips credentials, query and fragment again at the CMS
boundary. Delivery errors use an exact allowlist of known generic reasons and
HTTP100–599 status codes; arbitrary legacy/provider messages become
“Webhook delivery failed” even when returned by an older/custom producer.
ContentFn retains deleted-hook history using queue provenance; a worker that
finds a missing hook/event records terminal failed/not-attempted instead of a
fabricated delivered status; deleting
the dataset deletes that history. Delivery entries describe latest status and
attempt count, not an invented record for every previous attempt.

Hosts must deploy the ContentFn schema 4 prerequisite, backfill existing rows and
acknowledge `webhookAuditWriterSchemaVersion: 4` only after old writers are drained.
See ContentFn's `.conduct/webhook-audit-readiness.md` for DDL, resumable backfill,
unknown provenance and mixed-version limits. Unauthorized upstream access stays
denied. ContentFn schema 3 has no supported dataset-wide route and remains an
explicit upstream error, so this CMS change alone does not enable the feature.

## Evidence

- CMS server: 99 tests across 16 files; full strict typecheck and package build.
- CMS core: 46 tests, strict typecheck and package build.
- Exact copied Studio audit pane sources/tests in a fresh normal isolated install:
  5 React/jsdom tests and strict subset typecheck. Studio remains absent from the
  root workspace; this is not whole-Studio build/runtime certification.
- Committed `webhook-audit-http-acceptance.mjs`, executed with normally installed
  local tarballs: real CMS HTTP → actual ContentFn HTTP/client → shared memory
  storage; 105 actual queued deliveries across 3 pages; local signed HTTP delivery
  preserves the real destination query while audit hides it; deleted-hook history,
  dataset deletion, roles/dataset scope, trusted headers and upstream denials.
- ContentFn's native SQLite suite separately proves schema 3 DDL upgrade, bounded
  transaction rollback/restart/backfill, real worker timestamp preservation,
  unknown and conflicting provenance, plus its existing delivery/retry/reopen
  acceptance. No external provider or deployment was used.
- Strict installed NodeNext consumer compiles new producer query/migration types
  and CMS nullable/processing metadata. Normal npm11 production-only packed
  install: zero reported vulnerabilities. The isolated Studio test graph retains
  its existing Vitest3.2.4 tooling advisories; no forced dependency upgrades or
  peer bypasses were used.

Logs: `/tmp/cms-webhook-{full-final,types,server-build,core-tests,core-types,packed-install,packed-http,consumer-types,studio}.log`
and `/tmp/cms-webhook-production-audit.json`. Owned fixtures are cleaned after
validation; logs remain. An initial packed run caught missing top-level trusted
header forwarding for the webhook route; the HTTP regression and installed
acceptance now cover that wiring.

Remaining limits: offset pages are not snapshot-isolated against concurrent
queue transitions; legacy history with neither hook nor event provenance needs
explicit host reconciliation and conservatively blocks dataset queries; host
writer acknowledgement is not a distributed fence. Existing overall CMS gaps
such as full Studio lifecycle/build verification are unchanged.

Privacy follow-up: CMS99 server tests, strict types/build, and fresh packed HTTP
acceptance pass with a private legacy provider error injected into queue storage.
Neither producer nor CMS response exposes that string. The production-only normal
install audit remains zero; owned fixture removed. Logs:
`/tmp/cms-webhook-privacy-{tests,types,build}.log`,
`/tmp/cms-webhook-privacy-packed-{install,http}.log` and `audit.json`.
