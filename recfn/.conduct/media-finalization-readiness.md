# Media finalization — 2026-10-22

Historical valid-media checkpoint. The raw spool and full-result worker path
are superseded by `media-streaming-readiness.md`; evidence below describes the
earlier implementation.

Original REC-001 requires configured MP4/audio-only recordings containing actual
meeting media, with valid duration, size, and storage. The previous finalizer
concatenated arbitrary audio bytes, labeled them MP4/WAV, and computed duration
from callback timestamps. The worker never read video. That path could publish
files with no valid container and silently omit video.

The finalizer now spools explicitly typed audio and video concurrently, encodes
WAV or dual-track fragmented MP4 with installed ffmpeg, inspects the output with
ffprobe, decodes every output packet, and returns only validated bytes. The
worker passes the video stream and configurable host/resource options. Input
spools and output are byte bounded; output is captured through a capped pipe,
not ffmpeg `-fs` (which can silently produce a truncated successful file). WAV
RIFF/data lengths are finalized after piping. Failure cancels sibling readers,
waits for opened files to close, terminates owned encoder processes, and removes
temporary files. There is a capture lifetime deadline and per-process deadlines.

Meet/Teams use MediaRecorder WebM/Ogg bytes, not PCM. Container metadata now
survives the page boundary, asynchronous final blobs retain event order, and
completed capture stops owned tracks. Zoom forwards explicit PCM/RGB metadata
and a shared presentation clock; video does not invent timestamps from callback
arrival. Cancellation removes Zoom stream listeners.

Verification is local synthetic media, not live meeting evidence. Tests exercise
stereo PCM→WAV with exact decoded sample equality, chunked WebM/Opus→WAV, RGB24
plus PCM→MP4, and a Zoom bridge→worker→API/store path whose stored MP4 independently
decodes with ten H.264 video frames and a 48 kHz mono AAC track. Failure tests
cover empty/unknown/malformed/changed formats, cadence, input/output limits,
stalled input, missing executable, locked video acquisition, sibling cancellation,
and temporary-directory cleanup. Evaluated browser callbacks verify delayed final
blob ordering and track cleanup for Meet and Teams.

Host tools: ffmpeg/ffprobe 9.0.2. No tools installed, provider access, deployment,
SDK release, or live meeting was performed. Python is an HTTP/WebSocket client;
this does not change its recording wire schema or introduce Python encoding.

This does not complete REC-001 for every platform or production readiness.
Real Zoom layout conversion and meeting acceptance, Meet/Teams video, separate
participant tracks, desktop mislabeling, audio timeline/discontinuity policy,
ASR encoded-input support, one-hour <60-second finalization acceptance, disk
capacity provisioning, and unbounded upstream push queues remain open. Defaults
are documented finite limits, not proof of the original duration/performance
requirements. The existing final-storage interface retains a bounded full result
buffer. Runtime binaries and codec support are required on deployment hosts.

## Practical recording limit

At 1080p RGB24, each frame is 6,220,800 bytes. The default 256 MiB input
spool cap holds at most 43 frames before audio, about 1.4 seconds at 30 fps.
Thus valid short MP4 output is proven, but normal meeting-length MP4 remains
unusable at that resolution. The required next architecture is streaming
encoding with bounded producer backpressure and rolling/durable storage, not
raising the raw spool allowance to a huge default. Audio-only PCM also has an
explicit byte-duration ceiling. No one-hour performance claim is supported.

Migration: legacy frames without an encoding declaration now fail instead of
being published under a false filename/MIME type. Custom audio producers must
declare their actual wire encoding, and custom MP4 producers must provide video
and its media timestamps. Existing bogus stored recordings are not repaired.

## Validation receipt

- Server: 228 tests across 41 files pass; server typecheck/build pass.
- Core: 51 tests; Zoom 23; Meet 11; Teams 9; TypeScript client 12 pass.
- Core, Zoom, Meet, Teams, server and TypeScript client TypeScript builds pass.
- Python client: 14 tests pass on the existing Python 3.9 runtime, run from
  `recfn/python` so the package resolves correctly (the initial repository-root
  invocation could not import the package).
- `git diff --check` passes. No package dependencies or lockfiles changed.
- Logs: `/tmp/rec-media-full-tests.log`, `/tmp/rec-media-adapter-tests.log`,
  `/tmp/rec-media-builds.log`, `/tmp/rec-media-server-build-final.log`, and
  `/tmp/rec-media-python-tests.log`.
