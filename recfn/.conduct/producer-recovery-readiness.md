# Recording producer finalization and live recovery

## Failure and corrected behavior

Two focused failure regressions reproduced that `finishBotProducer` throwing in
an upload `finally` block replaced both a committed recording result and the
original `RECORDING_FINALIZATION_FAILED` error. The caller could consequently
retry an already committed upload. Finalization errors now produce a separate
`recording.producer.finish_failed` diagnostic with bot, namespace, recording,
producer identity and external-settlement state. The upload result/error remains
unchanged, including if that diagnostic logger throws. The persistent producer
intent remains available for explicit recovery; no successful cleanup is claimed.

The existing reconciliation API previously required a pending deletion. It now
also permits live-bot recovery after explicit operator proof that the original
operation, including any remote write, stopped. Under the same bot-root transaction
lock, a producer is removed only if a recording in the same namespace has its
recording ID, bot ID and (when present) exact storage reference. The recording
then remains responsible for later object deletion. A producer without matching
persisted ownership remains a settled intent, retaining its resource reference
and counting toward the 64-slot limit. Pending deletion retains all intents until
the existing deletion protocol finishes. No timeout, age, transport error or
uncertain state supplies stop proof; no automatic recovery or slot bypass exists.

This API remains a trusted operator boundary, not an HTTP endpoint or external
stop attestation. A failed upload with an unlinked object can still fill producer
capacity; safe independent orphan removal is not implemented here. Operators can
use the existing terminal-bot deletion protocol after proving all writers stopped.
No lease/owner migration or PostgreSQL schema change is included in this follow-up.

## Validation

The pre-fix recording regression run failed both new cases, with the producer DB
error replacing the intended success/error. Native SQLite coverage creates all
64 producer slots, reopens the database, verifies admission rejects, rejects
missing-reason/wrong-namespace reconciliation, retains an unlinked stored object
and its slot, then reconciles exactly one matching recording. After reopen the
recording and both objects remain, 62 unresolved producers remain active, and
exactly one additional producer can be admitted. Existing pending-deletion tests
remain part of the same suite.

Final checks on 2026-10-23, Node 20.20.0:

- Focused upload/deletion run: 18 passed; expanded upload diagnostic-failure
  cases are included in the full suite below.
- Full server with `--maxWorkers=1 --minWorkers=1`: 289 tests / 51 files passed
  in 24.30 seconds, preserving all existing per-test deadlines.
- Server typecheck and build passed.
- Final native SQLite deletion suite: 11 passed after explicitly setting the
  recovery fixture bot to `recording`; no bot deletion is needed for the matching
  recording recovery path.

The default parallel full-suite attempt returned 281 passed / 8 failed across
six files, with 5-second native test and 10-second hook timeouts (including
unchanged scratch, encryption and end-to-end cases). Aggregate collection time
was 177 seconds versus 8.81 seconds in the serial run. This is preserved as an
unresolved parallel scheduling/host sensitivity limitation; the serial pass
alone does not prove its cause or repair the default-parallel failures. No test
threshold or repository execution configuration changed.

Local receipts: `/tmp/rec-producer-baseline.log`,
`/tmp/rec-producer-focused2.log`, `/tmp/rec-producer-full.log`,
`/tmp/rec-producer-full-serial.log`, `/tmp/rec-producer-live-final.log`,
`/tmp/rec-producer-types-final.log`, `/tmp/rec-producer-build.log`.
All owned test processes exited; SQLite fixture roots and local objects were
removed by their awaited cleanup. No container or external resource was created.

Python SDK source/API is unchanged; these are
TypeScript server lifecycle and native SQLite checks, not live storage-provider
termination or deployment acceptance.
