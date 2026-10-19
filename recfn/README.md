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

## Observability

- **Logging**: Pass a `Logger` (e.g. `MemoryLogger` or logfn) for structured logs.
- **Metrics**: Pass `metrics` (from `createMetricsEmitter(watchfn.track)`) to emit `recfn.bots.active`, `recfn.asr.latency_ms`, `recfn.bot.join_latency_ms`, etc.
- **Join latency**: Target &lt;10s; logs warning when exceeded.

## License

MIT
