# Survey and campaign dialog keyboard behavior

2026-10-23. Original messaging requirements call for focus trapping, ARIA and
reduced motion. The survey dialog previously left focus outside, and campaign
modal.focus() targeted a non-focusable element without a trap.

Survey and campaign modals now have explicit accessible dialog names and
aria-modal, focus the first available control, wrap Tab/Shift+Tab, redirect
programmatic outside focus while active, and dismiss with Escape through their
existing close behavior. Only the most recent owned dialog handles keyboard
input. Dismissal removes owned document listeners and restores the prior focus
when its element still exists. Advancing survey questions preserves this lifecycle;
identity/consent teardown uses the same cleanup. Reduced-motion preference disables
toast animation/transition. No survey transport or response policy changed.

Validation:235SDK tests, strict types and dual builds pass. Actual Chrome154
built SDK/HTTP/SQLite fixture verifies dialog semantics, both Tab boundaries,
outside-focus containment, Escape, opener restoration, listener removal after
withdrawal, campaign dialog behavior and reduced-motion computed animation. The
same run retains all survey lost-ACK/retry/identity/consent/key/cap cases and runs
without crypto.randomUUID. Logs /tmp/user-dialog-{tests,types,build,native}.log.
Owned browser/server/SQLite/tempfiles cleaned by fixture. Diff whitespace passes.

This is concrete keyboard acceptance, not full accessibility certification.
Screen-reader testing, other browser engines, richer campaign surfaces and feedback
widget acceptance in other engines remain open. Feedback keyboard and retry acceptance is recorded in feedback-dialog-readiness.md. No deployment, provider send or release occurred.
