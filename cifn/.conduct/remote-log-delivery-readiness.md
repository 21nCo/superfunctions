# Durable remote log delivery checkpoint

RUNNER-005 now has a real LogFn logger/sink path: owned shell output is redacted before the runner passes it to `@logfn/core`; its sink checkpoints private packets, the authenticated claim endpoint commits them through encrypted DatabaseStore CAS, and the run log endpoint reads the durable ledger. LogFn privacy prerequisite is branch head `87010c4c7dae32f02039ab8a2522e48e14994210`, merged normally into this branch. The dependency must accompany this change (LogFn PR 62).

## Protocol and failure behavior

Packets have stable sequence numbers and SHA-256 payload digests. Identical retries are acknowledged without duplication; changed payloads, gaps, stale execution/claim identities, wrong runners and post-terminal appends are rejected. Transport packets contain only bounded LogFn event fields; claim identity travels outside logger context. The exact `/ctx/stepKey` allowlist preserves that field without exposing environment values or credentials.

The runner atomically writes and fsyncs a mode-0600 spool inside a mode-0700 directory. Completed journals retain log outcome separately from execution outcome. A lost acknowledgement, control-plane outage or restarted runner replays the same packets without rerunning shell execution. Spool failures and truncation remain explicit. Job execution success never implies successful log delivery.

Event messages are split on Unicode code points only after configured-secret redaction. Packets are bounded to 64 KiB of serialized events and 128 events; jobs are bounded to 1 MiB and 4,096 events. Overflow ends in `truncated`, not `complete`. The original checkpoint withheld interrupted step output entirely. The live-line checkpoint below now persists redacted complete lines as they arrive and withholds unfinished trailing lines on interruption, timeout or capture overflow. The storage endpoint also rejects known secret values/lines; all-asterisk values are excluded from that secondary check because they are indistinguishable from the redaction marker.

`CIFN_LOG_RETENTION_MS` configures retention (default seven days; integer from 1 ms to 30 days). Server retention starts at claim acknowledgement; local spool retention starts at spool creation. Reads expire even a claim that never delivered its first packet. The server cleanup processes a page of 100 run records each minute and removes only expired log payloads; run/artifact records remain. Runner expiry clears its payloads on reopening/delivery, and old temporary files for that job are removed on reopening. An offline process cannot perform physical cleanup until it resumes. Empty tombstones retain replay/expiry identity.

## Configuration and remaining scope

The previous external LogFn adapter used fictional `/sinks` routes. Selecting `CIFN_LOGS_ADAPTER=real` now fails with an actionable unsupported-configuration error and does not send those requests. Use the durable SQLite control plane with `CIFN_LOGS_ADAPTER=memory` for lifecycle events; remote step logs use the separate durable protocol above. Genuine external LogFn forwarding remains open.

The original checkpoint delivered after a job finished. The subsequent [live log checkpoint](live-log-readiness.md) adds delivery during shell execution and between steps. A crashed execution whose journal is still `started` without a log outcome is not automatically sealed, replayed or rerun: another execution owner may still be active. Its log status remains pending until expiry, and execution reconciliation remains necessary. Pending therefore does not prove an active transfer. Arbitrary unknown-secret discovery is not claimed; the evidence covers configured literal secrets, multiline values and unsafe partial output.

## Local evidence

- Control-plane suite: 189 tests across 13 files; runner suite: 95 tests across five files.
- Strict durable control-plane and remote runner TypeScript configurations pass; both CJS/ESM/declaration builds pass. Actual merged LogFn source builds.
- Native HTTP/SQLite tests cover authentication, identity conflicts, sequence/digest conflicts, bounds, duplicate delivery, encrypted persistence, reopen, and expiry with and without an existing ledger.
- `node cifn/typescript/control-plane/scripts/verify-remote-logs.mjs` uses built runner/control-plane processes and actual shell stdout/stderr. It kills the control plane after a committed packet but before acknowledgement, reopens SQLite, restarts the runner, checks stable replay and exactly-once shell witnesses, then proves execution success during a log-only outage and recovery from the retained spool. Configured secret bytes are absent from transport and all owned persistence files.
- Spool tests cover multiline/Unicode redaction, cancelled secret prefixes, caps, control characters, file permissions, disk write failure and restart.
- Normal npm 11 installation of an isolated graph of 11 local tarballs passes, with `better-sqlite3@12.5.0` explicitly installed for the SQLite deployment. The installed package acceptance passes the same native crash/reopen and log-only-outage scenarios; CJS and ESM imports and declared type-file presence pass. No workspace symlink is used as installation evidence.
- Packaging explicitly includes `dist` and scripts so declared types and both server formats ship.

These are local receipts, not deployment evidence. Full monorepo npm installation remains blocked by an unrelated Fumadocs/react-router peer conflict under npm 11; no legacy-peer-deps bypass was used. Target-package packed installation is checked separately.
