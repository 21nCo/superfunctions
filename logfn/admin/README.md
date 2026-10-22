# LogFn administration

`@logfn/admin` exposes log emission and sink flushing through the shared administration runtime. Requires Node.js 20 or newer and the matching LogFn core package.

Bind `createLogFnAdminService(logger, scope)` to an installation, workspace, project, environment and optional namespace/region. Register `createLogFnAdminAdapter(service)` with the shared admin registry alongside its WatchFn owner. Both modules must be enabled.

Dispatch external requests through `createAdminDispatcher`, with authenticated actor context, permissions and an audit sink. Direct adapter/service calls are trusted internal APIs; they do not replace the dispatcher's schema validation and permission checks. Service-level scope checks still apply.

- `logfn.events.emit` uses the configured logger's level, pipeline and sinks. Actor and scope attribution override supplied context. Its acknowledgment means the logger method was invoked, not that a remote sink persisted the event.
- `logfn.sinks.flush` waits for accepted asynchronous sink work and flush hooks. Dispatch requires an idempotency key and an idempotency store. A sink failure rejects the operation; it does not return `flushed: true`.

Audit input redacts the supplied `context` object. Applications remain responsible for redacting sensitive message text through their logger pipeline and for configuring suitable audit retention.
