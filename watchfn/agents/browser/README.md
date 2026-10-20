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

`discardPending(): number` synchronously removes all locally pending events, including the batch currently awaiting acknowledgement, and returns that count. `discardedCount` is the cumulative count removed by this operation (not queue admission failures). It aborts the owned delivery request and retry wait; outstanding delivery promises reject with exported `BrowserDeliveryDiscardedError`, a subclass of `BrowserDeliveryError`. Late responses and retries from that delivery cycle cannot acknowledge or remove newly captured events, even if their serialized content is identical. New captures can start immediately without waiting for an abort-ignoring transport.

Discard does not close the client, disable automatic collection, cancel independent issue-status reads, or erase server-side records. Requests already handed to the network may still reach the server. For consent-controlled collection, use `autoTrack: false` and gate calls to `capture`/`track` in the host application; call `discardPending` on withdrawal and handle its distinct rejection. `close()` continues to flush pending delivery and stop collection; discarding does not reopen a closed client.
