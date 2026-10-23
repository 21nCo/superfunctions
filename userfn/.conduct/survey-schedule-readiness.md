# Survey schedule admission

2026-10-23. The original survey model includes start/end timing. Survey metadata
and trusted service policies now accept optional UTC epoch-millisecond schedules,
with inclusive start/exclusive end. TypeScript and Python eligibility share17
JSON boundary/malformed-policy vectors. Service admission checks the server clock
inside the transaction; client identify/configuration cannot extend the window.

Existing committed receipts replay before policy evaluation, so lost acknowledgements
remain recoverable after expiry. New out-of-window responses reject403 before
counter/storage mutation. No scheduler or background publication claim is implied:
this governs configured survey eligibility/admission, not authoring lifecycle.
Python None optional bounds represent omission; TypeScript explicit null is invalid.

Validation:255 SDK tests, strict types/dual builds and service build; Python3.9
normal CI234tests/mypy/build;11 service/native regressions. Actual HTTP/SQLite tests
exercise start-1 denial, exactstart admission, end-1 admission, exactend denial,
receipt replay after expiry and persisted-row count proving denied writes consumed
no storage. Previous race/rollback/reopen/lostack and policy tests remain green.
Logs /tmp/user-survey-schedule-{tests,types,build,service-build,python-ci,service-tests}.log.

Fresh seven-tarball ESM/CJS/service plus isolated Python3.9-wheel HTTP replay/cap
acceptance passes with production audit0. The isolated installed wheel also passes
all17 schedule vectors outside the checkout. Logs /tmp/user-survey-schedule-packed.log
and /tmp/user-survey-schedule-wheel-tests.log. Owned environments are removed after
validation; the packed fixture removes its temporary consumer.
Remaining original work includes durable client reconciliation, display admission,
analytics and survey authoring/publication; this checkpoint does not close those.
