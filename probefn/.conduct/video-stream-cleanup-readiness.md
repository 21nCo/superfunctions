# Streamed video admission and retryable scratch cleanup

The original SESSION-001, SNAP-001 and STORAGE-002 requirements need truthful
cleanup failures and complete, bounded artifact admission. Before this change,
BrowserRunner dropped a disconnected session even when removing its recording
directory failed. The runtime also dropped that ownership or cached a rejected
close promise. CLI video capture read the complete finalized recording into a
JavaScript buffer before run/checkpoint admission, then read the file again to
hash it.

BrowserRunner now retains disconnected sessions with pending scratch removal.
The runtime retains the native run owner and allows an explicit stop retry, while
rejecting another playback or independent managed writer. Finalized trace receipts
survive scratch removal failure and a later failure to persist the receipt in
session state. Abort cleanup explicitly enters the captured ownership context.

The additive stream callback waits for Playwright finalization, stats the file,
checks both configured budgets before the first read, and admits 64 KiB chunks
through the existing ArtifactStore transaction. Artifact hashes are incremental.
Short/growing streams fail; the checkpoint manifest is committed only after all
bytes and hashes succeed. The consumer promise is retained and joined even if
the producer returns or throws without awaiting it. Duplicate or late consumers
are rejected before allocation. Existing byte-array callbacks remain supported.

## Verification

Node 22.22.0, npm workspace/Turbo commands and real local Chromium were used.
All HTTP fixtures are owned loopback servers.

- Baseline scratch ownership: two native regressions failed before the fix
  (`/tmp/probe-scratch-baseline.log`).
- Early native stream run caught that `video.path()` does not join encoder
  completion; the corrected helper explicitly awaits `saveAs` in the same owned
  recording directory. The initial fixture also used invalid networkIdleMs=0;
  the public configuration test now uses its supported positive value.
- The earlier interrupted full run is not a passing result. It exposed request
  cancellation invoking cleanup outside the owner's async context; the context
  is now explicitly restored. `/tmp/probe-video-full.log` preserves that result.
- Focused final regressions: 23 passed across four files, including real WebM
  decoding, cap preflight with zero source reads, ignored async consumers,
  startup/stop cleanup failures, independent writer fencing, trace receipt retry,
  and request/session-stop cancellation. `/tmp/probe-video-resumed-focused.log`.
- Full final validation: `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm exec --
  turbo run build typecheck test --filter=@probefn/workspace --filter=@probefn/admin`
  passed all 17 tasks, 230 workspace tests in 45 files and four admin tests.
  `/tmp/probe-video-resumed-full.log` (85 seconds; no cached tasks).
- Fresh installed validation: `PROBEFN_PLAYWRIGHT_VERSION=1.57.0
  PROBEFN_NPM_CLI=/Users/serro/.npm/_npx/04c1df8cf750d1fc/node_modules/npm/bin/npm-cli.js
  PATH=/opt/homebrew/opt/node@22/bin:$PATH node
  probefn/scripts/verify-distribution.mjs --browser` passed 13 local tarballs,
  strict declaration compilation, CLI bin/MCP stdio/scoped admin, real Chromium
  143 browser actions, native ownership fencing, cap failures and live flow traces.
  The installed CLI captured a 6,645-byte WebM with matching manifest SHA-256.
  Production npm audit reported zero vulnerabilities.
  `/tmp/probe-video-resumed-packed.log`.
- Owned installed consumer and focused fixture directories were removed; process
  and temporary-directory readback found no remaining owned runners/consumers.
  No Safari settings were changed by these checks.

## Remaining boundaries

This is not a total physical disk quota. Playwright encoder/finalization scratch,
SQLite journals/metadata and filesystem allocation overhead remain outside the
admitted payload budget. OS-backed scratch limits and crash reclamation remain
required readiness work. Cleanup ownership survives only while its host remains
alive; a killed host can leave scratch files. The legacy byte-array callback owns
its allocation; the CLI uses the new stream path. No claim is made for native
Firefox/WebKit, remote providers, deployment, or an unimplemented Python runtime.
