# Streaming meeting media — 2026-10-22

This supersedes the raw-spool limitation in `media-finalization-readiness.md`.
Original REC-001/REC-003 still require provider-backed recordings and practical
meeting-duration acceptance. The preceding valid-media checkpoint could hold
only about 1.4 seconds of 1080p RGB frames. Increasing that raw spool limit would
not make it a meeting recorder.

## Data path

`captureToFile` reads one bounded audio/video chunk per pump and writes to two
FFmpeg pipe descriptors concurrently. Each pump awaits the pipe write callback
before requesting another chunk. FFmpeg input queues are limited to four packets;
video uses two threads, zero-latency H.264, and one-second fragmented MP4 output.
Only encoded output reaches disk, under a configured byte quota. WAV header
lengths are patched with bounded header reads. Full independent output inspection
and decoding remain mandatory. No `-fs` truncation can masquerade as success.

The worker uses an owned file artifact, and shared storage uploads consume its
64 KiB stream. Artifact disposal covers successful upload, upload failure,
preflight failure, worker cancellation, and file readers. The existing buffer
capture API remains a bounded compatibility wrapper. The worker's
`cancelCaptures()` cancels active media and disposes retained artifacts; callers
must stop dequeuing jobs before invoking it. Successful recordings still become
ready only after validation and upload/persistence.

Default encoded-file quota is 1 GiB (configurable below 4 GiB), with no default
cumulative raw-byte limit. An optional `maxInputBytes` quota remains supported;
`maxChunkBytes` defaults to 64 MiB. The buffer wrapper defaults to 64 MiB and
cannot exceed 256 MiB. Capture deadline defaults to four hours; after ingress EOF
encoder draining has a 60-second deadline. Probe and full decoder each have a
60-second deadline and respond to capture cancellation. These are resource gates,
not proof that every four-hour meeting or complex high-resolution workload fits.

## Backpressure and failures

Built-in Zoom ingress copies SDK-owned buffers and bounds each stream queue to
32 MiB. Meet/Teams bound queued/in-progress blob bytes and Node-side stream bytes
to 8 MiB each. Overflow fails visibly with a platform capture error; no media is
dropped or silently replaced. Browser arrays have JS representation overhead,
so byte quotas are not equivalent to process RSS. Provider SDK/browser internals
and arbitrary custom producers must also honor their own resource contracts.

The real-time transcription branch uses a coordinated bounded split (8 MiB per
branch plus one pending chunk), rather than native tee's potentially unlimited
slow-consumer backlog. Normalization is pull-driven. Slow downstream consumers
backpressure the source; live push producers that cannot keep up fail at their
explicit queue limit. This does not add ASR codec support.

Failure of either pump, encoder exit, explicit abort, deadline, invalid frame,
or output quota cancels both readers and terminates/awaits the owned process.
The first-frame handshake validates each stream independently, so malformed audio
does not wait indefinitely for a stalled video producer. Temporary output is
removed on failure, and no partial recording is registered.

## Evidence and limits

Reproducible fixture: `media-streaming-acceptance.mjs`, run with
`node --max-old-space-size=128`. It generates media faster than real time, runs
full decoder validation, streams to the shared native local-storage adapter,
compares SHA-256 across upload/download, and independently counts decoded frames.
It reports generated duration separately from actual elapsed time, resolution,
frame count, sampled Node/child RSS, and output bytes. Colors are low-complexity
synthetic RGB frames, not a real meeting or representative camera motion.

The first 128 MiB old-space run exposed retained cancellation-promise handlers
per read/write. Replacing repeated `Promise.race` calls against one unresolved
promise with reader cancellation/process termination removed that growth; the
same one-hour fixture then passed without increasing the heap allowance.

Remaining requirements include real Zoom frame-layout conversion/acceptance,
Meet/Teams video, desktop container correctness, per-participant recording,
encoded-ASR support, PCM discontinuity/timeline policy, complex-motion and
provider-paced acceptance, production disk provisioning/recovery after process
crash, and operational deployments. Nothing here proves live provider recording.

## Measured receipts

Final local receipt: `media-streaming-receipt-20261022.json`. Commands used
128 MiB V8 old-space, whose reported total V8 heap limit was 184,549,376 bytes.
RSS includes external buffers and is reported separately. Values are sampled,
not guaranteed absolute process peaks.

| Fixture | Generated media | Raw ingress | Capture + full validation | After both producer EOF | Total incl. storage/hash/frame count | Node RSS / child RSS | Encoded bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Long duration | 3600 s, 64×64, 30 fps, 108000 frames | 1,442,304,000 B | 42.666 s | 4.074 s | 43.735 s | 108,183,552 / 37,289,984 B | 30,749,416 |
| Full resolution | 30 s, 1920×1080, 30 fps, 900 frames | 5,599,680,000 B | 3.098 s | 0.218 s | 3.902 s | 143,015,936 / 157,270,016 B | 608,985 |

Both have 16 kHz mono PCM input, AAC output, exact expected independently decoded
video frame counts, and matching stored/downloaded SHA-256. AAC priming extends
container durations to 3600.064063 and 30.064063 seconds. The post-EOF interval
includes queued ingress drain and full validation; total time additionally
includes local storage upload/download hash comparison and independent frame
count. Other parallel tasks were present on the host. These are acceptance
measurements, not a representative production benchmark or cloud-storage SLA.

Zero-latency encoding reduced the earlier sampled 1080p child working set from
458 MB to about 157 MB. Neither fixture extrapolates to one-hour complex 1080p
camera motion. Per-session disk quotas also require deployment-wide admission
and disk-capacity policy; they do not impose a global multi-session quota.


Storage streaming removes full-file buffering, but signed-URL upload still needs
an explicit operation deadline and response-body lifecycle policy. A stalled
remote upload can retain its artifact beyond capture deadlines. This remains a
storage-operation bound to implement; capture limits do not imply upload limits.

## Validation receipt

Server: 239 tests across 43 files; core 51, Zoom 25, Meet 11, Teams 9,
TypeScript client 12, Python client 14. Core/platform/server/client TypeScript
builds pass. Tests cover buffer and file APIs, actual signed HTTP upload,
artifact cleanup on preflight/storage failure, zero/nonzero encoder exit while
both inputs stall, abort/limits, active file-reader disposal, SDK/browser overflow,
bounded audio split and unconsumed-ASR cleanup. No dependency/lockfile changes.
Logs: `/tmp/rec-stream-full-tests.log`, `/tmp/rec-stream-all-adapter-tests.log`,
`/tmp/rec-stream-python-tests.log`, `/tmp/rec-stream-builds.log`, and
`/tmp/rec-stream-final-build.log`.
