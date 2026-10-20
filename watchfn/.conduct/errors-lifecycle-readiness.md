# Exception capture lifecycle checkpoint — 2026-10-20

ExceptionHandler now owns removable listener references. Installation is idempotent; uninstall removes only this handler's registrations, allowing repeated WatchFn start/stop and multiple independent instances without anonymous-listener accumulation. Browser error and unhandled-rejection listeners do not prevent default behavior. WatchFn passes its parsed capture options to install and uninstalls capture when collection stops (coordinated core lifecycle change).

On Node, the handler uses `uncaughtExceptionMonitor` rather than `uncaughtException` or `unhandledRejection`. The former implementation installed handlers that suppressed Node's default fatal exit. Monitoring now observes errors without replacing that behavior. The event origin distinguishes ordinary uncaught errors from fatal unhandled rejections, and captureUnhandled/captureRejections independently control recording. Synchronous capture failures are contained so they cannot replace the original error.

`ignoreErrors` applies substring string matches or RegExp matches to the error message; RegExp lastIndex is not mutated. Captured contexts include current breadcrumbs. Restart retains the existing breadcrumb buffer.

## Node rejection limitation

Fatal rejected promises are captured in Node's default throw mode and strict mode when Node emits uncaughtExceptionMonitor. Rejection handling under `--unhandled-rejections=warn`/`none`, or an application's own `unhandledRejection` handler, may not produce that monitor event. These nonfatal policies are not intercepted by this implementation: applications must call captureException from their own rejection policy if they require those records. Registering a new unhandledRejection listener would itself alter default behavior, so the collector does not do so. Fatal-process capture also cannot guarantee that asynchronous database writes complete before Node exits; no exit delay or durable crash-report mechanism is introduced.

## Validation and remaining scope

Focused tests cover duplicate installation, two-owner removal, restart, browser default preservation and flags, ignored errors, breadcrumb context, observer failure isolation, and core lifecycle option forwarding. Child processes verify the original fatal error still exits with code 1 for uncaught exceptions and rejected promises, both with capture enabled and disabled, and that throwing capture code does not replace the fatal cause. These are process-behavior checks rather than simulated process.emit assertions.

No broad collector rewrite, persistent crash reporting, source-map processing, hosted deployment, remote push or PR is included.

Final checks: all 10 lifecycle tests pass, including five child-process fatal-behavior cases; standalone WatchFn TypeScript checking and diff whitespace checking pass. Core install/uninstall wiring is owned by the coordinated storage-lifecycle change and must remain with this collector change.
