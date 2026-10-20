# CiFn durable webhook notification checkpoint

2026-10-20. Implements the webhook delivery portion of SPEC §7.3. The subsequent
[SendFn email checkpoint](email-notification-readiness.md) adds authenticated email
transport; per-pipeline configuration and hosted provider acceptance remain open.

## Configuration and integration

The built control plane requires durable SQLite storage when notifications are
enabled. Configure:

```sh
CIFN_NOTIFY_ON_RUN_COMPLETE=true
CIFN_NOTIFICATION_WEBHOOK_URL=https://receiver.example/cifn-events
```

The flag accepts only `true` or `false`; default is disabled. Enabled configuration
without an explicit HTTP(S) webhook fails startup. Userinfo/fragments and
non-HTTP protocols are rejected. Redirects are not followed. Incomplete email configuration fails explicitly. Complete configuration uses the
subsequent email transport described above; the legacy `EmailSendFnClient`
placeholder still rejects instead of returning fabricated success.

Programmatic durable callers may supply `DatabaseStoreOptions.notifications` or
`createApp({store,sendFnConfig:{enabled:true,webhookUrl}})`. The durable app returns
`notificationPublisher`; embedding applications must start/stop it, as the built
server does. Injected `sendFn` callbacks are rejected for durable stores because
they bypass this delivery contract. MemoryStore's existing callback interface
remains a best-effort local/testing path and is not durable delivery evidence.

The destination is snapshotted into each run's encrypted state at acceptance.
Changing configuration applies to subsequently accepted runs; it does not reroute
or erase pending events. Disabling new notifications does not discard already
accepted delivery obligations. Historical runs without the snapshot produce no
retroactive event. Configuration must be consistent across accepting replicas.

## Atomic event and delivery semantics

The first terminal run transition creates one event inside the same encrypted
run-row CAS. This includes remote DAG completion, direct terminal status updates,
and cancellation. A failed update commits neither transition nor intent. Repeated
completion/cancellation and stopped receipts do not create additional events.

Event IDs are stable SHA-256 identities over namespace, run ID, terminal status
and protocol version. Payloads include `eventId`, `runId`, terminal `status`,
`pipelineRef`, trigger type, timestamps and a fixed summary. Raw trigger payload,
commands, environments, logs and prepared credentials are excluded. Known secret
values are redacted from pipeline references, URL userinfo/query/fragment are
removed, and reference strings are capped. Destinations remain encrypted at rest
and are never printed in failure diagnostics.

A `cancelled` event means cancellation intent committed. Its summary explicitly
states that subprocess termination is tracked separately. It does not claim that
jobs stopped, change completion semantics, or replace claim stopped receipts.

The publisher scans ten terminal records per bounded tick and advances a cursor.
It CAS-claims each pending event with a random token and a ten-second lease. HTTP
POST uses a three-second timeout and includes both `Idempotency-Key` and
`X-CiFn-Event-Id` headers. Only a 2xx response followed by a matching, unexpired
lease acknowledgement records delivery. Failed requests, non-2xx responses and
expired leases preserve pending work. Retry delay doubles from one second and
caps at sixty seconds; retries are not silently discarded after an attempt cap.
An expired lease can be reclaimed after process failure; stale workers cannot
acknowledge a newer lease. Shutdown waits for the active bounded publisher tick.

Delivery is **at least once**. A receiver may accept a request whose response is
lost, or before CiFn crashes while recording its receipt. The same event ID is
retried and the receiver must deduplicate it. A 2xx response means receiver HTTP
acceptance, not downstream email delivery or exactly-once effects. No generic
remote SendFn API was invented; at this webhook checkpoint the SendFn email/provider integration still
needs its documented SDK and transaction-status semantics.

## Evidence

Native SQLite tests cover atomic terminal/outbox rollback with an actual trigger,
close/reopen, concurrent publisher claims, expired/forged/stale lease rejection,
stable event identity, retry backoff, delivered-event suppression, disabled and
invalid configuration, and explicit failure of the email placeholder. Real HTTP
tests return 503, accept then drop a response, retry after database reopen with
receiver deduplication, and never return headers to verify the request timeout.

`verify-notifications.mjs` starts the built control plane as a subprocess and a
real HTTP receiver. It drives authenticated completion, observes failed delivery
and accepted response loss, SIGKILLs the control plane, reopens the same SQLite
file, verifies replay with one receiver identity, retries completion, delivers a
cancellation-intent event, and verifies disabling new events does not emit one.
It scans SQLite/output for fixture secrets and cleans children, sockets and files.
This probe exercises notification delivery, not shell execution; the separate
remote execution probe proves real shell/DAG/cancellation behavior.

```sh
npm test --workspace=./cifn/typescript/control-plane
npm run lint --workspace=./cifn/typescript/control-plane
npm exec --workspace=./cifn/typescript/control-plane -- tsc -p tsconfig.durable.json
npm run test:notifications --workspace=./cifn/typescript/control-plane
npm run test:remote --workspace=./cifn/typescript/control-plane
```

Validation passed on local Node 20.20.0/macOS with native SQLite: 174
control-plane tests (22 durable cases), package typecheck, strict durable
configuration with `skipLibCheck:false`, CJS/ESM/declaration build, the notification
process/HTTP acceptance probe, and the existing real remote shell/DAG/cancellation
probe. No hosted receiver, email provider, production deployment, or load test
was used as evidence.

## Remaining original gates

Hosted SendFn/provider acceptance, per-pipeline notification options,
credential rotation/migration tooling, operator dead-letter/retry tooling, retention,
large-history scan/index performance and deployed receiver/provider acceptance
remain incomplete. Memory notification callbacks are not made durable. Existing
execution lease/reconciliation, remote provider/log/artifact, platform/runtime,
Python/CLI/dashboard, load/performance and deployment gates remain open.
