# Artifacts

Probefn writes evidence to repository-relative paths under `.artifacts/`.

## Run Layout

Each run has a stable local root:

```text
.artifacts/
  runs/
    run_healthy/
      session.json
      browser.trace.zip
      report.json
      report.md
      session-storage/
        storage-state.json
      checkpoints/
        landing/
          checkpoint.json
          screenshot.png
          dom.json
          ax.json
          layout.json
          styles.json
      events/
        console.ndjson
        page-errors.ndjson
        network.ndjson
      devserver/
        stdout.ndjson
        stderr.ndjson
  auth-profiles/
    customer-admin/
      storage-state.json
  baselines/
    registry.json
```

## How Reports Map To Evidence

`report export` does not invent evidence. It indexes and links:

- run manifest metadata
- checkpoint manifests
- event sink entries
- design findings
- baseline diff summaries
- trace path when present

The JSON report includes `artifactReferences` so an agent can map a finding back to the local source files that produced it.

## Event Sinks

Runtime events are append-only NDJSON:

- `events/console.ndjson`
- `events/page-errors.ndjson`
- `events/network.ndjson`
- `devserver/stdout.ndjson`
- `devserver/stderr.ndjson`

These files are intended to be machine-readable and stable enough for downstream report building.

## Redaction

Sensitive values are redacted before persistence/export where required by the contract.

- secrets are replaced with `[REDACTED]`
- auth-profile storage-state paths are omitted from exported structures by default
- export warnings note when sensitive auth-profile references were omitted

## Instability

If a checkpoint is captured during dev-server instability or HMR noise, the checkpoint and related design findings are marked unstable. Those warnings remain visible in exported reports so agents can distinguish deterministic issues from transient capture noise.


## Durable Run Quotas

The default admitted artifact budget remains **2 GiB per run**. `ArtifactStore`
uses a local SQLite coordinator at `<artifactRoot>/.quota.sqlite` to serialize
writers across instances and processes. Node.js 22.13.0 or newer is required.
The cap is persisted before artifact IO. A newly opened store cannot increase an
existing run's cap; a lower configured cap is persisted without deleting evidence.
If retained bytes exceed that lower cap, new writes fail until the application
explicitly removes artifacts. Distinct runs have independent byte budgets.

Accounting scans actual retained file sizes, including manifests, reports,
checkpoints, visual diff PNG/JSON, browser trace/video/screenshot evidence, event segments and session
state associated with that run. Reopening does not reset usage. The existing
50,000-events-per-file default is recovered from persisted sink state and actual
files after restart. Configured `maxEventsPerSink` and error/rollover behavior
remain enforced across separate sink instances.

Atomic replacement reserves the new staging bytes while the previous file still
exists. A replacement therefore needs room for both versions until rename.
Successful replacement releases the old bytes; failed writes remove their owned
temporary output, and explicit deletion makes its bytes available again. This
changes the previous cumulative-attempt semantics: repeated overwrites no longer
consume quota forever. Calls that cannot fit fail with `E_STORAGE_CAP_EXCEEDED`;
evidence is never silently truncated.

SQLite's OS transaction lock is released when a writer crashes. The next writer
reconciles actual files and removes abandoned files from the reserved
`.probefn-staging` directory while exclusively holding that lock. It does not use
PID/age-based lock stealing. Partial event records are charged as retained bytes
and rejected on append, requiring explicit repair or deletion rather than silent
truncation. Session-state paths belong permanently to their recorded run; use a
new session ID for a new run. Both `writeArtifact` and `writeArtifactStream` require
an explicit `{ runId }` scope for session-state paths, including replacement of
already registered files. Repository/artifact ancestors and files must not be
symlinks, hardlinks or special files.

Use `ArtifactStore.createEventSink`, `writeArtifact`, `writeArtifactStream`,
`importArtifactFile` and `deleteArtifact` for run output. Direct low-level
`NdjsonEventSink`/`ArtifactCapTracker` instances and generic writes outside a run
retain their legacy local accounting and do not establish a durable run quota.
Shared auth profiles and baseline-registry storage are not per-run artifacts.
The artifact tree and coordinator must be application-owned on a local filesystem
with working SQLite file locks; arbitrary external writers are not sandboxed.

This is an admitted-artifact limit, **not a hard quota on total filesystem disk
usage**. SQLite metadata/journals, filesystem allocation overhead, and opaque
Playwright recording/trace scratch files are outside the admitted payload budget.
Trace output is now imported incrementally through the capped store and its owned
scratch directory is removed on normal success/failure. Screenshot/video evidence
also goes through store admission. A killed browser/host process can leave opaque
browser scratch behind; OS-enforced scratch quotas and crash reclamation remain
required before claiming a total-run physical disk bound. No post-hoc file-size
check is presented as such a bound.


### Video streaming and cleanup retries

Ephemeral CLI checkpoint video waits for Playwright finalization into the browser's
owned scratch directory, then checks its known size against the checkpoint and
remaining durable run budgets before reading the first chunk. It copies bounded
64 KiB chunks through `ArtifactStore.writeArtifactStream`; each write still checks
the quota. Hashing existing video/trace artifacts is incremental. Short, growing,
or failed streams never commit a checkpoint manifest. The existing
`videoCapture(): Promise<Uint8Array>` callback remains supported for SDK callers;
those callers own its allocation. Prefer `videoCaptureStream` for bounded reads.

A failed video scratch removal retains the browser session and runtime ownership,
even after Chromium disconnects. The structured error includes `cleanupPending`
and `scratchDirectory`; retry `session.stop` on the same live runtime (or
`BrowserRunner.stopSession` on the same runner). New playback and independent
managed writers remain blocked until cleanup succeeds. A stopped browser is not
reopened during cleanup retry. Finalized trace receipts survive scratch removal
failures and session-state persistence failures, and are recorded on retry. Host shutdown must report cleanup failures rather
than silently discarding the runtime. If that host exits or is killed, retained
in-memory cleanup ownership cannot reclaim files: offline operator cleanup and
crash reclamation remain separate requirements. The finalized disk copy and
Playwright encoder scratch remain outside admitted payload accounting; streaming
does not establish a physical disk quota.
