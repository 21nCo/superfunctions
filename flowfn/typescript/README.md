# @flowfn/core

Typed queues, streams and workflows with memory, Redis and PostgreSQL adapters.
Requires Node.js 20 or newer. Install with `npm install @flowfn/core`.

```ts
import { createFlow } from '@flowfn/core';
import { MemoryAdapter } from '@flowfn/core/adapters/memory';

const flow = createFlow({ adapter: new MemoryAdapter() });
const queue = flow.queue<{ recipient: string }>('mail');
queue.process('send', async job => ({ recipient: job.data.recipient, sent: true }));
await queue.add('send', { recipient: 'person@example.com' });
await queue.drain();
await flow.close();
```

Both CommonJS and ESM entry points include declarations. Adapter entry points are
`@flowfn/core/adapters/memory`, `/adapters/redis` and `/adapters/postgres`.
The PostgreSQL adapter accepts an initialized Drizzle database and owns its
namespaced tables; call its `initialize()` before use. Memory state is not durable.

See [queue ownership](docs/queue-ownership.md) for lease recovery, atomic
deduplication and at-least-once delivery; [retry strategies](docs/retry-strategies.md)
for custom backoff; and [usage](docs/USAGE.md) for the broader API.

D1, SQS and Kafka adapters are not implemented. Workflow ownership, persistent
scheduler coordination, stream partition assignment and the original performance
targets remain incomplete. This package is not yet a production-readiness claim.
