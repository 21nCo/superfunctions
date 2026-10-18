# Durable scheduling

`flow.scheduler()` persists schedule definitions and occurrence state using the
configured memory, Redis or PostgreSQL adapter. Memory survives only as long as
the shared adapter instance. The standalone `new Scheduler()` remains local.

```ts
await flow.scheduler().schedule('invoice', {
  every: 60_000,
  version: '2',
  data: { account: 'example' },
}, async (data, context) => {
  await invoice(data, {
    signal: context.signal,
    idempotencyKey: context.occurrence,
  });
});
```

Every process that may run a schedule must register its callback. Re-registering
the same name and options binds the callback to persisted progress, including
completed attempt limits. Changing options or `version` starts a new generation.
Callback code is not serialized. Bump `version` when its semantics change.

Competing schedulers acquire a renewable occurrence lease through revision-checked
mutations. Redis and PostgreSQL validate expiry on the provider clock. Losing
ownership aborts the callback signal and prevents stale completion. Pauses,
cancellation and replacement persist independently of that lease and are checked
before execution, during renewal and before completion.

A crashed callback may run again after lease expiry. The same occurrence ID is
provided on retry so external operations can deduplicate. This is at-least-once
delivery: effects outside the adapter need application idempotency. Callbacks
receive a detached payload; mutations do not alter future invocations.

`close()` stops local polling and aborts active callbacks without deleting durable
definitions. Cooperative callbacks allow it to finish; callbacks that ignore the
signal can delay shutdown. The default lease is 30 seconds. Direct
`new DurableScheduler(adapter, namespace, leaseDuration)` allows a custom lease.

Each successful or failed callback increments the attempt count. The next run is
computed from completion time, so missed intervals coalesce instead of creating
an unbounded backlog. Failed callbacks expose `lastError` through `list()` and
retry at the next interval. Native acceptance includes competing owners,
persisted limits, cross-runtime controls and separate-process SIGKILL recovery.
Throughput, scheduling-latency and bounded-shutdown targets remain release gates.
