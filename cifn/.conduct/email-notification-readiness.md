# CiFn durable SendFn email checkpoint

2026-10-20. Extends the terminal-run notification outbox required by SPEC §7.3
with the existing SendFn `POST /email` API. This is a bounded integration
checkpoint; it does not establish full CiFn or SendFn production readiness.

## Configuration and compatibility

Set `CIFN_NOTIFY_ON_RUN_COMPLETE=true`, `CIFN_NOTIFICATION_EMAIL_TO`,
`CIFN_SENDFN_EMAIL_URL`, `CIFN_SENDFN_ADMIN_KEY`, and `CIFN_SENDFN_USER_ID`.
The URL is the full email endpoint, including any deployment prefix. It accepts
HTTP(S) without userinfo, query or fragment; redirects are rejected. Use HTTPS
outside local testing. Choose one email or webhook destination. Incomplete
configuration fails explicitly. Email requires a durable store. Programmatic
`SendFnConfig` exposes corresponding `emailTo`, `sendFnEmailUrl`,
`sendFnAdminKey`, `sendFnUserId` fields. No new production dependency is required.

The destination is captured when the run is accepted and encrypted with the
existing deployment-supplied 32-byte store key. The terminal transition and
notification intent still commit in one run-record CAS. Existing webhook string
destinations remain readable unchanged. Endpoint/admin key/recipient/user changes
apply to future runs only; already accepted runs retain their snapshot. Operators
must drain or reconcile old intents before invalidating those credentials. No
new key is generated, persisted separately, or silently migrated. The deprecated
standalone `EmailSendFnClient` placeholder still throws; it does not bypass the
durable transport.

## Delivery state and uncertainty

Each request contains the fixed notification event ID as SendFn's
`idempotencyKey`, with `cifnEventId` and `cifnRunId` metadata. Authorization uses
SendFn's bearer admin key. Email text contains only the existing redacted fixed
run summary; cancellation says cancellation was requested, not that processes
stopped. Prepared jobs, environments and secrets are not email content.

A request has a three-second timeout and a 64 KiB response limit. The existing
ten-second lease, CAS fencing and capped one-to-sixty-second retry backoff apply.
Network uncertainty, timeout, 429/unknown 5xx, and a `pending` transaction retain
the same identity for retry. SendFn suppression occurs before transaction creation:
a bounded JSON HTTP 500 envelope with `ok: false`, `SENDFN_SUPPRESSED`,
`retryable: false`, and the matching recipient is parked as `sendfn_suppressed`.
Unknown codes, mismatched recipients, missing details, malformed JSON and oversized
error bodies remain retryable; arbitrary error text is never persisted. A successful HTTP envelope is insufficient: the transaction
must match the recipient, user, and event metadata, have a UUID identifier, and
report `sent` or `delivered` with a nonempty provider message ID and valid sent
time. The stored receipt preserves that status; `sent` is provider acceptance,
not inbox delivery. The historical `deliveredAt` outbox field records acceptance
by this transport, with `emailReceipt.status` disambiguating the provider state.

Failed/bounced/complained transactions, rejected requests, and structurally
invalid receipts are parked for explicit reconciliation. Malformed or oversized
JSON remains retryable without changing identity. No fresh key is generated to
force a failed or uncertain transaction to send again. Parked intents survive
restart and are excluded from automatic claims. `DatabaseStore.getNotificationState`
returns only event ID, attempts, timing and fixed receipt/reconciliation metadata;
it omits credentials, destinations and message content. There is no operator
retry/reconciliation endpoint yet.

The actual SendFn service returns existing terminal transactions, returns recent
pending transactions, and only reclaims stale pending transactions for providers
that declare idempotency support. Non-idempotent stale work becomes an explicit
ambiguous failure. CiFn preserves those states. SendFn/provider idempotency
retention and transaction database durability remain prerequisites; CiFn cannot
promise exactly-once delivery across a provider's expiry window.

## Source integration and evidence

`email-transport.test.ts` imports the actual SendFn `EmailService`, `SendfnDb`,
`ResendAdapter`, schema and template engine from this repository. A local HTTP
bridge hosts the service with the documented bearer/envelope boundary; an actual
local HTTP receiver exercises ResendAdapter's request and idempotency header.
This is source integration, not acceptance of the entire SendFn router, an npm
consumer installation, or the hosted Resend service. SendFn transaction state in
this fixture uses the shared memory adapter; it does not prove SendFn database
restart durability. CiFn's outbox tests use real file-backed SQLite, not memory.

The tests demonstrate response loss after actual service/provider acceptance,
replay returning one transaction with one provider call, pending suppression,
provider failure followed by terminal failed replay, invalid receipt binding,
invalid configuration/authentication, actual pre-transaction suppression with
the router-shaped error envelope, hostile/unknown error-envelope handling,
response size and timeout bounds, and
CiFn SQLite close/reopen for uncertain and parked intents. Database bytes do not
contain the snapshotted admin credential. Reopened delivery retains the event
identity and stores a sanitized acceptance receipt.

Validation commands:

```sh
npm test -w @cifn/control-plane
npm run lint -w @cifn/control-plane
npx tsc -p cifn/typescript/control-plane/tsconfig.durable.json
npm run build -w @cifn/control-plane
node cifn/typescript/control-plane/scripts/verify-notifications.mjs
```

## Remaining original gates and upstream prerequisite

The generic `sendfn/typescript/src/delivery.ts` provider currently discards the
returned email transaction status and reports `sent: true` even for pending or
failed transactions; its default parameter mapping also omits the delivery
idempotency key. This checkpoint uses the actual email API contract directly and
does not fix or certify that generic provider. It remains an upstream integration
gate before substituting that abstraction.

Full SendFn router and packed-package acceptance, durable SendFn transaction
restart, hosted provider/inbox delivery, provider idempotency expiry behavior,
credential rotation tooling, per-pipeline notification options, operator
reconciliation/retry interfaces, retention and large-history indexing/load tests
remain open. Existing CiFn execution lease/reconciliation, remote Docker/provider
steps, logs/artifacts, platform/runtime, Python/CLI/dashboard and deployment gates
remain open. Local HTTP acceptance does not imply hosted delivery or full readiness.
