# RecFn

Self-hosted meeting recording SDK for the Superfunctions ecosystem. Record meetings from Zoom, Google Meet, and Microsoft Teams; transcribe with ASR providers; search transcripts; and deliver events via webhooks.

## Packages

- **`recfn`** (core) — Types, interfaces, and utilities
- **`recfn-server`** — HTTP API server
- **`recfn/client`** — TypeScript HTTP client
- **`recfn/desktop`** — Desktop capture and recorder
- **`recfn/python`** — Python SDK
- **`recfn/platforms/*`** — Platform adapters (Zoom, Meet, Teams)
- **`recfn/adapters/*`** — ASR adapters (Deepgram, AssemblyAI, Google STT)

## Quick start

### Server

```ts
import { createRecFnServer, createMemoryStore, MemoryStorageAdapter } from '@recfn/server';

const store = createMemoryStore();
const storage = new MemoryStorageAdapter();

const server = createRecFnServer({
  store,
  storage,
  validateApiKey: (key) => ({ namespace: 'default', apiKey: key }),
});
```

### Persistent server storage

Pass a shared `@superfunctions/db` adapter to `createDbStore`. RecFn wraps it with its schema internally; consumers do not pass `adapterSchema` to the adapter constructor. Apply migrations based on `getRecFnSchema()` before serving requests.

```ts
import { createDbStore, getRecFnSchema } from '@recfn/server';

const schema = getRecFnSchema(); // Migration metadata for the application's database.
const store = createDbStore({ adapter, durable: true });
```

`durable: true` is an explicit deployment assertion that the configured backend survives connection/process restarts. It defaults to false because a database adapter can point at an in-memory database. The built-in memory adapter cannot be declared durable. Production startup retains the durable-store guard.

The store schema uses JSON text and ISO date text, and requires a unique `(namespace, botId)` index for meeting metadata. Existing installations must migrate those representations and resolve duplicate metadata rows before applying this schema. Do not switch existing native JSON columns without a matching migration. File-backed SQLite close/reopen is covered by the store acceptance test; other providers require their own migration and persistence validation.

### Bot worker

```ts
import { createBotWorker, MemoryQueueAdapter, QUEUE_NAMES } from '@recfn/server';

const worker = createBotWorker({
  store,
  queue,
  logger,
  platformAdapters: new Map([['zoom', zoomAdapter]]),
});

// Poll for jobs
while (await worker.processNext()) {}
```

## Webhook delivery options

Webhook delivery uses the shared validated, DNS-pinned Undici transport. The obsolete `fetch` injection option has been removed from `WebhookDelivererDeps` and `PlugFnWebhookDeps`. Migrate callers to `resolveHostname`, `maxRetries`, `initialDelayMs`, `maxDelayMs`, and `perAttemptTimeoutMs` as needed. Custom resolver results still pass public-address validation; redirects are not followed automatically. Tests should mock the transport boundary rather than replace delivery through a runtime option.

## Observability

- **Logging**: Pass a `Logger` (e.g. `MemoryLogger` or logfn) for structured logs.
- **Metrics**: Pass `metrics` (from `createMetricsEmitter(watchfn.track)`) to emit `recfn.bots.active`, `recfn.asr.latency_ms`, `recfn.bot.join_latency_ms`, etc.
- **Join latency**: Target &lt;10s; logs warning when exceeded.

## License

MIT
## Recoverable bot deletion

`DELETE /api/v1/bots/:id` and exported `deleteBotAggregate(id, namespace, deps)`
first persist a deletion marker and inventory recording keys, then remove search
entries and recording objects, then atomically delete the database aggregate.
External I/O runs outside database transactions. Active bots still return 409.
A completed deletion returns HTTP 200 with `deleted: true, state: "completed"`.
HTTP 202 with `deleted: false` means cleanup is pending or blocked: callers must
inspect this field, including TypeScript and Python clients, and retry the same
bot ID. Missing cleanup adapters block deletion; recordings require a search
cleanup adapter even when the host believes no index exists.

Apply the additive `botDeletions` and `botProducers` tables and indexes from
`getRecFnSchema()` before starting this version. Resources are JSON text and
created timestamps are ISO text, matching the existing schema normalization.
Stop old workers during migration: they do not participate in producer admission.
Do not remove these tables or restart older writers while deletion is pending.
Existing bot/recording rows need no backfill; deletion inventories them at request
time. Completed markers retain only bot ID, namespace, state and creation time;
resource references and producer rows are removed. Retain these markers to keep
retries idempotent and never reuse deleted bot IDs.

Built-in uploads and transcription index publication reserve durable producer
intents before external writes. The store fences child mutations after deletion
begins and rejects producers without an existing bot. Each bot allows at most 64
unresolved/retained intents; successful operations with a persisted recording
release their slot. A failed or crashed external operation remains unresolved
because an error or timeout does not prove that a remote write stopped. Deletion
returns `state: "blocked"` and the affected `producerIds`.

After independently verifying that an operation and any remote write have stopped,
a trusted operator can call
`store.reconcileBotProducer(id, namespace, { operationStopped: true, reason })`,
then retry deletion. This method is intentionally not exposed as an HTTP route.
It requires a pending deletion and a nonempty reason; it is not a lease expiry or
a cancellation mechanism. There is no automatic cleanup scheduler in this slice.
Custom upload/index producers must use the same admission/completion protocol;
direct storage/search writes bypass it. External delete adapters must be
idempotent and acknowledge completed removal, including deletion of absent keys.

`store.deleteBot()` remains the database-only transaction primitive; use the
coordinator or HTTP endpoint for external cleanup. The database adapter must
support transactions and serialize writes to the bot root. File-backed SQLite,
real local files, and the SearchFn memory index have failure/reopen and concurrent
producer coverage. Other database isolation modes and remote storage/search
providers require their own acceptance; this is not live-provider evidence.

### Bot media finalization

Bot workers require `ffmpeg` (PCM/AAC and libx264 encoders) and `ffprobe` on
`PATH`. They encode and fully decode-check media before storing a recording.
`BotWorkerConfig.captureOptions` can select executable paths, a private temporary
parent directory, and capture limits. Defaults are 256 MiB combined input,
64 MiB output, and a four-hour capture deadline; output can be configured up to
256 MiB. Exceeding a limit fails the recording instead of publishing truncated
media. At 1920×1080 RGB24, the default input cap holds at most 43 video
frames (about 1.4 seconds at 30 fps, before audio). This spool-first video path
is a valid-media checkpoint and cannot yet record ordinary meetings; streaming
encoding with bounded backpressure/storage is still required. Each encoder/decoder invocation has a 60-second deadline. Temporary files
are removed on success or failure. The final bounded result is held in memory
for the existing storage API; this is not unlimited-duration streaming storage.

Adapters must declare `AudioChunk.encoding`: interleaved signed 16-bit
little-endian PCM (`pcm_s16le`), or consecutive bytes from one WebM/Ogg audio
container. PCM sample rate and channel count must remain constant and frames
must contain complete samples. For encoded audio, decoder metadata determines
the resulting sample format. Audio-only recordings are finalized as WAV.
Meet/Teams propagate their actual MediaRecorder MIME container and preserve the
last asynchronous data event before closing the stream.

MP4 requires both audio and video. Video currently accepts complete even-sized
RGB24 frames (up to 4096×4096) at a declared constant rate of 1–120 fps. Video
presentation timestamps must be monotonic at that cadence within 1 ms and share
a millisecond clock with audio; Zoom SDK bridges must provide these media
timestamps, not arrival times. MP4 contains AAC audio and H.264 video in a
fragmented MP4 container. Initial audio/video offset is preserved (up to one
minute); AAC codec priming can extend the container duration. Duration comes
from the encoded file, including the final sample/frame, rather than the interval
between callback arrivals. Unknown encodings, absent video, format/cadence
changes, malformed input, missing binaries, or encoding failures reject capture.

A Zoom bridge must identify its actual raw frame layout or convert it to this
contract. The SDK interface alone does not establish that a real provider emits
RGB24. Meet/Teams currently expose audio only and therefore cannot satisfy the
default MP4 request; request `audio_only` for that capture path. Live provider
video support, per-participant tracks, one-hour latency/resource acceptance,
ASR compatibility with encoded MediaRecorder chunks, and desktop recorder
container correctness remain separate unfinished requirements.
