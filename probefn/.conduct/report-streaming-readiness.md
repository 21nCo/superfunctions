# Artifact-only report exports

## Contract

Original SPEC report semantics (lines 516–521) require lossless JSON and Markdown summaries; compatibility rules (lines 593 onward) preserve CLI/MCP JSON output within a schema major. The existing `buildReportJson`, `ReportService.exportReport`, `SessionManager.exportReport`, and default CLI/MCP response retain complete event arrays. They continue to do so.

The additive `exportReportArtifact` methods and CLI `--artifact-only` / MCP `artifactOnly: true` write the complete report but return artifact references instead of the full event index. Both JSON and Markdown are supported. JSON values, event order, rollover provenance, warnings, redacted-placeholder counts and correlation outcomes match the existing path; whitespace and property order are not promised byte-identical. Markdown bytes match.

Event processing uses the storage iterator with awaited writes. Correlation retains the first witness for each existing rule (at most six events), using the same predicates as full-report correlation. Auth-profile filtering and redaction are applied to each persisted event and remaining metadata. The output is written to a unique temporary file, subject to the existing cumulative attempted-byte cap, and atomically renamed after completion. Malformed input, cap errors and filesystem failures preserve an existing report and remove temporary output. Raw `ArtifactStore.writeArtifactStream` is an internal building block whose callers own content redaction, like `writeArtifact`; report APIs enforce redaction.

## Validation

Node 22:

- Five focused files: 23 tests pass, covering JSON content/Markdown byte equivalence, checkpoints/analyzers/trace metadata, first-witness rule precedence, rollover, Unicode, redaction/auth-profile filtering, malformed input, byte-cap failures, filesystem failures, CLI mode and MCP schema/response. Log: `/tmp/probe-report-tests-final.log`.
- Strict TypeScript checks pass: `/tmp/probe-report-types-final.log`.
- `npm run test:report-streaming --workspace=@probefn/workspace`: exports 160,000 events to a 274,658,664-byte JSON artifact under a 64 MiB V8 heap. The same child streams the resulting artifact and validates every event ID, line number, Unicode payload and redacted password. Disposable input/output is removed. Log: `/tmp/probe-report-memory-final.log`.
- The broader suite run before the final filesystem-error test passed 151 tests and failed one unchanged POSIX descendant-cleanup test with host `kill EPERM`; its isolated rerun passed all 12 process-lifecycle tests. No assertion or process ownership implementation was relaxed. Logs: `/tmp/probe-report-full-tests.log`, `/tmp/probe-report-lifecycle-isolated.log`.

## Remaining limits

The memory claim concerns event volume, not the entire report domain. Individual records and up to six retained witnesses, run/checkpoint/regression metadata, checkpoint audit bundles, findings and sink-name enumeration still consume memory. The default single-record bound is 64 MiB; six maximum-sized records do not fit the small-record acceptance heap. Existing full-return APIs remain output-sized. The iterator observes a live append-only file family, not an immutable snapshot across concurrent mutations.

The cap remains the existing per-store cumulative attempted-payload budget, not durable per-run disk accounting across processes, restarts, external browser artifacts or overwritten files. This change does not resolve that separate gate. Firefox host launch, Windows process ownership, packaged/hosted validation and broader original production-readiness gates remain distinct. No provider deployment or hosted CI success is claimed.
