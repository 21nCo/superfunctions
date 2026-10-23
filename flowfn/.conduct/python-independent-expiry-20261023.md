# Python expiry observation during provider cancellation

2026-10-23; follows e4f872e10dc4ecafb86a711137a0c9a1b80e9802.

## Reproduced problem

The prior native diagnostic observed a renewal still pending beyond its local
conservative deadline while the queue loss event remained unset. Awaiting
asyncio.wait_for is insufficient as an independent expiry observer: its timeout
can wait for the awaited operation's cancellation handshake to finish.

New Redis/PostgreSQL tests perform real successful renewal operations, then hold
the reply and suppress cancellation until an explicit test-owned release. With
unchanged 1000ms leases, all six queue/workflow/stream cases failed because local
loss or handler cancellation remained unobservable while cleanup was pending
(`/tmp/flowfn-expiry-observer-baseline.log`: 6 failed, 207 deselected, 8.39s).
The fixture releases every hold in finally; it creates no indefinitely detached
operation. This models slow driver cancellation without claiming the exact cause
of every earlier PostgreSQL failure.

## Behavior and ownership

A function-internal monotonic expiry observer runs independently of the renewal
coroutine. Expiry synchronously marks a queue lease lost or cancels the owned
workflow/stream handler on the event loop. Successful renewal can replace the
timer only before the previous deadline; expired or closed observers cannot be
rearmed. Completion/release closes the observer. No lease duration is increased.

Queue/workflow registries retain pending heartbeat tasks until they settle,
including cleanup for an old execution while a successor uses the same ID.
Timer callbacks and registry removal are guarded by the specific owner. Shutdown
continues to join owned provider cleanup; it does not falsely report completion
or discard an operation that refuses to finish cancellation. This change cannot
force an arbitrary Python awaitable to terminate, and event-loop starvation still
delays all callbacks. Local loss observation does not undo an unknown native
renewal side effect; storage fencing tokens remain authoritative.

Stream expiry remains an ownership-expiry error to its consumer loop, rather
than turning the independently cancelled handler into an accidental subscription
shutdown. Retry, acknowledgement and workflow persistence behavior remain covered
by the existing native suites.

## Focused evidence

- Six held-cancellation cases passed after the fix in 6.53s
  (`/tmp/flowfn-expiry-observer-fixed.log`).
- Eight native cases, including old/successor heartbeat cleanup, passed in 9.54s
  (`/tmp/flowfn-expiry-observer-successor.log`).
- Normal CI builds wheel/sdist, passes Ruff and strict mypy across 85 files,
  and reports 91 passed / 126 native-provider skips in 6.09s
  (`/tmp/flowfn-expiry-ci-final3.log`). No checks or assertions were weakened.
- Follow-up assertions additionally require release/close to remain pending until
  held cleanup is explicitly released; full native results follow below.

Validation uses the existing owned loopback Redis 7/PostgreSQL 16 runner and
Python 3.12 native environments; normal CI uses Python 3.11. No TypeScript source,
public API, dependency, native schema or performance threshold changed. Prior
source/wheel/TypeScript intermittent PostgreSQL failures remain historical open
evidence unless separately diagnosed; this checkpoint is not full readiness.

## Full native source acceptance

`FLOWFN_PYTHON_VERSION=3.12 node flowfn/typescript/scripts/provider-acceptance.mjs --python`
reported **211 passed / 6 skipped in 112.18s**
(`/tmp/flowfn-expiry-native-source.log`). This includes the strengthened
release/close pending assertions and both successor cases. Normal CI after these
assertions passed the same 85-file strict check and 91 tests / 126 skips
(`/tmp/flowfn-expiry-ci-final3.log`).

For diagnosis only, the owned disposable PostgreSQL instance enabled
`log_min_duration_statement=100ms` during this source run. Its captured log
(`/tmp/flowfn-expiry-native-pg.log`) contained the intentional `locked` contract's
606ms renewal and 599ms update, with 30000ms leases; those are existing explicit
lock-contention cases. It did not identify a cause for earlier intermittent
failures. The source runner and log follower exited successfully, and its owned
containers were removed. No external database configuration was changed.

## Installed wheel and cleanup

`FLOWFN_PYTHON_VERSION=3.12 node flowfn/typescript/scripts/provider-acceptance.mjs --python-wheel`
built a fresh wheel, verified its import from isolated site-packages outside the
checkout, and reported **211 passed / 6 skipped in 124.15s**
(`/tmp/flowfn-expiry-native-wheel.log`). The test copy includes all eight new
native observer/successor cases and existing queue/workflow/stream contracts.

Both final native runners exited zero. No `flowfn-acceptance-*` containers or
owned native/log-following processes remained on readback. The wheel temporary
directory was absent after runner cleanup. The owned normal-CI virtual environment
and generated coverage file were removed; shared uv caches and unrelated
containers were preserved. Diff whitespace checks pass. No push, external
provider request, release or deployment was performed.
