# Owned process-group probe uncertainty — 2026-10-22

An actual cancellation test intermittently returned EPERM from the signal-zero
process-group probe after escalation. Previously any non-ESRCH probe error failed
immediately. EPERM now means present/unknown and remains inside the existing
bounded TERM/KILL cleanup wait. Only ESRCH confirms group disappearance; persistent
EPERM still raises ProcessGroupUncertainError at the deadline. Actual signal-delivery
permission errors still fail immediately. No recovered or unrelated PID is used.

An injected transient EPERM test proceeds through native owned-group cleanup;
a persistent probe EPERM test proves the runner retains uncertainty instead of
reporting stopped. The full89-test runner suite passed after the implementation
change; the final17-case remote-runner file, including both probe cases, passes.
Runner source and strict remote typechecks and dual builds pass. The prior failed
full-suite run is retained at /tmp/cifn-api-redaction-runner-tests.log; passing
receipts are /tmp/cifn-api-redaction-runner-tests2.log and
/tmp/cifn-group-probe-tests.log. Test-owned children are stopped by the native
cancellation path and fixtures removed. Cross-platform escaped processes and
crash recovery remain outside the existing ownership guarantee.
