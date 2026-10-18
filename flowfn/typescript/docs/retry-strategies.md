# Named retry strategies

Custom retry delays use a serializable name on the job and a function registered
on every processing queue instance. Producers do not need the registry.

```ts
const queue = flow.queue('requests', {
  backoffStrategies: {
    service: (attempt, error, job) => Math.min(30_000, attempt * 1_000),
  },
});
await queue.add('fetch', { url: '/resource' }, {
  attempts: 5,
  backoff: { type: 'custom', strategy: 'service', delay: 0, maxDelay: 10_000 },
});
```

The callback receives the number of failures so far (starting at one), the
handler error, and a detached job snapshot. It must synchronously return a finite
nonnegative delay in milliseconds. `maxDelay` caps the result, including a zero
cap. Fixed and exponential delays also respect this cap. Exponential overflow
saturates at the configured cap or `Number.MAX_SAFE_INTEGER`.

Malformed backoff options are rejected before enqueue. A missing strategy,
callback exception, or invalid callback return terminates that job as failed and
retains the original handler failure in its failure reason. It does not strand
the job as active or silently use fixed backoff. The normal failed-job retention
and configured dead-letter handling still apply.

Named batch processors select only jobs with that name; other names require
their own processor. Batch processing still has outstanding timeout, cache,
limiter, and retention parity work. Distributed queue leases and atomic enqueue
deduplication remain separate production gates.
