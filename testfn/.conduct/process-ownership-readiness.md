# Framework subprocess ownership checkpoint

The original execution/cancellation contract now waits for the owned POSIX
process group to disappear before returning from a framework process. Previously,
a framework leader could exit successfully while an ignored-stdio descendant
continued running; the caller received exit code zero and ownership ended.

Leader exit and stream closure are observed separately. Residual descendants
receive SIGTERM, then SIGKILL after one second if necessary. Group disappearance
is checked for up to five additional seconds; stream drain has a separate
one-second bound. A normal framework exit with surviving descendants is reported
as failure. Cancellation, execution timeout and output overflow use the same
owned-group cleanup. Permission errors or an unconfirmed termination reject the
operation instead of claiming that execution stopped. Cleanup finishes before
its promise settles. No process identity is recovered from persistent state.

Actual local macOS subprocess tests exercise SIGTERM-resistant descendants with
ignored and explicitly closed stdout/stderr, normal-exit orphan cleanup,
cancellation, timeout, and an unrelated sentinel that remains alive. A permission
failure injected only at the group signal boundary verifies rejection while the
real descendant is still running; the test then restores signalling and removes
its own fixture group. Core tests pass (55), typecheck/build pass, and existing
real framework acceptance passes nine assertions across Vitest, Jest, Playwright
Chromium/WebKit and Puppeteer Chromium.

These checks do not establish Linux behavior, Windows process-tree termination,
or termination of processes that deliberately escape their group. Windows keeps
its direct-child control behavior. If termination cannot be confirmed, operator
cleanup remains necessary; rejection is not proof of termination. This change
does not add durable execution reconciliation or change configured test retries.
