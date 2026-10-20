# Explicit zero campaign caps

2026-10-20. Campaign caps declare a maximum shown count. The TypeScript public
field was documented as a maximum, Python uses `Optional[int]` with `None` for
omission, and no zero-as-unlimited sentinel is documented in the original spec
or SDK docs. Python already enforced zero as allowing no shown deliveries.

TypeScript previously tested cap truthiness, so an explicit zero incorrectly left
the campaign eligible. It now distinguishes omission from zero. Missing caps or
an omitted global cap stay uncapped; positive caps stop eligibility at their exact
shown-count boundary. Dismissed/clicked records do not consume this shown cap.

A matching TS/Python matrix covers omitted caps, empty caps, zero, one and two,
including non-shown records and transitions after each shown record. Before the
fix only the TS zero case failed. Both SDK full suites, TS typecheck and build
pass after the fix. Python production behavior is unchanged.

These counters remain local in-memory campaign counters. This does not implement
per-user/per-session durable limits, cross-instance/global enforcement, schedules,
cooldowns or reconciliation; those original messaging requirements remain open.
The separate survey cap implementation was not changed by this campaign fix.
