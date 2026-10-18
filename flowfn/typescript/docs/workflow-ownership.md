# Workflow checkpoint ownership

Built-in memory, Redis and PostgreSQL adapters use revision-checked checkpoint
mutations. Each active execution holds a renewable lease. Competing runtimes
cannot resume the same checkpoint until the lease expires, and stale owners
cannot checkpoint results or perform compensation after detecting ownership loss.
Redis and PostgreSQL evaluate lease expiry using their own clocks.

Configure the lease before building a workflow:

```ts
const workflow = flow.workflow('payment')
  .version('2')
  .ownership({ leaseDuration: 30_000 })
  .step('charge', charge)
  .waitForEvent('confirmed')
  .build();
```

The default lease is 30 seconds. Renewals run at one third of the lease duration.
Transient transport failures retry within the last confirmed monotonic deadline;
an expired or rejected lease aborts the handler signal and pending checkpoint
waits. Handlers must cooperate with cancellation. External effects still need
idempotency because a crash between an effect and its checkpoint can replay it.

After a crashed process's lease expires, rebuild the same definition and call
`resumeExecution(executionId)`. Persisted step journals and event-wait results
prevent replay of checkpointed work. The workflow catalog uses revision retries
so concurrent processes do not lose execution IDs.

Structural definition fingerprints reject resumption after step, ordering or
option changes. Callback source and captured values are not serialized; bump
`.version()` whenever callback behavior changes. Checkpoints without a matching
fingerprint need an explicit application migration before resumption.

The legacy `saveWorkflowState` method cannot overwrite a revision-controlled
record. Custom adapters must implement atomic `mutateWorkflowState` to run
workflows. The provider acceptance runner includes competing-owner, expired-owner,
hung-renewal and separate-process SIGKILL recovery checks.

Signals and approval calls currently require the owning runtime. Distributed
signal delivery, automatic discovery/recovery and persistent distributed scheduling
remain outstanding contracts. Functional checks do not establish workflow
throughput, latency or concurrent-execution targets.
