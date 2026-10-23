# Durable bot join ownership and queue recovery

## Original contracts and reproduced failure

BOT-009 requires join timeout/failure to produce public `error` status and an
error message. BOT-002 requires terminal states to remain final; LIMIT-001 bounds
namespace concurrent bots. The previous row-admission checkpoint alone did not
bound provider operations: two workers could both read `creating`, then both
join the same bot. The built reproduction
`reproduce-duplicate-worker-join.mjs` returned
`{"configuredCap":1,"botRows":1,"joins":2,"status":"error"}`. Its local provider
accepted the call then threw a lost-acknowledgement error; no network was used.
The baseline worker also retained its timeout timer after rejection. That owned
fixture exited naturally; the new worker clears its timer on all race outcomes.

The shared queue exposes destructive dequeue without an acknowledgement/replay
contract. The FlowFn HTTP queue does not implement arbitrary matching dequeue.
Queue exceptions therefore cannot prove whether a request was accepted, and a
successful dequeue does not prove a worker ever invoked the provider.

## Transaction authority and permanent ownership

Bot creation now writes a `botWork` pending intent in the same namespace-admission
transaction as the bot. Its stable identity is the bot ID. A worker atomically
changes pending work to owned, records a random owner token, and changes the bot
to joining before calling the adapter factory or provider. Duplicate delivery
cannot claim that row again. There is no lease expiry, automatic reassignment,
or retry that creates a new provider connection for an already claimed bot.

Lock order remains namespace policy first, then bot/deletion fence. Work,
status, and capacity mutations use the same shared transaction authority and
supported-adapter restrictions as namespace admission. No separate lock backend
or new provider abstraction is introduced.

An ambiguous operation stores public bot `error` and work `uncertain` together.
`botWork.heldTerminalCapacity=true` reserves its namespace capacity even though
the public bot is terminal. Admission counts nonterminal rows plus these held
terminal claims inside one guarded transaction. Direct reactivation and deletion
cannot bypass an unresolved claim. Thus public timeout/error semantics are kept
without silently permitting a replacement external operation.

Proven-stop completion atomically writes work closed, clears held capacity, and
writes final bot done/error. External notifications follow the commit. A failure
between work update and bot update rolls back both. Join-only leave emits the
left transition and converges durably to done; it does not strand a left bot in
capacity after dropping its local owner. Notification failure is logged and does
not undo the durable completed state.

## Provider and cancellation boundaries

The platform contract provides join/leave promises but no remote reconciliation
identifier or cancellation acknowledgement for a failed join. Browser-core leave
can be a no-op when no local session was acquired; Zoom delegates to SDK leave.
Consequently rejected/ambiguous join plus resolved leave is **not** proof of
remote termination. Such work stays uncertain and held. Adapter factory failure
is also conservative: constructors may have side effects before throwing.

A successful join followed by acknowledged leave and stopped/disposed local
capture permits normal owner completion. Shutdown stops new dequeuing, cancels
local capture, interrupts the join wait, and retains the actual pending join and
cleanup promises. Late join success cannot start capture: it enters leave/cleanup
instead. Shutdown acknowledgement has a configurable finite deadline (default
5 seconds) and returns `unresolvedBotIds`; it does not imply that uncooperative
provider code has stopped. Pending claims remain held and cannot be taken over.
A shutdown before any provider factory/join is invoked can safely close the
no-attempt claim. Concurrent finalization/shutdown shares one leave promise.

Operator recovery is explicit `reconcileBotWork(botId, namespace, ownerToken,
{ workerStopped: true, providerStopped: true, reason })`. The caller must first
stop the original worker and independently establish termination of the external
operation. The token and reason are persisted transactionally; timestamps alone
are not evidence. This is an operator evidence contract, not a remotely verified
provider attestation. A new bot may be created after reconciliation; the old
claimed bot is never reactivated. There is no public automatic takeover endpoint.

## Actual worker recovery path

Configure `recoveryNamespaces` explicitly (1–100 distinct nonempty namespaces;
required in production). Production worker creation also reuses `assertProductionStore`: a worker-only host cannot bypass the durable store/atomic admission guard enforced by the HTTP server. Memory stores remain available in explicit development/test mode. `processNext()` alternates durable-intent recovery with
queue processing, so continuous queue traffic cannot starve pending work. It
processes at most one recovered intent per call. Namespace selection is round
robin; each namespace has an advancing ID cursor that wraps to include newly
inserted lower IDs. An idle sweep reads at most two one-row pages per configured
namespace. It never enumerates every tenant implicitly. Continue calling
`processNext()` on the host's normal polling schedule after an idle result;
cursors are an optimization and can safely restart on process restart.

Recovery invokes the same claim-before-I/O path directly; it does not need an
undisclosed external outbox scheduler or queue matching support. Pending intent
survives enqueue lost ACK and destructive dequeue loss until claim. The hosted
local POC now configures its own namespace for this path; its memory backend
still does not provide restart durability.

Finalization is owned locally. A wrong worker consuming a finalization notification
does not mark the bot failed. The actual owner checks durable leaving status on
every `processNext()` and performs leave/finalization even if that notification
was consumed elsewhere. A crashed owner remains held for reconciliation; no
other process pretends to have its in-memory capture or encryption key.

## Deployment migration

Drain/reconcile old workers, stop all old-code writers, and apply `botWork` from
`getRecFnSchema()` before restarting. New fields: id (bot ID, primary/unique),
namespace, state, optional ownerToken/reason, required heldTerminalCapacity,
createdAt/updatedAt; indexes cover namespace/state/id and namespace/held capacity.
Keep the prior botAdmission migration and matching persisted namespace policy.

Do not backfill every legacy error with held=false: an old timeout or lost join
ACK may still represent an external operation. Establish stopped worker/provider
state for legacy active or ambiguous bots before release. Only known unclaimed
creating bots become pending intents with held=false. Existing known completed
bots may have no work row. The migration must not overlap old workers, which do
not honor these claims/held flags. Configure recovery namespaces on every worker
responsible for those namespaces. Prisma/unknown adapters and Drizzle SQLite are
still excluded; native acceptance here covers Kysely SQLite only.

## Validation

On Node 20.20.0, final build, server typecheck, and the complete server suite
passed: **283 tests across 51 files**, including six focused ownership cases and
one native independent-process scenario (1,909 ms in the final run). Commands:

- `npm run build --workspace=@recfn/server`
- `npm test --workspace=@recfn/server`
- `npm run typecheck --workspace=@recfn/server`
- `node recfn/.conduct/reproduce-duplicate-worker-join.mjs`
- `git diff --check`

The built reproduction now returns
`{"configuredCap":1,"botRows":1,"joins":1,"status":"error"}` and exits without
waiting for a leaked join timer. The initial full runs exposed missing joining
notifications and cleanup/status boundaries; final tests retain those assertions
and pass after correction. The join-only test now asserts done plus left/done
notifications and the focused cap-one test admits the next bot after completion.

The native fileSQLite test starts independent Node processes using built server
exports and real shared Kysely transactions. After simulated queue acceptance with
lost ACK and destructive dequeue loss, two fresh workers recover the same intent
with one provider invocation. A third process races admission while the error+
held update holds the native transaction; admission rejects. Reopen confirms
public error and held capacity. A trigger that fails the bot update after work
closure proves atomic rollback retains uncertain/held state. Explicit token-bound
reconciliation allows admission again. Another worker is killed with SIGKILL
after provider invocation; a fresh process does not invoke that provider again,
and reopened state remains owned/joining with capacity held.

Focused coverage additionally verifies no-op leave after lost join ACK cannot
release capacity; wrong-worker finalization cannot fail the owner; terminal-held
reactivation is blocked; shutdown before provider factory and during pending join
cannot start late capture; late successful join leaves once; overlapping recovery
calls serialize; scan failure propagates for host backoff; and blank operator
reasons are rejected. Production capture/scratch fixtures now use real file-backed
SQLite and assert that production memory stores are rejected at the worker boundary.

Every owned child is awaited (the killed fixture records SIGKILL), connections are
closed, and fixture directories are removed. Final process readback found no owned
worker, SQLite fixture, encoder or reproduction processes. Local logs:
`/tmp/rec-ownership-{build,full,types}-final.log` and
`/tmp/rec-duplicate-worker-fixed.log`.

The TypeScript server/store lifecycle changes preserve core Bot/error envelopes;
Python and TypeScript client sources are unchanged. Their existing envelope
handling continues receiving public error status rather than a new wire status.
This run does not imply a separate fresh Python wheel acceptance. No live
meeting/provider, deployment or registry publication was used.
Remaining broader gates include real provider credentials/media acceptance,
storage encryption attestation, supported SQL dialect acceptance, operational
reconciliation procedures and deployment readiness. Process-local encrypted
scratch keys still cannot recover a killed worker's capture.
