# Python Memory receipt and retention parity

This follow-up to `50c2823c29597fea8daef277552f578baa21f21b` closes that checkpoint's explicitly remaining unconfigured Memory lifecycle gap. Original stream acknowledgement/retention and partition requirements remain in `flowfn/SPEC.md` (P0 stream capabilities). Python durable-provider partition/retention parity and performance gates remain open.

## Reproduction

The first two tests in `python/tests/test_memory_stream_receipts.py` failed against `50c2823`:

1. A returned manual callback never expired and therefore did not redeliver within 500ms despite a 100ms visibility timeout.
2. Trimming a stream with one held and one unread message to zero removed 0 payloads instead of 2. The pending queue retained payload copies independently of the configured retention cap.

These are functional contract failures, not performance acceptance measurements. The corrected tests retain their original timeout values.

## Implementation

The receipt engine now lives in `adapters/memory_stream.py` and serves both modes; the separate `memory_partitions.py` implementation is removed. Configured groups fence by partition and track sparse per-partition cursors. Unconfigured groups fence by message ID and use one global cursor, preserving concurrent handling of different messages. Both retain only receipt metadata and retry IDs, resolve payloads from current retained history, and use existing `LeaseExpiry`/`run_with_lease` ownership mechanisms.

Active callbacks renew; returned manual callbacks stop renewal and expire at their last confirmed deadline. Exact receipt tokens fence ACK/NACK, expiry and unsubscribe cleanup, including same-name replacement consumers. Unsubscribe waits for owned callback cancellation before releasing current receipts. Cancellation-resistant callbacks can delay shutdown; expiry cannot undo their external side effects.

Memory retention now removes held and unread payloads rather than protecting them against the cap. Current receipts remain authorized to settle until expiry, but trimmed payloads cannot renew or enter a retry queue. Configured partition barriers remain independent of payload retention. Existing Python durable-provider pending-payload protection is unchanged and remains a parity gap.

This is an intentional change to older unconfigured Memory retention behavior. Hosts must size retention for required processing/replay windows. Memory is process-local, so no persisted schema migration exists; restarting into the new code does not preserve in-memory messages or receipts. This checkpoint makes no durability or performance claim.

## Validation

Focused initial result: 35 passed/4 durable-provider skips across receipt, partition and retention suites. Ruff and strict whole-tree mypy 88 files passed. Final normal CI (`node scripts/ci-run-python-package.mjs flowfn/python` with the owned Python environment on PATH) completed: wheel/sdist build, Ruff, strict mypy 88 files, 121 tests passed/126 skipped in 7.81s. Skipped tests are not native-provider acceptance. The shell wrapper stopped after completed CI because it used a read-only zsh variable; the separate wheel fixture then ran normally. No check or assertion was disabled.

The reusable `verify-python-memory-partitions.py` fixture now copies both partition and legacy-receipt suites into fresh Python 3.9/3.11 wheel consumers. It verifies installed import paths, executes both suites, checks strict consumer typing, and removes temporary environments. Existing durable-provider retention tests remain unchanged; only the Memory assertion changes to verify actual retention and absence of hidden redelivery.

## Package closure correction

The first normal build reused setuptools `build/lib` from the prior checkpoint and carried the removed `memory_partitions.py` into its wheel. Both runtime/consumer suites passed, but that artifact is not the final package acceptance evidence. The fixture now builds from an owned clean source copy excluding generated build/dist/egg-info/cache directories and asserts the removed module is absent from the archive. The stale, untracked repository build/dist outputs were removed after checking they contained no tracked files. Final clean-copy wheel results on October25,2026:

- Python 3.9.6: 30 tests passed in 2.31s; strict typing of both installed consumer files passed.
- Python 3.11.14: 30 tests passed in 2.25s; strict typing of both installed consumer files passed.
- The archive contained `memory_stream.py` and excluded removed `memory_partitions.py`; installed imports resolved inside each isolated environment.
- Owned clean source copy and both consumer environments were removed, with absence verified. All commands/processes exited0. No native services, containers, external provider calls, dependency metadata changes or deployments were involved.

The remaining parity gaps are Python Redis/PostgreSQL partitioning and their payload-retention behavior, plus cross-language durable protocol/layout compatibility. Memory-only receipt/retention gaps described by the preceding checkpoint are closed by this slice. Original performance gates and whole-product readiness remain open.
