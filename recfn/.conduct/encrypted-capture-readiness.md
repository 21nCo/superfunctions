# Encrypted capture scratch

Date: 2026-10-23. Baseline: `65c612d56a72d2f62b9357d94e06cea443bbef6d`.

## Requirement and boundary

Original REC-004 prohibits raw recordings on plaintext disk (apart from an explicit
local-development opt-out) and requires encryption at rest through the storage
adapter. The streaming encoder previously persisted its encoded WAV/MP4 output as
a plaintext temporary file. This change encrypts that server capture scratch by
default, with no plaintext fallback or opt-out. It does not establish the separate
storage adapter encryption guarantee: passing `encryption: true` is not proof that
a configured adapter encrypts its backing store. Provider capture, deployment,
and external storage encryption attestation remain open.

## Implementation

FFmpeg stdout feeds an authenticated encrypted file through awaited bounded writes.
Each 64 KiB plaintext record uses AES-256-GCM, a fresh random 12-byte nonce, a
16-byte tag, and authenticated record index and length. The per-artifact 256-bit
key exists only in process memory. No key sidecar or recoverable key is written.
Files use exclusive creation and mode 0600 in the owned temporary directory.
The existing shared OAuth vault encrypts individual token values; it does not
provide a bounded media-file primitive, so this implementation uses Node crypto
without new dependencies or a duplicate storage adapter.

Authenticated bounded reads patch RIFF sizes in memory; every rewrite receives a
fresh nonce. Stream reads verify the whole record before yielding its plaintext.
Length changes, truncation, reordering, and authentication failure reject reads.
Full media inspection and decoder validation receive plaintext only through pipes.
Because ffprobe cannot infer WAV duration from a nonseekable stdin format header,
validation now derives duration from packet presentation times and durations,
while parsing bounded lines rather than buffering all packet metadata.

The default encoded-byte allowance remains 1 GiB. Ciphertext adds exactly 28 bytes
per 64 KiB record, including a final partial record: `N + ceil(N / 65536) * 28`.
For a full 1 GiB recording this is 458,752 additional bytes. Filesystem allocation
rounding and directory metadata are additional; this is not a global physical disk
quota. Node and Web stream queues explicitly count bytes, preserving backpressure.
Public artifact size/content type/stream contents remain ordinary encoded media.
Worker uploads continue using the existing streaming artifact interface.

Dispose destroys and joins active readers, closes the file, zeros owned key and
pending buffers, and removes the capture directory. Existing capture cancellation,
quota, encoder failure, and upload cleanup paths use this same disposal. A killed
worker leaves ciphertext, loses its process-only key, and closes its encoder pipes.
It does not automatically remove crash remnants or resume an incomplete recording.
Deployment cleanup/admission remains necessary. This protects files deliberately
written by the capture implementation; host swap, core dumps, privileged process
inspection, and adapter-owned files need their own deployment controls. It does
not promise secure erasure of every transient plaintext memory copy.

## Local validation

Node 20.20.0; FFmpeg and ffprobe 9.0.2. No live meeting or provider was contacted.

- Focused native suite: 30 tests across five files, including actual WAV/MP4/WebM
  output, exact PCM bytes, storage/upload deadlines, cipher integrity, boundary
  patches, active-reader disposal, and real killed-worker cleanup.
- Full server suite: 258 tests across 46 files.
- Turbo build/typecheck: 37 tasks pass for server, core, Zoom, Meet, Teams,
  TypeScript client and their dependency closure. Core 51, Zoom 25, Meet 11,
  Teams 9, and TypeScript client 12 tests pass.
- Python capture is server-side; the Python SDK remains an HTTP/WebSocket client
  with no source or protocol changes. A fresh Python 3.11.14 environment using
  normal `recfn/python[dev]` dependencies passes all 17 client tests (one existing
  WebSockets legacy-fixture deprecation warning).
- Final killed-worker fixture cleanup was hardened to read its owned encoder PID
  even if readiness fails; its two native lifecycle tests pass again afterward.
- The killed-worker fixture starts an owned native encoder, waits for at least one
  ciphertext record on disk, sends actual SIGKILL to the worker, verifies encoder
  PID disappearance, checks that only ciphertext remains without a key sidecar,
  then removes its owned scratch. No guessed/unrelated PID is terminated.
- The first focused run failed with EBADF because the new file was opened
  write-only; changing exclusive creation from `wx` to `wx+` fixed authenticated
  reads. The subsequent focused and full suites passed without timeout changes.

The existing synthetic fixture generated 3600 seconds of 64x64 RGB24 at 30 fps,
16 kHz mono PCM, and 108000 video frames. With 128 MiB V8 old-space (reported total
heap limit 184,549,376 bytes), capture plus full validation took 37.401 seconds,
including 3.192 seconds after both producer EOFs; total storage/hash/frame-count
acceptance took 38.467 seconds. Sampled Node RSS was 134,103,040 bytes and encoder/
probe child RSS 38,895,616 bytes. Encoded size was 30,749,416 bytes and independently
probed duration 3600.064063 seconds. All 108000 frames decoded; upload/download
SHA-256 matched `22009a7ae5c2f615af4246c02a15bfa6fcc74a4bb7015bd169bbf947ad14523e`.
Only the fixture storage directory remained before its final recursive cleanup.
These low-complexity accelerated frames are not representative camera motion or
live provider-paced evidence. The local storage fixture deliberately stores the
uploaded plaintext media to independently probe it; it does not attest storage
adapter encryption.

Commands and receipts:

```sh
npm run build --workspace=@recfn/server
npm test --workspace=@recfn/server -- __tests__/encrypted-media-file.test.ts __tests__/encrypted-capture-lifecycle.test.ts __tests__/recording-capture.test.ts __tests__/capture-artifact-storage.test.ts __tests__/upload-deadline.test.ts
npm test --workspace=@recfn/server
node --max-old-space-size=128 recfn/.conduct/media-streaming-acceptance.mjs
```

Logs: `/tmp/rec-encrypted-focused2.log`, `/tmp/rec-encrypted-server-full.log`,
`/tmp/rec-encrypted-hour.json` (also retained beside this note).

Additional receipts: `/tmp/rec-encrypted-types-build.log`,
`/tmp/rec-encrypted-sdk-platform-tests.log`, `/tmp/rec-encrypted-python.log`,
and `/tmp/rec-encrypted-lifecycle-final.log`. No package or lock metadata changed.
