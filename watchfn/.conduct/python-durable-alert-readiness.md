# Python durable alert lifecycle and pending outbox

SPEC section9 requires named definitions, stored metric evaluation, explicit
recovery, acknowledgement and notes. The prior Python database path still kept
those definitions/state only in the local manager. Database WatchFn now lazily
binds a durable manager using its existing storage owner loop and shared adapter.
No extra engine, SQL abstraction or runtime raw SQL is introduced. Event-only
clients do not require alert tables or an alert-valid namespace.

## Storage and transition contract

Exported `get_alert_schema()` supplies `watchfn_alerts` and
`watchfn_alert_outbox` with TS-compatible names and JSON-text payloads. Hosts
migrate before alert use. Namespace is the trusted Watch name, not tenant auth.
Each lifecycle transition uses an atomic revision predicate and writes pending
channel obligations in the same transaction; outbox failure rolls back state.
The optional shared transaction `update_many` extension is required and detected
before writes. There is no select/unconditional-write emulation.

Shared prerequisite059aaaced was published separately, then ordinarily merged
into Watch as1121286b5. It adds the optional protocol without changing the base
TransactionAdapter protocol, and uses one conditional SQL UPDATE on the existing
SQLAlchemy transaction connection. Core/SQLAlchemy normal CI and installed-wheel
native writer tests are documented in `_conduct/python-transaction-cas-readiness.md`.

Create/list/update/get, enable/disable, notes, acknowledgement, manual resolution
and windowed stored evaluation now survive close/reopen. Observation selection
retains separate per-condition metric windows over one completed bounded event
snapshot. Each alert commits independently with its observed definition revision;
concurrent edits or another worker's transition conflict instead of overwriting
state or duplicating notifications. No cross-page atomicity or combined
observation/definition snapshot guarantee is claimed.

`register(Alert)` is only partially compatible: original trusted full definitions
are insert-if-absent/idempotent without resetting state. Public getters return
detached objects with redacted channel metadata; named public channels cannot be
registered as a delivery configuration. Use trusted full configuration with
create/update. Starting the database owner loop is now required before durable
registration. Legacy array evaluation cannot mutate durable state. Removal is
explicitly unavailable until notification reconciliation; disabling is supported.

## Delivery and privacy boundary

Transitions persist bounded `pending` outbox rows for triggered, acknowledged and
resolved events. They are never marked delivered in this slice. Public channel
metadata reports configured:false; process_notifications explicitly raises.
No provider HTTP calls or custom senders run. Dispatcher leasing, retries,
dead-letter reconciliation, provider configuration, callbacks and calculated-value
notification context remain required original work, not completed parity.

Stored credentials and notification snapshots are plaintext: hosts must protect
the database/backups. Get/list/legacy getters/notifications redact channel secrets.
Shared adapter errors are sanitized because their SQL parameters may contain the
payload. Custom adapters must honor the shared error contract and avoid logging
credentials themselves. Stored payload, notes, timestamps, namespace, revision and
pending-count shapes are validated before mutation.

Bounds: definition32KiB, total alert payload512KiB,100 notes of4096 characters,
10 channels, default100 pending obligations per alert, pages1–100. Legacy get_all
raises rather than truncating beyond100 definitions. Existing event scan and
observation caps remain. Per-record bounds do not limit total retained database
volume; delivery/retention policy is still required.

## Validation and cleanup

- Normal Python package CI and fresh five-wheel installed consumer:138 tests each.
  Installed imports resolve to site-packages; FastAPI/Flask ingest/query/auth
  contracts remain covered, and no new HTTP alert routes were added.
- Native SQLite close/reopen restores definition, triggered/acknowledged/resolved
  state, notes and pending obligations. Duplicate resolution does not enqueue again.
- Two independent Watch clients, adapter engines and owner threads race the same
  observed revision: exactly one commits and one conflicts; one notification exists.
- Injected outbox failure rolls back lifecycle; capacity failure preserves state;
  an ambiguous post-commit retry does not duplicate the trigger obligation.
- Unsupported transaction CAS fails before writes; namespace isolation and stopped
  lifecycle reject access. Event-only database usage remains valid without alert
  migration or alert namespace requirements.
- Public secret redaction, SQL constraint-error sanitization, invalid stored
  note/count/time shapes, full-definition replacement and idempotent original
  registration covered. Existing shared window vectors still run through actual
  memory and SQLite stored evaluation.
- Early validation exposed sub-millisecond producer timestamps being excluded by
  integer-truncated evaluation time. Default evaluation preserves fractional epoch
  milliseconds; only the outbox's scheduling column is stored as integer millis.
  Final full source and installed acceptance pass without relaxing future filtering.

Logs: `/tmp/watch-durable-{ci,wheel,focused}.log`. Owned wheel environments and
SQLite fixtures clean up automatically; source venv removed after checks. No
provider sends, deployment, release or push. This checkpoint leaves dispatch and
other documented original readiness requirements open.
