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
