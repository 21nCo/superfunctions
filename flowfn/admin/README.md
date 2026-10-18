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
trusted data. List APIs currently use numeric `offset`/`limit` pagination;
`nextCursor` is always null and does not indicate that an offset page is last.

Dead-letter redrive requires confirmation and idempotency, retries an existing
failed job or inserts a missing one, and deletes the DLQ record only after enqueue
and snapshot persistence succeed. A non-failed existing job causes conflict. These
three components have no shared transaction: a failure after enqueue may leave
both a queued job and its DLQ evidence. Inspect live job status before retrying;
redrive refuses to silently enqueue the same live job again.

Workers must have handlers registered by the host before admin starts them.
Worker close is terminal; create and bind a new worker to restart processing.
Workflow, stream, schedule, and consumer administration are not exposed by this
package's current capability manifest.
