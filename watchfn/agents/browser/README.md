# WatchFn browser transport

`track(name, properties)` collects sampled browser/RUM events. `capture(event)` sends a canonical event envelope unchanged and works without a DOM. Explicit captures bypass `sampleRate` and return a promise that resolves after HTTP acknowledgment.

```ts
import { BrowserClient } from '@watchfn/browser';

const client = new BrowserClient({
  endpoint: 'https://watch.example/ingest',
  projectId: 'checkout',
  autoTrack: false,
  apiKey: () => currentIngestionKey,
});

await client.capture({
  id: 'bug-123',
  type: 'bug_report',
  timestamp: new Date().toISOString(),
  app: { name: 'checkout' },
  sessionId: 'session-123',
  report: { title: 'Checkout failed', severity: 'high' },
  context: {},
});
await client.close();
```

Use an ingestion credential appropriate for the client; browser code cannot hide deployment secrets. `apiKey` and `headers` callbacks are evaluated on each delivery attempt, allowing refreshed authentication.

The transport snapshots JSON at admission, limits each event to64KiB, and uses the configured bounded queue, batch sizes, timeout and retry limits. `capture()` rejects invalid/oversized/full-queue admission or failed delivery. Failed deliveries stay queued; call `flush()` after recovery instead of capturing the same event again. `close()` stops collection and awaits queued delivery; failed close can be retried.

Delivery is at least once. A lost acknowledgment or partial batch persistence can create duplicate arrivals, including identical producer IDs. WatchFn storage does not deduplicate them. The memory queue does not survive a page/process restart.

The ingestion endpoint validates canonical `bug_report` identity, timestamp, app, session, report and context fields. Other event types continue to require a nonempty `name`. Producer envelopes are preserved rather than wrapped in tracking properties.
