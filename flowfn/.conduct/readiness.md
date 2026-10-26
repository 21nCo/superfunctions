# FlowFn readiness work

Branch codex/flowfn-readiness-20261016 based shared prerequisite19c38aa34; imported source next523c66ae8. All original SPEC, v0.intent and public README requirements remain accountable.

Python first checkpoint: workflow execution tasks are owned and cancelled/awaited; completed status cannot overwrite cancellation; compensation stacks isolated by run; parallel failure awaits cancelled siblings; flow.close waits workflows before adapter cleanup. Four regressions plus five existing workflow tests pass on Python3.12.

Whole Python suite:15pass5fail. Archived unchanged next baseline at /tmp/flowfn-baseline.eRurn0 produces11pass5samefail. Existing stream.subscribe decorator returns coroutine; health_check returns dataclass contrary dict API/tests. These remain implementation work, along with queue retry backoff/delay/pause-resume, consumer groups, persistence, metadata and full packed gates. TypeScript workflow event/approval waits require original contract audit and implementation. No full readiness claimed.

Validation command: /tmp/testfn-python-readiness-venv/bin/python -m pytest -o addopts= flowfn/python/tests/test_workflow.py flowfn/python/tests/test_workflow_lifecycle.py -q

Agent boundary: root owns FlowFn tree; other agents own TestFn and ContentFn trees.

## Python lifecycle continuation

28 tests pass on Python3.10 and3.12. Original5 baseline failures fixed: synchronous decorator registration with awaitable readiness barrier and owned unsubscribe lifecycle; health returns documented dictionary. Queue now enforces due times, fixed/exponential/custom retry backoff, timeout cancellation, state-transition persistence via new adapter.update_job protocol, retained workers while paused, drain delayed-job accounting and cancelled-active requeue. Custom strategies are process-local callable configuration excluded from serialized options; durable provider strategy restoration remains an acceptance concern. Four workflow, six queue and two stream regressions added beyond original16.

New adapter.update_job is a required Python adapter contract for persisted transitions. Only built-in MemoryAdapter currently implemented. Provider adapters, groups, retention, queue dependencies/dedup, full configuration/typing/package metadata and packed-runtime acceptance remain. Scope is not waived by passing tests.

## Consumer group checkpoint

FlowFn Python dfd3d7fc6:33 tests pass3.10/3.12. Actual consumer groups now share pending work with ack/nack, perconsumer in-flight bounds, pause/resume, unacknowledged disconnect redelivery, retained-history start and independent group copies. Replay/trim/count now read adapter state across instances; count is awaitable (documented API change). Memory remains process-local. Custom adapter consume/options/subscription and retention methods documented. Tests cover group distribution, pending recovery, nacks, paused startup, duplicateconsumer and sharedretention.

Initial non-strict mypy scan still has baseline Python typing issues (priority Any/mixedheap, storage subscriptiontype, core inferredNone, optionalpsutilstubs), and configured strict gate not yet passed. Packagemetadata/provideradapters/queuefullcontract stillopen. No readiness completion claim.

SharedDB0.4.0 prerequisite dabaf5123 isolated in Content tree,216sharedtests/nativeSQLite and26packednamespace tests eachVitest3/4 pass; TestFn cherry-picked as1b05e33eb. Dedicated shareddependency delivery and exact dependent locks pending. FlowTS agent found test config excludes tests/*.test.ts; enabling fullsuite before acceptance.

## Queue contract checkpoint

Flow Python c0b997afb adds atomic enqueue returning canonical job (stable IDs/pending payload dedup), dependency readiness/failure propagation/cycle validation, inherited job defaults, comparator-aware stable heap and isolated Job/Event storage snapshots.40tests pass3.10/3.12 (final mixednumeric/explicitpriority regression included3.10 run). Retention/removeOn and DLQ routing, durable providers, scheduler, stricttyping/metadata/packedgates remain open; broad originalscope preserved. Enqueue adaptercontract now returns Job.

FlowTS agent reports93tests across17files with previouslyexcluded tests enabled, strictTS/build pass. It owns allTS/admin for nextfullcontractaudit; root ownsPython. Content DB prerequisite dabaf5123 remains separate; coordinatedContent0.2.0 proposed subjectregistry and originalruntimecompatibility audit.

## Failed-job recovery and schema entry checkpoint

FlowPython ccdc79b2f:45tests pass3.10/3.12, adapter-backed deadletters/atomicretry preserveoptions and originalqueue, rejectambiguoussameIDs, retentioncounts/zero/immediateremoval anddependencyoutcomes, failedrequeuekeepsDLQ. Durableproviderimplementations stillpending; memoryonlylifetime. Queue.finalfailure and dependencyfailures now createDLQrecords.

DBPR248 followup43c943700 adds./schema narrowentry; exactNode20.19.0 freshpackedCJS and repositoryprobe pass. AvoidsDBrootobservabilitytop-levelawait forContent synchronousCJSfactory. npm10optionalpeerArborist crashed; npm11clean consumerinstallpassed. Followup communicatedContent/TestFn; sourceonlycherry-pick.
