# @flowfn/admin

Environment-bound administration of FlowFn queues, jobs, workers, dead letters
and event logs through the shared `@superfunctions/admin` dispatcher.

Bind `installationId`, `workspaceId`, `projectId`, `environmentId`, `namespace`
and optional `region` to the deployed instance. Requests must match all bound
scope fields. The legacy `organizationId` alias is accepted only for the same
installation; conflicting aliases are rejected. The host must authenticate actors
and supply a fail-closed authorizer, confirmation verifier, audit sink and
idempotency store appropriate to its deployment. The domain service alone is a
trusted internal API, not an authentication boundary.

Job reads use the queue's live adapter state, including worker results. The
provided `jobs` storage receives enqueue/redrive snapshots for compatibility;
it is not the source of live status. Payloads, results, errors and logs are
redacted by the dispatcher capability. Direct domain-service calls return raw
trusted data. List APIs accept `offset`/`limit` or the returned `nextCursor` as
`cursor`. A null cursor marks the final page. These are offset cursors; concurrent
collection changes can shift subsequent pages.

Dead-letter redrive requires confirmation and idempotency, retries an existing
failed job or inserts a missing one, and deletes the DLQ record only after enqueue
and snapshot persistence succeed. A non-failed existing job causes conflict. These
three components have no shared transaction: a failure after enqueue may leave
both a queued job and its DLQ evidence. Inspect live job status before retrying;
redrive refuses to silently enqueue the same live job again.

Workers must have handlers registered by the host before admin starts them.
Worker close is terminal; create and bind a new worker to restart processing.
The capability also lists registered workflows, lists/reads their durable
executions, signals and approves waits, retries/cancels executions, and requests
abandoned-execution recovery. Approval identity comes from the authenticated
admin actor. Stream inspection reports retained counts and consumer-group lag.
Schedule operations list, pause, resume and cancel persisted definitions. Runtime
mutations require confirmation and idempotency; execution data is redacted.
Callbacks and workflow definitions must be registered by the deployment host.
Consumer-instance controls and callback registration are not exposed remotely.
