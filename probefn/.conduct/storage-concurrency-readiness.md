# Storage concurrency and rollover checkpoint

2026-10-20 UTC. The original specification remains the acceptance target.

Credential assignment and Bearer-scheme redaction now handles lowercase and mixed-case strings. Regression inputs cover nested arrays, multiple credentials, repeated calls, safe text, metadata and preservation of caller input.

Storage writes reserve bytes synchronously before asynchronous I/O. The shared tracker includes pending reservations in admission decisions. Each event sink serializes append and rollover, advancing counters after successful writes. A known directory-creation failure releases its reservation; an uncertain append failure retains the budget and makes that sink terminal rather than continuing after potentially partial NDJSON. ArtifactStore snapshots JSON before reserving and serializes atomic replacement, including overlapping target names.

Accounting is a cumulative attempted-payload budget for the current tracker, including overwrites and uncertain atomic-write failures. It is not an inventory of existing files or an exact filesystem usage limit; external browser trace/video/screenshot writes and process restarts need separate accounting before claiming a global durable quota.

A shared event reader loads the initial sink and numbered rollover siblings in numeric order. Action deltas, MCP event retrieval and report generation now include rolled events. Reports retain the actual segment path and physical line number, with unique event IDs across segments. Missing anchors retain existing caller behavior; malformed records fail rather than silently disappearing. These are live reads, not retained snapshots against simultaneous rotation/deletion.

Validation: strict Probe TypeScript checking passes and the Node22.23.3 full suite passes102 tests across23 files. Targeted tests exercise cross-sink byte contention, overlapping file writes, per-sink rotation, failure accounting and recovery boundaries. Actual NDJSON files spanning12 segments verify numeric ordering, unrelated-file exclusion, action counts, MCP retrieval, report provenance, malformed data, physical line numbers and path traversal rejection. The previous browser/action checkpoint passed all28 unfiltered vectors; those vectors are not a substitute for the new concurrency cases.

No generated artifacts or additional ignore changes are included. Streaming readers, durable global disk quotas, requested video, other browsers/platforms, security/performance/accessibility and deployment acceptance remain open. No release or base merge.
