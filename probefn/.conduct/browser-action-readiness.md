# Browser ownership and action event checkpoint

2026-10-20 UTC. The original specification remains the acceptance target.

Browser startup reserves session IDs before launch and retains ownership through cleanup. Stop joins an in-flight startup and concurrent stops share cleanup. Context, navigation, trace, and event-storage failures still attempt browser closure; a connected browser whose close fails remains available for a later stop attempt. Event capture observes synchronous and asynchronous sink failures immediately, and flush drains its captured write barrier before reporting failures.

Selector and semantic actions capture target identity before execution, so a button that removes itself can still return its original identity. Request observers are installed before execution. After the action returns, a bounded network quiet period and event-storage flush precede delta counting. The default quiet period is 100 ms and settlement deadline is 5000 ms. A timeout reports E_ACTION_SETTLE_TIMEOUT with actionMayHaveExecuted and retryable false, avoiding an automatic replay of a potentially completed side effect. Observers and timers are always removed. MCP playback supplies the event flush and configured quiet period and surfaces browser cleanup failures.

Real Chromium cases cover delayed HTTP 500 responses, delayed storage writes, selector and semantic actions, a hanging request, self-removing targets, failed startup and stop stages, duplicate starts, stop during launch, shared stops, retained ownership and retry, and synchronous/asynchronous event-write failure.

The unfiltered Node 22.23.3 vector command passes all 28 declared vectors. Its grouped mapping is evidence for the implemented harness, not proof of every specification requirement. The full Node 22.23.3 suite passes 85 tests across 21 files. Strict TypeScript checking passes. Generated artifacts remain ignored; no additional ignore change is needed.

Remaining limits include Firefox/WebKit, Windows process ownership, escaped POSIX process groups, unbounded hung storage/close operations, distribution/admin integration, security/performance/accessibility and deployment acceptance. Network observation is bounded and cannot guarantee capture of work scheduled after the quiet period. No production release or base merge is implied.
