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
