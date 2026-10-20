# Storage lifecycle checkpoint

Collector methods remain synchronous, while every storage operation is immediately
observed and tracked. Synchronous adapter throws and asynchronous rejections are
retained without leaving an unhandled storage promise. `await watch.flush()` waits
for operations admitted before that call, reports their failures in AggregateError
and consumes those retained failure records. Later writes belong to a later flush.
Concurrent flush callers covering the same failing write both observe its error.

`await watch.stop()` synchronously closes admission, detaches its storage listener,
uninstalls exception/HTTP collectors and stops monitoring/synthetic timers, then
waits for already admitted writes. An admitted ingest batch snapshots its array
membership and remains owned across all sequential writes even after stop begins.
Ingest still reports its original adapter error and may partially persist a batch;
this change does not claim atomic batches or exactly-once delivery.

Concurrent stop calls share their Promise. Ignoring the returned Promise remains
possible for legacy callers: its rejection is internally observed, but callers
must await stop to establish persistence completion. Stop retains failure records,
so an ignored failure remains available to a later explicit flush; an awaited
failed stop can likewise be followed by a caught flush to consume those failures.
Collector cleanup failures are aggregated after every cleanup has been attempted
and storage has drained. Restart while stop is pending throws with await-stop
guidance; restart after settlement registers exactly one storage listener.
Readback from retained stopped storage remains supported.

Public WatchFnInstance now declares stop():Promise<void> and flush():Promise<void>.
ExceptionHandler receives configured capture/filter options and is uninstalled
at stop, matching its separately implemented listener ownership lifecycle.

Validation:10 storage lifecycle regressions pass and full WatchFn source
TypeScript checking passes. Tests cover deferred persistence, finite flush
barriers, whole admitted batch ownership, new-admission rejection, synchronous
and asynchronous failures, concurrent waiters, ignored stop, restart and cleanup
failure isolation.

Remaining: no storage cancellation or shutdown timeout is introduced; a hung
adapter can keep stop pending. Failed records remain until explicit flush and
pending writes are not bounded by backpressure in this checkpoint. Automatic
retry, durable queues, collector tasks that have not yet emitted an event, full
native-provider validation and other original readiness gates remain open.
