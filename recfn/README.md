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

### Bot admission policy

Built-in stores enforce a persisted per-namespace nonterminal bot limit, default
100 (`RECFN_MAX_CONCURRENT_BOTS`), configurable with
`createDbStore({ adapter, maxConcurrentBots: 100, durable: true })` or
`createMemoryStore({ maxConcurrentBots: 100 })`. The environment is sampled when
the store is constructed; an explicit option wins. API creation, calendar scheduling,
and direct store creation share the transaction; finalizing bots remain counted,
and direct reactivation requires available capacity. Full capacity returns 429.

Existing installations must migrate the `botAdmission` model and seed namespace
policies before restarting writers. Policy changes require stopped writers and a
matching database/configuration update; lowering below occupancy permits draining.
Supported paths are shared memory and transactional native-upsert Kysely/Drizzle;
Prisma, unknown adapters, and Drizzle SQLite remain unsupported for this admission
contract. Native acceptance covers Kysely SQLite and PostgreSQL 16 at read committed
isolation with the declared TEXT storage, not every database deployment.
See [admission and migration details](.conduct/bot-admission-readiness.md).
PostgreSQL installations must also remove the redundant namespace-only UNIQUE
constraint using the [explicit constraint migration](.conduct/postgres-store-readiness.md);
retain the deterministic ID primary key. Schema metadata changes do not migrate
existing databases.

An ambiguous queue-enqueue failure retains its creating bot and capacity. It does
not prove that no worker will run. Reconcile the existing operation before retrying
or releasing it. Workers now claim durable per-bot work before provider access.
An errored bot with an unresolved external operation continues holding capacity.
See [worker ownership and migration](.conduct/bot-worker-ownership-readiness.md);
this is not remote provider termination attestation.

### Bot worker

```ts
import { createBotWorker, MemoryQueueAdapter, QUEUE_NAMES } from '@recfn/server';

const worker = createBotWorker({
  store,
  queue,
  logger,
  recoveryNamespaces: ['your-namespace'],
  platformAdapterFactories: new Map([['zoom', () => createZoomAdapter()]]),
});

// Drain current work; repeat this on the host polling schedule after idle.
while (await worker.processNext()) {}
// Stop polling before shutdown. Any unresolved IDs require reconciliation.
const { unresolvedBotIds } = await worker.cancelCaptures();
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
It requires explicit stopped-operation proof and a nonempty reason; it is not a
lease expiry or cancellation mechanism. Without a pending deletion, reconciliation
releases a producer slot only when a persisted recording in the same namespace
owns the exact bot/recording/storage identity. Otherwise it retains a settled
intent, including its resource key, for eventual deletion; that intent still
counts toward the 64-slot bound. Uncertain slots are never ignored to admit more
work. Failed producer-finalization writes are logged as
`recording.producer.finish_failed` with the producer ID and preserve the already
committed recording result or original upload error. Operators must resolve the
retained intent after proving that its external operation stopped. There is no automatic cleanup scheduler in this slice.
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
`PATH`. Audio/video are encoded concurrently through bounded pipes into a
quota-limited temporary artifact; raw media is not spooled. Validated artifacts
stream to shared storage and are disposed on success/failure. The worker uses
`captureToFile`; `captureFromStream` remains a bounded buffer convenience API.

`BotWorkerConfig.captureOptions` selects executable paths, a private temporary
parent directory, and limits. File capture defaults to a 1 GiB encoded-output
quota, 64 MiB maximum individual input chunk, and four-hour capture deadline.
There is no default cumulative raw-byte quota; callers can set `maxInputBytes`.
The buffer API defaults to 64 MiB output and caps configuration at 256 MiB. File
output may be configured below 4 GiB. Quota/deadline failures reject the recording
instead of publishing truncated media. Encoder draining after input EOF, probing,
and full decoder validation each have a 60-second deadline. Stop dequeuing jobs,
then call `worker.cancelCaptures()` to abort active capture and release artifacts.

Server scratch is encrypted in authenticated 64 KiB chunks with process-only keys;
each chunk adds 28 bytes beyond the encoded-output allowance. Media validation and
upload receive authenticated plaintext through streams, without a plaintext disk
fallback. External storage encryption still requires adapter/deployment attestation.

Production workers (`environment: 'production'` or `NODE_ENV=production`) now
require a managed, cleanup-capable scratch root. Configure it before constructing
the worker; an unmanaged `temporaryDirectory` is a development compatibility path.

```ts
import { createRecordingScratch, createBotWorker } from '@recfn/server';
const scratch = await createRecordingScratch({
  directory: '/var/lib/recfn/recording-scratch',
});
const worker = createBotWorker({ ...workerConfig, environment: 'production',
  captureOptions: { scratch } });
// Inspect scratch.lastCleanup; continue bounded sweeps with await scratch.cleanup().
// Stop dequeuing and await worker.cancelCaptures() before await scratch.close().
```

Use a dedicated canonical path on a host-local filesystem, with an existing parent.
The root is created privately or reopened with its own marker; unmarked existing
directories are refused. Linux/macOS host/boot/PID identity supports conservative
dead-owner cleanup. Unsupported identity retains files and fails the production
worker guard. Live or reused PIDs, foreign identities, unknown entries and unsafe
permissions are never reclaimed by age. Scan reports expose skipped/incomplete
work and resume across calls on the same manager; close it at shutdown. Cleanup
budgets do not bound stalled filesystem calls. Crashed recordings are unrecoverable
because their keys were process-only. Global admission/disk capacity and offline
repair remain deployment responsibilities. See [scratch lifecycle details](.conduct/recording-scratch-cleanup-readiness.md).

Zoom queues copy SDK buffers and cap each stream at 32 MiB. Browser capture caps
queued blob bytes and its Node stream queue at 8 MiB each. A coordinated bounded
audio split applies backpressure to both recording and real-time ASR consumers.
Overflow is an explicit capture failure, not frame dropping. Provider internals
and custom producers retain their own backpressure obligations. Low-complexity
one-hour generated-media acceptance is documented in
[streaming readiness](.conduct/media-streaming-readiness.md); live provider and
representative workload acceptance remain unfinished.

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
