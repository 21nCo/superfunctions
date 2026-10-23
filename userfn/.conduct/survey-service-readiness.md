# Durable survey response service — 2026-10-23

Original survey spec requires server response storage and per-user/per-time-window
caps. This checkpoint adds the authoritative response endpoint and transactional
storage, rather than mistaking the previous process-local renderer count for a
durable quota. Display admission and SDK wiring are still separate open work.

Two additive schema tables store accepted response payloads, server timestamps,
tenant/user identity, idempotency fingerprints, total counters and latest accepted
time. The optional service policy resolver controls audience, enabled state,
questions and limits; its result is cloned before asynchronous transactional work.
An authenticated user with userfn:surveys:write is required. Body-supplied identity,
timestamps or policy are rejected. Schema wrapping remains internal to UserFn.

The lifetime cap defaults to one. Configured rolling windows are (now-duration,
now], with zero denying. History is queried with a bounded limit and indexed by
user/survey counter and time; all response inserts coordinate through a total-count
CAS in the same transaction. Unique races and transaction conflicts retry, so
competing instances cannot both consume the last slot. Receipt replay checks the
same actor/key and payload before policy resolution, preserving reconciliation
after retirement without accepting a new response. Conflicting reuse returns409.
Backwards server time fails closed against the actor's latest accepted timestamp.

Validation uses a real HTTP server and two independent SQLite connections. It
covers auth/scope/actor denials, forged identity/timestamps, duplicate/unknown
questions, scale and choice validation, eight concurrent submissions with exactly
two window winners, identical-key races, tenant/user isolation, exact rolling
expiry, lifetime limits, backwards time, zero caps, disabled/deleted policies,
receipt replay, persisted answers after close/reopen and injected insert failure.
The failure trigger proves response insertion rolls back its earlier counter
update. An initial fixture expected500 for database failure; the existing service
correctly maps that to503, and the expectation was corrected without changing
runtime error handling.

All21 service native tests and10 unit tests pass; service TypeScript checking and
build pass. Native suites include existing TS/Python feedback and flag transport
cases, but the NEW survey route is currently exercised through direct HTTP, not
new survey SDK methods. Receipts /tmp/user-surveys-{native-final,unit,build}.log
and /tmp/user-surveys-service-types.log. Test fixtures close sockets/adapters and
remove their owned SQLite directory in finally.

Remaining requirements: SDK survey HTTP transport and recoverable delivery state,
Python survey engine, presentation eligibility/reservations, response listing,
branching/templates, WatchFn durable analytics delivery, real browser and fresh
installed-package survey acceptance, and all broader UserFn readiness. Existing
renderer caps still count local submissions and do not imply server acceptance.
No release, deployment, provider send or base merge performed.
