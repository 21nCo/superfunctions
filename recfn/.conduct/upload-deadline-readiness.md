# Bounded recording uploads — 2026-10-22

`uploadObject`, `uploadRecording`, and `createBotWorker` now accept
`uploadTimeoutMs`. The default is 300000 ms (five minutes); values must be positive
integer milliseconds no larger than 2147483647. The deadline covers adapter
acquisition or URL signing, input reads, backpressured writes, close, HTTP request,
and response-body cancellation. `UploadOptions` and `UploadRecordingInput` also
accept an `AbortSignal`; worker shutdown propagates its session cancellation into
an in-progress upload. Existing manual-upload routes use the finite default.

The streaming path owns a reader and writer, awaits each write before reading
another chunk, and removes per-operation cancellation listeners. Timeout or caller
cancellation cancels its reader, releases stream locks, requests writable abort,
and returns without waiting indefinitely for the adapter. Late stream acquisition
is observed and aborted without writing. Native fetch receives the abort signal;
HTTP response bodies are cancelled after their status is received, including
unbounded successful bodies. Upload consumes and disposes the native capture
artifact on success and failure.

## External effects and limits

The shared `StorageAdapter` acquisition/signing methods do not accept a signal.
A custom adapter can continue after timeout. Web Streams defer underlying sink
abort until a pending write settles; an adapter whose write never settles can
retain its own resources despite the caller returning. This change does not claim
that such an operation was stopped or rolled back. Late promises have rejection
handlers, and bounded caller lifetime does not establish remote object absence.

The pre-existing producer intent remains `uncertain` after timeout/cancellation.
No recording row or ready event is produced. A late sink completion does not clear
that intent. Operators must establish that the original external operation stopped
before invoking the existing reconciliation workflow. Timeout alone is not proof.

These bounds cover the storage operation, not database operations, platform leave,
metadata retrieval, or arbitrary user-provided artifact disposal. The owned native
capture artifact destroys and awaits its local file readers before removal. Hosts
still need broader lifecycle and database bounds. There are no shared adapter
interface changes, new dependencies, remote storage acceptance, or live meetings.

## Reproduction and evidence

Run from the repository root:

```
npm test --workspace=@recfn/server -- --run
npm run build --workspace=@recfn/server
```

`upload-deadline.test.ts` uses real timers, native localhost HTTP servers and an
FFmpeg-created WAV file artifact. The stalled sink fixture leaves `write()` pending
through a 100 ms deadline. The caller returns, the artifact directory is empty,
locks are released, no recording exists, and the producer remains uncertain.
The sink's abort has not run at that point. Releasing the owned test write then
allows abort to run; uncertainty remains unchanged.

The native HTTP receiver accepts 1024 bytes and withholds the response. The 300 ms
deadline rejects and the receiver observes connection closure. A second receiver
sends 200 headers and an unending body; cancellation closes that connection while
the successful upload returns. Fixtures close their owned listeners/connections.
Other cases cover late stream acquisition, shutdown during a pending read, and
invalid deadline values.

The worker lifecycle tests exercise both the configured deadline and explicit
`cancelCaptures()` while a sink write is pending. Both finish in error, retain the
uncertain intent, emit no finalization-complete result, and remove local artifacts.

Validation: 251 server tests across 44 files passed; server typecheck and build
passed. Logs: `/tmp/rec-upload-server-tests.log`, `/tmp/rec-upload-build.log`.
Only TypeScript server upload/lifecycle code changes; Python and TypeScript client
wire APIs and platform/media contracts are unchanged.
