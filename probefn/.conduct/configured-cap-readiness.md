# Configured artifact and event caps — 2026-10-23

## Exact requirement and boundary

Original STORAGE-002 requires configurable artifact/event caps, explicit failure
or rollover and no silent truncation. SPEC defines “Default maximum artifact
volume per run: 2 GiB.” TV-LIMITS-001 uses eventCap3 and a checkpoint override
artifactCapBytes1, expecting `E_STORAGE_CAP_EXCEEDED` before checkpoint commit.
The original documents do not require aggregate OS disk allocation limits: their
only “physical” reference permits a configurable artifact root (STORAGE-001).

Persisted artifact bytes are the original cap contract. Filesystem metadata,
SQLite journals and opaque browser profile/trace/video scratch are separate
operational limits. The accounting database pager bound is an additional control,
not a substitute for either artifact caps or a hard whole-runtime filesystem quota.
No volumes were created/mounted and no host settings changed during investigation.

## Wiring and semantics

The previous config schema dropped storage caps and the CLI/MCP runtime created
stores with defaults. Configuration now accepts validated `storageCaps`:

```ts
export default {
  storageCaps: {
    maxArtifactBytes: 2 * 1024 * 1024,
    maxEventsPerSink: 3,
    maxAccountingDatabaseBytes: 16 * 1024 * 1024,
  },
  // Existing devServers settings ...
};
```

Run artifact/event policy is persisted before producer startup, after duplicate
session admission. Later default-configured stores and separate CLI/MCP processes
use that policy. Explicit later values can lower but cannot raise an accepted
limit. Configurations above defaults remain effective; ordinary writers do not
silently replace them with defaults. Accounting byte limits remain artifact-root
scoped, while artifact/event limits are run scoped. Legacy run rows receive the
previous 50,000-event default. A per-sink explicit allowance can further restrict
the stored event policy.

An optional checkpoint `artifactCapBytes` adds a stricter byte allowance for newly
written checkpoint artifacts and its manifest. The exported core API, MCP tool
and CLI `--artifact-cap-bytes` share this behavior. It never increases or lowers
the persisted run cap. This lets the one-byte negative test fail while retaining
lifecycle cleanup and earlier evidence. Storage cap errors survive checkpoint
cleanup rather than being changed to generic capture errors.

A run budget too small even for startup and failed-state manifests now retains
`E_STORAGE_CAP_EXCEEDED`, with `manifestFinalized:false` and
`processCleanupComplete:true` only after process cleanup actually completed.
Failures to terminate a process retain the existing aggregate failure behavior;
no failed manifest is claimed as persisted when the cap prevented it.

## Acceptance

`verify-distribution.mjs --browser` uses the configured caps through the installed
CLI/MCP workflow and exports the normal checkpoint first. It then requests one-byte
checkpoints through MCP and a separate installed CLI process, checks the structured
cap errors and absence of both checkpoint manifests, and confirms later report
export still works. It reopens the installed storage API with no explicit caps,
checks the persisted 2 MiB/3-event policy, verifies an oversized run artifact fails,
and appends seven uniquely numbered records: three labeled segments, two explicit
rollover warnings, all seven records preserved. A separate configured one-byte run
fails startup with the structured cap error and no committed session manifest.

Source tests cover invalid config values, one-byte and partial-write checkpoint
failure cleanup, initial-manifest cap failure, duplicate admission without policy
mutation, and a 100,000-event configured policy remaining effective past 50,000
records after reopening with default settings. Existing independent-process cap,
pager, sink and cleanup suites remain enabled. Final results follow below.

The installed CLI emits its error JSON on stderr. Node22's SQLite experimental
warning can precede it; the fixture locates the canonical JSON envelope instead
of incorrectly treating empty stdout as an error payload.

Final validation: 191 integration tests in 37 files plus four admin tests passed;
strict types/builds completed all 17 Turbo tasks (no cached tasks). Log:
`/tmp/probe-caps-final3-full.log`. Fresh installed 13-package acceptance passed on
Node 22.22.0, npm 11.21.0, Playwright 1.57.0 / Chromium 143.0.7499.4. MCP and CLI
one-byte checkpoint errors were verified, the run policy remained 2,097,152 bytes
and three events, and all seven sequence records survived with two explicit
rollovers. The one-byte startup failure retained the structured cap error. Fifteen
artifacts and one valid PNG remained for the successful session, report export
worked, owned PID 75626 was absent after stop and its port closed. Strict installed
consumer declarations and production audit (zero vulnerabilities) passed. Log:
`/tmp/probe-caps-final-installed.log`. Temporary consumer and native fixture roots
were removed; no owned validation processes remain. No pushes or deployments.
