# Survey identity and callback boundaries — 2026-10-23

Original survey requirements include per-user and time-window caps plus durable
response storage. Inspection found the TypeScript engine stored response arrays
under survey ID alone: Alice responding suppressed Bob's eligibility. The
renderer callback only rechecked current consent, so stale callbacks could run
after identity changes or consent withdrawal/regrant. Zero caps were treated as
omission by truthiness checks.

Responses are now indexed by user ID then survey ID. The legacy global field is
documented as a local per-user response cap, default one; zero and malformed
runtime values deny eligibility. Returning to a previous identity retains its
count for the client lifetime. Submission callbacks check captured identity and
messaging epoch, reject a different survey ID, and accept only once per
presentation. Responses are still local; no persistence or remote receipt is
invented.

Three regressions fail against the original runtime and pass after the fix:
identity separation, zero/malformed caps, and stale/duplicate callback fencing.
All225 SDK tests in17files pass, as do TypeScript checks and dual runtime/types
builds. The first callback test fixture had the wrong renderer method name;
correcting the fake to dismissMessages fixed that harness error. Original-runtime
baseline then produced the intended three assertion failures. Receipts:
/tmp/user-survey-boundaries-{baseline,all,types,build}.log.

Python was inspected: client.py still has a TODO rather than a SurveyEngine.
The service contains no survey routes/storage. Python survey delivery, durable
cross-client admission, per-time-window caps, response validation/storage,
WatchFn emission and real browser/installed consumer survey acceptance remain
open. This checkpoint does not complete the survey requirement or UserFn.
